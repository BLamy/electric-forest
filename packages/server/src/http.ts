import {
  createServer as createNodeServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { URL } from "node:url";
import {
  canonicalJson,
  compareOffsets,
  STREAM_SNAPSHOT_OFFSET_HEADER,
  type Event,
} from "@eforest/protocol";
import { recordAppendInvocation, type AppendDoor } from "./append-metrics.js";
import { DispatchRejectionError, handleDispatchRoute } from "./dispatch.js";
import { MemoryStreamStore } from "./store/memory.js";
import { type LiveReadOptions } from "./live.js";
import { InvalidRequestError } from "./request-errors.js";
import { parseJsonBody } from "./request-body.js";
import { errorResponse, jsonResponse, textResponse } from "./response.js";
import {
  handleEventsRoute,
  handleStateRoute,
  parseOffset,
  reduceStateAtOffset,
  type StateRouteOptions,
} from "./redux/routes.js";
import { ReducerRegistry } from "./redux/registry.js";
import { StateCache } from "./redux/state-cache.js";
import {
  createDefaultActionValidatorRegistry,
  type ActionValidatorRegistry,
} from "./validation.js";
import {
  InvalidEventError,
  InvalidSnapshotError,
  StreamConfigConflictError,
  StreamNotFoundError,
  StreamSequenceConflictError,
  NoSnapshotError,
  type StreamStore,
} from "./store/types.js";

export interface HttpServerOptions {
  readonly longPollTimeoutMs?: number;
  readonly sseHeartbeatMs?: number;
  readonly reducerRegistry?: ReducerRegistry;
  readonly stateCache?: StateCache;
  readonly actionValidators?: ActionValidatorRegistry;
}

const DEFAULT_LIVE_OPTIONS: Required<LiveReadOptions> = {
  longPollTimeoutMs: 30_000,
  sseHeartbeatMs: 15_000,
};

const DEFAULT_REDUX_OPTIONS: StateRouteOptions = {
  registry: new ReducerRegistry(),
  cache: new StateCache(),
  actionValidators: createDefaultActionValidatorRegistry(),
};

type StreamRouteKind = "read" | "dump" | "events" | "state" | "dispatch" | "compact";

function streamIdFrom(pathname: string): { streamId: string; kind: StreamRouteKind } | undefined {
  const parts = pathname.split("/");
  if (parts.length !== 3 && parts.length !== 4) return undefined;
  if (
    parts[1] !== "streams" ||
    !parts[2] ||
    (parts.length === 4 &&
      !["dump", "events", "state", "dispatch", "compact"].includes(parts[3] ?? ""))
  )
    return undefined;
  try {
    const kind = parts.length === 3 ? "read" : (parts[3] as StreamRouteKind);
    return { streamId: decodeURIComponent(parts[2]), kind };
  } catch {
    return undefined;
  }
}

function parseSequence(request: IncomingMessage): number {
  const header = request.headers["stream-seq"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new InvalidRequestError("Stream-Seq must be a non-negative integer");
  }
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence)) throw new InvalidRequestError("Stream-Seq is out of range");
  return sequence;
}

function parseEvents(value: unknown): readonly Event[] {
  const events = Array.isArray(value)
    ? value
    : value !== null &&
        typeof value === "object" &&
        Array.isArray((value as { events?: unknown }).events)
      ? (value as { events: unknown[] }).events
      : undefined;
  if (!events || events.length === 0)
    throw new InvalidRequestError("body must contain a non-empty events array");
  return events as Event[];
}

// This wrapper is intentionally private to the HTTP server module. The raw protocol
// route and the validated dispatch route are the only callers; no append helper is part
// of the public server package or the source test surface.
function appendThroughDoor(
  store: StreamStore,
  streamId: string,
  events: readonly Event[],
  sequence: number,
  door: AppendDoor,
) {
  recordAppendInvocation(door);
  return store.append(streamId, events, sequence);
}

function handleStoreError(response: ServerResponse, error: unknown): boolean {
  if (error instanceof StreamNotFoundError) {
    errorResponse(response, 404, "stream_not_found", error.message);
    return true;
  }
  if (error instanceof StreamConfigConflictError) {
    errorResponse(response, 409, "stream_config_conflict", error.message);
    return true;
  }
  if (error instanceof StreamSequenceConflictError) {
    errorResponse(response, 409, "stream_sequence_conflict", error.message, {
      "stream-seq": String(error.currentSequence),
    });
    return true;
  }
  if (error instanceof InvalidEventError) {
    errorResponse(response, 400, "invalid_event", error.message);
    return true;
  }
  return false;
}

export async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  store: StreamStore,
  liveOptions: Required<LiveReadOptions> = DEFAULT_LIVE_OPTIONS,
  reduxOptions: StateRouteOptions = DEFAULT_REDUX_OPTIONS,
): Promise<void> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  } catch {
    errorResponse(response, 400, "invalid_url", "request URL is invalid");
    return;
  }
  const route = streamIdFrom(parsedUrl.pathname);
  if (!route) {
    errorResponse(response, 404, "not_found", "route not found");
    return;
  }
  if (
    (route.kind === "dump" || route.kind === "events" || route.kind === "state") &&
    request.method !== "GET"
  ) {
    response.setHeader("allow", "GET");
    errorResponse(response, 405, "method_not_allowed", "this route only supports GET");
    return;
  }
  if (route.kind === "dispatch" && request.method !== "POST") {
    response.setHeader("allow", "POST");
    errorResponse(response, 405, "method_not_allowed", "this route only supports POST");
    return;
  }
  if (route.kind === "compact" && request.method !== "POST") {
    response.setHeader("allow", "POST");
    errorResponse(response, 405, "method_not_allowed", "this route only supports POST");
    return;
  }

  try {
    if (request.method === "PUT" && route.kind === "read") {
      const config = await parseJsonBody(request, true);
      const result = store.create(route.streamId, config);
      reduxOptions.cache.invalidateStream(route.streamId);
      jsonResponse(response, result.created ? 201 : 200, {
        created: result.created,
        head: result.head,
        stream: route.streamId,
        streamSeq: result.sequence,
      });
      return;
    }
    if (request.method === "POST" && route.kind === "dispatch") {
      await handleDispatchRoute(
        request,
        response,
        store,
        route.streamId,
        reduxOptions,
        (streamId, events, sequence) =>
          appendThroughDoor(store, streamId, events, sequence, "dispatch"),
      );
      return;
    }
    if (request.method === "POST" && route.kind === "compact") {
      // Preserve a reducer baseline before pruning the log. A subsequent
      // dispatch must validate against the compacted stream's current state,
      // even though the reducer cannot replay the pre-snapshot prefix.
      const streamConfig = store.getConfig(route.streamId);
      const streamType =
        streamConfig !== null && typeof streamConfig === "object" && !Array.isArray(streamConfig)
          ? (streamConfig as Record<string, unknown>).type
          : undefined;
      if (reduxOptions.registry.get(streamType)) {
        reduceStateAtOffset(store, route.streamId, null, false, reduxOptions);
      }
      const result = store.compact(route.streamId);
      jsonResponse(response, 200, result, {
        [STREAM_SNAPSHOT_OFFSET_HEADER]: String(result.snapshotOffset),
      });
      return;
    }
    if (request.method === "POST" && route.kind === "read") {
      const sequence = parseSequence(request);
      const events = parseEvents(await parseJsonBody(request, false));
      const result = appendThroughDoor(store, route.streamId, events, sequence, "raw");
      jsonResponse(
        response,
        201,
        { events: result.records, head: result.head, streamSeq: result.sequence },
        { "stream-seq": String(result.sequence) },
      );
      return;
    }
    if (request.method === "GET") {
      if (route.kind === "dump") {
        const records = store.dump(route.streamId);
        const body = records.map((record) => canonicalJson(record)).join("\n");
        textResponse(response, 200, body.length === 0 ? "" : `${body}\n`, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "stream-next-offset": String(store.head(route.streamId)),
        });
        return;
      }
      if (route.kind === "state") {
        handleStateRoute(
          response,
          store,
          route.streamId,
          parsedUrl.searchParams.get("offset"),
          parsedUrl.searchParams.get("cache") === "bypass",
          reduxOptions,
          store.compactionOffset(route.streamId),
        );
        return;
      }
      if (route.kind === "read" || route.kind === "events") {
        const compactionOffset = store.compactionOffset(route.streamId);
        const snapshotOffset = store.latestSnapshotOffset(route.streamId);
        if (
          compactionOffset !== undefined &&
          compareOffsets(parseOffset(parsedUrl.searchParams.get("offset")), compactionOffset) < 0
        ) {
          const headerOffset = snapshotOffset ?? compactionOffset;
          const body = canonicalJson({ error: "gone", snapshotOffset: headerOffset });
          response.writeHead(410, {
            "content-type": "application/json; charset=utf-8",
            "content-length": String(Buffer.byteLength(body)),
            [STREAM_SNAPSHOT_OFFSET_HEADER]: String(headerOffset),
          });
          response.end(body);
          return;
        }
        const exclusive = parsedUrl.searchParams.get("exclusive") === "1";
        const inclusive =
          parsedUrl.searchParams.get("inclusive") === "1" ||
          (compactionOffset !== undefined && !exclusive);
        handleEventsRoute(
          request,
          response,
          store,
          route.streamId,
          parseOffset(parsedUrl.searchParams.get("offset")),
          parsedUrl.searchParams.get("live"),
          liveOptions,
          inclusive,
        );
        return;
      }
      throw new InvalidRequestError("GET route is not supported");
    }
    response.setHeader(
      "allow",
      route.kind === "read"
        ? "GET, POST, PUT"
        : route.kind === "dispatch" || route.kind === "compact"
          ? "POST"
          : "GET",
    );
    errorResponse(response, 405, "method_not_allowed", "method is not supported for this route");
  } catch (error) {
    if (error instanceof DispatchRejectionError) {
      jsonResponse(response, error.status, { error: error.detail });
      return;
    }
    if (handleStoreError(response, error)) return;
    if (error instanceof NoSnapshotError) {
      jsonResponse(response, 409, { error: "no_snapshot", message: error.message });
      return;
    }
    if (error instanceof InvalidSnapshotError) {
      jsonResponse(response, 409, {
        error: "invalid_snapshot",
        message: error.message,
        snapshotOffset: error.snapshotOffset,
      });
      return;
    }
    if (error instanceof InvalidRequestError) {
      errorResponse(response, 400, "invalid_request", error.message);
      return;
    }
    if (error instanceof Error && error.name === "CanonicalJsonError") {
      errorResponse(response, 400, "invalid_json_value", error.message);
      return;
    }
    errorResponse(response, 500, "internal_error", "unexpected server error");
  }
}

export function createHttpServer(
  store: StreamStore = new MemoryStreamStore(),
  options: HttpServerOptions = {},
): Server {
  const liveOptions: Required<LiveReadOptions> = {
    longPollTimeoutMs: options.longPollTimeoutMs ?? DEFAULT_LIVE_OPTIONS.longPollTimeoutMs,
    sseHeartbeatMs: options.sseHeartbeatMs ?? DEFAULT_LIVE_OPTIONS.sseHeartbeatMs,
  };
  const reduxOptions: StateRouteOptions = {
    registry: options.reducerRegistry ?? new ReducerRegistry(),
    cache: options.stateCache ?? new StateCache(),
    actionValidators: options.actionValidators ?? createDefaultActionValidatorRegistry(),
  };
  return createNodeServer((request, response) => {
    void handleRequest(request, response, store, liveOptions, reduxOptions);
  });
}
