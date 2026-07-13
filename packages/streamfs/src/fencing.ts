import type { Event } from "@eforest/protocol";
import type {
  ActionSchemaValidator,
  ActionValidatorContext,
  ActionValidatorRegistry,
  ActionValidatorResult,
} from "@eforest/server";
import {
  isFsFilePatchPayload,
  isFsFileWritePayload,
  type FsFilePatchPayload,
  type FsFileWritePayload,
} from "./events.js";
import type { FsTree } from "./tree.js";

/** Sentinel used by a first content write after file creation or recreation. */
export const BASE_NONE = "BASE_NONE" as const;

function stateOf(
  context: ActionValidatorContext,
  resolveState: (context: ActionValidatorContext) => FsTree | undefined = defaultStateOf,
): FsTree | undefined {
  return resolveState(context);
}

function defaultStateOf(context: ActionValidatorContext): FsTree | undefined {
  const state = context.state as Record<string, unknown> | null;
  if (
    state === null ||
    typeof state !== "object" ||
    Array.isArray(state) ||
    state.files === null ||
    typeof state.files !== "object" ||
    Array.isArray(state.files)
  ) {
    return undefined;
  }
  return state as unknown as FsTree;
}

function payloadRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const baseSchema: ActionSchemaValidator = (action: Event) => {
  const payload = payloadRecord(action.payload);
  if (payload === undefined) {
    return {
      class: "schema-violation",
      reason: "action payload must be an object",
      field: "payload",
    };
  }
  if (!Object.hasOwn(payload, "base")) {
    return {
      class: "schema-violation",
      reason: "content mutation base is required",
      field: "base",
    };
  }
  if (typeof payload.base !== "string") {
    return {
      class: "schema-violation",
      reason: "content mutation base must be a string",
      field: "base",
    };
  }
  return undefined;
};

function expectedBase(file: { readonly lastContentOffset: string } | undefined): string {
  return file?.lastContentOffset ?? BASE_NONE;
}

function stale(path: string, expected: string, actual: string): ActionValidatorResult {
  return {
    ok: false,
    class: "validator-rejected",
    reason: "stale-base",
    conflict: { path, expectedBase: expected, actualBase: actual },
  };
}

function fence(
  action: Event,
  context: ActionValidatorContext,
  payload: FsFileWritePayload | FsFilePatchPayload,
  resolveState: (context: ActionValidatorContext) => FsTree | undefined,
): ActionValidatorResult {
  const state = stateOf(context, resolveState);
  const file = state?.files[payload.path];
  if (file === undefined) return { ok: true };
  const expected = expectedBase(file);
  if (
    payload.base !== expected ||
    (action.type === "fs.file.patch" && payload.base === BASE_NONE)
  ) {
    return stale(payload.path, expected, payload.base);
  }
  return { ok: true };
}

function writeFence(
  action: Event,
  context: ActionValidatorContext,
  resolveState: (context: ActionValidatorContext) => FsTree | undefined,
): ActionValidatorResult {
  if (!isFsFileWritePayload(action.payload)) return { ok: true };
  return fence(action, context, action.payload, resolveState);
}

function patchFence(
  action: Event,
  context: ActionValidatorContext,
  resolveState: (context: ActionValidatorContext) => FsTree | undefined,
): ActionValidatorResult {
  if (!isFsFilePatchPayload(action.payload)) return { ok: true };
  return fence(action, context, action.payload, resolveState);
}

export function registerFsFencing(
  validators: ActionValidatorRegistry,
  resolveState: (context: ActionValidatorContext) => FsTree | undefined = defaultStateOf,
): ActionValidatorRegistry {
  validators.registerSchemaValidator("fs.file.write", baseSchema);
  validators.registerSchemaValidator("fs.file.patch", baseSchema);
  validators.registerValidator("fs.file.write", (action, context) =>
    writeFence(action, context, resolveState),
  );
  validators.registerValidator("fs.file.patch", (action, context) =>
    patchFence(action, context, resolveState),
  );
  return validators;
}
