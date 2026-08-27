import type { Event } from "@eforest/protocol";
import type { AttachmentListState } from "@eforest/evidence";
import type { MeadowPrState } from "./reducer.js";
import {
  isMeadowPrMergeOutcomeEvent,
  isPrMergeCommandEvent,
  type MeadowPrMergeOutcomeEvent,
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
