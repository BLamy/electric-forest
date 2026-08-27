import { useDispatch, useStreamReducer } from "@eforest/web-hooks";
import type { ApplicationRecord, DispatchFunction, StreamReducerResult } from "@eforest/web-hooks";
import type { Event } from "@eforest/protocol";
import {
  BOARD_REDUCER,
  ISSUE_STATES,
  WORKFLOW_TRANSITIONS,
  filterBoard,
  issueStreamId,
  repoIssueBoardStreamId,
  type IssueBoard,
  type IssueState,
  type IssueStateName,
} from "@eforest/reducers";

export interface RenderedIssueError {
  readonly code: string;
  readonly message: string;
}

export interface IssueBoardBinding {
  readonly streamId: string;
  readonly reducerId: typeof BOARD_REDUCER;
  readonly projection: StreamReducerResult<IssueBoard>;
}

export interface IssueBinding {
  readonly streamId: string;
  readonly projection: StreamReducerResult<IssueState>;
  readonly dispatch: DispatchFunction;
  readonly transitionTargets: readonly IssueStateName[];
  readonly canClose: boolean;
  readonly canReopen: boolean;
}

export const issueStates: readonly IssueStateName[] = ISSUE_STATES;

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function issueEvent(type: string, payload: Record<string, unknown>): Event {
  return { type, payload: { v: 1, ...payload }, ts: Date.now() };
}

export const issueActions = Object.freeze({
  open: (title: string, body: string): Event => issueEvent("issue.opened", { title, body }),
  comment: (commentId: string, body: string): Event =>
    issueEvent("issue.commented", { commentId, body }),
  label: (label: string): Event => issueEvent("issue.labeled", { label }),
  unlabel: (label: string): Event => issueEvent("issue.unlabeled", { label }),
  transition: (to: IssueStateName): Event => issueEvent("issue.state-changed", { to }),
  close: (reason?: string): Event =>
    issueEvent("issue.closed", reason === undefined || reason === "" ? {} : { reason }),
  reopen: (): Event => issueEvent("issue.reopened", {}),
});

export function issueError(error: unknown): RenderedIssueError {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return {
      code: error.code,
      message: "message" in error && typeof error.message === "string" ? error.message : error.code,
    };
  }
  return {
    code: "dispatch-failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

export function issueBoardForLabel(board: IssueBoard, labelId: string): IssueBoard {
  return labelId === "" ? board : filterBoard(board, labelId);
}

export function issueTimeline(
  projection: StreamReducerResult<IssueState>,
): readonly ApplicationRecord[] {
  return projection.records;
}

export function useIssueBoard(org: string, repo: string): IssueBoardBinding {
  const streamId = repoIssueBoardStreamId(org, repo);
  const projection = useStreamReducer<IssueBoard>({
    apiPath: `/api/repos/${encoded(org)}/${encoded(repo)}/board`,
    streamId,
    reducerId: BOARD_REDUCER,
    followWaitMs: 500,
    reconnectDelayMs: 100,
  });
  return { streamId, reducerId: BOARD_REDUCER, projection };
}

export function useIssueCreator(org: string, repo: string, issueId: string): DispatchFunction {
  return useDispatch(issueStreamId(org, repo, issueId));
}

export function useIssue(org: string, repo: string, issueId: string): IssueBinding {
  const streamId = issueStreamId(org, repo, issueId);
  const projection = useStreamReducer<IssueState>({
    apiPath: `/api/repos/${encoded(org)}/${encoded(repo)}/main/events?stream=issue&issueId=${encoded(issueId)}`,
    streamId,
    reducerId: "issue",
    followWaitMs: 500,
    reconnectDelayMs: 100,
  });
  const dispatch = useDispatch(streamId, { replayedOffset: projection.checkpoint });
  const state = projection.state.state;
  const transitions = WORKFLOW_TRANSITIONS[state]["issue.state-changed"];
  return {
    streamId,
    projection,
    dispatch,
    transitionTargets: Array.isArray(transitions) ? transitions : [],
    canClose: WORKFLOW_TRANSITIONS[state]["issue.closed"] !== false,
    canReopen: WORKFLOW_TRANSITIONS[state]["issue.reopened"] !== false,
  };
}

export type { ApplicationRecord, IssueBoard, IssueState, IssueStateName };
