import {
  canonicalJson,
  OFFSET_BEFORE_FIRST,
  stateDigest,
  type Event,
  type Offset,
} from "@eforest/protocol";
import { offsetForOrdinal, isWellFormedOffset } from "@eforest/protocol/offset-allocation";
import {
  isRunEvent,
  isRunEventType,
  isRunStreamId,
  type RunEvent,
  type RunRecord,
  type RunRole,
  type RunTerminalStatus,
} from "./events.js";

export type RunStatus = "created" | "running" | "completed" | "failed" | "aborted";

export interface RunState {
  readonly v: 1;
  readonly stream: string;
  readonly runId: string;
  readonly taskId: string;
  readonly actor: string;
  readonly role: RunRole;
  readonly leaseId: string;
  readonly capabilityId: string;
  readonly branch: { readonly stream: string; readonly head: Offset };
  readonly evidenceStream: string;
  readonly queueProofDigest: string;
  readonly projectOffset: Offset | "-1";
  readonly status: RunStatus;
  readonly head: Offset | "-1";
  readonly inputs: number;
  readonly toolResults: number;
  readonly gateResults: number;
  readonly artifacts: number;
  readonly heartbeats: number;
  readonly mutationIntents: readonly string[];
  readonly mutationIds: readonly string[];
  readonly terminal?: {
    readonly type: "run.exited" | "run.revoked";
    readonly status: RunTerminalStatus;
  };
}

export class RunProtocolError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "RunProtocolError";
  }
}

function eventOffset(record: RunRecord | Event, index: number): Offset {
  const candidate = (record as Event & { readonly offset?: unknown }).offset;
  if (
    typeof candidate === "string" &&
    candidate !== OFFSET_BEFORE_FIRST &&
    isWellFormedOffset(candidate)
  ) {
    return candidate;
  }
  return offsetForOrdinal(index);
}

function cleanRecord(record: unknown): Event {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new RunProtocolError("run/malformed-record");
  }
  const value = record as Record<string, unknown>;
  if (
    typeof value.type !== "string" ||
    typeof value.ts !== "number" ||
    !Number.isFinite(value.ts)
  ) {
    throw new RunProtocolError("run/malformed-record");
  }
  return { type: value.type, payload: value.payload, ts: value.ts };
}

function initial(stream: string): RunState {
  return {
    v: 1,
    stream,
    runId: "",
    taskId: "",
    actor: "",
    role: "builder",
    leaseId: "",
    capabilityId: "",
    branch: { stream: "", head: OFFSET_BEFORE_FIRST },
    evidenceStream: "",
    queueProofDigest: "",
    projectOffset: OFFSET_BEFORE_FIRST,
    status: "created",
    head: OFFSET_BEFORE_FIRST,
    inputs: 0,
    toolResults: 0,
    gateResults: 0,
    artifacts: 0,
    heartbeats: 0,
    mutationIntents: [],
    mutationIds: [],
  };
}

function startedState(
  state: RunState,
  event: Extract<RunEvent, { type: "run.started" }>,
  at: Offset,
): RunState {
  const payload = event.payload;
  const separator = payload.run.lastIndexOf("/");
  return {
    ...state,
    runId: separator < 0 ? "" : payload.run.slice(separator + 1),
    taskId: payload.taskId,
    actor: payload.actor,
    role: payload.role,
    leaseId: payload.leaseId,
    capabilityId: payload.capabilityId,
    branch: payload.branch,
    evidenceStream: payload.evidenceStream,
    queueProofDigest: payload.queueProofDigest,
    projectOffset: payload.projectOffset,
    status: "running",
    head: at,
  };
}

/** Pure replay reducer. Invalid or out-of-lifecycle records are deterministic no-ops. */
export function runReducer(state: RunState, rawEvent: Event, at?: Offset): RunState {
  const event = cleanRecord(rawEvent);
  if (!isRunEvent(event)) return state;
  const offset = at ?? eventOffset(rawEvent, 0);
  if (event.type === "run.started") {
    if (state.status !== "created" || state.runId !== "") return state;
    if (!isRunStreamId(event.payload.run) || event.payload.run !== state.stream) return state;
    return startedState(state, event, offset);
  }
  if (state.status !== "running") return state;
  switch (event.type) {
    case "run.input":
      return { ...state, inputs: state.inputs + 1, head: offset };
    case "run.tool-result":
      return { ...state, toolResults: state.toolResults + 1, head: offset };
    case "run.gate-result":
      return { ...state, gateResults: state.gateResults + 1, head: offset };
    case "run.artifact":
      return { ...state, artifacts: state.artifacts + 1, head: offset };
    case "run.heartbeat":
      return { ...state, heartbeats: state.heartbeats + 1, head: offset };
    case "run.mutation-intent":
      return state.mutationIntents.includes(event.payload.operationId)
        ? { ...state, head: offset }
        : {
            ...state,
            mutationIntents: [...state.mutationIntents, event.payload.operationId],
            head: offset,
          };
    case "run.mutation-accepted": {
      if (state.mutationIds.includes(event.payload.operationId)) return { ...state, head: offset };
      return {
        ...state,
        mutationIds: [...state.mutationIds, event.payload.operationId],
        head: offset,
      };
    }
    case "run.exited":
      return {
        ...state,
        status: event.payload.status,
        head: offset,
        terminal: { type: event.type, status: event.payload.status },
      };
    case "run.revoked":
      return {
        ...state,
        status: "aborted",
        head: offset,
        terminal: { type: event.type, status: "aborted" },
      };
    default:
      return state;
  }
}

export function runInitialStateForStream(stream: string): RunState {
  if (!isRunStreamId(stream)) throw new TypeError(`invalid agent run stream: ${stream}`);
  return initial(stream);
}

export function replayRunLog(stream: string, records: readonly unknown[]): RunState {
  if (!isRunStreamId(stream)) throw new TypeError(`invalid agent run stream: ${stream}`);
  return records.reduce<RunState>((state, record, index) => {
    const clean = cleanRecord(record);
    if (!isRunEventType(clean.type) || !isRunEvent(clean)) return state;
    return runReducer(state, clean, eventOffset(record as RunRecord, index));
  }, initial(stream));
}

export function runStateDigest(state: RunState): string {
  return stateDigest(state);
}

export function runLogDigest(records: readonly unknown[]): string {
  const normalized = records.map((record, index) => {
    const event = cleanRecord(record);
    return { ...event, offset: eventOffset(record as RunRecord, index) };
  });
  return stateDigest(normalized);
}

export function runProjectionBytes(state: RunState): string {
  return `${canonicalJson({ ...state, digest: runStateDigest(state) })}\n`;
}

export function isRunTerminal(state: RunState): boolean {
  return state.status === "completed" || state.status === "failed" || state.status === "aborted";
}
