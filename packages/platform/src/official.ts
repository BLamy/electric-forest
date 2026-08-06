import {
  appendDurableJson,
  checkpoint,
  createDurableJsonStream,
  forkDurableJsonStream,
  followDurableJson,
  headDurableJsonStream,
  isDurableNotFound,
  readDurableJson,
  StreamReader,
  type FollowDurableJsonOptions,
  type StreamBatch,
  type StreamCheckpoint,
} from "@eforest/client";
import { OFFSET_BEFORE_FIRST, type Event, type Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { readStreamDumpWithTransportOffsets } from "@eforest/streamfs";

export interface StreamAdapter {
  create(streamId: string): Promise<void>;
  /** Optional exact existence probe for in-memory/test adapters whose read cannot distinguish absence. */
  exists?(streamId: string): Promise<boolean>;
  append(
    streamId: string,
    event: Event,
    options?: StreamAppendOptions,
  ): Promise<void | StreamAppendResult>;
  /** Native fork plus the child-owned fork directive, behind the dispatch door. */
  fork?(
    streamId: string,
    sourceStreamId: string,
    forkOffset: Offset,
    event: Event,
    options?: StreamForkOptions,
  ): Promise<void>;
  read(streamId: string): Promise<readonly unknown[]>;
  follow(streamId: string, signal?: AbortSignal): AsyncIterable<unknown>;
  applicationBootstrap?(streamId: string): Promise<StreamBatch>;
  applicationFollow?(
    streamId: string,
    from: StreamCheckpoint,
    signal?: AbortSignal,
  ): AsyncIterable<StreamBatch>;
}

export interface StreamAppendOptions {
  readonly idempotencyKey?: string;
  readonly sequence?: string;
  /** Product-owned checkpoint persisted in the application event body. */
  readonly applicationOffset?: Offset;
}

export interface StreamForkOptions {
  readonly idempotencyKey?: string;
}

export class StreamForkValidationError extends Error {
  constructor(
    readonly reason: "fs/fork-offset-out-of-range",
    message: string,
  ) {
    super(message);
    this.name = "StreamForkValidationError";
  }
}

export class StreamForkExistsError extends Error {
  constructor() {
    super("branch stream already exists");
    this.name = "StreamForkExistsError";
  }
}

export type StreamAppendResult = "appended" | "producer-duplicate-closed";

export interface OfficialStreamAdapterOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly headers?: Readonly<Record<string, string>>;
}

function normalizedBaseUrl(value: string): string {
  const result = value.replace(/\/+$/, "");
  if (result.length === 0) throw new TypeError("baseUrl must not be empty");
  return result;
}

export class OfficialStreamAdapter implements StreamAdapter {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch | undefined;
  private readonly headers: Readonly<Record<string, string>> | undefined;

  constructor(options: OfficialStreamAdapterOptions) {
    this.baseUrl = normalizedBaseUrl(options.baseUrl);
    this.fetcher = options.fetch;
    this.headers = options.headers;
  }

  async create(streamId: string): Promise<void> {
    await createDurableJsonStream(this.options(streamId));
  }

  async exists(streamId: string): Promise<boolean> {
    try {
      await this.read(streamId);
      return true;
    } catch (error) {
      if (isDurableNotFound(error)) return false;
      throw error;
    }
  }

  async append(
    streamId: string,
    event: Event,
    appendOptions?: StreamAppendOptions,
  ): Promise<StreamAppendResult> {
    const options = this.options(streamId);
    let producerDuplicateClosed = false;
    const upstream = options.fetch ?? globalThis.fetch;
    const observingFetch = (async (input, init) => {
      const response = await upstream(input, init);
      producerDuplicateClosed =
        response.status === 204 && response.headers.get("Stream-Closed")?.toLowerCase() === "true";
      return response;
    }) as typeof fetch;
    await appendDurableJson(
      appendOptions?.idempotencyKey === undefined
        ? { ...options, fetch: observingFetch }
        : {
            ...options,
            fetch: observingFetch,
            headers: {
              ...options.headers,
              "Producer-Id": appendOptions.idempotencyKey,
              "Producer-Epoch": "0",
              "Producer-Seq": "0",
            },
          },
      appendOptions?.applicationOffset === undefined
        ? event
        : { ...event, offset: appendOptions.applicationOffset },
      appendOptions?.sequence,
    );
    return producerDuplicateClosed ? "producer-duplicate-closed" : "appended";
  }

  async fork(
    streamId: string,
    sourceStreamId: string,
    forkOffset: Offset,
    event: Event,
    options: StreamForkOptions = {},
  ): Promise<void> {
    const source = await readStreamDumpWithTransportOffsets(
      {
        baseUrl: this.baseUrl,
        metadataStreamId: sourceStreamId,
        fetcher: this.fetchWithHeaders,
      },
      sourceStreamId,
    );
    const sourceIndex = source.records.findIndex((record) => record.offset === forkOffset);
    if (sourceIndex < 0) {
      throw new StreamForkValidationError(
        "fs/fork-offset-out-of-range",
        `fork offset ${forkOffset} is not present in the parent stream`,
      );
    }
    const sourceOffset = source.transportOffsets?.[sourceIndex] ?? forkOffset;
    const target = await headDurableJsonStream(this.options(streamId));
    if (target.exists) throw new StreamForkExistsError();
    await forkDurableJsonStream({
      ...this.options(streamId),
      sourceUrl: this.options(sourceStreamId).url,
      sourceOffset,
    });
    const child = await readStreamDumpWithTransportOffsets(
      {
        baseUrl: this.baseUrl,
        metadataStreamId: streamId,
        fetcher: this.fetchWithHeaders,
      },
      streamId,
    );
    const record = {
      ...event,
      offset: nextApplicationOffset(child.records),
    } as Event & { readonly offset: Offset };
    await this.append(streamId, record, {
      sequence: record.offset,
      applicationOffset: record.offset,
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    });
  }

  async read(streamId: string): Promise<readonly unknown[]> {
    return readDurableJson(this.options(streamId));
  }

  async applicationBootstrap(streamId: string): Promise<StreamBatch> {
    const events = [];
    let current = checkpoint(OFFSET_BEFORE_FIRST);
    for await (const batch of new StreamReader({
      baseUrl: this.baseUrl,
      streamId,
      ...(this.fetcher === undefined ? {} : { fetch: this.fetcher }),
    }).read(OFFSET_BEFORE_FIRST)) {
      events.push(...batch.events);
      current = batch.checkpoint;
    }
    return { events, checkpoint: current };
  }

  async *applicationFollow(
    streamId: string,
    from: StreamCheckpoint,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamBatch> {
    if (signal?.aborted) return;
    try {
      yield* new StreamReader({
        baseUrl: this.baseUrl,
        streamId,
        ...(this.fetcher === undefined ? {} : { fetch: this.fetcher }),
      }).tail(from, { mode: "long-poll", ...(signal === undefined ? {} : { signal }) });
    } catch (error) {
      if (signal?.aborted) return;
      throw error;
    }
  }

  /**
   * The store's own deletion surface (`DELETE /streams/:id`). Server-internal
   * only — no client door routes here; E2-T08's rebuild uses it to discard a
   * surviving `__registry__` under `--force`.
   */
  async delete(streamId: string): Promise<boolean> {
    const options = this.options(streamId);
    const upstream = options.fetch ?? globalThis.fetch;
    const response = await upstream(options.url, {
      method: "DELETE",
      ...(options.headers === undefined ? {} : { headers: options.headers }),
    });
    if (response.status === 404) return false;
    if (!response.ok) {
      throw new Error(`DELETE ${streamId} failed: ${String(response.status)}`);
    }
    return true;
  }

  async *follow(streamId: string, signal?: AbortSignal): AsyncGenerator<unknown> {
    const options: FollowDurableJsonOptions = {
      ...this.options(streamId),
      live: "long-poll",
      ...(signal === undefined ? {} : { signal }),
    };
    for await (const batch of followDurableJson<unknown>(options)) yield* batch.items;
  }

  private options(streamId: string): {
    readonly url: string;
    readonly fetch?: typeof fetch;
    readonly headers?: Readonly<Record<string, string>>;
  } {
    if (streamId.length === 0) throw new TypeError("streamId must not be empty");
    return {
      url: `${this.baseUrl}/streams/${encodeURIComponent(streamId)}`,
      ...(this.fetcher === undefined ? {} : { fetch: this.fetcher }),
      ...(this.headers === undefined ? {} : { headers: this.headers }),
    };
  }

  private readonly fetchWithHeaders = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(this.headers);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    return (this.fetcher ?? fetch)(input, { ...init, headers });
  };
}

function nextApplicationOffset(records: readonly { readonly offset: Offset }[]): Offset {
  let ordinal = -1;
  for (const record of records) {
    const suffix = record.offset.slice(record.offset.lastIndexOf("_") + 1);
    const candidate = Number(suffix);
    if (Number.isSafeInteger(candidate) && candidate >= 0) ordinal = Math.max(ordinal, candidate);
  }
  return offsetForOrdinal(ordinal + 1);
}
