import { stateDigest, type Event } from "@eforest/protocol";

export const ISSUE_EVENT_VERSION = 1 as const;
export const ISSUE_STATES = ["open", "in-progress", "done", "closed", "wont-do"] as const;
export type IssueStateName = (typeof ISSUE_STATES)[number];
export type IssueActionType =
  | "issue.opened"
  | "issue.commented"
  | "issue.labeled"
  | "issue.unlabeled"
  | "issue.state-changed"
  | "issue.closed"
  | "issue.reopened";

export interface IssueComment {
  readonly commentId: string;
  readonly body: string;
  readonly ts: number;
}
export interface IssueState {
  readonly v: typeof ISSUE_EVENT_VERSION;
  readonly issueId: string;
  readonly title: string;
  readonly body: string;
  readonly state: IssueStateName;
  readonly labels: readonly string[];
  readonly comments: readonly IssueComment[];
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

function hasBeenOpened(state: IssueState): boolean {
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
    "issue.state-changed": ["in-progress", "done", "wont-do"] as const,
    "issue.closed": "closed",
    "issue.reopened": false,
  }),
  "in-progress": Object.freeze({
    "issue.opened": false,
    "issue.commented": "in-progress",
    "issue.labeled": "in-progress",
    "issue.unlabeled": "in-progress",
    "issue.state-changed": ["open", "done", "wont-do"] as const,
    "issue.closed": "closed",
    "issue.reopened": false,
  }),
  done: Object.freeze({
    "issue.opened": false,
    "issue.commented": "done",
    "issue.labeled": "done",
    "issue.unlabeled": "done",
    "issue.state-changed": ["open", "in-progress", "wont-do"] as const,
    "issue.closed": false,
    "issue.reopened": "open",
  }),
  closed: Object.freeze({
    "issue.opened": false,
    "issue.commented": "closed",
    "issue.labeled": "closed",
    "issue.unlabeled": "closed",
    "issue.state-changed": false,
    "issue.closed": false,
    "issue.reopened": "open",
  }),
  "wont-do": Object.freeze({
    "issue.opened": false,
    "issue.commented": "wont-do",
    "issue.labeled": "wont-do",
    "issue.unlabeled": "wont-do",
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
    {
      v: 1,
      issueId: "",
      title: "",
      body: "",
      state: "open",
      labels: [],
      comments: [],
    },
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
    if (hasBeenOpened(state)) return state;
    return nextIssueState(state, { title: p.title as string, body: p.body as string });
  }
  if (!hasBeenOpened(state)) return state;
  if (!isLegal(state.state, event.type, p.to as IssueStateName | undefined)) return state;
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
  if (event.type === "issue.state-changed")
    return nextIssueState(state, { state: p.to as IssueStateName });
  if (event.type === "issue.closed") return nextIssueState(state, { state: "closed" });
  return nextIssueState(state, { state: "open" });
}

function reduceIssueApplicationEvent(state: unknown, event: Event): IssueState {
  const payload =
    event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? Object.fromEntries(
          Object.entries(event.payload).filter(([key]) => key !== "actor" && key !== "writer"),
        )
      : event.payload;
  return issueReducer(state as IssueState, { ...event, payload });
}

function isIssueEventShape(event: Event): boolean {
  if (event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return false;
  }
  const p = event.payload as Record<string, unknown>;
  const keys = Object.keys(p).sort();
  const expected =
    event.type === "issue.opened"
      ? ["body", "title", "v"]
      : event.type === "issue.commented"
        ? ["body", "commentId", "v"]
        : event.type === "issue.labeled" || event.type === "issue.unlabeled"
          ? ["label", "v"]
          : event.type === "issue.state-changed"
            ? ["to", "v"]
            : event.type === "issue.closed"
              ? p.reason === undefined
                ? ["v"]
                : ["reason", "v"]
              : ["v"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
    return false;
  if (p.v !== ISSUE_EVENT_VERSION) return false;
  if (event.type === "issue.opened")
    return typeof p.title === "string" && typeof p.body === "string";
  if (event.type === "issue.commented")
    return typeof p.commentId === "string" && typeof p.body === "string";
  if (event.type === "issue.labeled" || event.type === "issue.unlabeled")
    return typeof p.label === "string";
  if (event.type === "issue.state-changed") return typeof p.to === "string";
  if (event.type === "issue.closed") return p.reason === undefined || typeof p.reason === "string";
  return event.type === "issue.reopened";
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
