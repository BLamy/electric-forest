import type { Event, Offset } from "@eforest/protocol";
import {
  OFFSET_BEFORE_FIRST,
  attachmentInitialStateForStream,
  attachmentReducer,
  contentInitialStateForStream,
  contentReducer,
  isEvidenceContentStreamId,
  isEvidenceStreamId,
  validateEvidenceAction,
  type AttachmentListState,
  type ContentState,
  type EvidenceClient,
  type EvidenceResolvedStream,
} from "../src/index.js";

export function offset(ordinal: number): Offset {
  return `0000000000000000_${String(ordinal).padStart(16, "0")}` as Offset;
}

export function event<T extends string, P>(type: T, payload: P, ts = 1): Event {
  return { type, payload, ts };
}

type EvidenceState = AttachmentListState | ContentState;

export class InMemoryEvidenceDoor implements EvidenceClient {
  private readonly records = new Map<string, Event[]>();
  private readonly states = new Map<string, EvidenceState>();
  private clock = 100;
  private id = 0;

  readonly now = (): number => {
    this.clock += 1;
    return this.clock;
  };

  readonly createAttachmentId = (): string => {
    this.id += 1;
    return `attachment-${this.id}`;
  };

  seedEntity(streamId: string): void {
    this.records.set(streamId, [event("entity.exists", { v: 1 })]);
  }

  async read(streamId: string): Promise<readonly Event[]> {
    return [...(this.records.get(streamId) ?? [])];
  }

  async resolveStream(streamId: string): Promise<EvidenceResolvedStream | undefined> {
    const records = this.records.get(streamId);
    if (records === undefined) return undefined;
    const state = this.states.get(streamId);
    return { records, ...(state === undefined ? {} : { state }) };
  }

  state(streamId: string): EvidenceState | undefined {
    return this.states.get(streamId);
  }

  async dispatch(streamId: string, action: Event): Promise<void> {
    const records = this.records.get(streamId) ?? [];
    const state =
      this.states.get(streamId) ??
      (isEvidenceStreamId(streamId)
        ? attachmentInitialStateForStream(streamId)
        : isEvidenceContentStreamId(streamId)
          ? contentInitialStateForStream(streamId)
          : undefined);
    if (state === undefined) throw new TypeError(`unsupported stream ${streamId}`);
    const headOffset = records.length === 0 ? OFFSET_BEFORE_FIRST : offset(records.length - 1);
    const nextOffset = offset(records.length);
    await validateEvidenceAction(action, {
      streamId,
      state,
      headOffset,
      nextOffset,
      records,
      resolveStream: (target) => this.resolveStream(target),
    });
    const record = { ...action, offset: nextOffset };
    records.push(record);
    this.records.set(streamId, records);
    this.states.set(
      streamId,
      isEvidenceStreamId(streamId)
        ? attachmentReducer(state as AttachmentListState, record)
        : contentReducer(state as ContentState, record),
    );
  }
}
