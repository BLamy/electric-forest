import { compareOffsets, isSnapshotEvent, type Event, type Offset } from "@eforest/protocol";

export interface StreamRecord extends Event {
  readonly offset: Offset;
}

export interface CreateStreamResult {
  readonly created: boolean;
  readonly head: Offset;
  readonly sequence: number;
}

export interface AppendStreamResult {
  readonly records: readonly StreamRecord[];
  readonly head: Offset;
  readonly sequence: number;
}

export interface CompactStreamResult {
  readonly snapshotOffset: Offset;
  readonly head: Offset;
}

export type AppendListener = (result: AppendStreamResult) => void;

export interface StreamStore {
  create(streamId: string, config: unknown): CreateStreamResult;
  append(streamId: string, events: readonly Event[], sequence: number): AppendStreamResult;
  subscribe(streamId: string, listener: AppendListener): () => void;
  getConfig(streamId: string): unknown;
  read(streamId: string, after: Offset, inclusive?: boolean): readonly StreamRecord[];
  dump(streamId: string): readonly StreamRecord[];
  head(streamId: string): Offset;
  sequence(streamId: string): number;
  compact(streamId: string): CompactStreamResult;
  latestSnapshotOffset(streamId: string): Offset | undefined;
  compactionOffset(streamId: string): Offset | undefined;
}

export function latestSnapshotOffset(records: readonly StreamRecord[]): Offset | undefined {
  let latest: Offset | undefined;
  for (const record of records) {
    const event = { type: record.type, payload: record.payload, ts: record.ts };
    if (isSnapshotEvent(event)) {
      if (latest === undefined || compareOffsets(record.offset, latest) > 0) {
        latest = event.payload.snapshotOffset;
      }
    }
  }
  return latest;
}

export function snapshotRetentionStart(
  records: readonly StreamRecord[],
  snapshotOffset: Offset,
): number {
  const index = records.findIndex((record) => compareOffsets(record.offset, snapshotOffset) >= 0);
  if (index < 0) throw new InvalidSnapshotError(snapshotOffset);
  return index;
}

export class StreamNotFoundError extends Error {
  constructor(streamId: string) {
    super(`stream ${streamId} does not exist`);
    this.name = "StreamNotFoundError";
  }
}

export class StreamConfigConflictError extends Error {
  constructor(streamId: string) {
    super(`stream ${streamId} already exists with a different configuration`);
    this.name = "StreamConfigConflictError";
  }
}

export class StreamSequenceConflictError extends Error {
  readonly currentSequence: number;

  constructor(currentSequence: number) {
    super(`stream sequence ${currentSequence} is current`);
    this.name = "StreamSequenceConflictError";
    this.currentSequence = currentSequence;
  }
}

export class InvalidEventError extends Error {
  constructor(index: number) {
    super(`event ${index} is not a valid protocol envelope`);
    this.name = "InvalidEventError";
  }
}

export class NoSnapshotError extends Error {
  constructor(streamId: string) {
    super(`stream ${streamId} has no snapshot event`);
    this.name = "NoSnapshotError";
  }
}

export class InvalidSnapshotError extends Error {
  readonly snapshotOffset: Offset;

  constructor(snapshotOffset: Offset) {
    super(`snapshot offset ${snapshotOffset} is not present in the stream`);
    this.name = "InvalidSnapshotError";
    this.snapshotOffset = snapshotOffset;
  }
}
