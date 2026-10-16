import type { Event, Offset } from "@eforest/protocol";
import { evidenceActionValidators, type EvidenceResolvedStream } from "@eforest/evidence";
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
import { registerChatValidators } from "./chat/validators.js";
import { registerOrgRosterValidators } from "./org/validators.js";
import { taskActionValidators, type TaskState } from "@eforest/tasks";
import {
  PROJECT_ACTION_TYPES,
  validateProjectEvent,
  type ProjectActorRole,
  type ProjectRecordResolver,
  type ProjectState,
} from "./loop/index.js";

export interface ActionValidationContext {
  readonly streamId: string;
  readonly state: unknown;
  readonly headOffset: Offset;
  readonly nextOffset: Offset;
  readonly records: readonly Event[];
  readonly issueSource?: IssueEnvelopeSource;
  /** Identity stamped by the dispatch door; task validators bind `by.actor` to it. */
  readonly actor?: string;
  /** Role the dispatch door derived from the credential (E6-T03): session = human, grant = agent. */
  readonly actorRole?: ProjectActorRole;
  /** Offset-stamped, metadata-stripped records of another stream (E6-T03 queue proofs). */
  readonly resolveRecords?: ProjectRecordResolver;
  readonly resolveBranch?: (streamId: string) => Promise<PrBranchSnapshot | undefined>;
  readonly resolveStream?: (streamId: string) => Promise<EvidenceResolvedStream | undefined>;
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
    "issue.linked",
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

export function registerEvidenceValidators(
  registry = new ActionValidatorRegistry(),
): ActionValidatorRegistry {
  for (const validator of evidenceActionValidators) {
    registry.registerValidator(validator.actionType, async (action, context) => {
      await validator.validate(action, {
        streamId: context.streamId,
        state: context.state as Parameters<typeof validator.validate>[1]["state"],
        headOffset: context.headOffset,
        nextOffset: context.nextOffset,
        records: context.records,
        resolveStream: context.resolveStream ?? (async () => undefined),
      });
    });
  }
  return registry;
}

export function registerTaskValidators(
  registry = new ActionValidatorRegistry(),
): ActionValidatorRegistry {
  for (const validator of taskActionValidators) {
    registry.registerValidator(validator.actionType, async (action, context) => {
      await validator.validate(action, {
        streamId: context.streamId,
        state: context.state as TaskState,
        headOffset: context.headOffset,
        nextOffset: context.nextOffset,
        records: context.records,
        ...(context.actor === undefined ? {} : { actor: context.actor }),
        resolveStream: context.resolveStream ?? (async () => undefined),
      });
    });
  }
  return registry;
}

export function registerProjectValidators(
  registry = new ActionValidatorRegistry(),
): ActionValidatorRegistry {
  for (const actionType of PROJECT_ACTION_TYPES) {
    registry.registerValidator(actionType, async (action, context) => {
      await validateProjectEvent(action, {
        streamId: context.streamId,
        state: context.state as ProjectState,
        headOffset: context.headOffset,
        nextOffset: context.nextOffset,
        records: context.records,
        ...(context.actor === undefined ? {} : { actor: context.actor }),
        ...(context.actorRole === undefined ? {} : { actorRole: context.actorRole }),
        ...(context.resolveRecords === undefined ? {} : { resolveRecords: context.resolveRecords }),
      });
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
  registerEvidenceValidators(registry);
  registerTaskValidators(registry);
  registerProjectValidators(registry);
  registerChatValidators(registry);
  registerOrgRosterValidators(registry);
  return registry;
}
