import { compareOffsets, OFFSET_BEFORE_FIRST, type Offset } from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";
import { PR_EVENT_VERSION } from "./events.js";

export type PrStatus = "open" | "approved" | "merged" | "closed";

export interface PrReview {
  readonly id: Offset;
  readonly author: string;
  readonly body: string;
  readonly path?: string;
  readonly replyTo?: Offset;
}

export interface PrThread {
  readonly root: Offset;
  readonly comments: readonly PrReview[];
}

export interface PrState {
  readonly v: typeof PR_EVENT_VERSION;
  readonly status: PrStatus;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly forkOffset: Offset;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly approvals: readonly string[];
  readonly reviews: readonly PrReview[];
  readonly threads: readonly PrThread[];
  readonly openedAtOffset: Offset;
  readonly resolvedAtOffset: Offset;
}

export const prInitialState: PrState = Object.freeze({
  v: PR_EVENT_VERSION,
  status: "open",
  sourceBranch: "",
  targetBranch: "",
  forkOffset: OFFSET_BEFORE_FIRST,
  title: "",
  body: "",
  author: "",
  approvals: Object.freeze([]),
  reviews: Object.freeze([]),
  threads: Object.freeze([]),
  openedAtOffset: OFFSET_BEFORE_FIRST,
  resolvedAtOffset: OFFSET_BEFORE_FIRST,
});

export function canonicalApprovals(values: Iterable<string>): readonly string[] {
  return [...new Set(values)].sort();
}

function compareReviewOffsets(left: PrReview, right: PrReview): number {
  return compareOffsets(left.id, right.id);
}

export function canonicalReviews(values: Iterable<PrReview>): readonly PrReview[] {
  return [...values].sort(compareReviewOffsets);
}

export function canonicalThreads(values: readonly PrReview[]): readonly PrThread[] {
  const reviews = canonicalReviews(values);
  const byId = new Map(reviews.map((review) => [review.id, review]));
  const rootFor = (review: PrReview): Offset => {
    let current = review;
    const seen = new Set<Offset>();
    while (current.replyTo !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.replyTo);
      if (parent === undefined || compareOffsets(parent.id, current.id) >= 0) break;
      current = parent;
    }
    return current.id;
  };
  const grouped = new Map<Offset, PrReview[]>();
  for (const review of reviews) {
    const root = rootFor(review);
    const comments = grouped.get(root) ?? [];
    comments.push(review);
    grouped.set(root, comments);
  }
  return [...grouped]
    .filter(([root]) => isWellFormedOffset(root))
    .sort(([left], [right]) => compareOffsets(left, right))
    .map(([root, comments]) => ({ root, comments: canonicalReviews(comments) }));
}

export function prStateIsOpened(state: PrState): boolean {
  return state.openedAtOffset !== OFFSET_BEFORE_FIRST;
}
