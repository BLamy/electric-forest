import { isAgentRunStreamId, type TaskBranchRef, type TaskRole } from "@eforest/tasks";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";
import type { Event, Offset } from "@eforest/protocol";

/** Versioned event family for the durable agent-run evidence stream. */
export const RUN_EVENT_VERSION = 1 as const;
export const RUN_REDUCER_ID = "agent-run/v1" as const;

export const RUN_EVENT_TYPES = [
  "run.started",
  "run.input",
  "run.tool-result",
  "run.gate-result",
  "run.artifact",
  "run.mutation-intent",
  "run.mutation-accepted",
  "run.heartbeat",
  "run.exited",
  "run.revoked",
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export const RUN_ROLES = ["builder", "critic"] as const satisfies readonly TaskRole[];
export type RunRole = (typeof RUN_ROLES)[number];

export const RUN_TERMINAL_STATUSES = ["completed", "failed", "aborted"] as const;
export type RunTerminalStatus = (typeof RUN_TERMINAL_STATUSES)[number];

export const RUN_REVOCATION_REASONS = [
  "project-paused",
  "project-invalid",
  "lease-lost",
  "capability-revoked",
  "lease-released",
  "crashed",
] as const;
export type RunRevocationReason = (typeof RUN_REVOCATION_REASONS)[number];

const DIGEST = /^[a-f0-9]{64}$/;
const RUN_ID = /^[A-Za-z0-9._~-]{1,160}$/;
const ACTOR = /^[^\s]{1,256}$/;
const SAFE_NAME = /^[A-Za-z0-9._:/-]{1,160}$/;
const OFFSET = /^-1$|^[0-9]{16}_[0-9]{16}$/;

export interface RunStartedEvent extends Event {
  readonly type: "run.started";
  readonly payload: {
    readonly v: typeof RUN_EVENT_VERSION;
    readonly run: string;
    readonly taskId: string;
    readonly actor: string;
    readonly role: RunRole;
    readonly leaseId: string;
    readonly capabilityId: string;
    readonly branch: TaskBranchRef;
    readonly evidenceStream: string;
    readonly queueProofDigest: string;
    readonly projectOffset: Offset | "-1";
  };
}

export interface RunInputEvent extends Event {
  readonly type: "run.input";
  readonly payload: {
    readonly v: typeof RUN_EVENT_VERSION;
    readonly name: string;
    readonly digest: string;
    readonly size: number;
    readonly summary?: string;
  };
}

export interface RunToolResultEvent extends Event {
  readonly type: "run.tool-result";
  readonly payload: {
    readonly v: typeof RUN_EVENT_VERSION;
    readonly tool: string;
    readonly ok: boolean;
    readonly outputDigest: string;
    readonly summary?: string;
  };
}

export interface RunGateResultEvent extends Event {
  readonly type: "run.gate-result";
  readonly payload: {
    readonly v: typeof RUN_EVENT_VERSION;
    readonly gate: string;
    readonly ok: boolean;
    readonly exitCode: number;
    readonly outputDigest: string;
  };
}

export interface RunArtifactEvent extends Event {
  readonly type: "run.artifact";
  readonly payload: {
    readonly v: typeof RUN_EVENT_VERSION;
    readonly artifactId: string;
    readonly kind: string;
    readonly digest: string;
    readonly size: number;
  };
}

export interface RunMutationIntentEvent extends Event {
  readonly type: "run.mutation-intent";
  readonly payload: {
    readonly v: typeof RUN_EVENT_VERSION;
    readonly operationId: string;
    readonly target: "branch" | "evidence" | "verdict";
    readonly stream: string;
    readonly eventType: string;
    readonly mutationDigest: string;
    readonly expectedTargetOffset: Offset | "-1";
  };
}

export interface RunMutationAcceptedEvent extends Event {
  readonly type: "run.mutation-accepted";
  readonly payload: {
    readonly v: typeof RUN_EVENT_VERSION;
    readonly operationId: string;
    readonly target: "branch" | "evidence" | "verdict";
    readonly stream: string;
    readonly eventType: string;
    readonly targetOffset: Offset;
  };
}

export interface RunHeartbeatEvent extends Event {
  readonly type: "run.heartbeat";
  readonly payload: {
    readonly v: typeof RUN_EVENT_VERSION;
    readonly leaseFence: number;
  };
}

export interface RunExitedEvent extends Event {
  readonly type: "run.exited";
  readonly payload: {
    readonly v: typeof RUN_EVENT_VERSION;
    readonly status: Exclude<RunTerminalStatus, "aborted">;
    readonly exitCode: number;
    readonly reason?: string;
  };
}

export interface RunRevokedEvent extends Event {
  readonly type: "run.revoked";
  readonly payload: {
    readonly v: typeof RUN_EVENT_VERSION;
    readonly reason: RunRevocationReason;
  };
}

export type RunEvent =
  | RunStartedEvent
  | RunInputEvent
  | RunToolResultEvent
  | RunGateResultEvent
  | RunArtifactEvent
  | RunMutationIntentEvent
  | RunMutationAcceptedEvent
  | RunHeartbeatEvent
  | RunExitedEvent
  | RunRevokedEvent;

export type RunTraceEvent = Exclude<RunEvent, RunStartedEvent | RunExitedEvent | RunRevokedEvent>;
/** Events an agent may append directly; coordinator-owned fences stay internal. */
export type RunAppendEvent = Exclude<
  RunTraceEvent,
  RunMutationIntentEvent | RunMutationAcceptedEvent | RunHeartbeatEvent
>;

export type RunRecord = RunEvent & { readonly offset?: Offset };

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function optionalString(value: Record<string, unknown>, name: string, max: number): boolean {
  return (
    value[name] === undefined || (typeof value[name] === "string" && value[name].length <= max)
  );
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31);
  });
}

function safeString(value: unknown, pattern: RegExp = /^.+$/s): value is string {
  return typeof value === "string" && value.length > 0 && pattern.test(value);
}

function safeSummary(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 2_048 &&
    !hasControlCharacter(value) &&
    !/Bearer\s+[A-Za-z0-9._~-]+/i.test(value) &&
    !/(?:^|[\s:=])(?:ef_cli_|sk-|gh[pousr]_)[A-Za-z0-9._~-]+/i.test(value)
  );
}

function digest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

function offset(value: unknown): value is Offset | "-1" {
  return (
    typeof value === "string" && OFFSET.test(value) && (value === "-1" || isWellFormedOffset(value))
  );
}

function branchRef(value: unknown): value is TaskBranchRef {
  if (!exactObject(value, ["stream", "head"])) return false;
  return (
    safeString(value.stream, /^fs:[^\s]{1,512}:meta$/) && offset(value.head) && value.head !== "-1"
  );
}

function role(value: unknown): value is RunRole {
  return typeof value === "string" && (RUN_ROLES as readonly string[]).includes(value);
}

function runStream(value: unknown): value is string {
  return typeof value === "string" && isAgentRunStreamId(value);
}

function versionedPayload(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const expected = ["v", ...required];
  return (
    expected.every((key) => keys.includes(key)) &&
    keys.every((key) => expected.includes(key) || optional.includes(key)) &&
    record.v === RUN_EVENT_VERSION
  );
}

function eventEnvelope(value: unknown): value is Event {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    exactObject(value, ["type", "payload", "ts"]) &&
    typeof value.type === "string" &&
    typeof value.ts === "number" &&
    Number.isFinite(value.ts)
  );
}

function tracePayload(type: RunEventType, payload: unknown): boolean {
  if (type === "run.started") {
    if (
      !versionedPayload(payload, [
        "run",
        "taskId",
        "actor",
        "role",
        "leaseId",
        "capabilityId",
        "branch",
        "evidenceStream",
        "queueProofDigest",
        "projectOffset",
      ])
    )
      return false;
    return (
      runStream(payload.run) &&
      safeString(payload.taskId, RUN_ID) &&
      safeString(payload.actor, ACTOR) &&
      role(payload.role) &&
      safeString(payload.leaseId, RUN_ID) &&
      safeString(payload.capabilityId, RUN_ID) &&
      branchRef(payload.branch) &&
      safeString(payload.evidenceStream, /^evidence:[^\s]{1,512}$/) &&
      digest(payload.queueProofDigest) &&
      offset(payload.projectOffset)
    );
  }
  if (type === "run.input") {
    if (!versionedPayload(payload, ["name", "digest", "size"], ["summary"])) return false;
    return (
      safeString(payload.name, SAFE_NAME) &&
      digest(payload.digest) &&
      Number.isSafeInteger(payload.size) &&
      (payload.size as number) >= 0 &&
      (payload.size as number) <= 10_000_000 &&
      optionalString(payload, "summary", 2_048) &&
      (payload.summary === undefined || safeSummary(payload.summary))
    );
  }
  if (type === "run.tool-result") {
    if (!versionedPayload(payload, ["tool", "ok", "outputDigest"], ["summary"])) return false;
    return (
      safeString(payload.tool, SAFE_NAME) &&
      typeof payload.ok === "boolean" &&
      digest(payload.outputDigest) &&
      optionalString(payload, "summary", 2_048) &&
      (payload.summary === undefined || safeSummary(payload.summary))
    );
  }
  if (type === "run.gate-result") {
    if (!versionedPayload(payload, ["gate", "ok", "exitCode", "outputDigest"])) return false;
    return (
      safeString(payload.gate, SAFE_NAME) &&
      typeof payload.ok === "boolean" &&
      Number.isSafeInteger(payload.exitCode) &&
      (payload.exitCode as number) >= -255 &&
      (payload.exitCode as number) <= 255 &&
      digest(payload.outputDigest)
    );
  }
  if (type === "run.artifact") {
    if (!versionedPayload(payload, ["artifactId", "kind", "digest", "size"])) return false;
    return (
      safeString(payload.artifactId, RUN_ID) &&
      safeString(payload.kind, SAFE_NAME) &&
      digest(payload.digest) &&
      Number.isSafeInteger(payload.size) &&
      (payload.size as number) >= 0 &&
      (payload.size as number) <= 100_000_000
    );
  }
  if (type === "run.mutation-intent") {
    if (
      !versionedPayload(payload, [
        "operationId",
        "target",
        "stream",
        "eventType",
        "mutationDigest",
        "expectedTargetOffset",
      ])
    )
      return false;
    return (
      safeString(payload.operationId, RUN_ID) &&
      (payload.target === "branch" ||
        payload.target === "evidence" ||
        payload.target === "verdict") &&
      safeString(payload.stream, /^\S{1,512}$/) &&
      safeString(payload.eventType, SAFE_NAME) &&
      digest(payload.mutationDigest) &&
      offset(payload.expectedTargetOffset)
    );
  }
  if (type === "run.mutation-accepted") {
    if (
      !versionedPayload(payload, ["operationId", "target", "stream", "eventType", "targetOffset"])
    )
      return false;
    return (
      safeString(payload.operationId, RUN_ID) &&
      (payload.target === "branch" ||
        payload.target === "evidence" ||
        payload.target === "verdict") &&
      safeString(payload.stream, /^\S{1,512}$/) &&
      safeString(payload.eventType, SAFE_NAME) &&
      offset(payload.targetOffset) &&
      payload.targetOffset !== "-1"
    );
  }
  if (type === "run.heartbeat") {
    if (!versionedPayload(payload, ["leaseFence"])) return false;
    return Number.isSafeInteger(payload.leaseFence) && (payload.leaseFence as number) >= 1;
  }
  if (type === "run.exited") {
    if (!versionedPayload(payload, ["status", "exitCode"], ["reason"])) return false;
    return (
      (payload.status === "completed" || payload.status === "failed") &&
      Number.isSafeInteger(payload.exitCode) &&
      (payload.exitCode as number) >= -255 &&
      (payload.exitCode as number) <= 255 &&
      optionalString(payload, "reason", 2_048) &&
      (payload.reason === undefined || safeSummary(payload.reason))
    );
  }
  if (type === "run.revoked") {
    if (!versionedPayload(payload, ["reason"])) return false;
    return (RUN_REVOCATION_REASONS as readonly string[]).includes(payload.reason as string);
  }
  return false;
}

export function isRunEventType(value: string): value is RunEventType {
  return (RUN_EVENT_TYPES as readonly string[]).includes(value);
}

export function isRunEvent(value: unknown): value is RunEvent {
  return (
    eventEnvelope(value) && isRunEventType(value.type) && tracePayload(value.type, value.payload)
  );
}

export function isRunTraceEvent(value: unknown): value is RunTraceEvent {
  return (
    isRunEvent(value) &&
    value.type !== "run.started" &&
    value.type !== "run.exited" &&
    value.type !== "run.revoked"
  );
}

export function isRunAppendEvent(value: unknown): value is RunAppendEvent {
  return (
    isRunTraceEvent(value) &&
    value.type !== "run.mutation-intent" &&
    value.type !== "run.mutation-accepted" &&
    value.type !== "run.heartbeat"
  );
}

export function isRunStreamId(value: unknown): value is string {
  return runStream(value);
}

export function runStreamId(org: string, runId: string): string {
  const stream = `agent-run:${org}/${runId}`;
  if (!runStream(stream)) throw new TypeError("invalid agent run stream id");
  return stream;
}

export function runInputEvent(
  input: Omit<RunInputEvent["payload"], "v">,
  ts: number,
): RunInputEvent {
  return { type: "run.input", payload: { v: RUN_EVENT_VERSION, ...input }, ts };
}

export function runToolResultEvent(
  input: Omit<RunToolResultEvent["payload"], "v">,
  ts: number,
): RunToolResultEvent {
  return { type: "run.tool-result", payload: { v: RUN_EVENT_VERSION, ...input }, ts };
}

export function runGateResultEvent(
  input: Omit<RunGateResultEvent["payload"], "v">,
  ts: number,
): RunGateResultEvent {
  return { type: "run.gate-result", payload: { v: RUN_EVENT_VERSION, ...input }, ts };
}

export function runArtifactEvent(
  input: Omit<RunArtifactEvent["payload"], "v">,
  ts: number,
): RunArtifactEvent {
  return { type: "run.artifact", payload: { v: RUN_EVENT_VERSION, ...input }, ts };
}

export function runMutationAcceptedEvent(
  input: Omit<RunMutationAcceptedEvent["payload"], "v">,
  ts: number,
): RunMutationAcceptedEvent {
  return { type: "run.mutation-accepted", payload: { v: RUN_EVENT_VERSION, ...input }, ts };
}

export function runMutationIntentEvent(
  input: Omit<RunMutationIntentEvent["payload"], "v">,
  ts: number,
): RunMutationIntentEvent {
  return { type: "run.mutation-intent", payload: { v: RUN_EVENT_VERSION, ...input }, ts };
}

export function runHeartbeatEvent(leaseFence: number, ts: number): RunHeartbeatEvent {
  return { type: "run.heartbeat", payload: { v: RUN_EVENT_VERSION, leaseFence }, ts };
}

export function runExitedEvent(
  input: Omit<RunExitedEvent["payload"], "v">,
  ts: number,
): RunExitedEvent {
  return { type: "run.exited", payload: { v: RUN_EVENT_VERSION, ...input }, ts };
}

export function runRevokedEvent(reason: RunRevocationReason, ts: number): RunRevokedEvent {
  return { type: "run.revoked", payload: { v: RUN_EVENT_VERSION, reason }, ts };
}
