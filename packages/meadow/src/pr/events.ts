import type { Event, Offset } from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";
import { isPrEvent, type PrOpenedEvent } from "@eforest/pr";
import type { FsMergeConflictKind } from "@eforest/streamfs";
import { isEntityRef, type EntityRef } from "../links/refs.js";

export const PR_MERGE_EVENT_VERSION = 1 as const;

export type PrMergeKind = "fast-forward" | "three-way";

export const PR_LINK_NOOP_REASONS = [
  "dangling-reference",
  "already-done",
  "illegal-transition",
] as const;

export type PrLinkNoopReason = (typeof PR_LINK_NOOP_REASONS)[number];

export type PrLinkNoopProvenance =
  | { readonly trigger: "opened"; readonly openedOffset: Offset }
  | { readonly trigger: "merged"; readonly prMergedOffset: Offset };

export type PrLinkNoopPayload =
  | {
      readonly v: 1;
      readonly ref: EntityRef;
      readonly reason: "dangling-reference";
      readonly provenance: Extract<PrLinkNoopProvenance, { readonly trigger: "opened" }>;
    }
  | {
      readonly v: 1;
      readonly ref: EntityRef;
      readonly reason: PrLinkNoopReason;
      readonly provenance: Extract<PrLinkNoopProvenance, { readonly trigger: "merged" }>;
    };

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

export interface MeadowPrOpenedEvent extends Omit<PrOpenedEvent, "payload"> {
  readonly payload: PrOpenedEvent["payload"] & {
    readonly closes?: readonly EntityRef[];
  };
}

export interface PrLinkClosedEvent extends Event {
  readonly type: "pr.link-closed";
  readonly payload: {
    readonly v: 1;
    readonly ref: EntityRef;
    readonly issueOffset: Offset;
  };
}

export interface PrLinkNoopEvent extends Event {
  readonly type: "pr.link-noop";
  readonly payload: PrLinkNoopPayload;
}

export type PrLinkEvent = PrLinkClosedEvent | PrLinkNoopEvent;

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

function isEventOffset(value: unknown): value is Offset {
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

function isOpenedProvenance(
  value: unknown,
): value is Extract<PrLinkNoopProvenance, { readonly trigger: "opened" }> {
  return (
    exactObject(value, ["trigger", "openedOffset"]) &&
    value.trigger === "opened" &&
    isEventOffset(value.openedOffset)
  );
}

function isMergedProvenance(
  value: unknown,
): value is Extract<PrLinkNoopProvenance, { readonly trigger: "merged" }> {
  return (
    exactObject(value, ["trigger", "prMergedOffset"]) &&
    value.trigger === "merged" &&
    isEventOffset(value.prMergedOffset)
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

export function isMeadowPrOpenedEvent(value: unknown): value is MeadowPrOpenedEvent {
  if (!hasEnvelope(value) || value.type !== "pr.opened") return false;
  const payload = value.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const candidate = payload as Record<string, unknown>;
  const hasCloses = Object.hasOwn(candidate, "closes");
  const keys = ["v", "sourceBranch", "targetBranch", "forkOffset", "title", "body", "author"];
  if (hasCloses) keys.push("closes");
  if (!exactObject(candidate, keys)) return false;
  if (hasCloses && (!Array.isArray(candidate.closes) || !candidate.closes.every(isEntityRef))) {
    return false;
  }
  const { closes: _closes, ...basePayload } = candidate;
  return isPrEvent({ ...value, payload: basePayload });
}

export function isMeadowPrMergedEvent(value: unknown): value is MeadowPrMergedEvent {
  if (!hasEnvelope(value) || value.type !== "pr.merged") return false;
  const payload = value.payload;
  return (
    exactObject(payload, ["v", "targetMergeOffset", "kind", "resultTreeDigest"]) &&
    payload.v === PR_MERGE_EVENT_VERSION &&
    isEventOffset(payload.targetMergeOffset) &&
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
    isEventOffset(payload.targetMergeOffset) &&
    Array.isArray(payload.conflicts) &&
    payload.conflicts.length > 0 &&
    payload.conflicts.every(isConflict)
  );
}

export function isMeadowPrMergeOutcomeEvent(value: unknown): value is MeadowPrMergeOutcomeEvent {
  return isMeadowPrMergedEvent(value) || isMeadowPrMergeConflictedEvent(value);
}

export function isPrLinkClosedEvent(value: unknown): value is PrLinkClosedEvent {
  if (!hasEnvelope(value) || value.type !== "pr.link-closed") return false;
  const payload = value.payload;
  return (
    exactObject(payload, ["v", "ref", "issueOffset"]) &&
    payload.v === 1 &&
    isEntityRef(payload.ref) &&
    isEventOffset(payload.issueOffset)
  );
}

export function isPrLinkNoopEvent(value: unknown): value is PrLinkNoopEvent {
  if (!hasEnvelope(value) || value.type !== "pr.link-noop") return false;
  const payload = value.payload;
  if (
    !exactObject(payload, ["v", "ref", "reason", "provenance"]) ||
    payload.v !== 1 ||
    !isEntityRef(payload.ref) ||
    !(PR_LINK_NOOP_REASONS as readonly unknown[]).includes(payload.reason)
  ) {
    return false;
  }
  return isOpenedProvenance(payload.provenance)
    ? payload.reason === "dangling-reference"
    : isMergedProvenance(payload.provenance);
}

export function isPrLinkEvent(value: unknown): value is PrLinkEvent {
  return isPrLinkClosedEvent(value) || isPrLinkNoopEvent(value);
}
