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
  NoSnapshotError,
  latestSnapshotOffset,
  type AppendListener,
  type AppendStreamResult,
  type CreateStreamResult,
  type CompactStreamResult,
  type StreamRecord,
  type StreamStore,
} from "./types.js";

interface MemoryStream {
  readonly config: string;
  readonly records: StreamRecord[];
  sequence: number;
  nextOrdinal: number;
  compactionOffset?: Offset;
}

export class MemoryStreamStore implements StreamStore {
  private readonly streams = new Map<string, MemoryStream>();
  private readonly listeners = new Map<string, Set<AppendListener>>();

  create(streamId: string, config: unknown): CreateStreamResult {
    const canonicalConfig = canonicalJson(config);
    const existing = this.streams.get(streamId);
    if (existing) {
      if (existing.config !== canonicalConfig) throw new StreamConfigConflictError(streamId);
      return { created: false, head: this.headFrom(existing), sequence: existing.sequence };
    }
    const stream: MemoryStream = {
      config: canonicalConfig,
      records: [],
      sequence: -1,
      nextOrdinal: 0,
    };
    this.streams.set(streamId, stream);
    return { created: true, head: OFFSET_BEFORE_FIRST, sequence: -1 };
  }

  append(streamId: string, events: readonly Event[], sequence: number): AppendStreamResult {
    const stream = this.require(streamId);
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new StreamSequenceConflictError(stream.sequence);
    }
    if (sequence <= stream.sequence) throw new StreamSequenceConflictError(stream.sequence);
    if (events.length === 0) throw new InvalidEventError(0);

    for (const [index, event] of events.entries()) {
      if (!isEvent(event)) throw new InvalidEventError(index);
      // This validates values that a direct in-process caller could supply but JSON
      // transport would otherwise have rejected before reaching the store.
      canonicalJson(event);
    }

    const appended = events.map((event, index) => ({
      offset: offsetForOrdinal(stream.nextOrdinal + index),
      type: event.type,
      payload: event.payload,
      ts: event.ts,
    }));
    stream.records.push(...appended);
    stream.nextOrdinal += appended.length;
    stream.sequence = sequence;
    const result = { records: appended, head: this.headFrom(stream), sequence: stream.sequence };
    for (const listener of [...(this.listeners.get(streamId) ?? [])]) listener(result);
    return result;
  }

  subscribe(streamId: string, listener: AppendListener): () => void {
    this.require(streamId);
    const streamListeners = this.listeners.get(streamId) ?? new Set<AppendListener>();
    streamListeners.add(listener);
    this.listeners.set(streamId, streamListeners);
    return () => {
      streamListeners.delete(listener);
      if (streamListeners.size === 0) this.listeners.delete(streamId);
    };
  }

  read(streamId: string, after: Offset, inclusive = false): readonly StreamRecord[] {
    const stream = this.require(streamId);
    return stream.records.filter((record) =>
      inclusive
        ? compareOffsets(record.offset, after) >= 0
        : compareOffsets(record.offset, after) > 0,
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

  compact(streamId: string): CompactStreamResult {
    const stream = this.require(streamId);
    const snapshotOffset = latestSnapshotOffset(stream.records);
    if (snapshotOffset === undefined) throw new NoSnapshotError(streamId);
    stream.records.splice(
      0,
      stream.records.findIndex((record) => compareOffsets(record.offset, snapshotOffset) >= 0),
    );
    stream.compactionOffset = snapshotOffset;
    return { snapshotOffset, head: this.headFrom(stream) };
  }

  compactionOffset(streamId: string): Offset | undefined {
    return this.require(streamId).compactionOffset;
  }

  latestSnapshotOffset(streamId: string): Offset | undefined {
    return latestSnapshotOffset(this.require(streamId).records);
  }

  getConfig(streamId: string): unknown {
    return JSON.parse(this.require(streamId).config) as unknown;
  }

  private require(streamId: string): MemoryStream {
    const stream = this.streams.get(streamId);
    if (!stream) throw new StreamNotFoundError(streamId);
    return stream;
  }

  private headFrom(stream: MemoryStream): Offset {
    return stream.records.at(-1)?.offset ?? OFFSET_BEFORE_FIRST;
  }
}
