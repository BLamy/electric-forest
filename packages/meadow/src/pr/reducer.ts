import { OFFSET_BEFORE_FIRST, type Event, type Offset } from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";
import {
  canonicalApprovals,
  canonicalReviews,
  canonicalThreads,
  prInitialState,
  prInitialStateForStream,
  prReducer,
  prStateIsOpened,
  type PrReview,
  type PrState,
} from "@eforest/pr";
import { sameEntityRef, uniqueEntityRefs, type EntityRef } from "../links/refs.js";
import {
  isMeadowPrMergeConflictedEvent,
  isMeadowPrMergedEvent,
  isMeadowPrOpenedEvent,
  isPrLinkClosedEvent,
  isPrLinkNoopEvent,
  type MeadowPrMergeOutcomeEvent,
  type PrLinkNoopProvenance,
  type PrLinkNoopReason,
} from "./events.js";

export type MeadowPrStatus = PrState["status"] | "conflicted";

export type PrLinkState = "linked" | "closed" | "noop";

export interface PrLink {
  readonly ref: EntityRef;
  readonly state: PrLinkState;
  readonly reason?: PrLinkNoopReason;
  readonly issueOffset?: Offset;
  /** Present only for noops; this is the structural dedupe key. */
  readonly provenance?: PrLinkNoopProvenance;
}

export interface MeadowPrState extends Omit<PrState, "status"> {
  readonly status: MeadowPrStatus;
  readonly mergeOutcome?: MeadowPrMergeOutcomeEvent["payload"];
  /** Absent for every legacy E5-T02 opened event, preserving its v1 digest shape. */
  readonly closes?: readonly EntityRef[];
  /** Absent when `closes` is absent; one canonical entry per first-seen ref otherwise. */
  readonly links?: readonly PrLink[];
}

export const meadowPrInitialState: MeadowPrState = Object.freeze({ ...prInitialState });

function offsetOf(event: Event): Offset | undefined {
  const offset = (event as Event & { readonly offset?: unknown }).offset;
  return typeof offset === "string" && offset !== OFFSET_BEFORE_FIRST && isWellFormedOffset(offset)
    ? offset
    : undefined;
}

/**
 * Client validators remain exact. Persisted records additionally carry only these
 * server-owned payload fields, which reducers remove before applying schema guards.
 */
function cleanServerStampedPrEvent(event: Event): Event {
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

function asBaseState(state: MeadowPrState, status: PrState["status"]): PrState {
  const { mergeOutcome: _mergeOutcome, closes: _closes, links: _links, ...base } = state;
  return { ...base, status };
}

function preserveExtensions(state: MeadowPrState, next: PrState): MeadowPrState {
  return {
    ...next,
    ...(state.mergeOutcome === undefined ? {} : { mergeOutcome: state.mergeOutcome }),
    ...(state.closes === undefined ? {} : { closes: state.closes }),
    ...(state.links === undefined ? {} : { links: state.links }),
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
    return preserveExtensions(state, prReducer(asBaseState(state, "open"), event));
  }
  if (event.type === "pr.review-comment") {
    const next = prReducer(asBaseState(state, "open"), event);
    return { ...preserveExtensions(state, next), status: "conflicted" };
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

function linkedEntries(closes: readonly EntityRef[]): readonly PrLink[] {
  return uniqueEntityRefs(closes).map((ref) => ({ ref: { ...ref }, state: "linked" as const }));
}

function sameNoopProvenance(
  left: PrLinkNoopProvenance | undefined,
  right: PrLinkNoopProvenance,
): boolean {
  return right.trigger === "opened"
    ? left?.trigger === "opened" && left.openedOffset === right.openedOffset
    : left?.trigger === "merged" && left.prMergedOffset === right.prMergedOffset;
}

function reduceOpened(state: MeadowPrState, event: Event): MeadowPrState | undefined {
  const cleaned = cleanServerStampedPrEvent(event);
  if (!isMeadowPrOpenedEvent(cleaned)) return undefined;
  if (prStateIsOpened(asBaseState(state, state.status === "conflicted" ? "open" : state.status))) {
    return state;
  }
  const { closes, ...basePayload } = cleaned.payload;
  const next = prReducer(asBaseState(state, "open"), { ...cleaned, payload: basePayload });
  if (!prStateIsOpened(next)) return state;
  if (closes === undefined) return next;
  const recordedCloses = closes.map((ref) => ({ ...ref }));
  return {
    ...next,
    closes: recordedCloses,
    links: linkedEntries(recordedCloses),
  };
}

function reduceLinkEvent(state: MeadowPrState, event: Event): MeadowPrState | undefined {
  const cleaned = cleanServerStampedPrEvent(event);
  const linkIndex = (ref: EntityRef): number =>
    state.links?.findIndex((link) => sameEntityRef(link.ref, ref)) ?? -1;
  if (isPrLinkClosedEvent(cleaned)) {
    const index = linkIndex(cleaned.payload.ref);
    if (state.status !== "merged" || index < 0 || state.links === undefined) return state;
    const current = state.links[index]!;
    if (current.state === "closed") return state;
    const next: PrLink = {
      ref: current.ref,
      state: "closed",
      issueOffset: cleaned.payload.issueOffset,
    };
    return {
      ...state,
      links: state.links.map((link, candidate) => (candidate === index ? next : link)),
    };
  }
  if (!isPrLinkNoopEvent(cleaned)) return undefined;
  const index = linkIndex(cleaned.payload.ref);
  if (index < 0 || state.links === undefined) return state;
  const provenance = cleaned.payload.provenance;
  if (
    (provenance.trigger === "opened" && (state.status === "merged" || state.status === "closed")) ||
    (provenance.trigger === "merged" && state.status !== "merged")
  ) {
    return state;
  }
  const current = state.links[index]!;
  if (current.state === "closed") return state;
  if (current.state === "noop" && sameNoopProvenance(current.provenance, provenance)) {
    return state;
  }
  const next: PrLink = {
    ref: current.ref,
    state: "noop",
    reason: cleaned.payload.reason,
    provenance: { ...provenance },
  };
  return {
    ...state,
    links: state.links.map((link, candidate) => (candidate === index ? next : link)),
  };
}

export function meadowPrInitialStateForStream(streamId: string): MeadowPrState {
  return { ...prInitialStateForStream(streamId) };
}

/** Compose E5-T02's reducer and add only Meadow's additive PR contracts. */
export function meadowPrReducer(state: MeadowPrState, event: Event): MeadowPrState {
  if (event.type === "pr.opened") return reduceOpened(state, event) ?? state;

  const reducedLink = reduceLinkEvent(state, event);
  if (reducedLink !== undefined) return reducedLink;

  const offset = offsetOf(event);
  const outcome = cleanServerStampedPrEvent(event);
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
  return preserveExtensions(state, prReducer(asBaseState(state, state.status), event));
}

export function reduceMeadowPrEvents(streamId: string, events: readonly Event[]): MeadowPrState {
  return events.reduce(meadowPrReducer, meadowPrInitialStateForStream(streamId));
}
