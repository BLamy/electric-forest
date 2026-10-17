import { stateDigest, type Event } from "@eforest/protocol";

/**
 * Agent run log (`agent-run:<org>/<runId>`): everything an agent run did, verbatim.
 *
 * `agent.run.started` records who ran, on what, and why; `agent.run.output` carries the
 * harness's raw output lines (Claude Code `stream-json`, Codex `exec --json`, and stderr)
 * in gap-free `seq` order; `agent.run.finished` records the outcome. Nothing is parsed or
 * summarized on the way in — the log is the run, and replaying it is how you inspect it.
 */
export const AGENT_RUN_EVENT_VERSION = 1 as const;
export const AGENT_RUN_REDUCER = "agent-run" as const;
/** One raw output line; longer lines are split by the recorder, never truncated. */
export const AGENT_RUN_LINE_MAX_CODE_UNITS = 64 * 1024;
export const AGENT_RUN_BATCH_MAX_LINES = 256;

const ORG_PATTERN = "[a-z0-9](?:-?[a-z0-9])*";
const RUN_ID_PATTERN = "[a-z0-9][a-z0-9-]{0,79}";
const AGENT_RUN_RE = new RegExp(`^agent-run:(${ORG_PATTERN})/(${RUN_ID_PATTERN})$`);
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export type AgentRunActionType = "agent.run.started" | "agent.run.output" | "agent.run.finished";
export type AgentRunChannel = "stdout" | "stderr";
export type AgentRunStatus = "running" | "succeeded" | "failed";

export function isAgentRunActionType(type: string): type is AgentRunActionType {
  return (
    type === "agent.run.started" || type === "agent.run.output" || type === "agent.run.finished"
  );
}

export function agentRunStreamId(org: string, runId: string): string {
  return `agent-run:${org}/${runId}`;
}

export function parseAgentRunStreamId(
  streamId: string,
): { readonly org: string; readonly runId: string } | undefined {
  const match = AGENT_RUN_RE.exec(streamId);
  return match === null ? undefined : { org: match[1]!, runId: match[2]! };
}

export function isAgentRunStreamId(streamId: string): boolean {
  return AGENT_RUN_RE.test(streamId);
}

export interface AgentRunCodebase {
  readonly org: string;
  readonly repo: string;
  readonly branch: string;
}

export interface AgentRunState {
  readonly started: boolean;
  readonly handle: string | null;
  readonly harness: string | null;
  readonly status: AgentRunStatus | null;
  readonly trigger: { readonly streamId: string; readonly messageId: string } | null;
  readonly codebase: AgentRunCodebase | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  /** Next expected output line number (lines recorded so far). */
  readonly lines: number;
  readonly summary: string | null;
  readonly error: string | null;
  readonly pullRequest: string | null;
}

export const agentRunInitialState: AgentRunState = Object.freeze({
  started: false,
  handle: null,
  harness: null,
  status: null,
  trigger: null,
  codebase: null,
  startedAt: null,
  finishedAt: null,
  lines: 0,
  summary: null,
  error: null,
  pullRequest: null,
});

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function shortString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function optionalKeys(value: Record<string, unknown>, required: string[], optional: string[]) {
  const present = optional.filter((key) => Object.hasOwn(value, key));
  return exactObject(value, [...required, ...present]);
}

function isCodebase(value: unknown): value is AgentRunCodebase {
  return (
    exactObject(value, ["org", "repo", "branch"]) &&
    shortString(value.org, 40) &&
    shortString(value.repo, 40) &&
    shortString(value.branch, 64)
  );
}

/** Client-authored payload shape (before the gateway stamps `actor`). */
export function isAgentRunDispatchPayload(type: string, payload: unknown): boolean {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  if (value.v !== AGENT_RUN_EVENT_VERSION) return false;
  if (type === "agent.run.started") {
    if (!optionalKeys(value, ["v", "handle", "harness", "model", "trigger"], ["codebase"])) {
      return false;
    }
    const trigger = value.trigger;
    return (
      typeof value.handle === "string" &&
      HANDLE_RE.test(value.handle) &&
      shortString(value.harness, 64) &&
      shortString(value.model, 128) &&
      exactObject(trigger, ["streamId", "messageId"]) &&
      shortString(trigger.streamId, 200) &&
      shortString(trigger.messageId, 80) &&
      (value.codebase === undefined || isCodebase(value.codebase))
    );
  }
  if (type === "agent.run.output") {
    if (!exactObject(value, ["v", "seq", "channel", "lines"])) return false;
    return (
      Number.isSafeInteger(value.seq) &&
      (value.seq as number) >= 0 &&
      (value.channel === "stdout" || value.channel === "stderr") &&
      Array.isArray(value.lines) &&
      value.lines.length > 0 &&
      value.lines.length <= AGENT_RUN_BATCH_MAX_LINES &&
      value.lines.every(
        (line) => typeof line === "string" && line.length <= AGENT_RUN_LINE_MAX_CODE_UNITS,
      )
    );
  }
  if (type === "agent.run.finished") {
    if (!optionalKeys(value, ["v", "status"], ["exitCode", "summary", "error", "pullRequest"])) {
      return false;
    }
    return (
      (value.status === "succeeded" || value.status === "failed") &&
      (value.exitCode === undefined ||
        value.exitCode === null ||
        Number.isSafeInteger(value.exitCode)) &&
      (value.summary === undefined || shortString(value.summary, 64 * 1024)) &&
      (value.error === undefined || shortString(value.error, 8 * 1024)) &&
      (value.pullRequest === undefined || shortString(value.pullRequest, 200))
    );
  }
  return false;
}

function withoutWriter(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "writer"));
}

/** Committed event shape: the client payload plus the gateway-stamped `actor`. */
export function isAgentRunEvent(event: Event): boolean {
  if (!isAgentRunActionType(event.type)) return false;
  if (event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return false;
  }
  const { actor, ...rest } = withoutWriter(event.payload as Record<string, unknown>);
  return (
    typeof actor === "string" && actor.length > 0 && isAgentRunDispatchPayload(event.type, rest)
  );
}

/**
 * Why `event` cannot extend `state`, or undefined when it can. Shared by the reducer
 * (which ignores refused events on replay) and the gateway validator (which refuses them).
 */
export function agentRunRefusal(state: AgentRunState, event: Event): string | undefined {
  const payload = event.payload as Record<string, unknown> & { actor: string };
  if (event.type === "agent.run.started") {
    if (state.started) return "agent-run/already-started";
    if (payload.actor !== `agent:${String(payload.handle)}`) return "agent-run/not-the-agent";
    return undefined;
  }
  if (!state.started) return "agent-run/not-started";
  if (payload.actor !== `agent:${String(state.handle)}`) return "agent-run/not-the-agent";
  if (state.status !== "running") return "agent-run/finished";
  if (event.type === "agent.run.output" && payload.seq !== state.lines) {
    return "agent-run/sequence-gap";
  }
  return undefined;
}

export function agentRunReducer(state: AgentRunState, event: Event): AgentRunState {
  if (!isAgentRunEvent(event) || agentRunRefusal(state, event) !== undefined) return state;
  const payload = event.payload as Record<string, unknown>;
  if (event.type === "agent.run.started") {
    return {
      ...state,
      started: true,
      handle: payload.handle as string,
      harness: payload.harness as string,
      status: "running",
      trigger: payload.trigger as AgentRunState["trigger"],
      codebase: (payload.codebase as AgentRunCodebase | undefined) ?? null,
      startedAt: event.ts,
    };
  }
  if (event.type === "agent.run.output") {
    return { ...state, lines: state.lines + (payload.lines as string[]).length };
  }
  return {
    ...state,
    status: payload.status as AgentRunStatus,
    finishedAt: event.ts,
    summary: (payload.summary as string | undefined) ?? null,
    error: (payload.error as string | undefined) ?? null,
    pullRequest: (payload.pullRequest as string | undefined) ?? null,
  };
}

export const agentRunReducerDefinition = Object.freeze({
  id: AGENT_RUN_REDUCER,
  version: AGENT_RUN_EVENT_VERSION,
  initialState: agentRunInitialState,
  reduce: agentRunReducer as (state: unknown, event: Event) => unknown,
  digest: stateDigest,
  matchesStream: isAgentRunStreamId,
});
