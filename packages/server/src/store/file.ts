import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  canonicalJson,
  compareOffsets,
  isEvent,
  OFFSET_BEFORE_FIRST,
  type Event,
  type Offset,
} from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import {
  InvalidEventError,
  StreamConfigConflictError,
  StreamNotFoundError,
  StreamSequenceConflictError,
  type AppendListener,
  type AppendStreamResult,
  type CreateStreamResult,
  type StreamRecord,
  type StreamStore,
} from "./types.js";

/**
 * File format v1: a fixed header followed by [uint32 BE byte length][canonical JSON
 * payload][32-byte SHA-256 payload checksum] frames. A short final frame is truncated
 * to the last complete frame during startup; a complete frame with a bad checksum is
 * refused with FileStoreIntegrityError. Every acknowledged append has fsync'd its
 * complete frame before the HTTP layer can return 2xx.
 */
export const FILE_STORE_HEADER = "EFOREST_FILE_STORE_V1\n";
const HEADER_BYTES = Buffer.from(FILE_STORE_HEADER, "utf8");
const CHECKSUM_BYTES = 32;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

interface MemoryView {
  readonly streamId: string;
  readonly config: string;
  readonly filePath: string;
  readonly records: StreamRecord[];
  readonly listeners: Set<AppendListener>;
  sequence: number;
}

interface CreateFrame {
  readonly kind: "create";
  readonly streamId: string;
  readonly config: string;
}

interface AppendFrame {
  readonly kind: "append";
  readonly sequence: number;
  readonly events: readonly Event[];
}

type StoreFrame = CreateFrame | AppendFrame;

export class FileStoreIntegrityError extends Error {
  readonly streamId: string;
  readonly byteOffset: number;

  constructor(streamId: string, byteOffset: number, reason: string) {
    super(`file stream ${streamId} integrity error at byte ${byteOffset}: ${reason}`);
    this.name = "FileStoreIntegrityError";
    this.streamId = streamId;
    this.byteOffset = byteOffset;
  }
}

export function streamLogPath(dataDir: string, streamId: string): string {
  const encoded = Buffer.from(streamId, "utf8").toString("base64url");
  return join(resolve(dataDir), "streams", `stream-${encoded}.log`);
}

function writeFully(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
}

function checksum(payload: Buffer): Buffer {
  return createHash("sha256").update(payload).digest();
}

function encodeFrame(frame: StoreFrame): Buffer {
  const payload = Buffer.from(canonicalJson(frame), "utf8");
  if (payload.length > MAX_FRAME_BYTES) throw new Error("file store frame is too large");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(payload.length, 0);
  return Buffer.concat([length, payload, checksum(payload)]);
}

function decodeStreamId(fileName: string): string | undefined {
  if (!fileName.startsWith("stream-") || !fileName.endsWith(".log")) return undefined;
  const encoded = fileName.slice("stream-".length, -".log".length);
  try {
    return Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}

export class FileStreamStore implements StreamStore {
  readonly dataDir: string;
  private readonly streams = new Map<string, MemoryView>();

  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    const streamsDir = join(this.dataDir, "streams");
    mkdirSync(streamsDir, { recursive: true });
    for (const entry of readdirSync(streamsDir)) {
      const streamId = decodeStreamId(entry);
      if (!streamId) continue;
      const path = join(streamsDir, entry);
      if (!statSync(path).isFile()) continue;
      this.load(path, streamId);
    }
  }

  create(streamId: string, config: unknown): CreateStreamResult {
    const canonicalConfig = canonicalJson(config);
    const existing = this.streams.get(streamId);
    if (existing) {
      if (existing.config !== canonicalConfig) throw new StreamConfigConflictError(streamId);
      return { created: false, head: this.headFrom(existing), sequence: existing.sequence };
    }
    const filePath = streamLogPath(this.dataDir, streamId);
    const stream: MemoryView = {
      streamId,
      config: canonicalConfig,
      filePath,
      listeners: new Set(),
      records: [],
      sequence: -1,
    };
    const fd = openSync(filePath, "wx");
    try {
      writeFully(fd, HEADER_BYTES);
      writeFully(fd, encodeFrame({ kind: "create", streamId, config: canonicalConfig }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.streams.set(streamId, stream);
    return { created: true, head: OFFSET_BEFORE_FIRST, sequence: -1 };
  }

  append(streamId: string, events: readonly Event[], sequence: number): AppendStreamResult {
    const stream = this.require(streamId);
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new StreamSequenceConflictError(stream.sequence);
    }
    if (sequence <= stream.sequence) throw new StreamSequenceConflictError(stream.sequence);
    this.validateEvents(events);
    const appended = events.map((event, index) => ({
      offset: offsetForOrdinal(stream.records.length + index),
      type: event.type,
      payload: event.payload,
      ts: event.ts,
    }));
    const fd = openSync(stream.filePath, "a");
    try {
      writeFully(fd, encodeFrame({ kind: "append", sequence, events }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    stream.records.push(...appended);
    stream.sequence = sequence;
    const result = { records: appended, head: this.headFrom(stream), sequence };
    for (const listener of [...stream.listeners]) listener(result);
    return result;
  }

  subscribe(streamId: string, listener: AppendListener): () => void {
    const stream = this.require(streamId);
    stream.listeners.add(listener);
    return () => stream.listeners.delete(listener);
  }

  read(streamId: string, after: Offset): readonly StreamRecord[] {
    return this.require(streamId).records.filter(
      (record) => compareOffsets(record.offset, after) > 0,
    );
  }

  dump(streamId: string): readonly StreamRecord[] {
    return [...this.require(streamId).records];
  }

  head(streamId: string): Offset {
    return this.headFrom(this.require(streamId));
  }

  sequence(streamId: string): number {
    return this.require(streamId).sequence;
  }

  private load(filePath: string, expectedStreamId: string): void {
    const bytes = readFileSync(filePath);
    if (
      bytes.length < HEADER_BYTES.length ||
      !bytes.subarray(0, HEADER_BYTES.length).equals(HEADER_BYTES)
    ) {
      throw new FileStoreIntegrityError(expectedStreamId, 0, "invalid or truncated file header");
    }
    let cursor = HEADER_BYTES.length;
    let lastComplete = cursor;
    let stream: MemoryView | undefined;
    while (cursor < bytes.length) {
      if (bytes.length - cursor < 4) {
        truncateSync(filePath, lastComplete);
        break;
      }
      const payloadLength = bytes.readUInt32BE(cursor);
      if (payloadLength === 0 || payloadLength > MAX_FRAME_BYTES) {
        throw new FileStoreIntegrityError(expectedStreamId, cursor, "invalid frame length");
      }
      const frameLength = 4 + payloadLength + CHECKSUM_BYTES;
      if (bytes.length - cursor < frameLength) {
        truncateSync(filePath, lastComplete);
        break;
      }
      const payloadStart = cursor + 4;
      const payload = bytes.subarray(payloadStart, payloadStart + payloadLength);
      const storedChecksum = bytes.subarray(payloadStart + payloadLength, cursor + frameLength);
      if (!checksum(payload).equals(storedChecksum)) {
        throw new FileStoreIntegrityError(expectedStreamId, cursor, "checksum mismatch");
      }
      let frame: StoreFrame;
      try {
        const text = payload.toString("utf8");
        frame = JSON.parse(text) as StoreFrame;
        if (canonicalJson(frame) !== text) throw new Error("non-canonical frame");
      } catch (error) {
        throw new FileStoreIntegrityError(
          expectedStreamId,
          cursor,
          error instanceof Error ? error.message : "invalid frame JSON",
        );
      }
      stream = this.applyFrame(stream, frame, filePath, expectedStreamId, cursor);
      cursor += frameLength;
      lastComplete = cursor;
    }
    if (!stream)
      throw new FileStoreIntegrityError(expectedStreamId, lastComplete, "missing create frame");
    this.streams.set(expectedStreamId, stream);
  }

  private applyFrame(
    stream: MemoryView | undefined,
    frame: StoreFrame,
    filePath: string,
    expectedStreamId: string,
    byteOffset: number,
  ): MemoryView {
    if (frame.kind === "create") {
      if (stream || frame.streamId !== expectedStreamId || typeof frame.config !== "string") {
        throw new FileStoreIntegrityError(expectedStreamId, byteOffset, "invalid create frame");
      }
      return {
        streamId: expectedStreamId,
        config: frame.config,
        filePath,
        listeners: new Set(),
        records: [],
        sequence: -1,
      };
    }
    if (!stream || !Number.isSafeInteger(frame.sequence) || frame.sequence <= stream.sequence) {
      throw new FileStoreIntegrityError(expectedStreamId, byteOffset, "invalid append sequence");
    }
    this.validateEvents(frame.events, expectedStreamId, byteOffset);
    const records = frame.events.map((event, index) => ({
      offset: offsetForOrdinal(stream.records.length + index),
      type: event.type,
      payload: event.payload,
      ts: event.ts,
    }));
    stream.records.push(...records);
    stream.sequence = frame.sequence;
    return stream;
  }

  private validateEvents(events: readonly Event[], streamId?: string, byteOffset?: number): void {
    if (events.length === 0) throw new InvalidEventError(0);
    for (const [index, event] of events.entries()) {
      if (!isEvent(event)) {
        if (streamId !== undefined && byteOffset !== undefined) {
          throw new FileStoreIntegrityError(streamId, byteOffset, `invalid event ${index}`);
        }
        throw new InvalidEventError(index);
      }
      try {
        canonicalJson(event);
      } catch (error) {
        if (streamId !== undefined && byteOffset !== undefined) {
          throw new FileStoreIntegrityError(
            streamId,
            byteOffset,
            error instanceof Error ? error.message : "invalid event JSON",
          );
        }
        throw error;
      }
    }
  }

  private require(streamId: string): MemoryView {
    const stream = this.streams.get(streamId);
    if (!stream) throw new StreamNotFoundError(streamId);
    return stream;
  }

  private headFrom(stream: MemoryView): Offset {
    return stream.records.at(-1)?.offset ?? OFFSET_BEFORE_FIRST;
  }
}
