import type { Event, Offset } from "@eforest/protocol";
import { OFFSET_BEFORE_FIRST } from "@eforest/protocol";
import { repoIssuesStreamId, replayIssueCatalog } from "@eforest/issues";
import { replayTaskLog, type TaskState } from "@eforest/tasks";
import {
  isProjectActionType,
  isProjectEventShape,
  type ProjectActorRole,
  type ProjectEvent,
  type ProjectProofTask,
  type ProjectQueueProof,
  type ProjectRefusalReason,
  type ProjectStatus,
  type ProjectTransitionedEvent,
} from "./project-events.js";
import {
  ProjectRefusalError,
  ProjectSchemaError,
  ProjectUnknownActionError,
  guardLoopAction,
  projectCitation,
  type ProjectRecordResolver,
} from "./project-guard.js";
import type { ProjectCompletion, ProjectState } from "./project-reducer.js";

export type ProjectTransition =
  | { readonly ok: true; readonly next: ProjectState }
  | { readonly ok: false; readonly reason: ProjectRefusalReason };

function refuse(reason: ProjectRefusalReason): ProjectTransition {
  return { ok: false, reason };
}

/**
 * The transition table, verbatim from `.eforest/loop.md`:
 *
 * | from          | to             | who              |
 * | ------------- | -------------- | ---------------- |
 * | building      | paused         | human only       |
 * | building      | invalid_loop   | anyone           |
 * | building      | complete       | anyone, with a queue proof |
 * | paused        | building       | human only (never self-resumed) |
 * | paused        | invalid_loop   | anyone           |
 * | invalid_loop  | building       | human only (the recovery authorization) |
 * | complete      | building       | human only (new tasks were planned) |
 *
 * Everything else — including `to === from` — is `project/invalid-transition`.
 */
export function transitionRefusal(
  from: ProjectStatus,
  to: ProjectStatus,
  role: ProjectActorRole,
): ProjectRefusalReason | undefined {
  if (to === from) return "project/invalid-transition";
  switch (from) {
    case "building":
      if (to === "paused") return role === "human" ? undefined : "project/human-required";
      return undefined; // invalid_loop, complete (the proof is checked by the caller)
    case "paused":
      if (to === "building") return role === "human" ? undefined : "project/unauthorized-resume";
      if (to === "invalid_loop") return undefined;
      return "project/invalid-transition";
    case "invalid_loop":
    case "complete":
      if (to === "building") return role === "human" ? undefined : "project/unauthorized-resume";
      return "project/invalid-transition";
  }
}

/**
 * Proof consistency that needs no I/O: at least one task, unique ids, every task
 * `verified`, exactly one capstone. Replay re-checks this; the door additionally holds
 * the proof against replayed task state (`verifyQueueProof`).
 */
export function proofConsistencyRefusal(
  proof: ProjectQueueProof,
): ProjectRefusalReason | undefined {
  if (proof.tasks.length === 0) return "project/false-proof";
  const ids = new Set(proof.tasks.map((task) => task.id));
  if (ids.size !== proof.tasks.length) return "project/false-proof";
  if (proof.tasks.some((task) => task.status !== "verified")) return "project/false-proof";
  if (proof.tasks.filter((task) => task.capstone).length !== 1) return "project/false-proof";
  return undefined;
}

function completionOf(proof: ProjectQueueProof): ProjectCompletion {
  return {
    queue: proof.queue,
    tasks: proof.tasks.length,
    capstone: proof.tasks.find((task) => task.capstone)!.id,
  };
}

/**
 * The single transition table for project events; the door throws its refusal before
 * append, replay treats the same refusal as a deterministic no-op. `offset` is the
 * stream offset the event occupies (or will occupy).
 */
export function decideProjectTransition(
  state: ProjectState,
  event: ProjectEvent,
  offset: Offset,
): ProjectTransition {
  if (event.payload.expectedOffset !== state.head) return refuse("project/stale-offset");
  const by = event.payload.by;
  if (event.type === "loop.launch.requested") {
    const reason = guardLoopAction(state.status, "loop.launch.requested");
    if (reason !== undefined) return refuse(reason);
    return {
      ok: true,
      next: {
        ...state,
        head: offset,
        launches: state.launches + 1,
        lastLaunch: { offset, run: event.payload.run, actor: by.actor, role: by.role },
      },
    };
  }
  const to = event.payload.to;
  const reason = transitionRefusal(state.status, to, by.role);
  if (reason !== undefined) return refuse(reason);
  let completion: ProjectCompletion | undefined;
  if (to === "complete") {
    if (event.payload.proof === undefined) return refuse("project/proof-required");
    const proofReason = proofConsistencyRefusal(event.payload.proof);
    if (proofReason !== undefined) return refuse(proofReason);
    completion = completionOf(event.payload.proof);
  } else if (event.payload.proof !== undefined) {
    return refuse("project/invalid-transition");
  }
  const base: ProjectState = {
    v: state.v,
    stream: state.stream,
    org: state.org,
    repo: state.repo,
    status: to,
    statusReason: event.payload.statusReason,
    updatedAt: event.ts,
    actor: by.actor,
    actorRole: by.role,
    head: offset,
    transitions: state.transitions + 1,
    launches: state.launches,
    ...(state.lastLaunch === undefined ? {} : { lastLaunch: state.lastLaunch }),
  };
  return { ok: true, next: completion === undefined ? base : { ...base, completion } };
}

function cleanRecord(record: Event): Event {
  if (
    record.payload === null ||
    typeof record.payload !== "object" ||
    Array.isArray(record.payload)
  )
    return record;
  const payload = Object.fromEntries(
    Object.entries(record.payload).filter(([key]) => key !== "actor" && key !== "writer"),
  );
  return { ...record, payload };
}

function headOf(records: readonly Event[]): Offset | typeof OFFSET_BEFORE_FIRST {
  const last = records.at(-1) as (Event & { readonly offset?: Offset }) | undefined;
  return last?.offset ?? OFFSET_BEFORE_FIRST;
}

/** A task, for completion purposes: an issue the loop has touched or one labeled as one. */
export function isLoopTask(task: TaskState): boolean {
  return (
    task.attempts.length > 0 ||
    task.issue.labels.includes("task") ||
    task.issue.labels.includes("capstone")
  );
}

export function expectedProofTask(task: TaskState): ProjectProofTask {
  return {
    id: task.taskId,
    status: task.status,
    capstone: task.issue.labels.includes("capstone"),
  };
}

/**
 * Hold a queue proof against stream state. The proof must cite the repository's issue
 * catalog at its current head (`project/stale-proof` otherwise) and list exactly the
 * catalog's loop tasks with their replayed status and capstone flag — an omitted,
 * invented, duplicated, or misreported task is `project/false-proof`. An unresolvable
 * proof is false: nothing here trusts the proof's own words.
 */
export async function verifyQueueProof(
  state: ProjectState,
  proof: ProjectQueueProof,
  resolve: ProjectRecordResolver | undefined,
): Promise<void> {
  const at = projectCitation(state);
  if (resolve === undefined) throw new ProjectRefusalError("project/false-proof", at);
  const catalogStream = repoIssuesStreamId(state.org, state.repo);
  if (proof.queue.stream !== catalogStream)
    throw new ProjectRefusalError("project/false-proof", at);
  const catalogRecords = (await resolve(catalogStream)) ?? [];
  if (headOf(catalogRecords) !== proof.queue.offset)
    throw new ProjectRefusalError("project/stale-proof", at);
  let catalog: ReturnType<typeof replayIssueCatalog>;
  try {
    catalog = replayIssueCatalog(catalogStream, catalogRecords.map(cleanRecord));
  } catch {
    throw new ProjectRefusalError("project/false-proof", at);
  }
  const expected = new Map<string, ProjectProofTask>();
  for (const issueStream of Object.keys(catalog.issues).sort()) {
    const task = replayTaskLog(issueStream, (await resolve(issueStream)) ?? []);
    if (isLoopTask(task)) expected.set(task.taskId, expectedProofTask(task));
  }
  const claimed = new Map<string, ProjectProofTask>();
  for (const task of proof.tasks) {
    if (claimed.has(task.id)) throw new ProjectRefusalError("project/false-proof", at);
    claimed.set(task.id, task);
  }
  if (claimed.size !== expected.size) throw new ProjectRefusalError("project/false-proof", at);
  for (const [id, truth] of expected) {
    const claim = claimed.get(id);
    if (
      claim === undefined ||
      claim.status !== truth.status ||
      claim.capstone !== truth.capstone ||
      truth.status !== "verified"
    ) {
      throw new ProjectRefusalError("project/false-proof", at);
    }
  }
}

export interface ProjectValidationContext {
  readonly streamId: string;
  readonly state: ProjectState;
  readonly headOffset: Offset | typeof OFFSET_BEFORE_FIRST;
  readonly nextOffset: Offset;
  readonly records: readonly Event[];
  /** Identity the dispatch door stamped on the event; absent for offline replay checks. */
  readonly actor?: string;
  /** Role the door derived from the credential (session = human, grant = agent). */
  readonly actorRole?: ProjectActorRole;
  /** Platform lookup for the queue proof's catalog and task streams. */
  readonly resolveRecords?: ProjectRecordResolver;
}

/**
 * The dispatch-door contract for the project stream: exact shape, identity and role
 * bound to the credential, the transition table at the cited offset, and — for
 * `building -> complete` — the queue proof held against replayed task state.
 */
export async function validateProjectEvent(
  action: Event,
  context: ProjectValidationContext,
): Promise<void> {
  if (!isProjectActionType(action.type)) throw new ProjectUnknownActionError();
  if (!isProjectEventShape(action)) throw new ProjectSchemaError();
  const at = projectCitation(context.state);
  if (context.actor !== undefined && action.payload.by.actor !== context.actor)
    throw new ProjectRefusalError("project/actor-mismatch", at);
  if (context.actorRole !== undefined && action.payload.by.role !== context.actorRole)
    throw new ProjectRefusalError("project/role-mismatch", at);
  const transition = decideProjectTransition(context.state, action, context.nextOffset);
  if (!transition.ok) throw new ProjectRefusalError(transition.reason, at);
  if (action.type === "project.transitioned" && action.payload.to === "complete") {
    await verifyQueueProof(
      context.state,
      (action as ProjectTransitionedEvent).payload.proof!,
      context.resolveRecords,
    );
  }
}
