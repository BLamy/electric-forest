import type { Event, Offset } from "@eforest/protocol";

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

export type AppendListener = (result: AppendStreamResult) => void;

export interface StreamStore {
  create(streamId: string, config: unknown): CreateStreamResult;
  append(streamId: string, events: readonly Event[], sequence: number): AppendStreamResult;
  subscribe(streamId: string, listener: AppendListener): () => void;
  read(streamId: string, after: Offset): readonly StreamRecord[];
  dump(streamId: string): readonly StreamRecord[];
  head(streamId: string): Offset;
  sequence(streamId: string): number;
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
