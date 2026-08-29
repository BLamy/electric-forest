import type { Event, Offset } from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";
import { isIssueStreamId } from "./issueReducer.js";

export const ISSUE_CATALOG_EVENT_VERSION = 1 as const;
export const ISSUE_CATALOG_EVENT = "repo.issue-observed" as const;

export interface IssueCatalogState {
  readonly v: typeof ISSUE_CATALOG_EVENT_VERSION;
  readonly issues: Readonly<Record<string, Offset>>;
}

export const issueCatalogInitialState: IssueCatalogState = Object.freeze({
  v: 1,
  issues: Object.freeze({}),
});

export function repoIssuesStreamId(org: string, repo: string): string {
  return `repo-issues:${org}/${repo}`;
}

export function isRepoIssuesStreamId(streamId: string): boolean {
  return /^repo-issues:[a-z0-9](?:-?[a-z0-9])*\/[a-z0-9](?:-?[a-z0-9])*$/.test(streamId);
}

export function issueBelongsToRepo(issueStreamId: string, org: string, repo: string): boolean {
  const match = /^issue:([^/]+)\/([^/]+)\/[^/]+$/.exec(issueStreamId);
  return match !== null && match[1] === org && match[2] === repo;
}

export function repoIdentityFromIssueCatalogStream(
  streamId: string,
): { readonly org: string; readonly repo: string } | undefined {
  const match = /^repo-issues:([^/]+)\/([^/]+)$/.exec(streamId);
  return match === null ? undefined : { org: match[1]!, repo: match[2]! };
}

function exactObject(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

export function isIssueCatalogEvent(event: Event): boolean {
  return (
    event.type === ISSUE_CATALOG_EVENT &&
    exactObject(event.payload, ["v", "issueStreamId", "sourceOffset"]) &&
    event.payload.v === ISSUE_CATALOG_EVENT_VERSION &&
    typeof event.payload.issueStreamId === "string" &&
    isIssueStreamId(event.payload.issueStreamId) &&
    isWellFormedOffset(event.payload.sourceOffset) &&
    event.payload.sourceOffset !== "-1"
  );
}

export function issueCatalogReducer(state: IssueCatalogState, event: Event): IssueCatalogState {
  if (!isIssueCatalogEvent(event)) throw new TypeError("repo-issues/corrupt-event");
  const payload = event.payload as {
    readonly issueStreamId: string;
    readonly sourceOffset: Offset;
  };
  const prior = state.issues[payload.issueStreamId];
  if (prior !== undefined && prior !== payload.sourceOffset)
    throw new TypeError("repo-issues/conflicting-source");
  if (prior !== undefined) return state;
  return { v: 1, issues: { ...state.issues, [payload.issueStreamId]: payload.sourceOffset } };
}

export function replayIssueCatalog(streamId: string, events: readonly Event[]): IssueCatalogState {
  const identity = repoIdentityFromIssueCatalogStream(streamId);
  if (identity === undefined) throw new TypeError("repo-issues/invalid-stream");
  return events.reduce<IssueCatalogState>((state, event) => {
    if (!isIssueCatalogEvent(event)) throw new TypeError("repo-issues/corrupt-event");
    const issueStreamId = (event.payload as { readonly issueStreamId: string }).issueStreamId;
    if (!issueBelongsToRepo(issueStreamId, identity.org, identity.repo))
      throw new TypeError("repo-issues/cross-repo-source");
    return issueCatalogReducer(state, event);
  }, issueCatalogInitialState);
}
