import { OFFSET_BEFORE_FIRST, type Event, type Offset } from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";
import { isPrEvent, isPrStreamId, type PrEvent } from "./events.js";
import {
  canonicalApprovals,
  canonicalReviews,
  canonicalThreads,
  prInitialState,
  prStateIsOpened,
  type PrState,
} from "./state.js";

type Verdict = "approved" | "changes-requested";
const PR_VERDICTS = "__eforestPrVerdicts" as const;
type InternalPrState = PrState & { readonly [PR_VERDICTS]: Readonly<Record<string, Verdict>> };

function verdictsFor(state: PrState): Readonly<Record<string, Verdict>> {
  const hidden = (state as Partial<InternalPrState>)[PR_VERDICTS];
  return hidden ?? Object.fromEntries(state.approvals.map((reviewer) => [reviewer, "approved"]));
}

function withVerdicts(state: PrState, verdicts: Readonly<Record<string, Verdict>>): PrState {
  Object.defineProperty(state, PR_VERDICTS, {
    configurable: false,
    enumerable: false,
    value: Object.freeze({ ...verdicts }),
    writable: false,
  });
  return state;
}

function nextState(
  state: PrState,
  patch: Partial<PrState>,
  verdicts = verdictsFor(state),
): PrState {
  return withVerdicts({ ...state, ...patch }, verdicts);
}

function offsetOf(event: Event): Offset | undefined {
  const offset = (event as Event & { readonly offset?: unknown }).offset;
  return typeof offset === "string" && offset !== OFFSET_BEFORE_FIRST && isWellFormedOffset(offset)
    ? (offset as Offset)
    : undefined;
}

function cleanPrEvent(event: Event): PrEvent | undefined {
  if (event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return undefined;
  }
  const payload = Object.fromEntries(
    Object.entries(event.payload).filter(([key]) => key !== "actor" && key !== "writer"),
  );
  const candidate = { ...event, payload };
  return isPrEvent(candidate) ? candidate : undefined;
}

function statusFrom(verdicts: Readonly<Record<string, Verdict>>): "open" | "approved" {
  const values = Object.values(verdicts);
  return values.includes("approved") && !values.includes("changes-requested") ? "approved" : "open";
}

export function prInitialStateForStream(streamId: string): PrState {
  if (!isPrStreamId(streamId)) throw new TypeError(`invalid PR stream id: ${streamId}`);
  return withVerdicts({ ...prInitialState }, {});
}

export function prReducer(state: PrState, rawEvent: Event): PrState {
  const event = cleanPrEvent(rawEvent);
  const offset = offsetOf(rawEvent);
  if (event === undefined || offset === undefined) return state;

  if (event.type === "pr.opened") {
    if (
      prStateIsOpened(state) ||
      event.payload.sourceBranch === event.payload.targetBranch ||
      event.payload.forkOffset === OFFSET_BEFORE_FIRST ||
      !isWellFormedOffset(event.payload.forkOffset)
    ) {
      return state;
    }
    return withVerdicts(
      {
        v: 1,
        status: "open",
        sourceBranch: event.payload.sourceBranch,
        targetBranch: event.payload.targetBranch,
        forkOffset: event.payload.forkOffset,
        title: event.payload.title,
        body: event.payload.body,
        author: event.payload.author,
        approvals: [],
        reviews: [],
        threads: [],
        openedAtOffset: offset,
        resolvedAtOffset: OFFSET_BEFORE_FIRST,
      },
      {},
    );
  }

  if (!prStateIsOpened(state) || state.status === "merged" || state.status === "closed") {
    return state;
  }

  if (event.type === "pr.review-comment") {
    if (
      state.reviews.some((review) => review.id === offset) ||
      (event.payload.replyTo !== undefined &&
        !state.reviews.some((review) => review.id === event.payload.replyTo))
    ) {
      return state;
    }
    const review = {
      id: offset,
      author: event.payload.author,
      body: event.payload.body,
      ...(event.payload.path === undefined ? {} : { path: event.payload.path }),
      ...(event.payload.replyTo === undefined ? {} : { replyTo: event.payload.replyTo }),
    };
    const reviews = canonicalReviews([...state.reviews, review]);
    return nextState(state, { reviews, threads: canonicalThreads(reviews) });
  }

  if (event.type === "pr.approved" || event.type === "pr.changes-requested") {
    const reviewer = event.payload.reviewer;
    if (reviewer === state.author) return state;
    const verdict: Verdict = event.type === "pr.approved" ? "approved" : "changes-requested";
    const current = verdictsFor(state);
    if (current[reviewer] === verdict) return state;
    const verdicts: Readonly<Record<string, Verdict>> = { ...current, [reviewer]: verdict };
    const approvals = canonicalApprovals(
      Object.entries(verdicts)
        .filter(([, latest]) => latest === "approved")
        .map(([name]) => name),
    );
    return nextState(state, { approvals, status: statusFrom(verdicts) }, verdicts);
  }

  if (event.type === "pr.merged") {
    return state.status === "approved"
      ? nextState(state, { status: "merged", resolvedAtOffset: offset })
      : state;
  }

  return nextState(state, { status: "closed", resolvedAtOffset: offset });
}

export function reducePrApplicationEvent(state: unknown, event: Event): PrState {
  return prReducer(state as PrState, event);
}

export const prReducerVersion = 1 as const;
