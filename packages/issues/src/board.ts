import { stateDigest, type Event, type Offset } from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";
import {
  ISSUE_STATES,
  issueHasBeenOpened,
  issueInitialStateForStream,
  isIssueEventShape,
  isIssueSiblingEvent,
  isIssueString,
  isLegal,
  issueReducer,
  type IssueState,
  type IssueStateName,
} from "./issueReducer.js";
import { labelInitialState, reduceLabelApplicationEvent, type LabelState } from "./labelReducer.js";

export const BOARD_REDUCER = "issue-board@1" as const;
export const BOARD_VIEW_VERSION = 1 as const;
export const ISSUE_BOARD_REPLACED_EVENT = "issue-board.replaced" as const;
export const ISSUE_BOARD_EVENT_VERSION = 1 as const;

export interface BoardColumn {
  readonly count: number;
  readonly issues: readonly string[];
}

export interface BoardLabel {
  readonly name: string;
  readonly color: string;
  readonly issues: readonly string[];
}

export interface IssueBoard {
  readonly v: typeof BOARD_VIEW_VERSION;
  readonly reducer: typeof BOARD_REDUCER;
  readonly columns: Readonly<Record<IssueStateName, BoardColumn>>;
  readonly labels: Readonly<Record<string, BoardLabel>>;
}

export interface IssueBoardInputProvenance {
  readonly streamId: string;
  readonly offset: Offset;
}

export interface IssueBoardProvenance {
  readonly inputs: readonly IssueBoardInputProvenance[];
}

export interface IssueBoardReplacementPayload {
  readonly v: typeof ISSUE_BOARD_EVENT_VERSION;
  readonly board: IssueBoard;
  readonly provenance: IssueBoardProvenance;
}

export type IssueBoardReplacementEvent = Event & {
  readonly type: typeof ISSUE_BOARD_REPLACED_EVENT;
  readonly payload: IssueBoardReplacementPayload;
};

export interface InputRecord extends Event {
  readonly offset?: Offset;
}

export interface IssueLog {
  readonly streamId: string;
  readonly events: readonly InputRecord[];
}

const utf8 = new TextEncoder();

export function compareUtf8(left: string, right: string): number {
  const a = utf8.encode(left);
  const b = utf8.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function cleanEvent(event: InputRecord): Event {
  const payload =
    event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? Object.fromEntries(
          Object.entries(event.payload).filter(([key]) => key !== "actor" && key !== "writer"),
        )
      : event.payload;
  return { type: event.type, payload, ts: event.ts };
}

function emptyColumns(): Record<IssueStateName, { count: number; issues: string[] }> {
  return {
    open: { count: 0, issues: [] },
    "in-progress": { count: 0, issues: [] },
    done: { count: 0, issues: [] },
    closed: { count: 0, issues: [] },
    "wont-do": { count: 0, issues: [] },
  };
}

export const issueBoardInitialState: IssueBoard = Object.freeze({
  v: BOARD_VIEW_VERSION,
  reducer: BOARD_REDUCER,
  columns: Object.freeze({
    open: Object.freeze({ count: 0, issues: Object.freeze([]) }),
    "in-progress": Object.freeze({ count: 0, issues: Object.freeze([]) }),
    done: Object.freeze({ count: 0, issues: Object.freeze([]) }),
    closed: Object.freeze({ count: 0, issues: Object.freeze([]) }),
    "wont-do": Object.freeze({ count: 0, issues: Object.freeze([]) }),
  }),
  labels: Object.freeze({}),
});

export function repoIssueBoardStreamId(org: string, repo: string): string {
  return `issue-board:${org}/${repo}`;
}

export function isRepoIssueBoardStreamId(streamId: string): boolean {
  return /^issue-board:[a-z0-9](?:-?[a-z0-9])*\/[a-z0-9](?:-?[a-z0-9])*$/.test(streamId);
}

function exactObject(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function sortedUniqueIssueIds(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  let previous: string | undefined;
  for (const issueId of value) {
    if (typeof issueId !== "string" || !/^[A-Za-z0-9._~-]+$/.test(issueId)) return false;
    if (previous !== undefined && compareUtf8(previous, issueId) >= 0) return false;
    previous = issueId;
  }
  return true;
}

export function isIssueBoard(value: unknown): value is IssueBoard {
  if (!exactObject(value, ["v", "reducer", "columns", "labels"])) return false;
  if (value.v !== BOARD_VIEW_VERSION || value.reducer !== BOARD_REDUCER) return false;
  if (!exactObject(value.columns, ISSUE_STATES)) return false;
  const boardIssueIds = new Set<string>();
  for (const state of ISSUE_STATES) {
    const column = value.columns[state];
    if (
      !exactObject(column, ["count", "issues"]) ||
      !Number.isSafeInteger(column.count) ||
      (column.count as number) < 0 ||
      !sortedUniqueIssueIds(column.issues) ||
      column.count !== column.issues.length
    ) {
      return false;
    }
    for (const issueId of column.issues) {
      if (boardIssueIds.has(issueId)) return false;
      boardIssueIds.add(issueId);
    }
  }
  if (value.labels === null || typeof value.labels !== "object" || Array.isArray(value.labels))
    return false;
  const labels = value.labels as Record<string, unknown>;
  const labelIds = Object.keys(labels);
  if (labelIds.some((labelId) => !/^[A-Za-z0-9._~-]+$/.test(labelId))) return false;
  if ([...labelIds].sort(compareUtf8).some((labelId, index) => labelId !== labelIds[index]))
    return false;
  for (const labelId of labelIds) {
    const label = labels[labelId];
    if (
      !exactObject(label, ["name", "color", "issues"]) ||
      !isIssueString(label.name) ||
      label.name === "" ||
      !isIssueString(label.color) ||
      label.color === "" ||
      !sortedUniqueIssueIds(label.issues) ||
      label.issues.some((issueId) => !boardIssueIds.has(issueId))
    ) {
      return false;
    }
  }
  return true;
}

export function isIssueBoardProvenance(value: unknown): value is IssueBoardProvenance {
  if (!exactObject(value, ["inputs"]) || !Array.isArray(value.inputs)) return false;
  let previous: string | undefined;
  for (const input of value.inputs) {
    if (
      !exactObject(input, ["streamId", "offset"]) ||
      typeof input.streamId !== "string" ||
      input.streamId.length === 0 ||
      typeof input.offset !== "string" ||
      !isWellFormedOffset(input.offset)
    ) {
      return false;
    }
    if (previous !== undefined && compareUtf8(previous, input.streamId) >= 0) return false;
    previous = input.streamId;
  }
  return true;
}

export function isIssueBoardReplacementEvent(event: Event): event is IssueBoardReplacementEvent {
  return (
    event.type === ISSUE_BOARD_REPLACED_EVENT &&
    exactObject(event.payload, ["v", "board", "provenance"]) &&
    event.payload.v === ISSUE_BOARD_EVENT_VERSION &&
    isIssueBoard(event.payload.board) &&
    isIssueBoardProvenance(event.payload.provenance)
  );
}

export function issueBoardReplacementEvent(
  board: IssueBoard,
  provenance: IssueBoardProvenance,
  ts = 0,
): IssueBoardReplacementEvent {
  const event: Event = {
    type: ISSUE_BOARD_REPLACED_EVENT,
    payload: { v: ISSUE_BOARD_EVENT_VERSION, board, provenance },
    ts,
  };
  if (!isIssueBoardReplacementEvent(event)) throw new TypeError("issue-board/invalid-snapshot");
  return event;
}

export function issueBoardReducer(_state: IssueBoard, event: Event): IssueBoard {
  if (!isIssueBoardReplacementEvent(event)) throw new TypeError("issue-board/corrupt-event");
  return event.payload.board;
}

export const issueBoardReducerDefinition = Object.freeze({
  id: BOARD_REDUCER,
  version: BOARD_VIEW_VERSION,
  initialState: issueBoardInitialState,
  reduce: issueBoardReducer as (state: unknown, event: Event) => IssueBoard,
  digest: boardDigest as (state: unknown) => string,
  matchesStream: isRepoIssueBoardStreamId,
});

function labelState(labelLog: readonly InputRecord[]): LabelState {
  return labelLog.reduce<LabelState>(
    (state, event) => reduceLabelApplicationEvent(state, cleanEvent(event)),
    labelInitialState,
  );
}

export function reduceIssueLog(log: IssueLog): IssueState {
  let state = issueInitialStateForStream(log.streamId);
  let opened = false;
  for (const record of log.events) {
    const event = cleanEvent(record);
    if (opened && isIssueSiblingEvent(event.type)) continue;
    if (!isIssueEventShape(event)) throw new TypeError(`corrupt issue event: ${log.streamId}`);
    if (!opened && event.type !== "issue.opened")
      throw new TypeError(`issue does not open first: ${log.streamId}`);
    if (opened && event.type === "issue.opened")
      throw new TypeError(`issue opens twice: ${log.streamId}`);
    if (opened) {
      const payload = event.payload as Record<string, unknown>;
      if (!isLegal(state.state, event.type, payload.to as IssueStateName | undefined))
        throw new TypeError(`illegal issue transition: ${log.streamId}`);
      if (
        event.type === "issue.commented" &&
        state.comments.some((comment) => comment.commentId === payload.commentId)
      )
        throw new TypeError(`duplicate issue comment: ${log.streamId}`);
      if (event.type === "issue.labeled" && state.labels.includes(payload.label as string))
        throw new TypeError(`duplicate issue label: ${log.streamId}`);
      if (event.type === "issue.unlabeled" && !state.labels.includes(payload.label as string))
        throw new TypeError(`missing issue label: ${log.streamId}`);
    }
    state = issueReducer(state, event);
    opened = true;
  }
  return state;
}

export function deriveBoardFromStates(
  catalog: LabelState,
  issueStates: readonly IssueState[],
): IssueBoard {
  const columns = emptyColumns();
  const memberships = new Map<string, string[]>(
    Object.keys(catalog.labels).map((labelId) => [labelId, []]),
  );
  for (const state of issueStates) {
    if (!issueHasBeenOpened(state)) continue;
    columns[state.state].issues.push(state.issueId);
    for (const labelId of state.labels) {
      const members = memberships.get(labelId);
      if (members === undefined)
        throw new TypeError(`issue references unknown labelId: ${labelId}`);
      members.push(state.issueId);
    }
  }
  for (const state of ISSUE_STATES) {
    columns[state].issues.sort(compareUtf8);
    columns[state].count = columns[state].issues.length;
  }
  const labels = Object.fromEntries(
    Object.keys(catalog.labels)
      .sort(compareUtf8)
      .map((labelId) => {
        const label = catalog.labels[labelId]!;
        return [
          labelId,
          {
            name: label.name,
            color: label.color,
            issues: (memberships.get(labelId) ?? []).sort(compareUtf8),
          },
        ];
      }),
  );
  return { v: BOARD_VIEW_VERSION, reducer: BOARD_REDUCER, columns, labels };
}

export function deriveBoard(
  labelLog: readonly InputRecord[],
  issueLogs: readonly IssueLog[],
): IssueBoard {
  const catalog = labelState(labelLog);
  const seen = new Set<string>();
  const states: IssueState[] = [];
  for (const log of issueLogs) {
    if (seen.has(log.streamId)) throw new TypeError(`duplicate issue log: ${log.streamId}`);
    seen.add(log.streamId);
    states.push(reduceIssueLog(log));
  }
  return deriveBoardFromStates(catalog, states);
}

export function filterBoard(board: IssueBoard, labelId: string): IssueBoard {
  if (!Object.prototype.hasOwnProperty.call(board.labels, labelId))
    throw new TypeError(`unknown labelId: ${labelId}`);
  const selected = board.labels[labelId]!;
  const allowed = new Set(selected.issues);
  const columns = emptyColumns();
  for (const state of ISSUE_STATES) {
    columns[state].issues = board.columns[state].issues.filter((issueId) => allowed.has(issueId));
    columns[state].count = columns[state].issues.length;
  }
  const labels = Object.fromEntries(
    Object.entries(board.labels)
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([id, label]) => [
        id,
        { ...label, issues: label.issues.filter((issueId) => allowed.has(issueId)) },
      ]),
  );
  return { v: BOARD_VIEW_VERSION, reducer: BOARD_REDUCER, columns, labels };
}

export function boardDigest(board: IssueBoard): string {
  return stateDigest(board);
}
