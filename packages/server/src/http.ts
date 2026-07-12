import {
  createServer as createNodeServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { URL } from "node:url";
import { canonicalJson, type Event } from "@eforest/protocol";
import { MemoryStreamStore } from "./store/memory.js";
import { type LiveReadOptions } from "./live.js";
import { InvalidRequestError } from "./request-errors.js";
import { errorResponse, jsonResponse, textResponse } from "./response.js";
import {
  handleEventsRoute,
  handleStateRoute,
  parseOffset,
  type StateRouteOptions,
} from "./redux/routes.js";
import { ReducerRegistry } from "./redux/registry.js";
import { StateCache } from "./redux/state-cache.js";
import {
  InvalidEventError,
  StreamConfigConflictError,
  StreamNotFoundError,
  StreamSequenceConflictError,
  type StreamStore,
} from "./store/types.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface HttpServerOptions {
  readonly longPollTimeoutMs?: number;
  readonly sseHeartbeatMs?: number;
  readonly reducerRegistry?: ReducerRegistry;
  readonly stateCache?: StateCache;
}

const DEFAULT_LIVE_OPTIONS: Required<LiveReadOptions> = {
  longPollTimeoutMs: 30_000,
  sseHeartbeatMs: 15_000,
};

const DEFAULT_REDUX_OPTIONS: StateRouteOptions = {
  registry: new ReducerRegistry(),
  cache: new StateCache(),
};

function contentType(req: IncomingMessage): string {
  const value = req.headers["content-type"];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const declaredLength = request.headers["content-length"];
    if (declaredLength && Number(declaredLength) > MAX_BODY_BYTES) {
      request.resume();
      reject(new InvalidRequestError("request body is too large"));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        request.resume();
        reject(new InvalidRequestError("request body is too large"));
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

async function parseJsonBody(request: IncomingMessage, allowEmpty: boolean): Promise<unknown> {
  const type = contentType(request).split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (type !== "" && type !== "application/json" && !type.endsWith("+json")) {
    throw new InvalidRequestError("content type must be application/json");
  }
  const raw = await readBody(request);
  if (raw.length === 0 && allowEmpty) return {};
  if (raw.length === 0) throw new InvalidRequestError("request body is empty");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new InvalidRequestError("request body is not valid JSON");
  }
}

type StreamRouteKind = "read" | "dump" | "events" | "state";

function streamIdFrom(pathname: string): { streamId: string; kind: StreamRouteKind } | undefined {
  const parts = pathname.split("/");
  if (parts.length !== 3 && parts.length !== 4) return undefined;
  if (
    parts[1] !== "streams" ||
    !parts[2] ||
    (parts.length === 4 && !["dump", "events", "state"].includes(parts[3] ?? ""))
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
    if (request.method === "POST" && route.kind === "read") {
      const sequence = parseSequence(request);
      const events = parseEvents(await parseJsonBody(request, false));
      const result = store.append(route.streamId, events, sequence);
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
        );
        return;
      }
      if (route.kind === "read" || route.kind === "events") {
        handleEventsRoute(
          request,
          response,
          store,
          route.streamId,
          parseOffset(parsedUrl.searchParams.get("offset")),
          parsedUrl.searchParams.get("live"),
          liveOptions,
        );
        return;
      }
      throw new InvalidRequestError("GET route is not supported");
    }
    response.setHeader("allow", route.kind === "read" ? "GET, POST, PUT" : "GET");
    errorResponse(response, 405, "method_not_allowed", "method is not supported for this route");
  } catch (error) {
    if (handleStoreError(response, error)) return;
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
  };
  return createNodeServer((request, response) => {
    void handleRequest(request, response, store, liveOptions, reduxOptions);
  });
}
