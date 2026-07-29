import type { StreamRecord } from "@eforest/client";
import { isFsThreeWayMergeEvent, type FsMergeChange } from "./events.js";

function eventOf(record: StreamRecord): {
  readonly type: string;
  readonly payload: unknown;
  readonly ts: number;
} {
  return { type: record.type, payload: record.payload, ts: record.ts };
}

export function threeWayChangesForRecord(record: StreamRecord): readonly FsMergeChange[] {
  const event = eventOf(record);
  return isFsThreeWayMergeEvent(event) ? event.payload.changes : [];
}

/**
 * Expand terminal three-way changes for byte reconstruction only. The ordinary
 * reducer and watcher deliberately keep them buffered until the terminal record.
 */
export function expandThreeWayMergeRecords(
  records: readonly StreamRecord[],
): readonly StreamRecord[] {
  const expanded: StreamRecord[] = [];
  for (const record of records) {
    for (const change of threeWayChangesForRecord(record)) {
      expanded.push({
        offset: record.offset,
        type: change.type,
        payload: change.payload,
        ts: record.ts,
      });
    }
    expanded.push(record);
  }
  return expanded;
}
