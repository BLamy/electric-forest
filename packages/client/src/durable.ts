import {
  DurableStream,
  DurableStreamError,
  stream,
  type HeadersRecord,
  type JsonBatch,
  type LiveMode,
  type Offset as DurableOffset,
} from "@durable-streams/client";
import { canonicalJson } from "@eforest/protocol";

export const DURABLE_JSON_CONTENT_TYPE = "application/json";

export interface DurableJsonStreamOptions {
  readonly url: string;
  readonly fetch?: typeof fetch;
  readonly headers?: HeadersRecord;
}

export interface DurableJsonHead {
  readonly exists: boolean;
  readonly offset?: DurableOffset;
}

export interface DurableJsonForkOptions extends DurableJsonStreamOptions {
  readonly sourceUrl: string;
  readonly sourceOffset?: DurableOffset;
  readonly sourceSubOffset?: number;
}

export interface FollowDurableJsonOptions extends DurableJsonStreamOptions {
  readonly offset?: DurableOffset;
  readonly live?: LiveMode;
  readonly signal?: AbortSignal;
}

function handle(options: DurableJsonStreamOptions): DurableStream {
  return new DurableStream({
    url: options.url,
    contentType: DURABLE_JSON_CONTENT_TYPE,
    batching: false,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    warnOnHttp: false,
  });
}

export async function headDurableJsonStream(
  options: DurableJsonStreamOptions,
): Promise<DurableJsonHead> {
  const result = await handle(options).head();
  if (!result.exists) return { exists: false };
  return { exists: true, ...(result.offset === undefined ? {} : { offset: result.offset }) };
}

export async function createDurableJsonStream(options: DurableJsonStreamOptions): Promise<void> {
  await DurableStream.create({
    url: options.url,
    contentType: DURABLE_JSON_CONTENT_TYPE,
    batching: false,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    warnOnHttp: false,
  });
}

export async function forkDurableJsonStream(options: DurableJsonForkOptions): Promise<void> {
  const headers: HeadersRecord = {
    ...options.headers,
    "Stream-Forked-From": new URL(options.sourceUrl).pathname,
  };
  if (options.sourceOffset !== undefined) headers["Stream-Fork-Offset"] = options.sourceOffset;
  if (options.sourceSubOffset !== undefined) {
    headers["Stream-Fork-Sub-Offset"] = String(options.sourceSubOffset);
  }
  await createDurableJsonStream({ ...options, headers });
}

export async function appendDurableJson<T>(
  options: DurableJsonStreamOptions,
  value: T,
  sequence?: string,
): Promise<void> {
  await handle(options).append(
    canonicalJson(value),
    sequence === undefined ? {} : { seq: sequence },
  );
}

export async function readDurableJson<T>(
  options: DurableJsonStreamOptions,
  offset: DurableOffset = "-1",
): Promise<readonly T[]> {
  const response = await stream<T>({
    url: options.url,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    offset,
    live: false,
    json: true,
    warnOnHttp: false,
  });
  return response.json<T>();
}

export async function* followDurableJson<T>(
  options: FollowDurableJsonOptions,
): AsyncGenerator<JsonBatch<T>> {
  const response = await stream<T>({
    url: options.url,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    offset: options.offset ?? "-1",
    live: options.live ?? "long-poll",
    json: true,
    warnOnHttp: false,
  });
  const batches: JsonBatch<T>[] = [];
  let finished = false;
  let failure: unknown;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    const current = wake;
    wake = undefined;
    current?.();
  };
  const unsubscribe = response.subscribeJson<T>((batch) => {
    batches.push(batch);
    notify();
  });
  void response.closed.then(
    () => {
      finished = true;
      notify();
    },
    (error: unknown) => {
      failure = error;
      finished = true;
      notify();
    },
  );
  try {
    while (!finished || batches.length > 0) {
      const batch = batches.shift();
      if (batch !== undefined) {
        yield batch;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    if (failure !== undefined) throw failure;
  } finally {
    unsubscribe();
  }
}

export function isDurableConflict(error: unknown): boolean {
  return error instanceof DurableStreamError && error.code === "CONFLICT_SEQ";
}

export function isDurableExistsConflict(error: unknown): boolean {
  return error instanceof DurableStreamError && error.code === "CONFLICT_EXISTS";
}

export function isDurableNotFound(error: unknown): boolean {
  return error instanceof DurableStreamError && error.code === "NOT_FOUND";
}
