import type { Event } from "@eforest/protocol";
import { isIssueActionType, type IssueActionType, type IssueState } from "@eforest/reducers";
import type { IssueEnvelopeSource } from "./issues/envelope.js";
import { IssueUnknownActionError, validateIssueEvent } from "./issues/validators.js";

export interface ActionValidationContext {
  readonly state: IssueState;
  readonly headOffset: string;
  readonly records: readonly Event[];
  readonly issueSource?: IssueEnvelopeSource;
}

export type ActionValidator = (action: Event, context: ActionValidationContext) => void;

export class ActionValidatorRegistry {
  private readonly validators = new Map<string, ActionValidator>();

  registerValidator(actionType: string, validator: ActionValidator): this {
    if (this.validators.has(actionType))
      throw new Error(`validator already registered: ${actionType}`);
    this.validators.set(actionType, validator);
    return this;
  }

  validate(action: Event, context: ActionValidationContext): void {
    const validator = this.validators.get(action.type);
    if (validator === undefined) throw new IssueUnknownActionError();
    validator(action, context);
  }
}

export function registerIssueValidators(
  registry = new ActionValidatorRegistry(),
): ActionValidatorRegistry {
  const actions: readonly IssueActionType[] = [
    "issue.opened",
    "issue.commented",
    "issue.labeled",
    "issue.unlabeled",
    "issue.state-changed",
    "issue.closed",
    "issue.reopened",
  ];
  for (const actionType of actions) {
    registry.registerValidator(actionType, (action, context) => {
      if (!isIssueActionType(action.type)) throw new IssueUnknownActionError();
      validateIssueEvent(action, context.state, context.records, context.issueSource);
    });
  }
  return registry;
}
