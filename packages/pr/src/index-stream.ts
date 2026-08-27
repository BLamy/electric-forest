import {
  compareOffsets,
  OFFSET_BEFORE_FIRST,
  stateDigest,
  type Event,
  type Offset,
} from "@eforest/protocol";
import { isWellFormedOffset, offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { parsePrStreamId } from "./events.js";
import { prInitialStateForStream, prReducer } from "./reducer.js";

export const PR_INDEX_REDUCER = "pr-index" as const;
export const PR_INDEX_EVENT = "pr-index.replaced" as const;
export const PR_INDEX_VERSION = 1 as const;

export type PrIndexStatus = "open" | "approved" | "conflicted" | "merged" | "closed";

export interface PrIndexRow {
  readonly prId: string;
  readonly prStream: string;
  readonly status: PrIndexStatus;
  readonly title: string;
  readonly author: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly headOffset: Offset;
}

export interface PrIndexInput {
  readonly prStream: string;
  readonly events: readonly Event[];
}

export interface PrIndexState {
  readonly rows: readonly PrIndexRow[];
  readonly inputs: readonly { readonly streamId: string; readonly offset: Offset }[];
}

export interface PrIndexReplacementEvent extends Event {
  readonly type: typeof PR_INDEX_EVENT;
  readonly payload: {
    readonly v: typeof PR_INDEX_VERSION;
    readonly state: PrIndexState;
  };
}

export const prIndexInitialState: PrIndexState = Object.freeze({ rows: [], inputs: [] });

const NAME_PATTERN = /^(?=[a-z0-9-]{1,40}$)[a-z0-9](?:-?[a-z0-9])*$/;

export function repoPrIndexStreamId(org: string, repo: string): string {
  if (!NAME_PATTERN.test(org) || !NAME_PATTERN.test(repo)) {
    throw new TypeError("invalid PR index stream identity");
  }
  return `pr-index:${org}/${repo}`;
}

export function isRepoPrIndexStreamId(streamId: string): boolean {
  const match = /^pr-index:([^/]+)\/([^/]+)$/.exec(streamId);
  return match !== null && NAME_PATTERN.test(match[1]!) && NAME_PATTERN.test(match[2]!);
}

function eventOffset(event: Event, ordinal: number): Offset {
  const value = (event as Event & { readonly offset?: unknown }).offset;
  return typeof value === "string" && value !== OFFSET_BEFORE_FIRST && isWellFormedOffset(value)
    ? value
    : offsetForOrdinal(ordinal);
}

function rowFor(input: PrIndexInput): PrIndexRow | undefined {
  const identity = parsePrStreamId(input.prStream);
  if (identity === undefined || input.events.length === 0) return undefined;
  let state = prInitialStateForStream(input.prStream);
  let status: PrIndexStatus = "open";
  for (const [ordinal, event] of input.events.entries()) {
    const priorStatus = status;
    const offset = eventOffset(event, ordinal);
    const payload =
      event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? Object.fromEntries(
            Object.entries(event.payload).filter(
              ([key]) =>
                key !== "actor" &&
                key !== "writer" &&
                !(event.type === "pr.opened" && key === "closes"),
            ),
          )
        : event.payload;
    const indexed = { ...event, payload, offset } as Event & { readonly offset: Offset };
    const reduced = prReducer(
      { ...state, status: status === "conflicted" ? "open" : status },
      indexed,
    );
    state = reduced;
    status = reduced.status;
    if (
      priorStatus === "conflicted" &&
      event.type !== "pr.approved" &&
      event.type !== "pr.changes-requested" &&
      event.type !== "pr.closed"
    ) {
      status = "conflicted";
    }
    if (event.type === "pr.merge-conflicted" && status === "approved") status = "conflicted";
    if (
      event.type === "pr.merged" &&
      status === "approved" &&
      event.payload !== null &&
      typeof event.payload === "object" &&
      "targetMergeOffset" in event.payload
    ) {
      status = "merged";
    }
    if (event.type === "pr.closed" && status === "conflicted") status = "closed";
  }
  if (state.title === "" || state.openedAtOffset === OFFSET_BEFORE_FIRST) return undefined;
  return {
    prId: identity.prId,
    prStream: input.prStream,
    status,
    title: state.title,
    author: state.author,
    sourceBranch: state.sourceBranch,
    targetBranch: state.targetBranch,
    headOffset: eventOffset(input.events.at(-1)!, input.events.length - 1),
  };
}

export function derivePrIndex(prLogs: readonly PrIndexInput[]): PrIndexState {
  const rows = prLogs
    .map(rowFor)
    .filter((row): row is PrIndexRow => row !== undefined)
    .sort((left, right) => {
      const byHead = compareOffsets(right.headOffset, left.headOffset);
      return byHead === 0 ? left.prStream.localeCompare(right.prStream) : byHead;
    });
  return {
    rows,
    inputs: rows
      .map((row) => ({ streamId: row.prStream, offset: row.headOffset }))
      .sort((left, right) => left.streamId.localeCompare(right.streamId)),
  };
}

function exactReplacement(event: Event): event is PrIndexReplacementEvent {
  if (
    event.type !== PR_INDEX_EVENT ||
    event.payload === null ||
    typeof event.payload !== "object"
  ) {
    return false;
  }
  const payload = event.payload as Record<string, unknown>;
  return (
    payload.v === PR_INDEX_VERSION && payload.state !== null && typeof payload.state === "object"
  );
}

export function prIndexReplacementEvent(
  state: PrIndexState,
  ts = Date.now(),
): PrIndexReplacementEvent {
  return { type: PR_INDEX_EVENT, payload: { v: PR_INDEX_VERSION, state }, ts };
}

export function prIndexReducer(state: PrIndexState, event: Event): PrIndexState {
  return exactReplacement(event) ? event.payload.state : state;
}

export function prIndexDigest(state: PrIndexState): string {
  return stateDigest(state);
}
