import type { Event, Offset } from "@eforest/protocol";

export const PR_EVENT_VERSION = 1 as const;
export const PR_REVIEW_COMMENT_VERSION = 2 as const;

export const PR_ACTION_TYPES = [
  "pr.opened",
  "pr.review-comment",
  "pr.approved",
  "pr.changes-requested",
  "pr.merged",
  "pr.closed",
] as const;

export type PrActionType = (typeof PR_ACTION_TYPES)[number];

export interface PrOpenedEvent extends Event {
  readonly type: "pr.opened";
  readonly payload: {
    readonly v: typeof PR_EVENT_VERSION;
    readonly sourceBranch: string;
    readonly targetBranch: string;
    readonly forkOffset: Offset;
    readonly title: string;
    readonly body: string;
    readonly author: string;
  };
}

export interface PrReviewCommentEventV1 extends Event {
  readonly type: "pr.review-comment";
  readonly payload: {
    readonly v: typeof PR_EVENT_VERSION;
    readonly author: string;
    readonly body: string;
    readonly path?: string;
    readonly replyTo?: Offset;
  };
}

export interface PrReviewCommentEventV2 extends Event {
  readonly type: "pr.review-comment";
  readonly payload: {
    readonly v: typeof PR_REVIEW_COMMENT_VERSION;
    readonly author: string;
    readonly body: string;
    readonly path?: string;
    /** One-based source-side line. A line anchor always names a path. */
    readonly line?: number;
    readonly replyTo?: Offset;
  };
}

export type PrReviewCommentEvent = PrReviewCommentEventV1 | PrReviewCommentEventV2;

export interface PrApprovedEvent extends Event {
  readonly type: "pr.approved";
  readonly payload: {
    readonly v: typeof PR_EVENT_VERSION;
    readonly reviewer: string;
  };
}

export interface PrChangesRequestedEvent extends Event {
  readonly type: "pr.changes-requested";
  readonly payload: {
    readonly v: typeof PR_EVENT_VERSION;
    readonly reviewer: string;
    readonly body: string;
  };
}

export interface PrMergedEvent extends Event {
  readonly type: "pr.merged";
  readonly payload: {
    readonly v: typeof PR_EVENT_VERSION;
    readonly mergedBy: string;
  };
}

export interface PrClosedEvent extends Event {
  readonly type: "pr.closed";
  readonly payload: {
    readonly v: typeof PR_EVENT_VERSION;
    readonly closedBy: string;
    readonly reason?: string;
  };
}

export type PrEvent =
  | PrOpenedEvent
  | PrReviewCommentEvent
  | PrApprovedEvent
  | PrChangesRequestedEvent
  | PrMergedEvent
  | PrClosedEvent;

export interface PrStreamIdentity {
  readonly org: string;
  readonly repo: string;
  readonly prId: string;
}

export interface BranchStreamIdentity {
  readonly org: string;
  readonly repo: string;
  readonly branch: string;
}

const NAME_PATTERN = /^(?=[a-z0-9-]{1,40}$)[a-z0-9](?:-?[a-z0-9])*$/;
const BRANCH_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PR_ID_PATTERN = /^[A-Za-z0-9._~-]+$/;

function exactObject(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) return false;
  const actual = (keys as string[]).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function text(value: unknown): value is string {
  return typeof value === "string";
}

function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isPrActionType(value: string): value is PrActionType {
  return (PR_ACTION_TYPES as readonly string[]).includes(value);
}

export function isPrEvent(event: Event): event is PrEvent {
  if (!isPrActionType(event.type)) return false;
  const payload = event.payload;
  if (event.type === "pr.opened") {
    return (
      exactObject(payload, [
        "v",
        "sourceBranch",
        "targetBranch",
        "forkOffset",
        "title",
        "body",
        "author",
      ]) &&
      payload.v === PR_EVENT_VERSION &&
      identity(payload.sourceBranch) &&
      identity(payload.targetBranch) &&
      identity(payload.forkOffset) &&
      text(payload.title) &&
      text(payload.body) &&
      identity(payload.author)
    );
  }
  if (event.type === "pr.review-comment") {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
    const candidate = payload as Record<string, unknown>;
    const keys = ["v", "author", "body"];
    if (Object.prototype.hasOwnProperty.call(candidate, "path")) keys.push("path");
    if (Object.prototype.hasOwnProperty.call(candidate, "line")) keys.push("line");
    if (Object.prototype.hasOwnProperty.call(candidate, "replyTo")) keys.push("replyTo");
    return (
      exactObject(candidate, keys) &&
      (candidate.v === PR_EVENT_VERSION || candidate.v === PR_REVIEW_COMMENT_VERSION) &&
      identity(candidate.author) &&
      text(candidate.body) &&
      (candidate.path === undefined || text(candidate.path)) &&
      (candidate.line === undefined ||
        (candidate.v === PR_REVIEW_COMMENT_VERSION &&
          candidate.path !== undefined &&
          Number.isSafeInteger(candidate.line) &&
          (candidate.line as number) >= 1)) &&
      (candidate.replyTo === undefined || identity(candidate.replyTo))
    );
  }
  if (event.type === "pr.approved") {
    return (
      exactObject(payload, ["v", "reviewer"]) &&
      payload.v === PR_EVENT_VERSION &&
      identity(payload.reviewer)
    );
  }
  if (event.type === "pr.changes-requested") {
    return (
      exactObject(payload, ["v", "reviewer", "body"]) &&
      payload.v === PR_EVENT_VERSION &&
      identity(payload.reviewer) &&
      text(payload.body)
    );
  }
  if (event.type === "pr.merged") {
    return (
      exactObject(payload, ["v", "mergedBy"]) &&
      payload.v === PR_EVENT_VERSION &&
      identity(payload.mergedBy)
    );
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const candidate = payload as Record<string, unknown>;
  const keys = Object.prototype.hasOwnProperty.call(candidate, "reason")
    ? ["v", "closedBy", "reason"]
    : ["v", "closedBy"];
  return (
    exactObject(candidate, keys) &&
    candidate.v === PR_EVENT_VERSION &&
    identity(candidate.closedBy) &&
    (candidate.reason === undefined || text(candidate.reason))
  );
}

export function prStreamId(org: string, repo: string, prId: string): string {
  if (!NAME_PATTERN.test(org) || !NAME_PATTERN.test(repo) || !PR_ID_PATTERN.test(prId)) {
    throw new TypeError("invalid PR stream identity");
  }
  return `pr:${org}/${repo}/${prId}`;
}

export function parsePrStreamId(streamId: string): PrStreamIdentity | undefined {
  const match = /^pr:([^/]+)\/([^/]+)\/([^/]+)$/.exec(streamId);
  if (match === null) return undefined;
  const [, org, repo, prId] = match as unknown as [string, string, string, string];
  return NAME_PATTERN.test(org) && NAME_PATTERN.test(repo) && PR_ID_PATTERN.test(prId)
    ? { org, repo, prId }
    : undefined;
}

export function isPrStreamId(streamId: string): boolean {
  return parsePrStreamId(streamId) !== undefined;
}

export function parseBranchStreamId(streamId: string): BranchStreamIdentity | undefined {
  const match = /^fs:([^/]+)\/([^:]+):([^:]+):meta$/.exec(streamId);
  if (match === null) return undefined;
  const [, org, repo, branch] = match as unknown as [string, string, string, string];
  return NAME_PATTERN.test(org) &&
    NAME_PATTERN.test(repo) &&
    BRANCH_PATTERN.test(branch) &&
    branch !== "meta" &&
    branch !== "file"
    ? { org, repo, branch }
    : undefined;
}
