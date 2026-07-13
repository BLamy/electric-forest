import type { Event, Offset } from "./index.js";
import { isEvent } from "./envelope.js";
import { isWellFormedOffset } from "./offset-allocation.js";

export const SNAPSHOT_FORMAT_VERSION = 1 as const;
export const SNAPSHOT_EVENT_TYPE = "fs.snapshot" as const;
export const STREAM_SNAPSHOT_OFFSET_HEADER = "Stream-Snapshot-Offset" as const;

export interface SnapshotEventPayload {
  readonly snapshotOffset: Offset;
  readonly stateDigest: string;
  readonly contentRef: string;
  readonly formatVersion: typeof SNAPSHOT_FORMAT_VERSION;
}

export interface SnapshotEvent extends Event {
  readonly type: typeof SNAPSHOT_EVENT_TYPE;
  readonly payload: SnapshotEventPayload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isSnapshotEvent(value: unknown): value is SnapshotEvent {
  if (!isEvent(value) || value.type !== SNAPSHOT_EVENT_TYPE || !isRecord(value.payload)) {
    return false;
  }
  const payload = value.payload;
  const keys = Object.keys(payload).sort().join(",");
  return (
    keys === "contentRef,formatVersion,snapshotOffset,stateDigest" &&
    isWellFormedOffset(payload.snapshotOffset) &&
    typeof payload.stateDigest === "string" &&
    /^[0-9a-f]{64}$/.test(payload.stateDigest) &&
    typeof payload.contentRef === "string" &&
    payload.contentRef.length > 0 &&
    payload.formatVersion === SNAPSHOT_FORMAT_VERSION
  );
}
