import { OFFSET_BEFORE_FIRST, type Event, type Offset } from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";
import {
  canonicalApprovals,
  canonicalReviews,
  canonicalThreads,
  prInitialState,
  prInitialStateForStream,
  prReducer,
  type PrReview,
  type PrState,
} from "@eforest/pr";
import {
  isMeadowPrMergeConflictedEvent,
  isMeadowPrMergedEvent,
  type MeadowPrMergeOutcomeEvent,
} from "./events.js";

export type MeadowPrStatus = PrState["status"] | "conflicted";

export interface MeadowPrState extends Omit<PrState, "status"> {
  readonly status: MeadowPrStatus;
  readonly mergeOutcome?: MeadowPrMergeOutcomeEvent["payload"];
}

export const meadowPrInitialState: MeadowPrState = Object.freeze({ ...prInitialState });

function offsetOf(event: Event): Offset | undefined {
  const offset = (event as Event & { readonly offset?: unknown }).offset;
  return typeof offset === "string" && offset !== OFFSET_BEFORE_FIRST && isWellFormedOffset(offset)
    ? offset
    : undefined;
}

/**
 * The dispatch door validates the exact client payload before append, then stamps
 * actor/writer into the persisted payload. Strip only those server-owned fields
 * for reduction; every other extra key remains a schema violation.
 */
function cleanServerStampedOutcome(event: Event): Event {
  if (
    (event.type !== "pr.merged" && event.type !== "pr.merge-conflicted") ||
    event.payload === null ||
    typeof event.payload !== "object" ||
    Array.isArray(event.payload)
  ) {
    return event;
  }
  return {
    ...event,
    payload: Object.fromEntries(
      Object.entries(event.payload).filter(([key]) => key !== "actor" && key !== "writer"),
    ),
  };
}

function asBaseState(state: MeadowPrState, status: PrState["status"]): PrState {
  const { mergeOutcome: _mergeOutcome, ...base } = state;
  return { ...base, status };
}

function preserveOutcome(state: MeadowPrState, next: PrState): MeadowPrState {
  return {
    ...next,
    ...(state.mergeOutcome === undefined ? {} : { mergeOutcome: state.mergeOutcome }),
  };
}

type ReviewVerdict = "approved" | "changes-requested";

function latestVerdicts(reviews: readonly PrReview[]): Map<string, ReviewVerdict> {
  const result = new Map<string, ReviewVerdict>();
  for (const review of reviews) {
    if (review.kind !== "comment") result.set(review.reviewer, review.kind);
  }
  return result;
}

function reduceConflictedState(state: MeadowPrState, event: Event): MeadowPrState {
  if (event.type === "pr.closed") {
    return preserveOutcome(state, prReducer(asBaseState(state, "open"), event));
  }
  if (event.type === "pr.review-comment") {
    const next = prReducer(asBaseState(state, "open"), event);
    return { ...preserveOutcome(state, next), status: "conflicted" };
  }
  if (event.type !== "pr.approved" && event.type !== "pr.changes-requested") return state;

  const payload = event.payload as { readonly reviewer?: unknown; readonly body?: unknown };
  const offset = offsetOf(event);
  if (
    offset === undefined ||
    typeof payload.reviewer !== "string" ||
    payload.reviewer.length === 0 ||
    payload.reviewer === state.author ||
    (event.type === "pr.changes-requested" && typeof payload.body !== "string")
  ) {
    return state;
  }
  const review =
    event.type === "pr.approved"
      ? ({ id: offset, kind: "approved", reviewer: payload.reviewer } as const)
      : ({
          id: offset,
          kind: "changes-requested",
          reviewer: payload.reviewer,
          body: payload.body as string,
        } as const);
  const reviews = canonicalReviews([...state.reviews, review]);
  const verdicts = latestVerdicts(reviews);
  const approvals = canonicalApprovals(
    [...verdicts].filter(([, verdict]) => verdict === "approved").map(([reviewer]) => reviewer),
  );
  const status =
    [...verdicts.values()].includes("approved") &&
    ![...verdicts.values()].includes("changes-requested")
      ? "approved"
      : "open";
  return {
    ...state,
    status,
    approvals,
    reviews,
    threads: canonicalThreads(reviews),
  };
}

export function meadowPrInitialStateForStream(streamId: string): MeadowPrState {
  return { ...prInitialStateForStream(streamId) };
}

/** Compose E5-T02's reducer and add only Meadow's two merge outcomes. */
export function meadowPrReducer(state: MeadowPrState, event: Event): MeadowPrState {
  const offset = offsetOf(event);
  const outcome = cleanServerStampedOutcome(event);
  if (isMeadowPrMergedEvent(outcome)) {
    return state.status === "approved" && offset !== undefined
      ? {
          ...state,
          status: "merged",
          resolvedAtOffset: offset,
          mergeOutcome: outcome.payload,
        }
      : state;
  }
  if (isMeadowPrMergeConflictedEvent(outcome)) {
    return state.status === "approved" && offset !== undefined
      ? {
          ...state,
          status: "conflicted",
          approvals: [],
          mergeOutcome: outcome.payload,
        }
      : state;
  }
  if (state.status === "conflicted") return reduceConflictedState(state, event);
  return preserveOutcome(state, prReducer(asBaseState(state, state.status), event));
}

export function reduceMeadowPrEvents(streamId: string, events: readonly Event[]): MeadowPrState {
  return events.reduce(meadowPrReducer, meadowPrInitialStateForStream(streamId));
}
