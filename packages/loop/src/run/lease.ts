import { stateDigest, type Event, type Offset } from "@eforest/protocol";
import { offsetForOrdinal, isWellFormedOffset } from "@eforest/protocol/offset-allocation";
import type { QueueProof } from "@eforest/tasks";
import type { TaskBranchRef, TaskRole } from "@eforest/tasks";

/** Durable lease-control stream version. Lease streams are separate from run evidence. */
export const LEASE_EVENT_VERSION = 1 as const;
export const LEASE_EVENT_TYPES = [
  "lease.acquired",
  "lease.heartbeat",
  "lease.released",
  "lease.revoked",
] as const;
export type LeaseEventType = (typeof LEASE_EVENT_TYPES)[number];

export const LEASE_REFUSAL_REASONS = [
  "lease/already-held",
  "lease/not-found",
  "lease/not-active",
  "lease/actor-mismatch",
  "lease/stale-fence",
  "lease/project-not-building",
  "lease/project-offset",
  "lease/queue-proof",
  "lease/task-not-eligible",
  "lease/invalid-target",
] as const;
export type LeaseRefusalReason = (typeof LEASE_REFUSAL_REASONS)[number];

const ORG = "[a-z0-9](?:-?[a-z0-9])*";
const REPO = "[a-z0-9](?:-?[a-z0-9])*";
const TASK = "[A-Za-z0-9._~-]+";
const LEASE = new RegExp(`^agent-lease:(${ORG})/(${REPO})/(${TASK})$`);
const IDENTIFIER = /^[A-Za-z0-9._~-]{1,160}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const OFFSET = /^-1$|^[0-9]{16}_[0-9]{16}$/;
const AUTHZ_NAME = /^[a-z0-9](?:-?[a-z0-9])*$/;
const QUEUE_STREAM = /^repo-issues:([a-z0-9](?:-?[a-z0-9])*)\/([a-z0-9](?:-?[a-z0-9])*)$/;

export interface LeaseRecord {
  readonly v: typeof LEASE_EVENT_VERSION;
  readonly leaseId: string;
  readonly org: string;
  readonly repo: string;
  readonly taskId: string;
  readonly runId: string;
  readonly actor: string;
  readonly role: TaskRole;
  readonly branch: TaskBranchRef;
  readonly evidenceStream: string;
  readonly queueProofDigest: string;
  readonly projectOffset: Offset | "-1";
  readonly capabilityId: string;
  /** Hash of the opaque capability token's stable base, never the base itself. */
  readonly capabilityBaseDigest: string;
  /** Hash of the currently valid fence-bound capability token. */
  readonly capabilityTokenDigest: string;
  readonly fence: number;
  readonly createdAt: number;
}

export interface LeaseAcquiredEvent extends Event {
  readonly type: "lease.acquired";
  readonly payload: { readonly v: typeof LEASE_EVENT_VERSION; readonly lease: LeaseRecord };
}

export interface LeaseHeartbeatEvent extends Event {
  readonly type: "lease.heartbeat";
  readonly payload: {
    readonly v: typeof LEASE_EVENT_VERSION;
    readonly leaseId: string;
    readonly fence: number;
    readonly capabilityTokenDigest: string;
  };
}

export interface LeaseReleasedEvent extends Event {
  readonly type: "lease.released";
  readonly payload: {
    readonly v: typeof LEASE_EVENT_VERSION;
    readonly leaseId: string;
    readonly fence: number;
  };
}

export interface LeaseRevokedEvent extends Event {
  readonly type: "lease.revoked";
  readonly payload: {
    readonly v: typeof LEASE_EVENT_VERSION;
    readonly leaseId: string;
    readonly fence: number;
    readonly reason: string;
  };
}

export type LeaseEvent =
  LeaseAcquiredEvent | LeaseHeartbeatEvent | LeaseReleasedEvent | LeaseRevokedEvent;
export type LeaseRecordWithOffset = LeaseEvent & { readonly offset?: Offset };

export interface LeaseState {
  readonly v: typeof LEASE_EVENT_VERSION;
  readonly stream: string;
  readonly head: Offset | "-1";
  readonly nextFence: number;
  readonly active: LeaseRecord | null;
  readonly lastLeaseId: string | null;
  readonly terminal: "released" | "revoked" | null;
}

export interface LeaseAdmissionInput {
  readonly taskId: string;
  readonly actor: string;
  readonly role: TaskRole;
  readonly runId: string;
  readonly leaseId: string;
  readonly branch: TaskBranchRef;
  readonly evidenceStream: string;
  readonly proof: QueueProof;
  readonly currentProof: QueueProof;
  readonly projectStatus: "building" | "complete" | "paused" | "invalid_loop";
  readonly projectOffset: Offset | "-1";
  readonly currentProjectOffset: Offset | "-1";
  readonly currentLease: LeaseState;
  readonly queueProofDigest: string;
  readonly capabilityId: string;
  readonly capabilityBaseDigest: string;
  readonly capabilityTokenDigest: string;
  readonly createdAt: number;
}

export type LeaseAdmission =
  | { readonly ok: true; readonly lease: LeaseRecord }
  | { readonly ok: false; readonly reason: LeaseRefusalReason };

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function actor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/\s/.test(value);
}

function digest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

function offset(value: unknown): value is Offset | "-1" {
  return (
    typeof value === "string" && OFFSET.test(value) && (value === "-1" || isWellFormedOffset(value))
  );
}

function role(value: unknown): value is TaskRole {
  return value === "builder" || value === "critic";
}

function branch(value: unknown): value is TaskBranchRef {
  if (!exactObject(value, ["stream", "head"])) return false;
  return (
    typeof value.stream === "string" &&
    value.stream.startsWith("fs:") &&
    offset(value.head) &&
    value.head !== "-1"
  );
}

function leaseRecord(value: unknown): value is LeaseRecord {
  if (
    !exactObject(value, [
      "v",
      "leaseId",
      "org",
      "repo",
      "taskId",
      "runId",
      "actor",
      "role",
      "branch",
      "evidenceStream",
      "queueProofDigest",
      "projectOffset",
      "capabilityId",
      "capabilityBaseDigest",
      "capabilityTokenDigest",
      "fence",
      "createdAt",
    ])
  )
    return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === LEASE_EVENT_VERSION &&
    identifier(record.leaseId) &&
    typeof record.org === "string" &&
    AUTHZ_NAME.test(record.org) &&
    typeof record.repo === "string" &&
    AUTHZ_NAME.test(record.repo) &&
    identifier(record.taskId) &&
    identifier(record.runId) &&
    actor(record.actor) &&
    role(record.role) &&
    branch(record.branch) &&
    typeof record.evidenceStream === "string" &&
    record.evidenceStream.startsWith("evidence:") &&
    digest(record.queueProofDigest) &&
    offset(record.projectOffset) &&
    identifier(record.capabilityId) &&
    digest(record.capabilityBaseDigest) &&
    digest(record.capabilityTokenDigest) &&
    Number.isSafeInteger(record.fence) &&
    (record.fence as number) >= 1 &&
    Number.isFinite(record.createdAt)
  );
}

export function leaseStreamId(org: string, repo: string, taskId: string): string {
  const stream = `agent-lease:${org}/${repo}/${taskId}`;
  if (!isLeaseStreamId(stream)) throw new TypeError("invalid agent lease stream id");
  return stream;
}

export function isLeaseStreamId(value: unknown): value is string {
  return typeof value === "string" && LEASE.test(value);
}

export function parseLeaseStreamId(
  value: string,
): { readonly org: string; readonly repo: string; readonly taskId: string } | undefined {
  const match = LEASE.exec(value);
  return match === null ? undefined : { org: match[1]!, repo: match[2]!, taskId: match[3]! };
}

export function isLeaseEvent(value: unknown): value is LeaseEvent {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exactObject(value, ["type", "payload", "ts"])
  )
    return false;
  const event = value as Record<string, unknown>;
  if (typeof event.ts !== "number" || !Number.isFinite(event.ts)) return false;
  const payload = event.payload;
  if (event.type === "lease.acquired") {
    return (
      exactObject(payload, ["v", "lease"]) &&
      payload.v === LEASE_EVENT_VERSION &&
      leaseRecord(payload.lease)
    );
  }
  if (event.type === "lease.heartbeat") {
    return (
      exactObject(payload, ["v", "leaseId", "fence", "capabilityTokenDigest"]) &&
      payload.v === LEASE_EVENT_VERSION &&
      identifier(payload.leaseId) &&
      Number.isSafeInteger(payload.fence) &&
      (payload.fence as number) >= 2 &&
      digest(payload.capabilityTokenDigest)
    );
  }
  if (event.type === "lease.released" || event.type === "lease.revoked") {
    const keys =
      event.type === "lease.revoked"
        ? ["v", "leaseId", "fence", "reason"]
        : ["v", "leaseId", "fence"];
    if (
      !exactObject(payload, keys) ||
      payload.v !== LEASE_EVENT_VERSION ||
      !identifier(payload.leaseId) ||
      !Number.isSafeInteger(payload.fence) ||
      (payload.fence as number) < 1
    )
      return false;
    return (
      event.type !== "lease.revoked" ||
      (typeof payload.reason === "string" &&
        payload.reason.length > 0 &&
        payload.reason.length <= 256)
    );
  }
  return false;
}

function recordOffset(record: unknown, index: number): Offset {
  const candidate =
    record !== null && typeof record === "object" && !Array.isArray(record)
      ? (record as Record<string, unknown>).offset
      : undefined;
  return typeof candidate === "string" && candidate !== "-1" && isWellFormedOffset(candidate)
    ? candidate
    : offsetForOrdinal(index);
}

function initial(stream: string): LeaseState {
  return {
    v: LEASE_EVENT_VERSION,
    stream,
    head: "-1",
    nextFence: 1,
    active: null,
    lastLeaseId: null,
    terminal: null,
  };
}

/** Pure lease replay. A malformed or out-of-order event cannot resurrect a lease. */
export function leaseReducer(state: LeaseState, rawEvent: Event, at?: Offset): LeaseState {
  if (!isLeaseEvent(rawEvent)) return state;
  const event = rawEvent;
  const offsetValue = at ?? recordOffset(rawEvent, 0);
  if (event.type === "lease.acquired") {
    if (state.active !== null || event.payload.lease.fence !== state.nextFence) return state;
    return {
      ...state,
      head: offsetValue,
      nextFence: state.nextFence + 1,
      active: event.payload.lease,
      lastLeaseId: event.payload.lease.leaseId,
      terminal: null,
    };
  }
  if (state.active === null || state.active.leaseId !== event.payload.leaseId) return state;
  if (event.type === "lease.heartbeat") {
    if (event.payload.fence !== state.active.fence + 1 || event.payload.fence !== state.nextFence)
      return state;
    return {
      ...state,
      head: offsetValue,
      nextFence: state.nextFence + 1,
      active: {
        ...state.active,
        fence: event.payload.fence,
        capabilityTokenDigest: event.payload.capabilityTokenDigest,
      },
    };
  }
  if (event.payload.fence !== state.active.fence) return state;
  return {
    ...state,
    head: offsetValue,
    active: null,
    lastLeaseId: state.active.leaseId,
    terminal: event.type === "lease.released" ? "released" : "revoked",
  };
}

export function leaseInitialStateForStream(stream: string): LeaseState {
  if (!isLeaseStreamId(stream)) throw new TypeError(`invalid agent lease stream: ${stream}`);
  return initial(stream);
}

export function replayLeaseLog(stream: string, records: readonly unknown[]): LeaseState {
  if (!isLeaseStreamId(stream)) throw new TypeError(`invalid agent lease stream: ${stream}`);
  return records.reduce<LeaseState>((state, record, index) => {
    if (record === null || typeof record !== "object" || Array.isArray(record)) return state;
    const value = record as Record<string, unknown>;
    const event: Event = {
      type: value.type as string,
      payload: value.payload,
      ts: value.ts as number,
    };
    if (!isLeaseEvent(event)) return state;
    return leaseReducer(state, event, recordOffset(record, index));
  }, initial(stream));
}

export function leaseStateDigest(state: LeaseState): string {
  return stateDigest(state);
}

export function admitLease(input: LeaseAdmissionInput): LeaseAdmission {
  if (input.projectStatus !== "building")
    return { ok: false, reason: "lease/project-not-building" };
  if (input.projectOffset !== input.currentProjectOffset)
    return { ok: false, reason: "lease/project-offset" };
  if (input.proof.digest !== input.currentProof.digest)
    return { ok: false, reason: "lease/queue-proof" };
  if (
    input.currentProof.decision.kind !== "eligible" &&
    input.currentProof.decision.kind !== "rework"
  ) {
    return { ok: false, reason: "lease/task-not-eligible" };
  }
  if (input.currentProof.decision.nextEligible !== input.taskId)
    return { ok: false, reason: "lease/task-not-eligible" };
  if (input.currentLease.active !== null) return { ok: false, reason: "lease/already-held" };
  const queueIdentity = QUEUE_STREAM.exec(input.proof.queue.stream);
  if (queueIdentity === null) return { ok: false, reason: "lease/invalid-target" };
  const [org, repo] = queueIdentity.slice(1) as [string, string];
  let expectedLeaseStream: string;
  try {
    expectedLeaseStream = leaseStreamId(org, repo, input.taskId);
  } catch {
    return { ok: false, reason: "lease/invalid-target" };
  }
  const parsed = parseLeaseStreamId(expectedLeaseStream);
  if (
    parsed === undefined ||
    parsed.org !== org ||
    parsed.repo !== repo ||
    !input.branch.stream.startsWith(`fs:${org}/${repo}:`) ||
    input.evidenceStream !== `evidence:${org}/${repo}/issue/${input.taskId}`
  ) {
    return { ok: false, reason: "lease/invalid-target" };
  }
  return {
    ok: true,
    lease: {
      v: LEASE_EVENT_VERSION,
      leaseId: input.leaseId,
      org,
      repo,
      taskId: input.taskId,
      runId: input.runId,
      actor: input.actor,
      role: input.role,
      branch: input.branch,
      evidenceStream: input.evidenceStream,
      queueProofDigest: input.queueProofDigest,
      projectOffset: input.projectOffset,
      capabilityId: input.capabilityId,
      capabilityBaseDigest: input.capabilityBaseDigest,
      capabilityTokenDigest: input.capabilityTokenDigest,
      fence: input.currentLease.nextFence,
      createdAt: input.createdAt,
    },
  };
}

export function leaseAcquiredEvent(lease: LeaseRecord, ts: number): LeaseAcquiredEvent {
  return { type: "lease.acquired", payload: { v: LEASE_EVENT_VERSION, lease }, ts };
}

export function leaseHeartbeatEvent(
  leaseId: string,
  fence: number,
  capabilityTokenDigest: string,
  ts: number,
): LeaseHeartbeatEvent {
  return {
    type: "lease.heartbeat",
    payload: { v: LEASE_EVENT_VERSION, leaseId, fence, capabilityTokenDigest },
    ts,
  };
}

export function leaseReleasedEvent(leaseId: string, fence: number, ts: number): LeaseReleasedEvent {
  return { type: "lease.released", payload: { v: LEASE_EVENT_VERSION, leaseId, fence }, ts };
}

export function leaseRevokedEvent(
  leaseId: string,
  fence: number,
  reason: string,
  ts: number,
): LeaseRevokedEvent {
  return { type: "lease.revoked", payload: { v: LEASE_EVENT_VERSION, leaseId, fence, reason }, ts };
}
