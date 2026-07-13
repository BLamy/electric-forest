import { canonicalJson, compareOffsets, isEvent, type Event, type Offset } from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";

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

export interface ClientResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface StreamWriterOptions {
  readonly baseUrl: string;
  readonly streamId: string;
  readonly initialSequence?: number;
  readonly batchSize?: number;
  readonly batchWindowMs?: number;
  readonly fetch?: typeof fetch;
}

export interface StreamReaderOptions {
  readonly baseUrl: string;
  readonly streamId: string;
  readonly reconnectDelayMs?: number;
  readonly fetch?: typeof fetch;
}

export interface TailOptions {
  readonly mode: "long-poll" | "sse";
  readonly signal?: AbortSignal;
}

export class StreamClientError extends Error {
  readonly response: ClientResponse;

  constructor(message: string, response: ClientResponse) {
    super(message);
    this.name = "StreamClientError";
    this.response = response;
  }
}

export class StreamSeqConflictError extends StreamClientError {
  readonly streamId: string;
  readonly sentSequence: number;
  readonly sentSeq: number;
  readonly serverResponse: ClientResponse;

  constructor(streamId: string, sentSequence: number, response: ClientResponse) {
    super(`stream ${streamId} rejected Stream-Seq ${sentSequence}; the writer is fenced`, response);
    this.name = "StreamSeqConflictError";
    this.streamId = streamId;
    this.sentSequence = sentSequence;
    this.sentSeq = sentSequence;
    this.serverResponse = response;
  }
}

interface PendingAppend {
  readonly event: Event;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface ParsedResponse {
  readonly response: ClientResponse;
  readonly raw: Response;
}

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_BATCH_WINDOW_MS = 10;
const DEFAULT_RECONNECT_DELAY_MS = 10;

function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.length === 0) throw new TypeError("baseUrl must not be empty");
  return normalized;
}

function streamPath(baseUrl: string, streamId: string): string {
  return `${baseUrl}/streams/${encodeURIComponent(streamId)}`;
}

function normalizeCheckpoint(value: StreamCheckpoint | Offset): StreamCheckpoint {
  if (typeof value === "string") {
    if (!isWellFormedOffset(value)) throw new TypeError("checkpoint offset is malformed");
    return { offset: value };
  }
  if (value === null || typeof value !== "object" || typeof value.offset !== "string") {
    throw new TypeError("checkpoint must contain an offset string");
  }
  if (!isWellFormedOffset(value.offset)) throw new TypeError("checkpoint offset is malformed");
  return { offset: value.offset as Offset };
}

export function checkpoint(offset: Offset): StreamCheckpoint {
  return normalizeCheckpoint(offset);
}

function headersToRecord(headers: Headers): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

async function parseResponse(response: Response): Promise<ParsedResponse> {
  const body = await response.text();
  return {
    raw: response,
    response: { status: response.status, headers: headersToRecord(response.headers), body },
  };
}

function responseMessage(response: ClientResponse): string {
  if (response.body.length === 0) return `HTTP ${response.status}`;
  return `HTTP ${response.status}: ${response.body}`;
}

function assertPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function assertNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function parseRecords(value: unknown): readonly StreamRecord[] {
  if (!Array.isArray(value)) throw new Error("server response did not contain an event array");
  return value.map((record, index) => {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`server response record ${index} is not an object`);
    }
    const candidate = record as Record<string, unknown>;
    if (typeof candidate.offset !== "string") {
      throw new Error(`server response record ${index} has no offset`);
    }
    const event = {
      type: candidate.type,
      payload: candidate.payload,
      ts: candidate.ts,
    };
    if (!isEvent(event)) throw new Error(`server response record ${index} is not an event`);
    return { offset: candidate.offset as Offset, ...event };
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("server response was not valid JSON");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class StreamWriter {
  private readonly baseUrl: string;
  private readonly streamId: string;
  private readonly batchSize: number;
  private readonly batchWindowMs: number;
  private readonly fetcher: typeof fetch;
  private nextSequence: number;
  private pending: PendingAppend[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private drainPromise: Promise<void> | undefined;
  private stopped: unknown;

  constructor(options: StreamWriterOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    if (options.streamId.length === 0) throw new TypeError("streamId must not be empty");
    this.streamId = options.streamId;
    this.batchSize = assertPositiveInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, "batchSize");
    this.batchWindowMs = assertNonNegativeInteger(
      options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS,
      "batchWindowMs",
    );
    this.nextSequence = assertNonNegativeInteger(options.initialSequence ?? 0, "initialSequence");
    this.fetcher = options.fetch ?? fetch;
  }

  append(event: Event): Promise<void> {
    if (this.stopped !== undefined) return Promise.reject(this.stopped);
    if (!isEvent(event)) return Promise.reject(new TypeError("append requires a valid event"));
    let snapshot: Event;
    try {
      snapshot = parseJson(canonicalJson(event)) as Event;
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ event: snapshot, resolve, reject });
      if (this.pending.length >= this.batchSize) {
        this.scheduleDrain(0);
      } else if (this.timer === undefined) {
        this.scheduleDrain(this.batchWindowMs);
      }
    });
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0 && this.drainPromise === undefined) return;
    await this.ensureDrain();
  }

  private scheduleDrain(milliseconds: number): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.ensureDrain().catch(() => undefined);
    }, milliseconds);
  }

  private ensureDrain(): Promise<void> {
    if (this.drainPromise === undefined) {
      this.drainPromise = this.drain().finally(() => {
        this.drainPromise = undefined;
      });
    }
    return this.drainPromise;
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0, this.batchSize);
      const sequence = this.nextSequence;
      try {
        await this.send(
          batch.map((item) => item.event),
          sequence,
        );
        this.nextSequence = sequence + 1;
        for (const item of batch) item.resolve();
      } catch (error) {
        for (const item of batch) item.reject(error);
        this.stop(error);
        throw error;
      }
    }
  }

  private stop(error: unknown): void {
    if (this.stopped !== undefined) return;
    this.stopped = error;
    const pending = this.pending.splice(0);
    for (const item of pending) item.reject(error);
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private async send(events: readonly Event[], sequence: number): Promise<void> {
    const raw = await this.fetcher(streamPath(this.baseUrl, this.streamId), {
      method: "POST",
      headers: { "content-type": "application/json", "stream-seq": String(sequence) },
      body: JSON.stringify({ events }),
    });
    const parsed = await parseResponse(raw);
    if (parsed.raw.status === 409) {
      throw new StreamSeqConflictError(this.streamId, sequence, parsed.response);
    }
    if (parsed.raw.status !== 201) {
      throw new StreamClientError(responseMessage(parsed.response), parsed.response);
    }
    const payload = parseJson(parsed.response.body);
    if (
      payload === null ||
      typeof payload !== "object" ||
      !Array.isArray((payload as { events?: unknown }).events) ||
      (payload as { streamSeq?: unknown }).streamSeq !== sequence ||
      parsed.response.headers["stream-seq"] !== String(sequence)
    ) {
      throw new StreamClientError(
        "server returned an invalid append acknowledgment",
        parsed.response,
      );
    }
  }
}

interface SseFrame {
  readonly id: Offset;
  readonly records: readonly StreamRecord[];
}

class SseTransportError extends Error {
  constructor(cause: unknown) {
    super("SSE transport closed unexpectedly", { cause });
    this.name = "SseTransportError";
  }
}

async function* readSseFrames(response: Response): AsyncGenerator<SseFrame> {
  if (!response.body) throw new Error("SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let id: Offset | undefined;
  let data: string[] = [];

  const emit = (): SseFrame | undefined => {
    if (data.length === 0) {
      id = undefined;
      return undefined;
    }
    const records = parseRecords(parseJson(data.join("\n")));
    if (id === undefined) throw new Error("SSE frame is missing its id checkpoint");
    const frame = { id, records } satisfies SseFrame;
    id = undefined;
    data = [];
    return frame;
  };

  const processLine = (line: string): SseFrame | undefined => {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (normalized === "") return emit();
    if (normalized.startsWith(":")) return undefined;
    const separator = normalized.indexOf(":");
    const field = separator < 0 ? normalized : normalized.slice(0, separator);
    const value = separator < 0 ? "" : normalized.slice(separator + 1).replace(/^ /, "");
    if (field === "id" && value.length > 0) id = value as Offset;
    if (field === "data") data.push(value);
    return undefined;
  };

  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw new SseTransportError(error);
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const frame = processLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (frame !== undefined) yield frame;
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const frame = processLine(buffer);
      if (frame !== undefined) yield frame;
    }
    const final = emit();
    if (final !== undefined) yield final;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export class StreamReader {
  private readonly baseUrl: string;
  private readonly streamId: string;
  private readonly reconnectDelayMs: number;
  private readonly fetcher: typeof fetch;

  constructor(options: StreamReaderOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    if (options.streamId.length === 0) throw new TypeError("streamId must not be empty");
    this.streamId = options.streamId;
    this.reconnectDelayMs = assertNonNegativeInteger(
      options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
      "reconnectDelayMs",
    );
    this.fetcher = options.fetch ?? fetch;
  }

  async *read(from: StreamCheckpoint | Offset): AsyncGenerator<StreamBatch> {
    const start = normalizeCheckpoint(from);
    const response = await this.fetcher(this.readUrl(start.offset));
    const parsed = await parseResponse(response);
    if (!parsed.raw.ok)
      throw new StreamClientError(responseMessage(parsed.response), parsed.response);
    const events = parseRecords(parseJson(parsed.response.body));
    if (events.length === 0) return;
    yield { events, checkpoint: checkpoint(events.at(-1)!.offset) };
  }

  async *tail(from: StreamCheckpoint | Offset, options: TailOptions): AsyncGenerator<StreamBatch> {
    let offset = normalizeCheckpoint(from).offset;
    if (options.mode !== "long-poll" && options.mode !== "sse") {
      throw new TypeError("tail mode must be long-poll or sse");
    }

    if (options.mode === "long-poll") {
      for (;;) {
        if (options.signal?.aborted) return;
        let response: Response;
        try {
          const init: RequestInit = {};
          if (options.signal !== undefined) init.signal = options.signal;
          response = await this.fetcher(this.liveUrl(offset, "long-poll"), init);
        } catch {
          if (options.signal?.aborted) return;
          await delay(this.reconnectDelayMs);
          continue;
        }
        const parsed = await parseResponse(response);
        if (parsed.raw.status === 204) {
          await delay(this.reconnectDelayMs);
          continue;
        }
        if (!parsed.raw.ok) {
          throw new StreamClientError(responseMessage(parsed.response), parsed.response);
        }
        const events = parseRecords(parseJson(parsed.response.body));
        if (events.length === 0) {
          await delay(this.reconnectDelayMs);
          continue;
        }
        const batch = { events, checkpoint: checkpoint(events.at(-1)!.offset) };
        yield batch;
        offset = batch.checkpoint.offset;
      }
    }

    for (;;) {
      if (options.signal?.aborted) return;
      const controller = new AbortController();
      const abortExternal = (): void => controller.abort();
      options.signal?.addEventListener("abort", abortExternal, { once: true });
      let response: Response;
      try {
        response = await this.fetcher(this.liveUrl(offset, "sse"), { signal: controller.signal });
      } catch {
        options.signal?.removeEventListener("abort", abortExternal);
        if (controller.signal.aborted) return;
        await delay(this.reconnectDelayMs);
        continue;
      }
      if (!response.ok) {
        const parsed = await parseResponse(response);
        controller.abort();
        throw new StreamClientError(responseMessage(parsed.response), parsed.response);
      }
      try {
        for await (const frame of readSseFrames(response)) {
          if (frame.records.length === 0) throw new Error("SSE frame has no event records");
          const lastRecordOffset = frame.records.at(-1)!.offset;
          if (frame.id !== lastRecordOffset || compareOffsets(frame.id, offset) <= 0) {
            throw new Error("SSE frame id does not match a strictly advancing batch checkpoint");
          }
          const batch = { events: frame.records, checkpoint: checkpoint(frame.id) };
          yield batch;
          offset = batch.checkpoint.offset;
        }
      } catch (error) {
        if (error instanceof SseTransportError && !controller.signal.aborted) {
          await delay(this.reconnectDelayMs);
        } else {
          throw error;
        }
      } finally {
        controller.abort();
        options.signal?.removeEventListener("abort", abortExternal);
      }
      await delay(this.reconnectDelayMs);
    }
  }

  private readUrl(offset: Offset): string {
    return `${streamPath(this.baseUrl, this.streamId)}?offset=${encodeURIComponent(offset)}`;
  }

  private liveUrl(offset: Offset, mode: TailOptions["mode"]): string {
    return `${streamPath(this.baseUrl, this.streamId)}?offset=${encodeURIComponent(offset)}&live=${mode}`;
  }
}

// This is the external, committed inventory used by downstream one-door audits.
// Keep every public method whose call graph can reach StreamWriter.send here.
export const APPEND_SURFACE = ["StreamWriter.append", "StreamWriter.flush"] as const;
