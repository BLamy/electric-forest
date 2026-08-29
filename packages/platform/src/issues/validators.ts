import type { Event } from "@eforest/protocol";
import { isIssueActionType, isLegal, issueReducer, type IssueState } from "@eforest/reducers";
import { isIssueEnvelopeSourceValid, isIssueEvent, type IssueEnvelopeSource } from "./envelope.js";

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

export function validateIssueEvent(
  event: Event,
  state: IssueState,
  records: readonly Event[] = [],
  source?: IssueEnvelopeSource,
): void {
  if (!isIssueActionType(event.type)) throw new IssueUnknownActionError();
  if (source !== undefined && !isIssueEnvelopeSourceValid(source)) throw new IssueSchemaError();
  if (!isIssueEvent(event)) throw new IssueSchemaError();
  if (records.length === 0 && event.type !== "issue.opened")
    throw new IssueRefusalError("issue/not-opened");
  if (records.length > 0 && event.type === "issue.opened")
    throw new IssueRefusalError("issue/already-opened");
  if (event.type === "issue.opened") return;
  const p = event.payload as Record<string, unknown>;
  if (!isLegal(state.state, event.type, p.to as never))
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

export interface IssueActionValidator {
  readonly streamType: "issue";
  readonly validate: typeof validateIssueEvent;
}
export const issueActionValidator: IssueActionValidator = Object.freeze({
  streamType: "issue",
  validate: validateIssueEvent,
});
