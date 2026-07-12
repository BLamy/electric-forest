import type { IncomingMessage, ServerResponse } from "node:http";
import { canonicalJson, isEvent, type Event, type Offset } from "@eforest/protocol";
import { parseJsonBody } from "./request-body.js";
import { InvalidRequestError } from "./request-errors.js";
import { jsonResponse } from "./response.js";
import { reduceStateAtOffset, type StateRouteOptions } from "./redux/routes.js";
import type { ReducerRegistry } from "./redux/registry.js";
import type { AppendStreamResult, StreamStore } from "./store/types.js";
import {
  createDefaultActionValidatorRegistry,
  type ActionValidatorContext,
  type ValidatorRejected,
} from "./validation.js";

export type DispatchErrorClass =
  "malformed-body" | "schema-violation" | "unknown-action-type" | "validator-rejected";

export interface DispatchError {
  readonly class: DispatchErrorClass;
  readonly actionType?: string;
  readonly field?: string;
  readonly reason: string;
}

export class DispatchRejectionError extends Error {
  readonly status: 400 | 404 | 409 | 422;
  readonly detail: DispatchError;

  constructor(status: 400 | 404 | 409 | 422, detail: DispatchError) {
    super(detail.reason);
    this.name = "DispatchRejectionError";
    this.status = status;
    this.detail = detail;
  }
}

export type DispatchAppend = (
  streamId: string,
  events: readonly Event[],
  sequence: number,
) => AppendStreamResult;

function rejection(
  status: 400 | 404 | 409 | 422,
  className: DispatchErrorClass,
  reason: string,
  field?: string,
  actionType?: string,
): DispatchRejectionError {
  const detail: DispatchError = {
    class: className,
    reason,
    ...(field === undefined ? {} : { field }),
    ...(actionType === undefined ? {} : { actionType }),
  };
  return new DispatchRejectionError(status, detail);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function schemaValidate(value: unknown): Event {
  const record = objectRecord(value);
  if (!record) throw rejection(422, "schema-violation", "action body must be an object", "body");

  const actionType = typeof record.type === "string" ? record.type : undefined;
  const expected = new Set(["type", "payload", "ts"]);
  for (const key of Object.keys(record)) {
    if (!expected.has(key)) {
      throw rejection(422, "schema-violation", `unexpected action field ${key}`, key, actionType);
    }
  }
  if (!Object.hasOwn(record, "type")) {
    throw rejection(422, "schema-violation", "action type is required", "type");
  }
  if (typeof record.type !== "string" || record.type.length === 0) {
    throw rejection(422, "schema-violation", "action type must be a non-empty string", "type");
  }
  if (!Object.hasOwn(record, "payload")) {
    throw rejection(422, "schema-violation", "action payload is required", "payload", actionType);
  }
  if (!Object.hasOwn(record, "ts")) {
    throw rejection(422, "schema-violation", "action timestamp is required", "ts", actionType);
  }
  if (typeof record.ts !== "number" || !Number.isFinite(record.ts)) {
    throw rejection(422, "schema-violation", "action timestamp must be finite", "ts", actionType);
  }
  try {
    canonicalJson(record);
  } catch (error) {
    throw rejection(
      422,
      "schema-violation",
      error instanceof Error ? error.message : "action contains a non-canonical JSON value",
      "payload",
      actionType,
    );
  }
  if (!isEvent(record)) {
    throw rejection(422, "schema-violation", "action envelope is invalid", "body", actionType);
  }
  return record;
}

function streamType(config: unknown): unknown {
  return config !== null && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>).type
    : undefined;
}

function lazyContext(
  store: StreamStore,
  streamId: string,
  headOffset: Offset,
  reduxOptions: StateRouteOptions,
): ActionValidatorContext {
  let evaluated = false;
  let value: unknown;
  const context = { headOffset } as ActionValidatorContext;
  Object.defineProperty(context, "state", {
    configurable: false,
    enumerable: true,
    get: () => {
      if (!evaluated) {
        value = reduceStateAtOffset(store, streamId, headOffset, false, reduxOptions).state;
        evaluated = true;
      }
      return value;
    },
  });
  return context;
}

export async function handleDispatchRoute(
  request: IncomingMessage,
  response: ServerResponse,
  store: StreamStore,
  streamId: string,
  reduxOptions: StateRouteOptions,
  append: DispatchAppend,
): Promise<void> {
  store.getConfig(streamId);
  let body: unknown;
  try {
    body = await parseJsonBody(request, false);
  } catch (error) {
    if (error instanceof InvalidRequestError) {
      throw rejection(400, "malformed-body", error.message);
    }
    throw error;
  }

  const action = schemaValidate(body);
  const config = store.getConfig(streamId);
  const type = streamType(config);
  const registry: ReducerRegistry = reduxOptions.registry;
  if (!registry.get(type) || !registry.acceptsAction(type, action.type)) {
    throw rejection(
      404,
      "unknown-action-type",
      registry.get(type)
        ? `action type ${action.type} is not registered for stream reducer ${String(type)}`
        : `no reducer is registered for stream type ${String(type)}`,
      "type",
      action.type,
    );
  }

  const headOffset = store.head(streamId);
  const validators = reduxOptions.actionValidators ?? createDefaultActionValidatorRegistry();
  const result: ValidatorRejected | undefined = validators.validate(
    action,
    lazyContext(store, streamId, headOffset, reduxOptions),
  );
  if (result) {
    throw rejection(409, result.class, result.reason, result.field, action.type);
  }

  const sequence = store.sequence(streamId) + 1;
  const appended = append(streamId, [action], sequence);
  const record = appended.records[0];
  if (!record) throw new Error("dispatch append did not return one record");
  jsonResponse(
    response,
    201,
    { event: record, offset: record.offset, head: appended.head, streamSeq: appended.sequence },
    { "stream-seq": String(appended.sequence) },
  );
}
