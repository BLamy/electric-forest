import { sha256Hex } from "@eforest/protocol";
import type { TaskRole } from "@eforest/tasks";
import type { LeaseRecord, LeaseState } from "./lease.js";

export const CAPABILITY_VERSION = 1 as const;
export const CAPABILITY_REFUSAL_REASONS = [
  "capability/invalid-token",
  "capability/unknown",
  "capability/revoked",
  "capability/stale-fence",
  "capability/role",
  "capability/foreign-target",
  "capability/branch-read-only",
] as const;
export type CapabilityRefusalReason = (typeof CAPABILITY_REFUSAL_REASONS)[number];

export const CAPABILITY_OPERATIONS = [
  "run.append",
  "branch.read",
  "branch.write",
  "evidence.append",
  "verdict.append",
] as const;
export type CapabilityOperation = (typeof CAPABILITY_OPERATIONS)[number];

export type CapabilityTarget =
  | { readonly kind: "run"; readonly stream: string }
  | { readonly kind: "branch"; readonly stream: string }
  | { readonly kind: "evidence"; readonly stream: string }
  | { readonly kind: "verdict"; readonly stream: string };

export interface AgentCapability {
  readonly v: typeof CAPABILITY_VERSION;
  readonly capabilityId: string;
  readonly leaseId: string;
  readonly org: string;
  readonly repo: string;
  readonly taskId: string;
  readonly runId: string;
  readonly actor: string;
  readonly role: TaskRole;
  readonly branchStream: string;
  readonly runStream: string;
  readonly evidenceStream: string;
  readonly verdictStream: string;
  readonly leaseFence: number;
  readonly tokenDigest: string;
}

export interface IssuedCapability {
  readonly capability: AgentCapability;
  /** Returned once to the caller; never included in a run or lease event. */
  readonly token: string;
}

export type CapabilityDecision =
  | { readonly allowed: true; readonly operation: CapabilityOperation; readonly stream: string }
  | { readonly allowed: false; readonly reason: CapabilityRefusalReason };

const ID = /^[A-Za-z0-9._~-]{1,160}$/;
const ORG = /^[a-z0-9](?:-?[a-z0-9])*$/;
const DIGEST = /^[a-f0-9]{64}$/;
const BASE = /^[A-Za-z0-9_-]{16,256}$/;
const TOKEN = /^cap_v1\.([A-Za-z0-9_-]{16,256})\.([1-9][0-9]*)$/;

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function digestToken(value: string): string {
  return sha256Hex(new TextEncoder().encode(value));
}

export function capabilityTokenForFence(baseOrToken: string, fence: number): string {
  const match = TOKEN.exec(baseOrToken);
  const base = match?.[1] ?? baseOrToken;
  if (!BASE.test(base) || !Number.isSafeInteger(fence) || fence < 1) {
    throw new TypeError("invalid capability token inputs");
  }
  return `cap_v1.${base}.${fence}`;
}

export function parseCapabilityToken(
  token: string,
): { readonly base: string; readonly fence: number } | undefined {
  const match = TOKEN.exec(token);
  if (match === null) return undefined;
  const fence = Number(match[2]);
  return Number.isSafeInteger(fence) ? { base: match[1]!, fence } : undefined;
}

export function capabilityBaseDigest(token: string): string {
  const parsed = parseCapabilityToken(token);
  if (parsed === undefined) throw new TypeError("invalid capability token");
  return digestToken(parsed.base);
}

export function capabilityTokenDigest(token: string): string {
  if (parseCapabilityToken(token) === undefined) throw new TypeError("invalid capability token");
  return digestToken(token);
}

export function issueCapability(
  lease: Omit<LeaseRecord, "capabilityBaseDigest" | "capabilityTokenDigest">,
  tokenBase: string,
): IssuedCapability {
  const token = capabilityTokenForFence(tokenBase, lease.fence);
  return {
    token,
    capability: {
      v: CAPABILITY_VERSION,
      capabilityId: lease.capabilityId,
      leaseId: lease.leaseId,
      org: lease.org,
      repo: lease.repo,
      taskId: lease.taskId,
      runId: lease.runId,
      actor: lease.actor,
      role: lease.role,
      branchStream: lease.branch.stream,
      runStream: `agent-run:${lease.org}/${lease.runId}`,
      evidenceStream: lease.evidenceStream,
      verdictStream: `issue:${lease.org}/${lease.repo}/${lease.taskId}`,
      leaseFence: lease.fence,
      tokenDigest: capabilityTokenDigest(token),
    },
  };
}

export function capabilityForLease(lease: LeaseRecord, token: string): AgentCapability {
  const parsed = parseCapabilityToken(token);
  if (parsed === undefined || parsed.fence !== lease.fence)
    throw new TypeError("stale capability token");
  if (capabilityTokenDigest(token) !== lease.capabilityTokenDigest)
    throw new TypeError("unknown capability token");
  return {
    v: CAPABILITY_VERSION,
    capabilityId: lease.capabilityId,
    leaseId: lease.leaseId,
    org: lease.org,
    repo: lease.repo,
    taskId: lease.taskId,
    runId: lease.runId,
    actor: lease.actor,
    role: lease.role,
    branchStream: lease.branch.stream,
    runStream: `agent-run:${lease.org}/${lease.runId}`,
    evidenceStream: lease.evidenceStream,
    verdictStream: `issue:${lease.org}/${lease.repo}/${lease.taskId}`,
    leaseFence: lease.fence,
    tokenDigest: lease.capabilityTokenDigest,
  };
}

export function isAgentCapability(value: unknown): value is AgentCapability {
  if (
    !exactObject(value, [
      "v",
      "capabilityId",
      "leaseId",
      "org",
      "repo",
      "taskId",
      "runId",
      "actor",
      "role",
      "branchStream",
      "runStream",
      "evidenceStream",
      "verdictStream",
      "leaseFence",
      "tokenDigest",
    ])
  )
    return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === CAPABILITY_VERSION &&
    ID.test(String(record.capabilityId)) &&
    ID.test(String(record.leaseId)) &&
    typeof record.org === "string" &&
    ORG.test(record.org) &&
    typeof record.repo === "string" &&
    ORG.test(record.repo) &&
    ID.test(String(record.taskId)) &&
    ID.test(String(record.runId)) &&
    typeof record.actor === "string" &&
    record.actor.length > 0 &&
    (record.role === "builder" || record.role === "critic") &&
    typeof record.branchStream === "string" &&
    record.branchStream.startsWith("fs:") &&
    typeof record.runStream === "string" &&
    record.runStream === `agent-run:${record.org}/${record.runId}` &&
    typeof record.evidenceStream === "string" &&
    record.evidenceStream === `evidence:${record.org}/${record.repo}/issue/${record.taskId}` &&
    typeof record.verdictStream === "string" &&
    record.verdictStream === `issue:${record.org}/${record.repo}/${record.taskId}` &&
    Number.isSafeInteger(record.leaseFence) &&
    (record.leaseFence as number) >= 1 &&
    typeof record.tokenDigest === "string" &&
    DIGEST.test(record.tokenDigest)
  );
}

function branchTargetMatches(branchStream: string, target: string): boolean {
  if (target === branchStream) return true;
  if (!branchStream.endsWith(":meta")) return false;
  return (
    target.startsWith(`${branchStream.slice(0, -5)}:file:`) &&
    target.length > branchStream.length + 1
  );
}

function activeFenceMatches(
  capability: AgentCapability,
  token: string,
  lease: LeaseRecord | null,
  leaseState?: LeaseState,
): CapabilityRefusalReason | undefined {
  if (lease === null) return "capability/unknown";
  if (leaseState?.active === null || leaseState?.active?.leaseId !== lease.leaseId)
    return "capability/revoked";
  const parsed = parseCapabilityToken(token);
  if (parsed === undefined) return "capability/invalid-token";
  if (parsed.fence !== lease.fence || capabilityTokenDigest(token) !== lease.capabilityTokenDigest)
    return "capability/stale-fence";
  if (
    capability.leaseId !== lease.leaseId ||
    capability.capabilityId !== lease.capabilityId ||
    capability.leaseFence !== lease.fence ||
    capability.tokenDigest !== lease.capabilityTokenDigest
  )
    return "capability/stale-fence";
  return undefined;
}

/** Decide a capability operation without reading any target stream. */
export function authorizeCapability(input: {
  readonly capability: AgentCapability;
  readonly token: string;
  readonly lease: LeaseRecord | null;
  readonly leaseState?: LeaseState;
  readonly operation: CapabilityOperation;
  readonly target: CapabilityTarget;
}): CapabilityDecision {
  const refusal = activeFenceMatches(input.capability, input.token, input.lease, input.leaseState);
  if (refusal !== undefined) return { allowed: false, reason: refusal };
  const capability = input.capability;
  const target = input.target;
  if (input.operation === "run.append") {
    return target.kind === "run" && target.stream === capability.runStream
      ? { allowed: true, operation: input.operation, stream: target.stream }
      : { allowed: false, reason: "capability/foreign-target" };
  }
  if (input.operation === "branch.read") {
    return target.kind === "branch" && branchTargetMatches(capability.branchStream, target.stream)
      ? { allowed: true, operation: input.operation, stream: target.stream }
      : { allowed: false, reason: "capability/foreign-target" };
  }
  if (input.operation === "branch.write") {
    if (capability.role !== "builder")
      return { allowed: false, reason: "capability/branch-read-only" };
    return target.kind === "branch" && branchTargetMatches(capability.branchStream, target.stream)
      ? { allowed: true, operation: input.operation, stream: target.stream }
      : { allowed: false, reason: "capability/foreign-target" };
  }
  if (input.operation === "evidence.append") {
    return target.kind === "evidence" && target.stream === capability.evidenceStream
      ? { allowed: true, operation: input.operation, stream: target.stream }
      : { allowed: false, reason: "capability/foreign-target" };
  }
  if (capability.role !== "critic") return { allowed: false, reason: "capability/role" };
  return target.kind === "verdict" && target.stream === capability.verdictStream
    ? { allowed: true, operation: input.operation, stream: target.stream }
    : { allowed: false, reason: "capability/foreign-target" };
}
