import type { Event } from "@eforest/protocol";
import {
  IssueRefusalError,
  IssueSchemaError,
  IssueUnknownActionError,
  isIssueActionType,
  validateIssueWorkflowEvent,
  type IssueState,
} from "@eforest/reducers";
import { isIssueEnvelopeSourceValid, type IssueEnvelopeSource } from "./envelope.js";

export { IssueRefusalError, IssueSchemaError, IssueUnknownActionError };

export function validateIssueEvent(
  event: Event,
  state: IssueState,
  records: readonly Event[] = [],
  source?: IssueEnvelopeSource,
): void {
  if (!isIssueActionType(event.type)) throw new IssueUnknownActionError();
  if (source !== undefined && !isIssueEnvelopeSourceValid(source)) throw new IssueSchemaError();
  validateIssueWorkflowEvent(event, state, records);
}

export interface IssueActionValidator {
  readonly streamType: "issue";
  readonly validate: typeof validateIssueEvent;
}
export const issueActionValidator: IssueActionValidator = Object.freeze({
  streamType: "issue",
  validate: validateIssueEvent,
});
