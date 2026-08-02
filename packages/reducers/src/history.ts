import { OFFSET_BEFORE_FIRST, stateDigest, type Event, type Offset } from "@eforest/protocol";

export interface HistoryApplicationRecord extends Event {
  readonly offset: Offset;
  readonly sourceStreamId: string;
  readonly actor: string;
}

export interface HistoryState {
  readonly records: readonly HistoryApplicationRecord[];
}

export const historyInitialState: HistoryState = Object.freeze({ records: [] });

function historyRecord(event: Event): HistoryApplicationRecord {
  const record = event as Event & {
    readonly offset?: unknown;
    readonly sourceStreamId?: unknown;
    readonly actor?: unknown;
  };
  return {
    offset: typeof record.offset === "string" ? (record.offset as Offset) : OFFSET_BEFORE_FIRST,
    type: record.type,
    payload: record.payload,
    ts: record.ts,
    sourceStreamId:
      typeof record.sourceStreamId === "string" ? record.sourceStreamId : "unknown-stream",
    actor: typeof record.actor === "string" ? record.actor : "unknown-actor",
  };
}

export const historyReducer = (state: HistoryState, event: Event): HistoryState => ({
  records: [...state.records, historyRecord(event)],
});

export const historyStateDigest = (state: unknown): string => stateDigest(state);
