import type { Event, Offset } from "@eforest/protocol";

export interface ActionValidatorContext {
  readonly state: unknown;
  readonly headOffset: Offset;
}

export interface ValidatorAccepted {
  readonly ok: true;
}

export interface ValidatorRejected {
  readonly ok: false;
  readonly class: "validator-rejected";
  readonly reason: string;
  readonly field?: string;
}

export type ActionValidatorResult = ValidatorAccepted | ValidatorRejected;
export type ActionValidator = (
  action: Event,
  context: ActionValidatorContext,
) => ActionValidatorResult;

export class ActionValidatorRegistry {
  private readonly validators = new Map<string, ActionValidator[]>();

  registerValidator(actionType: string, validator: ActionValidator): this {
    if (actionType.length === 0) throw new TypeError("action type must not be empty");
    const registered = this.validators.get(actionType) ?? [];
    registered.push(validator);
    this.validators.set(actionType, registered);
    return this;
  }

  validate(action: Event, context: ActionValidatorContext): ValidatorRejected | undefined {
    for (const validator of this.validators.get(action.type) ?? []) {
      const result = validator(action, context);
      if (!result.ok) return result;
    }
    return undefined;
  }
}

export function createDefaultActionValidatorRegistry(): ActionValidatorRegistry {
  const registry = new ActionValidatorRegistry();
  registry.registerValidator("counter/decrement", (action, context) => {
    const state = context.state;
    if (
      state === null ||
      typeof state !== "object" ||
      typeof (state as { count?: unknown }).count !== "number"
    ) {
      return {
        ok: false,
        class: "validator-rejected",
        reason: "counter state is not valid",
        field: "state",
      };
    }
    const count = (state as { count: number }).count;
    const amount = action.payload;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
      return {
        ok: false,
        class: "validator-rejected",
        reason: "decrement amount must be a positive finite number",
        field: "payload",
      };
    }
    if (count - amount < 0) {
      return {
        ok: false,
        class: "validator-rejected",
        reason: "counter cannot be decremented below zero",
        field: "payload",
      };
    }
    return { ok: true };
  });
  return registry;
}
