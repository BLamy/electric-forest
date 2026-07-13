import type { IncomingMessage, ServerResponse } from "node:http";
import {
  canonicalJson,
  compareOffsets,
  OFFSET_BEFORE_FIRST,
  replay,
  type Event,
  type Offset,
} from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";
import { handleLongPoll, handleSse, type LiveReadOptions } from "../live.js";
import { InvalidRequestError } from "../request-errors.js";
import { jsonResponse } from "../response.js";
import type { StreamStore } from "../store/types.js";
import { ReducerRegistry, UnknownReducerTypeError } from "./registry.js";
import { StateCache } from "./state-cache.js";
import type { ActionValidatorRegistry } from "../validation.js";

export function parseOffset(value: string | null): Offset {
  const raw = value ?? OFFSET_BEFORE_FIRST;
  if (!isWellFormedOffset(raw)) {
    throw new InvalidRequestError("offset must be -1 or an opaque numeric position");
  }
  return raw as Offset;
}

export function handleEventsRoute(
  request: IncomingMessage,
  response: ServerResponse,
  store: StreamStore,
  streamId: string,
  offset: Offset,
  live: string | null,
  liveOptions: Required<LiveReadOptions>,
  inclusive = false,
): void {
  if (live === "long-poll") {
    handleLongPoll(
      request,
      response,
      store,
      streamId,
      offset,
      liveOptions.longPollTimeoutMs,
      inclusive,
    );
    return;
  }
  if (live === "sse") {
    handleSse(request, response, store, streamId, offset, liveOptions.sseHeartbeatMs, inclusive);
    return;
  }
  if (live !== null) throw new InvalidRequestError("live must be long-poll or sse");
  const records = store.read(streamId, offset, inclusive);
  jsonResponse(response, 200, records, { "stream-next-offset": String(store.head(streamId)) });
}

export interface StateRouteOptions {
  readonly registry: ReducerRegistry;
  readonly cache: StateCache;
  readonly actionValidators?: ActionValidatorRegistry;
}

export interface ReducedState {
  readonly target: Offset;
  readonly state: unknown;
}

export class ReducerReplayError extends Error {
  readonly offset: Offset;

  constructor(offset: Offset, cause: unknown) {
    super(
      `reducer rejected event at offset ${offset}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "ReducerReplayError";
    this.offset = offset;
  }
}

export function reduceStateAtOffset(
  store: StreamStore,
  streamId: string,
  requestedOffset: Offset | null,
  bypassCache: boolean,
  options: StateRouteOptions,
): ReducedState {
  const head = store.head(streamId);
  const records = store.read(streamId, OFFSET_BEFORE_FIRST);
  const target = requestedOffset ?? head;
  if (compareOffsets(target, head) > 0) {
    throw new InvalidRequestError("state offset is past the stream head");
  }
  if (target !== OFFSET_BEFORE_FIRST && !records.some((record) => record.offset === target)) {
    throw new InvalidRequestError("state offset is not an event offset in this stream");
  }

  const config = store.getConfig(streamId);
  const type =
    config !== null && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>).type
      : undefined;
  const binding = options.registry.require(type);

  if (bypassCache) {
    options.cache.recordBypass();
  } else {
    const cached = options.cache.get(streamId, binding.version, target);
    if (cached !== undefined) return { target, state: cached };
  }

  const ancestor = bypassCache
    ? undefined
    : options.cache.nearestAncestor(streamId, binding.version, target);
  const source = ancestor?.state ?? binding.initialState;
  const toReplay = records.filter(
    (record) =>
      compareOffsets(record.offset, target) <= 0 &&
      (ancestor === undefined || compareOffsets(record.offset, ancestor.offset) > 0),
  );
  if (ancestor) options.cache.recordIncrementalReplay();
  const state = replay(
    toReplay,
    (current, event) => {
      const candidate = event as Event & { readonly offset?: unknown };
      const offset = typeof candidate.offset === "string" ? (candidate.offset as Offset) : target;
      try {
        return binding.reducer(current, event);
      } catch (error) {
        throw new ReducerReplayError(offset, error);
      }
    },
    source,
  );
  options.cache.put(streamId, binding.version, target, state);
  return { target, state };
}

export function handleStateRoute(
  response: ServerResponse,
  store: StreamStore,
  streamId: string,
  requestedOffset: string | null,
  bypassCache: boolean,
  options: StateRouteOptions,
  snapshotOffset?: Offset,
): void {
  try {
    const reduced = reduceStateAtOffset(
      store,
      streamId,
      requestedOffset === null ? null : parseOffset(requestedOffset),
      bypassCache,
      options,
    );
    writeState(response, reduced.target, reduced.state, snapshotOffset);
  } catch (error) {
    if (error instanceof UnknownReducerTypeError) {
      jsonResponse(response, 422, { error: "unknown_reducer_type", type: error.type });
      return;
    }
    if (error instanceof ReducerReplayError) {
      jsonResponse(response, 422, {
        error: "reducer_error",
        message: error.message,
        offset: error.offset,
      });
      return;
    }
    throw error;
  }
}

function writeState(
  response: ServerResponse,
  offset: Offset,
  state: unknown,
  snapshotOffset?: Offset,
): void {
  const body = canonicalJson(state);
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "stream-offset": String(offset),
    ...(snapshotOffset === undefined ? {} : { "stream-snapshot-offset": String(snapshotOffset) }),
  });
  response.end(body);
}
