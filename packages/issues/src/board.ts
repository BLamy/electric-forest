import { stateDigest, type Event, type Offset } from "@eforest/protocol";
import {
  ISSUE_STATES,
  issueHasBeenOpened,
  issueInitialStateForStream,
  isIssueEventShape,
  isLegal,
  issueReducer,
  type IssueState,
  type IssueStateName,
} from "./issueReducer.js";
import { labelInitialState, reduceLabelApplicationEvent, type LabelState } from "./labelReducer.js";

export const BOARD_REDUCER = "issue-board@1" as const;
export const BOARD_VIEW_VERSION = 1 as const;

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
