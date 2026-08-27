import type { Event, Offset } from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";
import type { FsMergeConflictKind } from "@eforest/streamfs";

export const PR_MERGE_EVENT_VERSION = 1 as const;

export type PrMergeKind = "fast-forward" | "three-way";

export interface PrMergeConflict {
  readonly path: string;
  readonly kind: FsMergeConflictKind;
}

/** Command accepted by the Meadow merge door. It is never persisted as an outcome. */
export interface PrMergeCommandEvent extends Event {
  readonly type: "pr.merge";
  readonly payload: {
    readonly v: typeof PR_MERGE_EVENT_VERSION;
  };
}

export interface MeadowPrMergedEvent extends Event {
  readonly type: "pr.merged";
  readonly payload: {
    readonly v: typeof PR_MERGE_EVENT_VERSION;
    readonly targetMergeOffset: Offset;
    readonly kind: PrMergeKind;
    readonly resultTreeDigest: string;
  };
}

export interface MeadowPrMergeConflictedEvent extends Event {
  readonly type: "pr.merge-conflicted";
  readonly payload: {
    readonly v: typeof PR_MERGE_EVENT_VERSION;
    readonly targetMergeOffset: Offset;
    readonly conflicts: readonly PrMergeConflict[];
  };
}

export type MeadowPrMergeOutcomeEvent = MeadowPrMergedEvent | MeadowPrMergeConflictedEvent;

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const CONFLICT_KINDS = ["edit-edit", "delete-edit", "rename-rename", "add-add"] as const;

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key === "symbol")) return false;
  const sorted = (actual as string[]).sort();
  const expected = [...keys].sort();
  return sorted.length === expected.length && sorted.every((key, index) => key === expected[index]);
}

function hasEnvelope(value: unknown): value is Event {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Partial<Event>).type === "string" &&
    typeof (value as Partial<Event>).ts === "number" &&
    Number.isFinite((value as Partial<Event>).ts)
  );
}

function isTargetMergeOffset(value: unknown): value is Offset {
  return isWellFormedOffset(value);
}

function isConflict(value: unknown): value is PrMergeConflict {
  return (
    exactObject(value, ["path", "kind"]) &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    (CONFLICT_KINDS as readonly unknown[]).includes(value.kind)
  );
}

export function isPrMergeCommandEvent(value: unknown): value is PrMergeCommandEvent {
  return (
    hasEnvelope(value) &&
    value.type === "pr.merge" &&
    exactObject(value.payload, ["v"]) &&
    value.payload.v === PR_MERGE_EVENT_VERSION
  );
}

export function isMeadowPrMergedEvent(value: unknown): value is MeadowPrMergedEvent {
  if (!hasEnvelope(value) || value.type !== "pr.merged") return false;
  const payload = value.payload;
  return (
    exactObject(payload, ["v", "targetMergeOffset", "kind", "resultTreeDigest"]) &&
    payload.v === PR_MERGE_EVENT_VERSION &&
    isTargetMergeOffset(payload.targetMergeOffset) &&
    (payload.kind === "fast-forward" || payload.kind === "three-way") &&
    typeof payload.resultTreeDigest === "string" &&
    DIGEST_PATTERN.test(payload.resultTreeDigest)
  );
}

export function isMeadowPrMergeConflictedEvent(
  value: unknown,
): value is MeadowPrMergeConflictedEvent {
  if (!hasEnvelope(value) || value.type !== "pr.merge-conflicted") return false;
  const payload = value.payload;
  return (
    exactObject(payload, ["v", "targetMergeOffset", "conflicts"]) &&
    payload.v === PR_MERGE_EVENT_VERSION &&
    isTargetMergeOffset(payload.targetMergeOffset) &&
    Array.isArray(payload.conflicts) &&
    payload.conflicts.length > 0 &&
    payload.conflicts.every(isConflict)
  );
}

export function isMeadowPrMergeOutcomeEvent(value: unknown): value is MeadowPrMergeOutcomeEvent {
  return isMeadowPrMergedEvent(value) || isMeadowPrMergeConflictedEvent(value);
}
