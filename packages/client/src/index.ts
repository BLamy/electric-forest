import { compareOffsets, isEvent, type Event, type Offset } from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";
import { followDurableJson, readDurableJson } from "./durable.js";

/**
 * Product events carry their own deterministic application offset. Durable
 * Streams read offsets remain opaque transport cursors owned by Electric.
 */
export interface StreamRecord extends Event {
  readonly offset: Offset;
}

export interface StreamCheckpoint {
  readonly offset: Offset;
}

export type Checkpoint = StreamCheckpoint;

export interface StreamBatch {
  readonly events: readonly StreamRecord[];
  readonly checkpoint: StreamCheckpoint;
}

export interface StreamReaderOptions {
  readonly baseUrl: string;
  readonly streamId: string;
  readonly fetch?: typeof fetch;
}

export interface TailOptions {
  readonly mode: "long-poll" | "sse";
  readonly signal?: AbortSignal;
}

function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.length === 0) throw new TypeError("baseUrl must not be empty");
  return normalized;
}

function streamUrl(baseUrl: string, streamId: string): string {
  return `${baseUrl}/streams/${encodeURIComponent(streamId)}`;
}

function normalizeCheckpoint(value: StreamCheckpoint | Offset): StreamCheckpoint {
  const offset = typeof value === "string" ? value : value?.offset;
  if (typeof offset !== "string" || !isWellFormedOffset(offset)) {
    throw new TypeError("checkpoint must contain a well-formed application offset");
  }
  return { offset };
}

function parseRecords(value: unknown): readonly StreamRecord[] {
  if (!Array.isArray(value)) throw new Error("Durable Streams response is not an item array");
  return value.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Durable Streams item ${index} is not an object`);
    }
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.offset !== "string" || !isWellFormedOffset(candidate.offset)) {
      throw new Error(`Durable Streams item ${index} has no application offset`);
    }
    const event = { type: candidate.type, payload: candidate.payload, ts: candidate.ts };
    if (!isEvent(event)) throw new Error(`Durable Streams item ${index} is not an event`);
    return { offset: candidate.offset, ...event };
  });
}

export function checkpoint(offset: Offset): StreamCheckpoint {
  return normalizeCheckpoint(offset);
}

/** Official-Durable-Streams-only reader for electric-forest application events. */
export class StreamReader {
  private readonly url: string;
  private readonly fetcher: typeof fetch;

  constructor(options: StreamReaderOptions) {
    const baseUrl = normalizeBaseUrl(options.baseUrl);
    if (options.streamId.length === 0) throw new TypeError("streamId must not be empty");
    this.url = streamUrl(baseUrl, options.streamId);
    this.fetcher = options.fetch ?? fetch;
  }

  async *read(from: StreamCheckpoint | Offset): AsyncGenerator<StreamBatch> {
    yield* this.readFiltered(from, false);
  }

  async *readInclusive(from: StreamCheckpoint | Offset): AsyncGenerator<StreamBatch> {
    yield* this.readFiltered(from, true);
  }

  async *tail(from: StreamCheckpoint | Offset, options: TailOptions): AsyncGenerator<StreamBatch> {
    if (options.mode !== "long-poll" && options.mode !== "sse") {
      throw new TypeError("tail mode must be long-poll or sse");
    }
    let applicationOffset = normalizeCheckpoint(from).offset;
    for await (const batch of followDurableJson<unknown>({
      url: this.url,
      fetch: this.fetcher,
      live: options.mode,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })) {
      const records = parseRecords(batch.items).filter(
        (record) => compareOffsets(record.offset, applicationOffset) > 0,
      );
      if (records.length === 0) continue;
      applicationOffset = records.at(-1)!.offset;
      yield { events: records, checkpoint: checkpoint(applicationOffset) };
    }
  }

  private async *readFiltered(
    from: StreamCheckpoint | Offset,
    inclusive: boolean,
  ): AsyncGenerator<StreamBatch> {
    const applicationOffset = normalizeCheckpoint(from).offset;
    const records = parseRecords(
      await readDurableJson<unknown>({ url: this.url, fetch: this.fetcher }),
    ).filter((record) => {
      const comparison = compareOffsets(record.offset, applicationOffset);
      return inclusive ? comparison >= 0 : comparison > 0;
    });
    if (records.length > 0) {
      yield { events: records, checkpoint: checkpoint(records.at(-1)!.offset) };
    }
  }
}

export {
  DURABLE_JSON_CONTENT_TYPE,
  appendDurableJson,
  appendDurableJsonBatch,
  closeDurableJsonStreamWithProducer,
  createDurableJsonStream,
  followDurableJson,
  forkDurableJsonStream,
  headDurableJsonStream,
  isDurableConflict,
  isDurableExistsConflict,
  isDurableNotFound,
  readDurableJson,
  readDurableJsonSnapshot,
  type DurableJsonForkOptions,
  type DurableJsonHead,
  type DurableJsonStreamOptions,
  type FollowDurableJsonOptions,
} from "./durable.js";
