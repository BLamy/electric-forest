import type { Event, Offset } from "@eforest/protocol";
import { OFFSET_BEFORE_FIRST } from "@eforest/protocol";
import { parseTaskStreamId } from "@eforest/tasks";
import {
  PROJECT_EVENT_VERSION,
  PROJECT_FENCE_EVENT,
  isProjectGuardedAction,
  projectStreamId,
  type ProjectActorRef,
  type ProjectFencedEvent,
  type ProjectGuardedAction,
  type ProjectRefusalReason,
  type ProjectStatus,
} from "./project-events.js";
import { replayProjectLog, type ProjectState } from "./project-reducer.js";

/** Where the guard decided: the project stream, its head offset, and the status there. */
export interface ProjectGuardCitation {
  readonly stream: string;
  readonly offset: Offset | typeof OFFSET_BEFORE_FIRST;
  readonly status: ProjectStatus;
}

export class ProjectSchemaError extends Error {
  constructor() {
    super("schema-violation");
    this.name = "ProjectSchemaError";
  }
}

export class ProjectUnknownActionError extends Error {
  constructor() {
    super("unknown-action-type");
    this.name = "ProjectUnknownActionError";
  }
}

/** A frozen refusal: the reason plus the exact project-state offset it was decided at. */
export class ProjectRefusalError extends Error {
  constructor(
    readonly reason: ProjectRefusalReason,
    readonly at: ProjectGuardCitation,
  ) {
    super(reason);
    this.name = "ProjectRefusalError";
  }
}

export function projectCitation(state: ProjectState): ProjectGuardCitation {
  return { stream: state.stream, offset: state.head, status: state.status };
}

/**
 * The loop guard: may this loop action run in this project status? `building` admits
 * every loop action; every other status refuses every loop action with its own stable
 * reason. The launch, the task claim, both verdicts, a task start, and a rework start
 * all pass through here, on the project stream and on task streams alike.
 */
export function guardLoopAction(
  status: ProjectStatus,
  action: ProjectGuardedAction,
): ProjectRefusalReason | undefined {
  void action;
  switch (status) {
    case "building":
      return undefined;
    case "paused":
      return "project/paused";
    case "complete":
      return "project/complete";
    case "invalid_loop":
      // E6_T03_INVALID_LOOP_GUARD: the sabotage sentinel removes this arm and proves
      // verify-E6-T03 goes red on an attempted launch against an invalid loop.
      return "project/invalid-loop";
  }
}

/** Records with server metadata stripped and a stream offset on each; `undefined` = no stream. */
export type ProjectRecordResolver = (streamId: string) => Promise<readonly Event[] | undefined>;

/**
 * The task-stream hook: before a loop event on `issue:<org>/<repo>/<task>` reaches the
 * task validator, replay `project:<org>/<repo>` and ask the guard. The refusal cites the
 * project head it was decided at and leaves the task stream untouched (the caller has
 * not appended anything yet). Non-loop issue events (comments, labels, links) are not
 * loop actions and never consult the project state.
 */
export async function guardTaskLoopAction(
  taskStreamId: string,
  eventType: string,
  resolve: ProjectRecordResolver,
): Promise<ProjectGuardCitation | undefined> {
  if (!isProjectGuardedAction(eventType)) return undefined;
  const identity = parseTaskStreamId(taskStreamId);
  if (identity === undefined) return undefined;
  const stream = projectStreamId(identity.org, identity.repo);
  const state = replayProjectLog(stream, (await resolve(stream)) ?? []);
  const reason = guardLoopAction(state.status, eventType);
  if (reason !== undefined) throw new ProjectRefusalError(reason, projectCitation(state));
  return projectCitation(state);
}

/** Compare-and-append: `true` when the record landed at `ordinal`, `false` on a lost race. */
export type ProjectFenceAppender = (
  streamId: string,
  event: ProjectFencedEvent,
  ordinal: number,
) => Promise<boolean>;

export interface ProjectFenceIo {
  readonly resolve: ProjectRecordResolver;
  readonly appendAt: ProjectFenceAppender;
}

export const PROJECT_FENCE_ATTEMPTS = 8;

/**
 * The cross-process fence for a guarded task loop event. The guard decision is re-made
 * against a fresh replay of the project stream and then *committed* by appending a
 * `project.fenced` record at that stream's current durable sequence. Any other append to
 * the project stream — a human pause, an invalid_loop stop — that wins the same sequence
 * makes this append conflict; the door then re-reads and refuses with the winning
 * state's own reason (`project/paused`, …). N gateways on the same streams therefore
 * agree on one linear history: no fence, and so no task loop event, can follow an
 * accepted pause at that pause's sequence. `target` binds the fence to the task-stream
 * offset the event will occupy. Eight consecutive lost races refuse
 * `project/fence-contention` (fail closed, never silently admit).
 */
export interface ProjectFenceTarget {
  readonly offset: Offset;
  readonly writer: { readonly sub: string; readonly seq: number };
}

/**
 * Classify one fence against its target stream's records: `landed` when the record at
 * `target.offset` is the fenced event (same type and writer identity), `dead` when that
 * offset holds another record, `open` when the offset is not yet written.
 */
export function classifyFence(
  fence: ProjectFencedEvent,
  targetRecords: readonly Event[] | undefined,
): "landed" | "dead" | "open" {
  const ordinal = Number(fence.payload.target.offset.split("_")[1]);
  const record = targetRecords?.[ordinal] as
    | (Event & { readonly payload: { readonly writer?: { sub?: unknown; seq?: unknown } } })
    | undefined;
  if (record === undefined) return "open";
  const writer = record.payload?.writer;
  return record.type === fence.payload.target.type &&
    writer !== undefined &&
    writer.sub === fence.payload.target.writer.sub &&
    writer.seq === fence.payload.target.writer.seq
    ? "landed"
    : "dead";
}

export async function fenceTaskLoopAction(
  taskStreamId: string,
  eventType: string,
  target: ProjectFenceTarget,
  by: ProjectActorRef,
  ts: number,
  io: ProjectFenceIo,
): Promise<ProjectGuardCitation | undefined> {
  if (!isProjectGuardedAction(eventType)) return undefined;
  const identity = parseTaskStreamId(taskStreamId);
  if (identity === undefined) return undefined;
  const stream = projectStreamId(identity.org, identity.repo);
  let state = replayProjectLog(stream, []);
  for (let attempt = 0; attempt < PROJECT_FENCE_ATTEMPTS; attempt += 1) {
    const records = (await io.resolve(stream)) ?? [];
    state = replayProjectLog(stream, records);
    // E6_T03_TASK_FENCE_GUARD: the guard decision the fence commits.
    const reason = guardLoopAction(state.status, eventType);
    if (reason !== undefined) throw new ProjectRefusalError(reason, projectCitation(state));
    const fence: ProjectFencedEvent = {
      type: PROJECT_FENCE_EVENT,
      payload: {
        v: PROJECT_EVENT_VERSION,
        by,
        action: eventType,
        target: {
          stream: taskStreamId,
          offset: target.offset,
          type: eventType,
          writer: target.writer,
        },
      },
      ts,
    };
    if (await io.appendAt(stream, fence, records.length)) return projectCitation(state);
  }
  throw new ProjectRefusalError("project/fence-contention", projectCitation(state));
}
