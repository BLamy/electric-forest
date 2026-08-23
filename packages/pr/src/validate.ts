import { OFFSET_BEFORE_FIRST, type Event, type Offset } from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";
import {
  isPrActionType,
  isPrEvent,
  parseBranchStreamId,
  parsePrStreamId,
  PR_ACTION_TYPES,
  type PrActionType,
} from "./events.js";
import { prStateIsOpened, type PrState } from "./state.js";

export const PR_REFUSAL_REASONS = [
  "pr/first-event-must-be-opened",
  "pr/already-opened",
  "pr/unknown-branch",
  "pr/same-branch",
  "pr/fork-offset-out-of-range",
  "pr/merge-without-approval",
  "pr/terminal",
  "pr/duplicate-verdict",
  "pr/self-review",
  "pr/reply-to-unknown-comment",
] as const;

export type PrRefusalReason = (typeof PR_REFUSAL_REASONS)[number];

export class PrSchemaError extends Error {
  constructor() {
    super("schema-violation");
    this.name = "PrSchemaError";
  }
}

export class PrUnknownActionError extends Error {
  constructor() {
    super("unknown-action-type");
    this.name = "PrUnknownActionError";
  }
}

export class PrRefusalError extends Error {
  constructor(readonly reason: PrRefusalReason) {
    super(reason);
    this.name = "PrRefusalError";
  }
}

export interface PrBranchSnapshot {
  readonly streamId: string;
  readonly offsets: readonly Offset[];
}

export interface PrActionValidationContext {
  readonly streamId: string;
  readonly state: PrState;
  readonly headOffset: Offset;
  readonly nextOffset: Offset;
  readonly records: readonly Event[];
  readonly resolveBranch: (streamId: string) => Promise<PrBranchSnapshot | undefined>;
}

export interface PrActionValidator {
  readonly actionType: PrActionType;
  readonly validate: (action: Event, context: PrActionValidationContext) => void | Promise<void>;
}

function latestVerdict(
  records: readonly Event[],
  reviewer: string,
): "pr.approved" | "pr.changes-requested" | undefined {
  let latest: "pr.approved" | "pr.changes-requested" | undefined;
  for (const event of records) {
    if (event.type !== "pr.approved" && event.type !== "pr.changes-requested") continue;
    if (
      event.payload !== null &&
      typeof event.payload === "object" &&
      !Array.isArray(event.payload) &&
      (event.payload as { readonly reviewer?: unknown }).reviewer === reviewer
    ) {
      latest = event.type;
    }
  }
  return latest;
}

export async function validatePrEvent(
  action: Event,
  context: PrActionValidationContext,
): Promise<void> {
  if (!isPrActionType(action.type)) throw new PrUnknownActionError();
  if (!isPrEvent(action)) throw new PrSchemaError();

  if (context.records.length === 0 && action.type !== "pr.opened") {
    throw new PrRefusalError("pr/first-event-must-be-opened");
  }

  if (context.state.status === "merged" || context.state.status === "closed") {
    throw new PrRefusalError("pr/terminal");
  }

  if (action.type === "pr.opened") {
    if (prStateIsOpened(context.state) || context.records.length > 0) {
      throw new PrRefusalError("pr/already-opened");
    }
    const pr = parsePrStreamId(context.streamId);
    const source = parseBranchStreamId(action.payload.sourceBranch);
    const target = parseBranchStreamId(action.payload.targetBranch);
    if (
      pr === undefined ||
      source === undefined ||
      target === undefined ||
      source.org !== pr.org ||
      source.repo !== pr.repo ||
      target.org !== pr.org ||
      target.repo !== pr.repo
    ) {
      throw new PrRefusalError("pr/unknown-branch");
    }
    if (action.payload.sourceBranch === action.payload.targetBranch) {
      throw new PrRefusalError("pr/same-branch");
    }
    const [sourceSnapshot, targetSnapshot] = await Promise.all([
      context.resolveBranch(action.payload.sourceBranch),
      context.resolveBranch(action.payload.targetBranch),
    ]);
    if (sourceSnapshot === undefined || targetSnapshot === undefined) {
      throw new PrRefusalError("pr/unknown-branch");
    }
    if (
      action.payload.forkOffset === OFFSET_BEFORE_FIRST ||
      !isWellFormedOffset(action.payload.forkOffset) ||
      !targetSnapshot.offsets.includes(action.payload.forkOffset)
    ) {
      throw new PrRefusalError("pr/fork-offset-out-of-range");
    }
    return;
  }

  if (!prStateIsOpened(context.state)) {
    throw new PrRefusalError("pr/first-event-must-be-opened");
  }

  if (action.type === "pr.review-comment") {
    if (
      action.payload.replyTo !== undefined &&
      !context.state.reviews.some((review) => review.id === action.payload.replyTo)
    ) {
      throw new PrRefusalError("pr/reply-to-unknown-comment");
    }
    return;
  }

  if (action.type === "pr.approved" || action.type === "pr.changes-requested") {
    if (action.payload.reviewer === context.state.author) {
      throw new PrRefusalError("pr/self-review");
    }
    if (latestVerdict(context.records, action.payload.reviewer) === action.type) {
      throw new PrRefusalError("pr/duplicate-verdict");
    }
    return;
  }

  if (action.type === "pr.merged" && context.state.status !== "approved") {
    throw new PrRefusalError("pr/merge-without-approval");
  }
}

export const prActionValidators: readonly PrActionValidator[] = PR_ACTION_TYPES.map((actionType) =>
  Object.freeze({
    actionType,
    validate: async (action: Event, context: PrActionValidationContext) => {
      if (action.type !== actionType) throw new PrUnknownActionError();
      await validatePrEvent(action, context);
    },
  }),
);
