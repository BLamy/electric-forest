import {
  OFFSET_BEFORE_FIRST,
  canonicalJson,
  sha256Hex,
  type Event,
  type Offset,
} from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import {
  attachmentInitialStateForStream,
  attachmentReducer,
  isEvidenceStreamId,
  type AttachmentListState,
  type EvidenceResolvedStream,
} from "@eforest/evidence";
import {
  taskInitialStateForStream,
  taskReducer,
  validateTaskEvent,
  type TaskState,
} from "../src/index.js";

export type OffsetEvent = Event & { readonly offset: Offset };

export function event(type: string, payload: unknown, ts: number): Event {
  return { type, payload, ts };
}

export interface LogSnapshot {
  readonly headOffset: Offset;
  readonly dumpSha256: string;
}

export function canonicalDump(records: readonly Event[]): string {
  return records.length === 0
    ? ""
    : `${records.map((record) => canonicalJson(record)).join("\n")}\n`;
}

export function dumpSha256(records: readonly Event[]): string {
  return sha256Hex(new TextEncoder().encode(canonicalDump(records)));
}

/**
 * An in-memory dispatch door with the same contract as the platform writer lane: validate
 * against the replayed state, then append with the next contiguous offset. Evidence
 * streams are seeded with E5-T10 `evidence.linked` records so attachment linkage resolves.
 */
export class InMemoryTaskDoor {
  private readonly records = new Map<string, OffsetEvent[]>();
  /** Actor the door "authenticated"; undefined disables the stamped-identity binding. */
  actor: string | undefined;

  constructor(actor?: string) {
    this.actor = actor;
  }

  read(streamId: string): readonly OffsetEvent[] {
    return [...(this.records.get(streamId) ?? [])];
  }

  snapshot(streamId: string): LogSnapshot {
    const records = this.read(streamId);
    return {
      headOffset: records.at(-1)?.offset ?? OFFSET_BEFORE_FIRST,
      dumpSha256: dumpSha256(records),
    };
  }

  state(streamId: string): TaskState {
    return this.read(streamId).reduce(taskReducer, taskInitialStateForStream(streamId));
  }

  seedAttachments(evidenceStream: string, attachmentIds: readonly string[]): void {
    const records = this.records.get(evidenceStream) ?? [];
    for (const attachmentId of attachmentIds) {
      records.push({
        type: "evidence.linked",
        payload: {
          v: 1,
          attachmentId,
          kind: "replay-recording",
          url: `https://app.replay.io/recording/${attachmentId}`,
        },
        ts: 1 + records.length,
        offset: offsetForOrdinal(records.length),
      });
    }
    this.records.set(evidenceStream, records);
  }

  attachmentList(evidenceStream: string): AttachmentListState {
    return this.read(evidenceStream).reduce(
      attachmentReducer,
      attachmentInitialStateForStream(evidenceStream),
    );
  }

  async resolveStream(streamId: string): Promise<EvidenceResolvedStream | undefined> {
    const records = this.records.get(streamId);
    if (records === undefined) return undefined;
    return isEvidenceStreamId(streamId)
      ? { records, state: this.attachmentList(streamId) }
      : { records };
  }

  async dispatch(streamId: string, action: Event): Promise<Offset> {
    const records = this.records.get(streamId) ?? [];
    const nextOffset = offsetForOrdinal(records.length);
    await validateTaskEvent(action, {
      streamId,
      state: this.state(streamId),
      headOffset: records.at(-1)?.offset ?? OFFSET_BEFORE_FIRST,
      nextOffset,
      records,
      ...(this.actor === undefined ? {} : { actor: this.actor }),
      resolveStream: (target) => this.resolveStream(target),
    });
    records.push({ ...action, offset: nextOffset });
    this.records.set(streamId, records);
    return nextOffset;
  }
}

/** The dispatchable action of a frozen record: the door assigns the offset itself. */
export function withoutOffset(record: Event & { readonly offset?: Offset }): Event {
  return { type: record.type, payload: record.payload, ts: record.ts };
}
