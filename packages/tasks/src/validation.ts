import type { Event, Offset } from "@eforest/protocol";
import {
  attachmentInitialStateForStream,
  attachmentReducer,
  isEvidenceStreamId,
  type AttachmentListState,
  type EvidenceResolvedStream,
} from "@eforest/evidence";
import { isIssueActionType, validateIssueWorkflowEvent } from "@eforest/issues";
import {
  TASK_ACTION_TYPES,
  isTaskActionType,
  isTaskEventShape,
  type TaskActionType,
  type TaskEvent,
} from "./events.js";
import { applyTaskEvent } from "./reducer.js";
import type { TaskState } from "./state.js";
import type { TaskRefusalReason } from "./version.js";

export class TaskSchemaError extends Error {
  constructor() {
    super("schema-violation");
    this.name = "TaskSchemaError";
  }
}

export class TaskUnknownActionError extends Error {
  constructor() {
    super("unknown-action-type");
    this.name = "TaskUnknownActionError";
  }
}

export class TaskRefusalError extends Error {
  constructor(readonly reason: TaskRefusalReason) {
    super(reason);
    this.name = "TaskRefusalError";
  }
}

export interface TaskActionValidationContext {
  readonly streamId: string;
  readonly state: TaskState;
  readonly headOffset: Offset;
  readonly nextOffset: Offset;
  readonly records: readonly Event[];
  /** Identity the dispatch door stamped on the event; absent for offline replay checks. */
  readonly actor?: string;
  /** Platform lookup for the task's E5-T10 attachment list; absent means "not resolvable here". */
  readonly resolveStream?: (streamId: string) => Promise<EvidenceResolvedStream | undefined>;
}

function attachmentList(
  streamId: string,
  resolved: EvidenceResolvedStream,
): AttachmentListState | undefined {
  const state = resolved.state as Partial<AttachmentListState> | undefined;
  if (state !== undefined && Array.isArray(state.attachments)) return state as AttachmentListState;
  if (!isEvidenceStreamId(streamId)) return undefined;
  return resolved.records.reduce(attachmentReducer, attachmentInitialStateForStream(streamId));
}

async function assertAttachmentsExist(
  event: TaskEvent,
  context: TaskActionValidationContext,
): Promise<void> {
  if (context.resolveStream === undefined || event.type === "task.started") return;
  if (event.type === "task.rework-started" || event.type === "task.spec-revised") return;
  const wanted = new Map<string, Set<string>>();
  const cite = (stream: string, attachmentId: string): void => {
    const ids = wanted.get(stream) ?? new Set<string>();
    ids.add(attachmentId);
    wanted.set(stream, ids);
  };
  for (const id of event.payload.evidence.attachmentIds) cite(event.payload.evidence.stream, id);
  if (event.type === "task.refuted") {
    for (const finding of event.payload.findings) {
      if ("attachmentId" in finding.citation)
        cite(finding.citation.stream, finding.citation.attachmentId);
    }
  }
  for (const [stream, ids] of wanted) {
    const resolved = await context.resolveStream(stream);
    const list = resolved === undefined ? undefined : attachmentList(stream, resolved);
    if (list === undefined) throw new TaskRefusalError("task/unknown-attachment");
    for (const id of ids) {
      const attachment = list.attachments.find((entry) => entry.attachmentId === id);
      if (attachment === undefined || attachment.detachedAtOffset !== undefined)
        throw new TaskRefusalError("task/unknown-attachment");
    }
  }
}

/**
 * The dispatch-door contract for a task stream. Issue events are validated by the
 * frozen E5-T01 workflow validator against the task's embedded issue state; loop events
 * are validated by the same transition table the reducer replays, plus the
 * dispatch-only linkages (stamped identity, attachment existence).
 */
export async function validateTaskEvent(
  action: Event,
  context: TaskActionValidationContext,
): Promise<void> {
  if (isIssueActionType(action.type)) {
    validateIssueWorkflowEvent(action, context.state.issue, context.records);
    return;
  }
  if (!isTaskActionType(action.type)) throw new TaskUnknownActionError();
  if (!isTaskEventShape(action)) throw new TaskSchemaError();
  if (
    context.actor !== undefined &&
    action.type !== "task.spec-revised" &&
    action.payload.by.actor !== context.actor
  )
    throw new TaskRefusalError("task/actor-mismatch");
  const transition = applyTaskEvent(context.state, action, context.nextOffset);
  if (!transition.ok) throw new TaskRefusalError(transition.reason);
  await assertAttachmentsExist(action, context);
}

export interface TaskActionValidator {
  readonly actionType: TaskActionType;
  readonly validate: typeof validateTaskEvent;
}

export const taskActionValidators: readonly TaskActionValidator[] = TASK_ACTION_TYPES.map(
  (actionType) => Object.freeze({ actionType, validate: validateTaskEvent }),
);
