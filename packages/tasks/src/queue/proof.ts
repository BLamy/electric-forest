/**
 * Queue proofs (E6-T04): a `QueueProof` is the projector's decision bound to every source
 * head it consumed. It is a claim to be checked, never a source: `checkQueueProof`
 * re-derives the projection from the current sources and refuses a proof whose cited
 * heads have moved (`queue/stale-proof`) or whose digest or decision does not match what
 * replay says (`queue/false-proof`). `admitSelection` is the fence a loop runner passes
 * a proof through before starting the task it names.
 *
 * Shapes align with E6-T03: `queue` is a `ProjectQueueRef` (`{stream, offset}` of the
 * issue catalog) and every `tasks[]` entry is a `ProjectProofTask` (`{id, status,
 * capstone}`), so a completion proof can be assembled from a queue proof directly.
 */
import type { Offset } from "@eforest/protocol";
import type { TaskStatus } from "../state.js";
import type { QueueDecision } from "./eligibility.js";
import {
  projectQueue,
  queueDigest,
  type QueueProjection,
  type QueueSourceHead,
  type QueueSources,
} from "./projector.js";

export const QUEUE_PROOF_VERSION = 1 as const;

export interface QueueProofTask {
  readonly id: string;
  readonly status: TaskStatus;
  readonly capstone: boolean;
}

export interface QueueProof {
  readonly v: typeof QUEUE_PROOF_VERSION;
  /** The issue catalog head the queue was derived at (E6-T03 `ProjectQueueRef` shape). */
  readonly queue: QueueSourceHead;
  /** Every task stream head consumed, sorted by stream id. */
  readonly heads: readonly QueueSourceHead[];
  /** Every ordered member (E6-T03 `ProjectProofTask` shape). */
  readonly tasks: readonly QueueProofTask[];
  /** The capstone that completes the repository: the last capstone in queue order, if any. */
  readonly finalCapstone: string | null;
  readonly digest: string;
  readonly decision: QueueDecision;
}

export const QUEUE_PROOF_REFUSAL_REASONS = [
  /** A cited source head (catalog or any task stream) is no longer the current head. */
  "queue/stale-proof",
  /** Heads match but the digest or decision is not what replay derives. */
  "queue/false-proof",
  /** The proof is valid but does not name the requested task as `nextEligible`. */
  "queue/not-eligible",
  /** The proof is an invalid-queue proof: nothing may be selected from it. */
  "queue/invalid",
] as const;
export type QueueProofRefusalReason = (typeof QUEUE_PROOF_REFUSAL_REASONS)[number];

export interface QueueProofRefusal {
  readonly ok: false;
  readonly reason: QueueProofRefusalReason;
  /** The head that moved (`queue/stale-proof`): the cited head and the current one. */
  readonly stale?: {
    readonly stream: string;
    readonly cited: Offset | "-1";
    readonly current: Offset | "-1";
  };
  readonly current: QueueProof;
}

export type QueueProofCheck =
  { readonly ok: true; readonly current: QueueProof } | QueueProofRefusal;

export function queueProof(projection: QueueProjection): QueueProof {
  const capstones = projection.tasks.filter((task) => task.capstone);
  return {
    v: QUEUE_PROOF_VERSION,
    queue: projection.sources.catalog,
    heads: projection.sources.tasks,
    tasks: projection.tasks.map((task) => ({
      id: task.id,
      status: task.status,
      capstone: task.capstone,
    })),
    finalCapstone: capstones.at(-1)?.id ?? null,
    digest: queueDigest(projection),
    decision: projection.decision,
  };
}

function sameHead(a: QueueSourceHead, b: QueueSourceHead): boolean {
  return a.stream === b.stream && a.offset === b.offset;
}

function firstMovedHead(
  cited: QueueProof,
  current: QueueProof,
): QueueProofRefusal["stale"] | undefined {
  if (!sameHead(cited.queue, current.queue)) {
    return {
      stream: current.queue.stream,
      cited: cited.queue.offset,
      current: current.queue.offset,
    };
  }
  const currentByStream = new Map(current.heads.map((head) => [head.stream, head.offset]));
  for (const head of cited.heads) {
    const now = currentByStream.get(head.stream);
    if (now === undefined) return { stream: head.stream, cited: head.offset, current: "-1" };
    if (now !== head.offset) return { stream: head.stream, cited: head.offset, current: now };
  }
  for (const head of current.heads) {
    if (!cited.heads.some((candidate) => candidate.stream === head.stream)) {
      return { stream: head.stream, cited: "-1", current: head.offset };
    }
  }
  return undefined;
}

function canonicalEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/**
 * Hold a proof against the current sources. Stale beats false: a moved head is reported
 * as `queue/stale-proof` with the exact stream and both offsets before anything else is
 * compared, so a runner learns *which* source advanced under it.
 */
export function checkQueueProof(proof: QueueProof, sources: QueueSources): QueueProofCheck {
  const current = queueProof(projectQueue(sources));
  const stale = firstMovedHead(proof, current);
  if (stale !== undefined) return { ok: false, reason: "queue/stale-proof", stale, current };
  if (
    proof.v !== current.v ||
    proof.digest !== current.digest ||
    !canonicalEqual(proof.decision, current.decision) ||
    !canonicalEqual(proof.tasks, current.tasks) ||
    proof.finalCapstone !== current.finalCapstone
  ) {
    return { ok: false, reason: "queue/false-proof", current };
  }
  return { ok: true, current };
}

/**
 * The selection fence: may `taskId` be started on the strength of `proof`? Only a fresh,
 * true, valid proof that names exactly that task as `nextEligible` admits it.
 */
export function admitSelection(
  proof: QueueProof,
  taskId: string,
  sources: QueueSources,
): QueueProofCheck {
  const check = checkQueueProof(proof, sources);
  if (!check.ok) return check;
  const decision = check.current.decision;
  if (decision.kind === "invalid")
    return { ok: false, reason: "queue/invalid", current: check.current };
  if (decision.nextEligible !== taskId)
    return { ok: false, reason: "queue/not-eligible", current: check.current };
  return check;
}
