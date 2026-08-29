import { useEffect, useMemo, useState } from "react";
import {
  compareOffsets,
  isEvent,
  OFFSET_BEFORE_FIRST,
  type Event,
  type Offset,
} from "@eforest/protocol";
import { isWellFormedOffset, nextAllocatedOffset } from "@eforest/protocol/offset-allocation";
import { requireReducer, type ReducerDefinition } from "@eforest/reducers";

export type StreamReducerStatus = "loading" | "live" | "reconnecting" | `error:${string}`;

export interface StreamReducerResult<State = unknown> {
  readonly state: State;
  readonly checkpoint: Offset;
  readonly digest: string;
  readonly status: StreamReducerStatus;
  readonly records: readonly ApplicationRecord[];
}

export interface UseStreamReducerOptions {
  readonly apiPath: string;
  readonly streamId: string;
  readonly reducerId: string;
  readonly followWaitMs?: number;
  readonly reconnectDelayMs?: number;
  readonly fetch?: typeof fetch;
  /** Optional per-stream state cache used when a route switches away and back. */
  readonly cache?: Map<string, StreamReducerResult<unknown>>;
  readonly cacheKey?: string;
}

export interface ApplicationRecord extends Event {
  readonly offset: Offset;
  readonly sourceStreamId?: string;
  readonly actor?: string;
}

interface ProjectionResponse {
  readonly events: readonly ApplicationRecord[];
  readonly checkpoint: Offset;
  readonly reducer: { readonly id: string; readonly version: number };
}

export class StreamReducerFailure extends Error {
  readonly offset: string;

  constructor(offset: string, message: string) {
    super(`${message} at application offset ${offset}`);
    this.name = "StreamReducerFailure";
    this.offset = offset;
  }
}

function parseProjectionResponse(
  value: unknown,
  definition: ReducerDefinition,
  from: Offset,
): ProjectionResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StreamReducerFailure(from, "projection response is not an object");
  }
  const response = value as Record<string, unknown>;
  const reducer = response.reducer;
  if (
    reducer === null ||
    typeof reducer !== "object" ||
    Array.isArray(reducer) ||
    (reducer as Record<string, unknown>).id !== definition.id ||
    (reducer as Record<string, unknown>).version !== definition.version
  ) {
    throw new StreamReducerFailure(from, "projection reducer identity changed");
  }
  if (!Array.isArray(response.events)) {
    throw new StreamReducerFailure(from, "projection events are not an array");
  }
  let previous = from;
  const events = response.events.map((value): ApplicationRecord => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new StreamReducerFailure(previous, "application record is not an object");
    }
    const record = value as Record<string, unknown>;
    const offset = record.offset;
    if (
      typeof offset !== "string" ||
      !isWellFormedOffset(offset) ||
      offset === OFFSET_BEFORE_FIRST
    ) {
      throw new StreamReducerFailure(String(offset ?? previous), "invalid application offset");
    }
    if (compareOffsets(offset, previous) <= 0) {
      throw new StreamReducerFailure(offset, "duplicate or out-of-order application event");
    }
    let expected: Offset;
    try {
      expected = nextAllocatedOffset(previous);
    } catch {
      throw new StreamReducerFailure(previous, "invalid prior application checkpoint");
    }
    if (offset !== expected) {
      throw new StreamReducerFailure(
        expected,
        `missing application event before observed offset ${offset}`,
      );
    }
    const event = { type: record.type, payload: record.payload, ts: record.ts };
    if (!isEvent(event)) {
      throw new StreamReducerFailure(offset, "malformed application event");
    }
    if (record.sourceStreamId !== undefined && typeof record.sourceStreamId !== "string") {
      throw new StreamReducerFailure(offset, "invalid source stream id");
    }
    if (record.actor !== undefined && typeof record.actor !== "string") {
      throw new StreamReducerFailure(offset, "invalid actor metadata");
    }
    previous = offset;
    return {
      offset,
      ...(record.sourceStreamId === undefined ? {} : { sourceStreamId: record.sourceStreamId }),
      ...(record.actor === undefined ? {} : { actor: record.actor }),
      ...event,
    };
  });
  if (typeof response.checkpoint !== "string" || !isWellFormedOffset(response.checkpoint)) {
    throw new StreamReducerFailure(previous, "invalid projection checkpoint");
  }
  const expected = events.at(-1)?.offset ?? from;
  if (response.checkpoint !== expected) {
    throw new StreamReducerFailure(
      response.checkpoint,
      "projection checkpoint does not match final event",
    );
  }
  return {
    events,
    checkpoint: response.checkpoint,
    reducer: { id: definition.id, version: definition.version },
  };
}

export function projectionUrl(
  apiPath: string,
  reducerId: string,
  checkpoint?: Offset,
  waitMs?: number,
): string {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  const url = new URL(apiPath, origin);
  url.searchParams.set("projection", "1");
  url.searchParams.set("reducer", reducerId);
  if (checkpoint !== undefined) {
    url.searchParams.set("live", "1");
    url.searchParams.set("checkpoint", checkpoint);
    url.searchParams.set("waitMs", String(waitMs ?? 10_000));
  }
  return `${url.pathname}${url.search}`;
}

export function applyProjectionBatch(
  definition: ReducerDefinition,
  current: StreamReducerResult,
  response: unknown,
): StreamReducerResult {
  const batch = parseProjectionResponse(response, definition, current.checkpoint);
  let state = current.state;
  for (const record of batch.events) {
    try {
      state = definition.reduce(state, record);
    } catch (error) {
      throw new StreamReducerFailure(
        record.offset,
        `reducer rejected event: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    state,
    checkpoint: batch.checkpoint,
    digest: definition.digest(state),
    status: "live",
    records: [...current.records, ...batch.events],
  };
}

function initialReducerState(definition: ReducerDefinition, streamId: string): unknown {
  return definition.initialStateForStream?.(streamId) ?? definition.initialState;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export interface StreamReducerRunOptions extends UseStreamReducerOptions {
  readonly signal: AbortSignal;
  readonly onUpdate: (result: StreamReducerResult) => void;
  readonly initialResult?: StreamReducerResult;
}

/**
 * Owns one bootstrap followed by checkpointed long-polls. Transport failures
 * retry from the last applied application checkpoint; semantic failures are
 * terminal so malformed events can never be silently skipped.
 */
export async function runStreamReducer(options: StreamReducerRunOptions): Promise<void> {
  const definition = requireReducer(options.reducerId, options.streamId);
  const fetcher = options.fetch ?? fetch;
  const initialState = initialReducerState(definition, options.streamId);
  let current: StreamReducerResult = options.initialResult ?? {
    state: initialState,
    checkpoint: OFFSET_BEFORE_FIRST,
    digest: definition.digest(initialState),
    status: "loading",
    records: [],
  };
  options.onUpdate(current);

  const request = async (url: string): Promise<unknown> => {
    const response = await fetcher(url, {
      credentials: "same-origin",
      signal: options.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new StreamReducerFailure(
        current.checkpoint,
        `projection request failed ${String(response.status)} ${body}`,
      );
    }
    return response.json();
  };

  if (current.checkpoint === OFFSET_BEFORE_FIRST) {
    current = applyProjectionBatch(
      definition,
      current,
      await request(projectionUrl(options.apiPath, definition.id)),
    );
    options.onUpdate(current);
  } else {
    // A retained stream state is already reduced through its checkpoint. Let
    // the ordinary retry loop perform the first checkpointed follow so a
    // transient reconnect is recoverable just like every later follow.
    current = { ...current, status: "live" };
    options.onUpdate(current);
  }

  while (!options.signal.aborted) {
    try {
      current = applyProjectionBatch(
        definition,
        current,
        await request(
          projectionUrl(options.apiPath, definition.id, current.checkpoint, options.followWaitMs),
        ),
      );
      options.onUpdate(current);
    } catch (error) {
      if (options.signal.aborted) return;
      if (error instanceof StreamReducerFailure) throw error;
      current = { ...current, status: "reconnecting" };
      options.onUpdate(current);
      await delay(options.reconnectDelayMs ?? 100, options.signal);
    }
  }
}

export function useStreamReducer<State = unknown>(
  options: UseStreamReducerOptions,
): StreamReducerResult<State> {
  const definition = useMemo(
    () => requireReducer(options.reducerId, options.streamId),
    [options.reducerId, options.streamId],
  );
  const cacheKey =
    options.cacheKey ?? `${options.reducerId}:${options.streamId}:${options.apiPath}`;
  const initialResult = useMemo(() => {
    const initialState = initialReducerState(definition, options.streamId);
    return (
      options.cache?.get(cacheKey) ?? {
        state: initialState,
        checkpoint: OFFSET_BEFORE_FIRST,
        digest: definition.digest(initialState),
        status: "loading" as const,
        records: [],
      }
    );
  }, [cacheKey, definition, options.cache, options.streamId]);
  const [result, setResult] = useState<StreamReducerResult>(() => initialResult);

  useEffect(() => {
    const controller = new AbortController();
    setResult(initialResult);
    void runStreamReducer({
      ...options,
      signal: controller.signal,
      initialResult,
      onUpdate: (next) => {
        options.cache?.set(cacheKey, next);
        setResult(next);
      },
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setResult((current) => ({
        ...current,
        status: `error:${error instanceof Error ? error.message : String(error)}`,
      }));
    });
    return () => controller.abort();
  }, [
    cacheKey,
    definition,
    initialResult,
    options.apiPath,
    options.cache,
    options.fetch,
    options.followWaitMs,
    options.reconnectDelayMs,
    options.streamId,
  ]);

  return result as StreamReducerResult<State>;
}
