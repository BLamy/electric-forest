import { stateDigest, type Event } from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";

export const ISSUE_EVENT_VERSION = 1 as const;
export const ISSUE_LINK_EVENT_VERSION = 2 as const;
export const ISSUE_STRING_MAX_CODE_UNITS = 1024 * 1024;
export const ISSUE_STATES = ["open", "in-progress", "done", "closed", "wont-do"] as const;
export type IssueStateName = (typeof ISSUE_STATES)[number];
export type IssueActionType =
  | "issue.opened"
  | "issue.commented"
  | "issue.labeled"
  | "issue.unlabeled"
  | "issue.linked"
  | "issue.state-changed"
  | "issue.closed"
  | "issue.reopened";

export interface IssueComment {
  readonly commentId: string;
  readonly body: string;
  readonly ts: number;
}
export interface IssueBacklink {
  readonly prStream: string;
  readonly atOffset: string;
}
export interface IssueClosedBy {
  readonly prStream: string;
  readonly prMergedOffset: string;
}
export interface IssueState {
  readonly v: typeof ISSUE_EVENT_VERSION;
  readonly issueId: string;
  readonly title: string;
  readonly body: string;
  readonly state: IssueStateName;
  readonly labels: readonly string[];
  readonly comments: readonly IssueComment[];
  /** Additive E5-T07 fields stay absent until a linking event preserves v1 digests. */
  readonly linkedBy?: readonly IssueBacklink[];
  readonly closedBy?: readonly IssueClosedBy[];
}

export function isIssueString(value: unknown): value is string {
  if (typeof value !== "string" || value.length > ISSUE_STRING_MAX_CODE_UNITS) return false;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0 || (codeUnit >= 0xd800 && codeUnit <= 0xdfff)) return false;
  }
  return true;
}

const ISSUE_OPENED = "__eforestIssueOpened" as const;
type InternalIssueState = IssueState & { readonly [ISSUE_OPENED]: boolean };

function withOpenedMarker(state: IssueState, opened: boolean): IssueState {
  Object.defineProperty(state, ISSUE_OPENED, {
    configurable: false,
    enumerable: false,
    value: opened,
    writable: false,
  });
  return state;
}

function nextIssueState(state: IssueState, patch: Partial<IssueState>): IssueState {
  return withOpenedMarker({ ...state, ...patch }, true);
}

export function issueHasBeenOpened(state: IssueState): boolean {
  const marker = (state as Partial<InternalIssueState>)[ISSUE_OPENED];
  return marker === true || (marker === undefined && (state.title !== "" || state.body !== ""));
}

export const WORKFLOW_TRANSITIONS: Readonly<
  Record<
    IssueStateName,
    Readonly<Record<IssueActionType, IssueStateName | readonly IssueStateName[] | false>>
  >
> = Object.freeze({
  open: Object.freeze({
    "issue.opened": false,
    "issue.commented": "open",
    "issue.labeled": "open",
    "issue.unlabeled": "open",
    "issue.linked": "open",
    "issue.state-changed": ["in-progress", "done", "wont-do"] as const,
    "issue.closed": "closed",
    "issue.reopened": false,
  }),
  "in-progress": Object.freeze({
    "issue.opened": false,
    "issue.commented": "in-progress",
    "issue.labeled": "in-progress",
    "issue.unlabeled": "in-progress",
    "issue.linked": "in-progress",
    "issue.state-changed": ["open", "done", "wont-do"] as const,
    "issue.closed": "closed",
    "issue.reopened": false,
  }),
  done: Object.freeze({
    "issue.opened": false,
    "issue.commented": "done",
    "issue.labeled": "done",
    "issue.unlabeled": "done",
    "issue.linked": "done",
    "issue.state-changed": ["open", "in-progress", "wont-do"] as const,
    "issue.closed": false,
    "issue.reopened": "open",
  }),
  closed: Object.freeze({
    "issue.opened": false,
    "issue.commented": "closed",
    "issue.labeled": "closed",
    "issue.unlabeled": "closed",
    "issue.linked": "closed",
    "issue.state-changed": false,
    "issue.closed": false,
    "issue.reopened": "open",
  }),
  "wont-do": Object.freeze({
    "issue.opened": false,
    "issue.commented": "wont-do",
    "issue.labeled": "wont-do",
    "issue.unlabeled": "wont-do",
    "issue.linked": "wont-do",
    "issue.state-changed": ["open", "in-progress", "done"] as const,
    "issue.closed": false,
    "issue.reopened": "open",
  }),
});

export function isIssueActionType(value: string): value is IssueActionType {
  return Object.prototype.hasOwnProperty.call(WORKFLOW_TRANSITIONS.open, value);
}

export function isLegal(
  state: IssueStateName,
  action: IssueActionType,
  to?: IssueStateName,
): boolean {
  const next = WORKFLOW_TRANSITIONS[state][action];
  if (next === false) return false;
  if (action !== "issue.state-changed") return true;
  return Array.isArray(next) && to !== undefined && next.includes(to);
}

export function issueStreamId(org: string, repo: string, issueId: string): string {
  if (!/^[A-Za-z0-9._~-]+$/.test(issueId)) throw new TypeError("invalid issue id");
  return `issue:${org}/${repo}/${issueId}`;
}

export function isIssueStreamId(streamId: string): boolean {
  return /^issue:[a-z0-9](?:-?[a-z0-9])*\/[a-z0-9](?:-?[a-z0-9])*\/[A-Za-z0-9._~-]+$/.test(
    streamId,
  );
}

export const issueInitialState: IssueState = Object.freeze(
  withOpenedMarker(
    { v: 1, issueId: "", title: "", body: "", state: "open", labels: [], comments: [] },
    false,
  ),
);

export function issueInitialStateFor(issueId: string): IssueState {
  return withOpenedMarker({ ...issueInitialState, issueId }, false);
}

export function issueInitialStateForStream(streamId: string): IssueState {
  const match = /^issue:[^/]+\/[^/]+\/([^/]+)$/.exec(streamId);
  if (match === null) throw new TypeError(`invalid issue stream id: ${streamId}`);
  return issueInitialStateFor(match[1]!);
}

export function issueReducer(state: IssueState, event: Event): IssueState {
  if (!isIssueActionType(event.type) || !isIssueEventShape(event)) return state;
  const p = event.payload as Record<string, unknown>;
  if (event.type === "issue.opened") {
    if (issueHasBeenOpened(state)) return state;
    return nextIssueState(state, { title: p.title as string, body: p.body as string });
  }
  if (!issueHasBeenOpened(state)) return state;
  if (!isLegal(state.state, event.type, p.to as IssueStateName | undefined)) return state;
  if (event.type === "issue.linked") {
    const by = p.by as { readonly stream: string };
    const backlink = { prStream: by.stream, atOffset: p.atOffset as string };
    if (
      state.linkedBy?.some(
        (existing) =>
          existing.prStream === backlink.prStream && existing.atOffset === backlink.atOffset,
      ) === true
    ) {
      return state;
    }
    return nextIssueState(state, { linkedBy: [...(state.linkedBy ?? []), backlink] });
  }
  if (event.type === "issue.commented") {
    if (state.comments.some((comment) => comment.commentId === p.commentId)) return state;
    return nextIssueState(state, {
      comments: [
        ...state.comments,
        { commentId: p.commentId as string, body: p.body as string, ts: event.ts },
      ],
    });
  }
  if (event.type === "issue.labeled") {
    if (state.labels.includes(p.label as string)) return state;
    return nextIssueState(state, { labels: [...state.labels, p.label as string].sort() });
  }
  if (event.type === "issue.unlabeled") {
    if (!state.labels.includes(p.label as string)) return state;
    return nextIssueState(state, { labels: state.labels.filter((label) => label !== p.label) });
  }
  if (event.type === "issue.state-changed") {
    const via = stateChangedVia(event);
    if (via === undefined) return nextIssueState(state, { state: p.to as IssueStateName });
    if (
      state.closedBy?.some(
        (existing) =>
          existing.prStream === via.prStream && existing.prMergedOffset === via.prMergedOffset,
      ) === true
    ) {
      return state;
    }
    return nextIssueState(state, {
      state: p.to as IssueStateName,
      closedBy: [...(state.closedBy ?? []), via],
    });
  }
  if (event.type === "issue.closed") return nextIssueState(state, { state: "closed" });
  return nextIssueState(state, { state: "open" });
}

export function reduceIssueApplicationEvent(state: unknown, event: Event): IssueState {
  const payload =
    event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? Object.fromEntries(
          Object.entries(event.payload).filter(([key]) => key !== "actor" && key !== "writer"),
        )
      : event.payload;
  return issueReducer(state as IssueState, { ...event, payload });
}

export function isIssueEventShape(
  event: Event,
): event is Event & { readonly type: IssueActionType } {
  if (event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload))
    return false;
  const p = event.payload as Record<string, unknown>;
  const keys = Object.keys(p).sort();
  const expected =
    event.type === "issue.opened"
      ? ["body", "title", "v"]
      : event.type === "issue.commented"
        ? ["body", "commentId", "v"]
        : event.type === "issue.labeled" || event.type === "issue.unlabeled"
          ? ["label", "v"]
          : event.type === "issue.linked"
            ? ["atOffset", "by", "v"]
            : event.type === "issue.state-changed"
              ? p.v === ISSUE_LINK_EVENT_VERSION
                ? ["to", "v", "via"]
                : ["to", "v"]
              : event.type === "issue.closed"
                ? p.reason === undefined
                  ? ["v"]
                  : ["reason", "v"]
                : ["v"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
    return false;
  if (
    p.v !== ISSUE_EVENT_VERSION &&
    !(
      p.v === ISSUE_LINK_EVENT_VERSION &&
      (event.type === "issue.linked" || event.type === "issue.state-changed")
    )
  ) {
    return false;
  }
  if (event.type === "issue.opened") return isIssueString(p.title) && isIssueString(p.body);
  if (event.type === "issue.commented") return isIssueString(p.commentId) && isIssueString(p.body);
  if (event.type === "issue.labeled" || event.type === "issue.unlabeled")
    return isIssueString(p.label);
  if (event.type === "issue.linked") {
    return (
      exactObject(p.by, ["entity", "stream"]) &&
      p.by.entity === "pr" &&
      nonEmptyString(p.by.stream) &&
      validEventOffset(p.atOffset)
    );
  }
  if (event.type === "issue.state-changed") {
    return (
      isIssueStateName(p.to) &&
      (p.v === ISSUE_EVENT_VERSION || stateChangedVia(event) !== undefined)
    );
  }
  if (event.type === "issue.closed") return p.reason === undefined || isIssueString(p.reason);
  return event.type === "issue.reopened";
}

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

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validEventOffset(value: unknown): value is string {
  return typeof value === "string" && value !== "-1" && isWellFormedOffset(value);
}

function isIssueStateName(value: unknown): value is IssueStateName {
  return (ISSUE_STATES as readonly unknown[]).includes(value);
}

export function stateChangedVia(event: Event): IssueClosedBy | undefined {
  if (
    event.type !== "issue.state-changed" ||
    event.payload === null ||
    typeof event.payload !== "object" ||
    Array.isArray(event.payload)
  ) {
    return undefined;
  }
  const payload = event.payload as Record<string, unknown>;
  if (
    payload.v !== ISSUE_LINK_EVENT_VERSION ||
    !exactObject(payload.via, ["prStream", "prMergedOffset"])
  ) {
    return undefined;
  }
  return nonEmptyString(payload.via.prStream) && validEventOffset(payload.via.prMergedOffset)
    ? { prStream: payload.via.prStream, prMergedOffset: payload.via.prMergedOffset }
    : undefined;
}

export const issueReducerDefinition = Object.freeze({
  id: "issue",
  version: ISSUE_EVENT_VERSION,
  initialState: issueInitialState,
  initialStateForStream: issueInitialStateForStream,
  reduce: reduceIssueApplicationEvent,
  digest: stateDigest,
  matchesStream: isIssueStreamId,
});
