import type { Event, Offset } from "@eforest/protocol";
import type { AttachmentListState } from "@eforest/evidence";
import { sameEntityRef, type EntityRef } from "../links/refs.js";
import type { MeadowPrState } from "./reducer.js";
import {
  isMeadowPrMergedEvent,
  isMeadowPrMergeOutcomeEvent,
  isMeadowPrOpenedEvent,
  isPrMergeCommandEvent,
  isPrLinkClosedEvent,
  isPrLinkEvent,
  isPrLinkNoopEvent,
  type MeadowPrMergeOutcomeEvent,
  type MeadowPrOpenedEvent,
  type PrLinkEvent,
} from "./events.js";

export const PR_MERGE_REFUSAL_REASONS = [
  "pr/merge-not-approved",
  "pr/already-merged",
  "pr/merge-evidence-missing",
] as const;

export type PrMergeRefusalReason = (typeof PR_MERGE_REFUSAL_REASONS)[number];

export class PrMergeSchemaError extends TypeError {
  constructor() {
    super("schema-violation");
    this.name = "PrMergeSchemaError";
  }
}

export class PrMergeRefusalError extends Error {
  constructor(readonly reason: PrMergeRefusalReason) {
    super(reason);
    this.name = "PrMergeRefusalError";
  }
}

export const PR_LINK_REFUSAL_REASONS = [
  "pr/terminal",
  "pr/link-requires-merged",
  "pr/link-ref-not-declared",
  "pr/link-provenance-mismatch",
  "pr/link-duplicate",
] as const;

export type PrLinkRefusalReason = (typeof PR_LINK_REFUSAL_REASONS)[number];

export class PrLinkSchemaError extends TypeError {
  constructor() {
    super("schema-violation");
    this.name = "PrLinkSchemaError";
  }
}

export class PrLinkRefusalError extends Error {
  constructor(readonly reason: PrLinkRefusalReason) {
    super(reason);
    this.name = "PrLinkRefusalError";
  }
}

export interface IssueCloseCitation {
  readonly prStream: string;
  readonly prMergedOffset: Offset;
}

export interface PrLinkValidationContext {
  readonly streamId: string;
  readonly state: MeadowPrState;
  readonly records: readonly Event[];
  readonly resolveIssueClose: (
    ref: EntityRef,
    issueOffset: Offset,
  ) => Promise<IssueCloseCitation | undefined>;
}

function cleanServerStamp(event: Event): Event {
  if (event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return event;
  }
  return {
    ...event,
    payload: Object.fromEntries(
      Object.entries(event.payload).filter(([key]) => key !== "actor" && key !== "writer"),
    ),
  };
}

function offsetOf(event: Event): Offset | undefined {
  const offset = (event as Event & { readonly offset?: unknown }).offset;
  return typeof offset === "string" ? (offset as Offset) : undefined;
}

function hasOwnMerge(context: PrLinkValidationContext, offset: Offset): boolean {
  return context.records.some((record) => {
    if (offsetOf(record) !== offset) return false;
    return isMeadowPrMergedEvent(cleanServerStamp(record));
  });
}

function declaredRef(state: MeadowPrState, ref: EntityRef): boolean {
  return state.closes?.some((candidate) => sameEntityRef(candidate, ref)) === true;
}

function sameProvenance(left: unknown, right: unknown): boolean {
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const a = left as {
    readonly trigger?: unknown;
    readonly openedOffset?: unknown;
    readonly prMergedOffset?: unknown;
  };
  const b = right as {
    readonly trigger?: unknown;
    readonly openedOffset?: unknown;
    readonly prMergedOffset?: unknown;
  };
  return (
    a.trigger === b.trigger &&
    a.openedOffset === b.openedOffset &&
    a.prMergedOffset === b.prMergedOffset
  );
}

function isWaiver(record: Event): boolean {
  if (
    record.type !== "evidence.waived" ||
    record.payload === null ||
    typeof record.payload !== "object" ||
    Array.isArray(record.payload)
  ) {
    return false;
  }
  const payload = record.payload as Record<string, unknown>;
  return (
    payload.v === 1 &&
    typeof payload.justification === "string" &&
    payload.justification.trim().length > 0
  );
}

export function hasMergeEvidence(state: AttachmentListState, records: readonly Event[]): boolean {
  return (
    state.attachments.some(({ detachedAtOffset }) => detachedAtOffset === undefined) ||
    records.some(isWaiver)
  );
}

export function validatePrMergeCommand(command: Event): asserts command is Event & {
  readonly type: "pr.merge";
  readonly payload: { readonly v: 1 };
} {
  if (!isPrMergeCommandEvent(command)) throw new PrMergeSchemaError();
}

export function validatePrMergeOutcome(event: Event): asserts event is MeadowPrMergeOutcomeEvent {
  if (!isMeadowPrMergeOutcomeEvent(event)) throw new PrMergeSchemaError();
}

export function validateMeadowPrOpenedEvent(event: Event): asserts event is MeadowPrOpenedEvent {
  if (!isMeadowPrOpenedEvent(event)) throw new PrLinkSchemaError();
}

export async function validatePrLinkEvent(
  event: Event,
  context: PrLinkValidationContext,
): Promise<void> {
  if (!isPrLinkEvent(event)) throw new PrLinkSchemaError();
  if (context.state.status === "closed") throw new PrLinkRefusalError("pr/terminal");
  if (!declaredRef(context.state, event.payload.ref)) {
    throw new PrLinkRefusalError("pr/link-ref-not-declared");
  }

  if (isPrLinkNoopEvent(event) && event.payload.provenance.trigger === "opened") {
    if (context.state.status === "merged") throw new PrLinkRefusalError("pr/terminal");
    if (event.payload.provenance.openedOffset !== context.state.openedAtOffset) {
      throw new PrLinkRefusalError("pr/link-provenance-mismatch");
    }
  } else {
    if (context.state.status !== "merged") {
      throw new PrLinkRefusalError("pr/link-requires-merged");
    }
    const mergedOffset = isPrLinkNoopEvent(event)
      ? event.payload.provenance.trigger === "merged"
        ? event.payload.provenance.prMergedOffset
        : undefined
      : context.state.resolvedAtOffset;
    if (
      mergedOffset === undefined ||
      mergedOffset !== context.state.resolvedAtOffset ||
      !hasOwnMerge(context, mergedOffset)
    ) {
      throw new PrLinkRefusalError("pr/link-provenance-mismatch");
    }
    if (isPrLinkClosedEvent(event)) {
      const citation = await context.resolveIssueClose(
        event.payload.ref,
        event.payload.issueOffset,
      );
      if (
        citation === undefined ||
        citation.prStream !== context.streamId ||
        citation.prMergedOffset !== mergedOffset
      ) {
        throw new PrLinkRefusalError("pr/link-provenance-mismatch");
      }
    }
  }

  const current = context.state.links?.find((link) => sameEntityRef(link.ref, event.payload.ref));
  const duplicate =
    current !== undefined &&
    (current.state === "closed" ||
      (isPrLinkNoopEvent(event) &&
        current.state === "noop" &&
        sameProvenance(current.provenance, event.payload.provenance)));
  if (duplicate) throw new PrLinkRefusalError("pr/link-duplicate");
}

/** Enforce E5-T07's additive terminal exception before the base PR validator runs. */
export async function validateMeadowPrPostTerminal(
  event: Event,
  context: PrLinkValidationContext,
): Promise<void> {
  if (context.state.status !== "merged" && context.state.status !== "closed") return;
  if (!isPrLinkEvent(event)) throw new PrLinkRefusalError("pr/terminal");
  await validatePrLinkEvent(event, context);
}

export function validatePrMergeGate(
  state: MeadowPrState,
  evidenceState: AttachmentListState,
  evidenceRecords: readonly Event[],
): void {
  if (state.status === "merged") throw new PrMergeRefusalError("pr/already-merged");
  if (state.status !== "approved") {
    throw new PrMergeRefusalError("pr/merge-not-approved");
  }
  if (!hasMergeEvidence(evidenceState, evidenceRecords)) {
    throw new PrMergeRefusalError("pr/merge-evidence-missing");
  }
}
