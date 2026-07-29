import { isDurableConflict } from "@eforest/client";
import { canonicalJson, type Event } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import type { StreamAdapter } from "./official.js";

export const WRITER_LANE_VERSION = 1 as const;

export interface WriterLane {
  readonly v: typeof WRITER_LANE_VERSION;
  readonly sub: string;
  readonly seq: number;
  readonly op?: string;
}

export interface WriterScopedPayload extends Record<string, unknown> {
  readonly actor: string;
  readonly writer: WriterLane;
}

export interface WriterScopedEvent extends Event {
  readonly payload: WriterScopedPayload;
}

export type WriterLaneState = Readonly<Record<string, number>>;

export class WriterLaneRefusalError extends Error {
  readonly reason = "writer/stale-sequence" as const;

  constructor(
    readonly subject: string,
    readonly expected: number,
    readonly provided: number,
  ) {
    super("writer/stale-sequence");
    this.name = "WriterLaneRefusalError";
  }
}

export class WriterLaneCorruptionError extends Error {
  constructor(readonly index: number) {
    super(`writer/corrupt-lane at record ${String(index)}`);
    this.name = "WriterLaneCorruptionError";
  }
}

export class WriterLaneContentionError extends Error {
  constructor() {
    super("writer lane dispatch conflict persisted without head progress");
    this.name = "WriterLaneContentionError";
  }
}

function exactWriterLane(value: unknown): value is WriterLane {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const baseKeys = keys.length === 3 && keys[0] === "seq" && keys[1] === "sub" && keys[2] === "v";
  const operationKeys =
    keys.length === 4 &&
    keys[0] === "op" &&
    keys[1] === "seq" &&
    keys[2] === "sub" &&
    keys[3] === "v";
  return (
    (baseKeys || operationKeys) &&
    record.v === WRITER_LANE_VERSION &&
    typeof record.sub === "string" &&
    record.sub.length > 0 &&
    typeof record.seq === "number" &&
    Number.isSafeInteger(record.seq) &&
    record.seq >= 1 &&
    (record.op === undefined || (typeof record.op === "string" && record.op.length > 0))
  );
}

/**
 * Fold only server-stamped writer metadata. Older application records without
 * a lane predate E2-T09 and are deliberately neutral; a present-but-malformed
 * lane is corruption and fails loudly instead of silently resetting a writer.
 */
export function reduceWriterLanes(records: readonly unknown[]): WriterLaneState {
  const entries: Array<[string, number]> = [];
  for (const [index, value] of records.entries()) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const payload = (value as { readonly payload?: unknown }).payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
    if (!Object.prototype.hasOwnProperty.call(payload, "writer")) continue;
    const writer = (payload as { readonly writer?: unknown }).writer;
    if (!exactWriterLane(writer)) throw new WriterLaneCorruptionError(index);
    const actor = (payload as { readonly actor?: unknown }).actor;
    if (typeof actor !== "string" || actor.length === 0 || actor !== writer.sub) {
      throw new WriterLaneCorruptionError(index);
    }
    const entry = entries.find(([subject]) => subject === writer.sub);
    const previous = entry?.[1] ?? 0;
    if (writer.seq !== previous + 1) throw new WriterLaneCorruptionError(index);
    if (entry === undefined) entries.push([writer.sub, writer.seq]);
    else entry[1] = writer.seq;
  }
  return Object.fromEntries(entries);
}

export function stampWriterEvent(
  event: Event,
  subject: string,
  sequence: number,
  operationId?: string,
): WriterScopedEvent {
  const payload = event.payload as Record<string, unknown>;
  return {
    ...event,
    payload: {
      ...payload,
      actor: subject,
      writer: {
        v: WRITER_LANE_VERSION,
        sub: subject,
        seq: sequence,
        ...(operationId === undefined ? {} : { op: operationId }),
      },
    },
  };
}

export interface WriterDispatchOptions {
  readonly requestedSequence?: number;
  readonly operationId?: string;
  readonly assertActive?: () => Promise<void>;
  /** Re-run against every newly observed global head before an append retry. */
  readonly validate?: (
    records: readonly unknown[],
    event: WriterScopedEvent,
  ) => void | Promise<void>;
}

export interface WriterDispatchReceipt {
  readonly event: WriterScopedEvent;
  readonly globalSequence: string;
}

/**
 * Application fencing above Durable Streams' one global Stream-Seq lane.
 * Writer state is rebuilt from the stream on every attempt; the promise chain
 * narrows local races but is not authoritative state. Cross-process races are
 * decided by the official append fence and retried only after a fresh replay.
 */
export class WriterLaneDispatcher {
  private serial: Promise<unknown> = Promise.resolve();

  constructor(private readonly streams: StreamAdapter) {}

  dispatch(
    streamId: string,
    event: Event,
    subject: string,
    options: WriterDispatchOptions = {},
  ): Promise<WriterDispatchReceipt> {
    const run = this.serial.then(() => this.dispatchNow(streamId, event, subject, options));
    this.serial = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  recover(operationId: string, streamId: string, event: Event): Promise<WriterDispatchReceipt> {
    const payload = event.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return Promise.reject(new WriterLaneCorruptionError(-1));
    }
    const actor = (payload as { readonly actor?: unknown }).actor;
    if (typeof actor !== "string" || actor.length === 0) {
      return Promise.reject(new WriterLaneCorruptionError(-1));
    }
    return this.dispatch(streamId, event, actor, { operationId });
  }

  private async dispatchNow(
    streamId: string,
    event: Event,
    subject: string,
    options: WriterDispatchOptions,
  ): Promise<WriterDispatchReceipt> {
    let lastLength = -1;
    let stalledConflicts = 0;
    for (;;) {
      const records = await this.streams.read(streamId);
      // Recovery is only meaningful inside a valid replay. Validate every lane before
      // inspecting operation IDs so an exact-looking record cannot hide a gap, malformed
      // duplicate, or any other corruption later in the stream.
      const lanes = reduceWriterLanes(records);
      if (options.operationId !== undefined) {
        const existingIndexes = records.flatMap((record, index) => {
          if (record === null || typeof record !== "object" || Array.isArray(record)) return [];
          const payload = (record as { readonly payload?: unknown }).payload;
          if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return [];
          const lane = (payload as { readonly writer?: unknown }).writer;
          return exactWriterLane(lane) && lane.op === options.operationId ? [index] : [];
        });
        if (existingIndexes.length > 1) throw new WriterLaneCorruptionError(existingIndexes[1]!);
        const existingIndex = existingIndexes[0];
        if (existingIndex !== undefined) {
          const existing = records[existingIndex] as WriterScopedEvent;
          if (existing.payload.writer.sub !== subject || existing.payload.actor !== subject) {
            throw new WriterLaneCorruptionError(existingIndex);
          }
          const expected = stampWriterEvent(
            event,
            subject,
            existing.payload.writer.seq,
            options.operationId,
          );
          if (canonicalJson(existing) !== canonicalJson(expected)) {
            throw new WriterLaneCorruptionError(existingIndex);
          }
          return { event: existing, globalSequence: offsetForOrdinal(existingIndex) };
        }
      }
      const expected = (lanes[subject] ?? 0) + 1;
      const provided = options.requestedSequence ?? expected;
      if (provided !== expected) {
        throw new WriterLaneRefusalError(subject, expected, provided);
      }
      const stamped = stampWriterEvent(event, subject, expected, options.operationId);
      await options.validate?.(records, stamped);
      await options.assertActive?.();
      const globalSequence = offsetForOrdinal(records.length);
      try {
        const result = await this.streams.append(streamId, stamped, {
          sequence: globalSequence,
          ...(options.operationId === undefined ? {} : { idempotencyKey: options.operationId }),
        });
        if (result === "producer-duplicate-closed") await options.assertActive?.();
        return { event: stamped, globalSequence };
      } catch (error) {
        if (!isDurableConflict(error)) throw error;
        stalledConflicts = records.length > lastLength ? 0 : stalledConflicts + 1;
        if (stalledConflicts >= 8) throw new WriterLaneContentionError();
        lastLength = records.length;
      }
    }
  }
}
