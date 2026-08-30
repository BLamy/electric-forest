import type { Event, Offset } from "@eforest/protocol";
import { OFFSET_BEFORE_FIRST } from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";
import { isIssueString } from "@eforest/issues";
import { TASK_STATUSES, isAgentRunStreamId, type TaskStatus } from "@eforest/tasks";

/** Frozen `project` envelope version: every project-state payload carries `v: 1`. */
export const PROJECT_EVENT_VERSION = 1 as const;

/** Registry id of the project-state projection (`ef replay --reducer project/v1`). */
export const PROJECT_REDUCER_ID = "project/v1" as const;

/**
 * The `.eforest/loop.md` project states, verbatim. `building` is the only state in which
 * the loop may launch or advance; the other three are enforcement states, not badges.
 */
export const PROJECT_STATES = ["building", "complete", "paused", "invalid_loop"] as const;
export type ProjectStatus = (typeof PROJECT_STATES)[number];

/**
 * Who dispatched a project event, as the door derived it from the presented
 * credential: `human` is a validated web session of a repository/org owner or admin
 * (`repo-owner` / `org-owner` / `membership:admin` authorization bases); `agent` is a
 * grant-backed bearer token (`grant:write`). The event's `by.role` must match.
 */
export const PROJECT_ACTOR_ROLES = ["human", "agent"] as const;
export type ProjectActorRole = (typeof PROJECT_ACTOR_ROLES)[number];

/**
 * Every event type the project stream accepts.
 *
 * - `project.transitioned` — the single validated transition door.
 * - `loop.launch.requested` — the guarded loop action. It has no runtime yet (the agent
 *   runner lands in E6-T07/E6-T11); this task freezes the event and the guard so that a
 *   launch is impossible outside `building` from the day the runtime exists.
 */
export const PROJECT_ACTION_TYPES = ["project.transitioned", "loop.launch.requested"] as const;
export type ProjectActionType = (typeof PROJECT_ACTION_TYPES)[number];

/** Loop actions the project guard decides for, on this stream and on task streams. */
export const PROJECT_GUARDED_ACTIONS = [
  "loop.launch.requested",
  "task.started",
  "task.claimed",
  "task.refuted",
  "task.rework-started",
  "task.verified",
] as const;
export type ProjectGuardedAction = (typeof PROJECT_GUARDED_ACTIONS)[number];

export const PROJECT_REFUSAL_REASONS = [
  /** A loop action or automatic resume while `paused`. */
  "project/paused",
  /** A loop action (launch/advance) while `complete`. */
  "project/complete",
  /** A loop action or automatic resume while `invalid_loop`. */
  "project/invalid-loop",
  /** `expectedOffset` is not the project stream head the door decided at. */
  "project/stale-offset",
  /** An agent credential tried `paused|invalid_loop|complete -> building`. */
  "project/unauthorized-resume",
  /** An agent credential tried a human-only transition (`building -> paused`). */
  "project/human-required",
  /** A `from -> to` pair outside the transition table (including `to === from`). */
  "project/invalid-transition",
  /** `building -> complete` without a queue proof. */
  "project/proof-required",
  /** The queue proof cites a queue head that is not the current catalog head. */
  "project/stale-proof",
  /** The queue proof contradicts replayed task state or is not the complete task set. */
  "project/false-proof",
  /** `by.actor` differs from the authenticated identity the door stamped. */
  "project/actor-mismatch",
  /** `by.role` differs from the role the door derived from the credential. */
  "project/role-mismatch",
] as const;
export type ProjectRefusalReason = (typeof PROJECT_REFUSAL_REASONS)[number];

export const PROJECT_ACTOR_MAX_CODE_UNITS = 256;
export const PROJECT_REASON_MAX_CODE_UNITS = 4096;
export const PROJECT_PROOF_MAX_TASKS = 4096;
export const PROJECT_STREAM_PATTERN =
  /^project:([a-z0-9](?:-?[a-z0-9])*)\/([a-z0-9](?:-?[a-z0-9])*)$/;
const TASK_ID_PATTERN = /^[A-Za-z0-9._~-]+$/;

export interface ProjectActorRef {
  readonly actor: string;
  readonly role: ProjectActorRole;
}

export interface ProjectQueueRef {
  /** The repo issue catalog `repo-issues:<org>/<repo>` — the queue's source of truth today. */
  readonly stream: string;
  /** The catalog head offset the proof was computed at. */
  readonly offset: Offset;
}

export interface ProjectProofTask {
  readonly id: string;
  readonly status: TaskStatus;
  readonly capstone: boolean;
}

/**
 * A queue proof: the complete set of loop tasks of the repository at the cited catalog
 * head, each with its replayed status. The door re-derives every field from stream
 * state; a proof is a claim to be checked, never a source.
 */
export interface ProjectQueueProof {
  readonly queue: ProjectQueueRef;
  readonly tasks: readonly ProjectProofTask[];
}

export interface ProjectTransitionedEvent extends Event {
  readonly type: "project.transitioned";
  readonly payload: {
    readonly v: typeof PROJECT_EVENT_VERSION;
    readonly by: ProjectActorRef;
    readonly to: ProjectStatus;
    /** The project stream head the dispatcher observed (`-1` for an unwritten stream). */
    readonly expectedOffset: Offset | typeof OFFSET_BEFORE_FIRST;
    readonly statusReason: string;
    readonly proof?: ProjectQueueProof;
  };
}

export interface LoopLaunchRequestedEvent extends Event {
  readonly type: "loop.launch.requested";
  readonly payload: {
    readonly v: typeof PROJECT_EVENT_VERSION;
    readonly by: ProjectActorRef;
    readonly expectedOffset: Offset | typeof OFFSET_BEFORE_FIRST;
    /** The `agent-run:<org>/<run-id>` trace stream the launched run will write. */
    readonly run: string;
  };
}

export type ProjectEvent = ProjectTransitionedEvent | LoopLaunchRequestedEvent;

export function isProjectActionType(value: string): value is ProjectActionType {
  return (PROJECT_ACTION_TYPES as readonly string[]).includes(value);
}

export function isProjectGuardedAction(value: string): value is ProjectGuardedAction {
  return (PROJECT_GUARDED_ACTIONS as readonly string[]).includes(value);
}

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === "string" && (PROJECT_STATES as readonly string[]).includes(value);
}

export function isProjectActorRole(value: unknown): value is ProjectActorRole {
  return typeof value === "string" && (PROJECT_ACTOR_ROLES as readonly string[]).includes(value);
}

export function projectStreamId(org: string, repo: string): string {
  return `project:${org}/${repo}`;
}

export function isProjectStreamId(streamId: string): boolean {
  return PROJECT_STREAM_PATTERN.test(streamId);
}

export interface ProjectStreamIdentity {
  readonly org: string;
  readonly repo: string;
}

export function parseProjectStreamId(streamId: string): ProjectStreamIdentity | undefined {
  const match = PROJECT_STREAM_PATTERN.exec(streamId);
  return match === null ? undefined : { org: match[1]!, repo: match[2]! };
}

function exactObject(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) return false;
  const actual = (keys as string[]).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function boundedText(value: unknown, max: number): value is string {
  return isIssueString(value) && value.length > 0 && value.length <= max;
}

function isExpectedOffset(value: unknown): value is Offset | typeof OFFSET_BEFORE_FIRST {
  return value === OFFSET_BEFORE_FIRST || (typeof value === "string" && isWellFormedOffset(value));
}

function isEventOffset(value: unknown): value is Offset {
  return typeof value === "string" && value !== OFFSET_BEFORE_FIRST && isWellFormedOffset(value);
}

export function isProjectActorRef(value: unknown): value is ProjectActorRef {
  return (
    exactObject(value, ["actor", "role"]) &&
    boundedText(value.actor, PROJECT_ACTOR_MAX_CODE_UNITS) &&
    isProjectActorRole(value.role)
  );
}

export function isProjectProofTask(value: unknown): value is ProjectProofTask {
  return (
    exactObject(value, ["id", "status", "capstone"]) &&
    typeof value.id === "string" &&
    value.id.length <= PROJECT_ACTOR_MAX_CODE_UNITS &&
    TASK_ID_PATTERN.test(value.id) &&
    (TASK_STATUSES as readonly unknown[]).includes(value.status) &&
    typeof value.capstone === "boolean"
  );
}

/** Shape only: duplicate ids, missing capstones, and false statuses are 409 refusals. */
export function isProjectQueueProof(value: unknown): value is ProjectQueueProof {
  if (!exactObject(value, ["queue", "tasks"])) return false;
  const queue = value.queue;
  if (
    !exactObject(queue, ["stream", "offset"]) ||
    !boundedText(queue.stream, PROJECT_ACTOR_MAX_CODE_UNITS) ||
    !isEventOffset(queue.offset)
  ) {
    return false;
  }
  return (
    Array.isArray(value.tasks) &&
    value.tasks.length <= PROJECT_PROOF_MAX_TASKS &&
    value.tasks.every(isProjectProofTask)
  );
}

/** Exact-shape guard for one project event; unknown fields, versions, and types are refused. */
export function isProjectEventShape(event: Event): event is ProjectEvent {
  if (!isProjectActionType(event.type)) return false;
  const p = event.payload;
  if (p === null || typeof p !== "object" || Array.isArray(p)) return false;
  const payload = p as Record<string, unknown>;
  if (payload.v !== PROJECT_EVENT_VERSION || !isProjectActorRef(payload.by)) return false;
  if (!isExpectedOffset(payload.expectedOffset)) return false;
  switch (event.type) {
    case "project.transitioned": {
      const withProof = Object.hasOwn(payload, "proof");
      const fields = withProof
        ? ["v", "by", "to", "expectedOffset", "statusReason", "proof"]
        : ["v", "by", "to", "expectedOffset", "statusReason"];
      return (
        exactObject(payload, fields) &&
        isProjectStatus(payload.to) &&
        boundedText(payload.statusReason, PROJECT_REASON_MAX_CODE_UNITS) &&
        (!withProof || isProjectQueueProof(payload.proof))
      );
    }
    case "loop.launch.requested":
      return (
        exactObject(payload, ["v", "by", "expectedOffset", "run"]) &&
        isAgentRunStreamId(payload.run)
      );
  }
}

export function projectEventOffset(event: Event): Offset | undefined {
  const offset = (event as Event & { readonly offset?: unknown }).offset;
  return isEventOffset(offset) ? offset : undefined;
}
