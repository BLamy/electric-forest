import type { Event, Offset } from "@eforest/protocol";
import {
  LabelSchemaError,
  validateLabelEvent,
  type LabelEventType,
  type LabelState,
} from "@eforest/issues";
import {
  isPrActionType,
  prActionValidators,
  type PrBranchSnapshot,
  type PrState,
} from "@eforest/pr";
import { isIssueActionType, type IssueActionType, type IssueState } from "@eforest/reducers";
import type { IssueEnvelopeSource } from "./issues/envelope.js";
import { IssueUnknownActionError, validateIssueEvent } from "./issues/validators.js";

export interface ActionValidationContext {
  readonly streamId: string;
  readonly state: unknown;
  readonly headOffset: Offset;
  readonly nextOffset: Offset;
  readonly records: readonly Event[];
  readonly issueSource?: IssueEnvelopeSource;
  readonly resolveBranch?: (streamId: string) => Promise<PrBranchSnapshot | undefined>;
}

export type ActionValidator = (
  action: Event,
  context: ActionValidationContext,
) => void | Promise<void>;

export class ActionValidatorRegistry {
  private readonly validators = new Map<string, ActionValidator>();

  registerValidator(actionType: string, validator: ActionValidator): this {
    if (this.validators.has(actionType))
      throw new Error(`validator already registered: ${actionType}`);
    this.validators.set(actionType, validator);
    return this;
  }

  async validate(action: Event, context: ActionValidationContext): Promise<void> {
    const validator = this.validators.get(action.type);
    if (validator === undefined) throw new IssueUnknownActionError();
    await validator(action, context);
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
      validateIssueEvent(action, context.state as IssueState, context.records, context.issueSource);
    });
  }
  return registry;
}

export function registerPrValidators(
  registry = new ActionValidatorRegistry(),
): ActionValidatorRegistry {
  for (const validator of prActionValidators) {
    registry.registerValidator(validator.actionType, async (action, context) => {
      if (!isPrActionType(action.type)) throw new IssueUnknownActionError();
      await validator.validate(action, {
        streamId: context.streamId,
        state: context.state as PrState,
        headOffset: context.headOffset,
        nextOffset: context.nextOffset,
        records: context.records,
        resolveBranch: context.resolveBranch ?? (async () => undefined),
      });
    });
  }
  return registry;
}

export function registerLabelValidators(
  registry = new ActionValidatorRegistry(),
): ActionValidatorRegistry {
  const actions: readonly LabelEventType[] = ["label.created", "label.renamed", "label.recolored"];
  for (const actionType of actions) {
    registry.registerValidator(actionType, (action, context) => {
      if (action.type !== actionType) throw new LabelSchemaError();
      validateLabelEvent(context.state as LabelState, action);
    });
  }
  return registry;
}

export function registerApplicationValidators(
  registry = new ActionValidatorRegistry(),
): ActionValidatorRegistry {
  registerIssueValidators(registry);
  registerLabelValidators(registry);
  registerPrValidators(registry);
  return registry;
}
