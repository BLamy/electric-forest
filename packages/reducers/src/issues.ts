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

export const WORKFLOW_TRANSITIONS: Readonly<
  Record<IssueStateName, Readonly<Record<IssueActionType, IssueStateName | false>>>
> = Object.freeze({
  open: Object.freeze({
    "issue.opened": false,
    "issue.commented": "open",
    "issue.labeled": "open",
    "issue.unlabeled": "open",
    "issue.state-changed": "in-progress",
    "issue.closed": "closed",
    "issue.reopened": false,
  }),
  "in-progress": Object.freeze({
    "issue.opened": false,
    "issue.commented": "in-progress",
    "issue.labeled": "in-progress",
    "issue.unlabeled": "in-progress",
    "issue.state-changed": "done",
    "issue.closed": "closed",
    "issue.reopened": false,
  }),
  done: Object.freeze({
    "issue.opened": false,
    "issue.commented": "done",
    "issue.labeled": "done",
    "issue.unlabeled": "done",
    "issue.state-changed": "wont-do",
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
    "issue.state-changed": "open",
    "issue.closed": false,
    "issue.reopened": "open",
  }),
});

export function isIssueActionType(value: string): value is IssueActionType {
  return value in WORKFLOW_TRANSITIONS.open;
}

export function isLegal(
  state: IssueStateName,
  action: IssueActionType,
  to?: IssueStateName,
): boolean {
  const next = WORKFLOW_TRANSITIONS[state][action];
  if (next === false) return false;
  if (action !== "issue.state-changed") return true;
  return to !== undefined && to !== "closed" && ISSUE_STATES.includes(to) && to !== state;
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

export const issueInitialState: IssueState = Object.freeze({
  v: 1,
  issueId: "",
  title: "",
  body: "",
  state: "open",
  labels: [],
  comments: [],
});

function payload(event: Event): Record<string, unknown> {
  if (event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload))
    throw new TypeError("issue schema violation");
  return event.payload as Record<string, unknown>;
}

export function issueReducer(state: IssueState, event: Event): IssueState {
  const p = payload(event);
  if (!isIssueActionType(event.type) || p.v !== ISSUE_EVENT_VERSION)
    throw new TypeError("issue schema violation");
  if (event.type === "issue.opened")
    return { ...state, title: p.title as string, body: p.body as string };
  if (event.type === "issue.commented")
    return {
      ...state,
      comments: [
        ...state.comments,
        { commentId: p.commentId as string, body: p.body as string, ts: event.ts },
      ],
    };
  if (event.type === "issue.labeled")
    return { ...state, labels: [...state.labels, p.label as string].sort() };
  if (event.type === "issue.unlabeled")
    return { ...state, labels: state.labels.filter((label) => label !== p.label) };
  if (event.type === "issue.state-changed") return { ...state, state: p.to as IssueStateName };
  if (event.type === "issue.closed") return { ...state, state: "closed" };
  return { ...state, state: "open" };
}

export const issueReducerDefinition = Object.freeze({
  id: "issue",
  version: ISSUE_EVENT_VERSION,
  initialState: issueInitialState,
  reduce: issueReducer as (state: unknown, event: Event) => unknown,
  digest: stateDigest,
  matchesStream: isIssueStreamId,
});
