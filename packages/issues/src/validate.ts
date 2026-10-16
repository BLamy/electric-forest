import type { Event } from "@eforest/protocol";
import {
  isIssueActionType,
  isIssueEventShape,
  isLegal,
  issueReducer,
  stateChangedVia,
  type IssueState,
  type IssueStateName,
} from "./issueReducer.js";

export class IssueSchemaError extends Error {
  constructor(readonly reason = "schema-violation") {
    super(reason);
    this.name = "IssueSchemaError";
  }
}
export class IssueUnknownActionError extends Error {
  constructor() {
    super("unknown-action-type");
    this.name = "IssueUnknownActionError";
  }
}
export class IssueRefusalError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "IssueRefusalError";
  }
}

/**
 * The E5-T01 issue workflow validator, independent of the HTTP source scan: unknown
 * action, envelope shape, open-once, legal transition, duplicate close link, and
 * comment/label uniqueness. Platform issue dispatch wraps it with the source-token
 * check; task streams (E6-T01) reuse it verbatim for the issue half of a task.
 */
export function validateIssueWorkflowEvent(
  event: Event,
  state: IssueState,
  records: readonly Event[] = [],
): void {
  if (!isIssueActionType(event.type)) throw new IssueUnknownActionError();
  if (!isIssueEventShape(event)) throw new IssueSchemaError();
  if (records.length === 0 && event.type !== "issue.opened")
    throw new IssueRefusalError("issue/not-opened");
  if (records.length > 0 && event.type === "issue.opened")
    throw new IssueRefusalError("issue/already-opened");
  if (event.type === "issue.opened") return;
  const p = event.payload as Record<string, unknown>;
  const via = stateChangedVia(event);
  if (
    via !== undefined &&
    state.closedBy?.some(
      (existing) =>
        existing.prStream === via.prStream && existing.prMergedOffset === via.prMergedOffset,
    ) === true
  ) {
    throw new IssueRefusalError("link/duplicate-close");
  }
  if (!isLegal(state.state, event.type, p.to as IssueStateName | undefined))
    throw new IssueRefusalError("issue/illegal-transition");
  if (
    event.type === "issue.commented" &&
    state.comments.some((comment) => comment.commentId === p.commentId)
  )
    throw new IssueRefusalError("issue/duplicate-comment");
  if (event.type === "issue.labeled" && state.labels.includes(p.label as string))
    throw new IssueRefusalError("issue/duplicate-label");
  if (event.type === "issue.unlabeled" && !state.labels.includes(p.label as string))
    throw new IssueRefusalError("issue/missing-label");
  issueReducer(state, event);
}
