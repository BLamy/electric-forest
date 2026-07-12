import type { IncomingMessage, ServerResponse } from "node:http";
import {
  canonicalJson,
  compareOffsets,
  OFFSET_BEFORE_FIRST,
  replay,
  type Offset,
} from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";
import { handleLongPoll, handleSse, type LiveReadOptions } from "../live.js";
import { InvalidRequestError } from "../request-errors.js";
import { jsonResponse } from "../response.js";
import type { StreamStore } from "../store/types.js";
import { ReducerRegistry, UnknownReducerTypeError } from "./registry.js";
import { StateCache } from "./state-cache.js";

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
): void {
  if (live === "long-poll") {
    handleLongPoll(request, response, store, streamId, offset, liveOptions.longPollTimeoutMs);
    return;
  }
  if (live === "sse") {
    handleSse(request, response, store, streamId, offset, liveOptions.sseHeartbeatMs);
    return;
  }
  if (live !== null) throw new InvalidRequestError("live must be long-poll or sse");
  const records = store.read(streamId, offset);
  jsonResponse(response, 200, records, { "stream-next-offset": String(store.head(streamId)) });
}

export interface StateRouteOptions {
  readonly registry: ReducerRegistry;
  readonly cache: StateCache;
}

export function handleStateRoute(
  response: ServerResponse,
  store: StreamStore,
  streamId: string,
  requestedOffset: string | null,
  bypassCache: boolean,
  options: StateRouteOptions,
): void {
  const head = store.head(streamId);
  const records = store.read(streamId, OFFSET_BEFORE_FIRST);
  const target = requestedOffset === null ? head : parseOffset(requestedOffset);
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
  let binding;
  try {
    binding = options.registry.require(type);
  } catch (error) {
    if (error instanceof UnknownReducerTypeError) {
      jsonResponse(response, 422, { error: "unknown_reducer_type", type: error.type });
      return;
    }
    throw error;
  }

  if (bypassCache) {
    options.cache.recordBypass();
  } else {
    const cached = options.cache.get(streamId, binding.version, target);
    if (cached !== undefined) {
      writeState(response, target, cached);
      return;
    }
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
  const state = replay(toReplay, binding.reducer, source);
  options.cache.put(streamId, binding.version, target, state);
  writeState(response, target, state);
}

function writeState(response: ServerResponse, offset: Offset, state: unknown): void {
  const body = canonicalJson(state);
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "stream-offset": String(offset),
  });
  response.end(body);
}
