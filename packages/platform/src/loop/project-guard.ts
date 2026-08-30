import type { Event, Offset } from "@eforest/protocol";
import { OFFSET_BEFORE_FIRST } from "@eforest/protocol";
import { parseTaskStreamId } from "@eforest/tasks";
import {
  isProjectGuardedAction,
  projectStreamId,
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
