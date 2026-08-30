/**
 * Queue eligibility (E6-T04): the pure rules of `.eforest/tasks/README.md` and
 * `tools/build_queue.py`, decided over replayed task state instead of frontmatter files.
 *
 * - Ordering is ascending numeric priority, then id (code-unit order).
 * - A dependency `E<n>-T<nn>` is satisfied only by a `verified` task of that id.
 * - A bare dependency `E<n>` is satisfied only by that epic's unique `verified` capstone.
 * - Only a `pending` or `refuted` task can be selected; at most one task may be active
 *   (`in-progress`, `implemented`, or `refuted`) at a time.
 * - Cycles, duplicate ids, missing dependencies, a completed epic without a capstone, an
 *   epic with several capstones, a capstone that is not its epic's final task, and a
 *   fractional priority without a stated reason invalidate the whole queue: the answer
 *   is an *invalid proof*, never a quietly empty queue.
 *
 * Nothing here reads a stream, a file, a clock, or randomness.
 */
import type { TaskStatus } from "../state.js";

/**
 * Sabotage sentinel for the critic's attack 5: this constant guards bare-epic dependency
 * resolution. With the guard removed a bare `E<n>` dependency is satisfied by *any*
 * verified task of the epic, and the frozen fixture where a non-capstone verifies before
 * the capstone (`bare-epic-noncapstone-first`) turns verify-E6-T04 red.
 */
export const E6_T04_BARE_EPIC_GUARD = true;

export const QUEUE_ACTIVE_STATUSES: readonly TaskStatus[] = [
  "in-progress",
  "implemented",
  "refuted",
];
export const QUEUE_STARTABLE_STATUSES: readonly TaskStatus[] = ["pending", "refuted"];

/** `E<n>-T<nn>` with an optional split suffix, or a bare `E<n>`. */
export const QUEUE_TASK_REF_PATTERN = /^E(0|[1-9][0-9]*)-T[0-9]{2}[a-z]?$/;
export const QUEUE_EPIC_REF_PATTERN = /^E(0|[1-9][0-9]*)$/;

/**
 * A fractional priority is a queue jump and must state its reason in the task's Context
 * section as a line `Queue-jump reason: <text>` (frontmatter comments do not survive
 * the E6-T02 canonical render, so the reason lives in the body).
 */
export const QUEUE_JUMP_REASON_PATTERN = /^Queue-jump reason: \S/m;

/** The spec of one queue member, as the projector extracted it from the task stream. */
export interface QueueTaskSpec {
  readonly id: string;
  readonly epic: number;
  /** Canonical decimal text (`604`, `302.5`); compared numerically, never through floats. */
  readonly priority: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly dependsOn: readonly string[];
  readonly capstone: boolean;
  /** Whether the Context section states a queue-jump reason. */
  readonly queueJumpReason: boolean;
}

export const QUEUE_BLOCK_REASONS = [
  /** The task itself cannot start (`in-progress`, `implemented`, `verified`). */
  "status/not-startable",
  /** A task dependency exists but is not `verified`; `detail` is its status. */
  "dep/unverified",
  /** A task dependency names no queue member. */
  "dep/missing",
  /** The same reference appears twice in `depends_on`. */
  "dep/duplicate-ref",
  /** A bare epic dependency names an epic with no queue member. */
  "dep/epic-missing",
  /** A bare epic dependency names an epic with no capstone. */
  "dep/epic-no-capstone",
  /** A bare epic dependency names an epic with several capstones. */
  "dep/epic-multiple-capstones",
  /** A bare epic dependency's unique capstone is not `verified`; `detail` is its status. */
  "dep/epic-capstone-unverified",
] as const;
export type QueueBlockReasonKind = (typeof QUEUE_BLOCK_REASONS)[number];

export interface QueueBlockReason {
  readonly reason: QueueBlockReasonKind;
  /** The dependency reference (or the task's own id for `status/not-startable`). */
  readonly ref: string;
  /** The referenced status where one exists. */
  readonly detail?: TaskStatus;
}

export const QUEUE_VIOLATION_REASONS = [
  /** Two queue members carry the same task id. */
  "queue/duplicate-id",
  /** More than one task is `in-progress`, `implemented`, or `refuted`. */
  "queue/multiple-active",
  /** A task dependency names no queue member. */
  "dep/missing",
  /** A bare epic dependency names an epic with no queue member. */
  "dep/epic-missing",
  /**
   * Dependencies form a cycle; `refs` lists every member, sorted. A bare epic reference
   * is an edge to each capstone of that epic, so a cycle through `E<n>` is found too.
   */
  "dep/cycle",
  /**
   * No task is active, nothing can start, and at least one task is still `pending`: the
   * queue can never advance. `refs` lists every pending member, sorted.
   */
  "dep/deadlock",
  /** An epic has more than one capstone. */
  "capstone/multiple",
  /** An epic's capstone is not that epic's final task in queue order. */
  "capstone/not-final",
  /** Every task of an epic is `verified` but the epic has no capstone. */
  "capstone/none-in-completed-epic",
  /** A fractional priority without a `Queue-jump reason:` line in Context. */
  "priority/fractional-without-reason",
  /** The task stream's body is not a parseable task readme (E6-T02 contract). */
  "spec/unparseable",
  /** The readme's frontmatter id is not the task stream's id. */
  "spec/id-mismatch",
  /** The readme's `capstone` flag disagrees with the task's `capstone` label. */
  "capstone/label-disagrees",
  /** The repository issue catalog is corrupt and cannot be replayed. */
  "catalog/corrupt",
] as const;
export type QueueViolationReason = (typeof QUEUE_VIOLATION_REASONS)[number];

export interface QueueViolation {
  readonly reason: QueueViolationReason;
  /** The ids (or dependency refs) involved, sorted, exact. */
  readonly refs: readonly string[];
}

function compareDecimal(a: string, b: string): number {
  const [ai, af = ""] = a.split(".") as [string, string?];
  const [bi, bf = ""] = b.split(".") as [string, string?];
  if (ai.length !== bi.length) return ai.length - bi.length;
  if (ai !== bi) return ai < bi ? -1 : 1;
  const width = Math.max(af.length, bf.length);
  const ap = af.padEnd(width, "0");
  const bp = bf.padEnd(width, "0");
  return ap === bp ? 0 : ap < bp ? -1 : 1;
}

/** Exact numeric comparison of two canonical decimal priorities. */
export function comparePriority(a: string, b: string): number {
  return compareDecimal(a, b);
}

/** Queue order: ascending priority, then id by code units. */
export function compareQueueOrder(a: QueueTaskSpec, b: QueueTaskSpec): number {
  const byPriority = comparePriority(a.priority, b.priority);
  if (byPriority !== 0) return byPriority;
  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}

export function sortQueue(specs: readonly QueueTaskSpec[]): readonly QueueTaskSpec[] {
  return [...specs].sort(compareQueueOrder);
}

export function isFractionalPriority(priority: string): boolean {
  return priority.includes(".");
}

export function epicOf(spec: QueueTaskSpec): string {
  return `E${spec.epic}`;
}

/** Group members by epic, each group in queue order. */
export function epicsOf(
  ordered: readonly QueueTaskSpec[],
): ReadonlyMap<string, readonly QueueTaskSpec[]> {
  const epics = new Map<string, QueueTaskSpec[]>();
  for (const spec of ordered) {
    const key = epicOf(spec);
    const group = epics.get(key);
    if (group === undefined) epics.set(key, [spec]);
    else group.push(spec);
  }
  return epics;
}

/**
 * The `verified` capstone that satisfies a bare epic dependency, or the reason there is
 * none. Exactly one capstone per epic may exist; it must be `verified`.
 */
export function resolveEpicDependency(
  epic: string,
  epics: ReadonlyMap<string, readonly QueueTaskSpec[]>,
): QueueBlockReason | undefined {
  const members = epics.get(epic);
  if (members === undefined) return { reason: "dep/epic-missing", ref: epic };
  const capstones = members.filter((member) => member.capstone);
  if (capstones.length === 0) return { reason: "dep/epic-no-capstone", ref: epic };
  if (capstones.length > 1) return { reason: "dep/epic-multiple-capstones", ref: epic };
  const capstone = capstones[0]!;
  // E6_T04_BARE_EPIC_GUARD: a bare epic dependency is satisfied only by the unique
  // capstone being verified — never by any other verified task of the epic.
  if (
    E6_T04_BARE_EPIC_GUARD
      ? capstone.status !== "verified"
      : !members.some((m) => m.status === "verified")
  ) {
    return { reason: "dep/epic-capstone-unverified", ref: epic, detail: capstone.status };
  }
  return undefined;
}

/** Every reason one task cannot start now: its own status, then each dependency in order. */
export function blockReasons(
  spec: QueueTaskSpec,
  byId: ReadonlyMap<string, QueueTaskSpec>,
  epics: ReadonlyMap<string, readonly QueueTaskSpec[]>,
): readonly QueueBlockReason[] {
  const reasons: QueueBlockReason[] = [];
  if (!QUEUE_STARTABLE_STATUSES.includes(spec.status)) {
    reasons.push({ reason: "status/not-startable", ref: spec.id, detail: spec.status });
  }
  const seen = new Set<string>();
  for (const ref of spec.dependsOn) {
    if (seen.has(ref)) {
      reasons.push({ reason: "dep/duplicate-ref", ref });
      continue;
    }
    seen.add(ref);
    if (QUEUE_EPIC_REF_PATTERN.test(ref)) {
      const epicReason = resolveEpicDependency(ref, epics);
      if (epicReason !== undefined) reasons.push(epicReason);
      continue;
    }
    const dep = byId.get(ref);
    if (dep === undefined) {
      reasons.push({ reason: "dep/missing", ref });
    } else if (dep.status !== "verified") {
      reasons.push({ reason: "dep/unverified", ref, detail: dep.status });
    }
  }
  return reasons;
}

/** Dependencies satisfied (ignoring the task's own status): the Python `eligible` core. */
export function dependenciesSatisfied(reasons: readonly QueueBlockReason[]): boolean {
  return reasons.every((reason) => reason.reason === "status/not-startable");
}

/**
 * The dependency edges of one task with bare epic references expanded: `E<n>` is an
 * edge to every capstone of epic `n` (a capstone-less epic contributes no edge; it blocks
 * as `dep/epic-no-capstone` and, if nothing else can move, deadlocks).
 */
export function dependencyEdges(
  spec: QueueTaskSpec,
  byId: ReadonlyMap<string, QueueTaskSpec>,
  epics: ReadonlyMap<string, readonly QueueTaskSpec[]>,
): readonly string[] {
  const edges: string[] = [];
  for (const ref of spec.dependsOn) {
    if (QUEUE_EPIC_REF_PATTERN.test(ref)) {
      for (const member of epics.get(ref) ?? []) if (member.capstone) edges.push(member.id);
    } else if (byId.has(ref)) {
      edges.push(ref);
    }
  }
  return edges;
}

function cycleMembers(
  ordered: readonly QueueTaskSpec[],
  byId: ReadonlyMap<string, QueueTaskSpec>,
  epics: ReadonlyMap<string, readonly QueueTaskSpec[]>,
): string[] {
  // Tarjan over the expanded edge set (task references and bare epic references resolved
  // to that epic's capstones). Every strongly connected component with a cycle — including
  // a self-loop such as a capstone depending on its own epic — is reported whole.
  const edges = new Map<string, readonly string[]>();
  for (const spec of ordered)
    if (!edges.has(spec.id)) edges.set(spec.id, dependencyEdges(spec, byId, epics));
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const members = new Set<string>();
  const connect = (id: string): void => {
    indices.set(id, index);
    low.set(id, index);
    index += 1;
    stack.push(id);
    onStack.add(id);
    for (const ref of edges.get(id) ?? []) {
      if (!indices.has(ref)) {
        connect(ref);
        low.set(id, Math.min(low.get(id)!, low.get(ref)!));
      } else if (onStack.has(ref)) {
        low.set(id, Math.min(low.get(id)!, indices.get(ref)!));
      }
    }
    if (low.get(id) === indices.get(id)) {
      const component: string[] = [];
      let top: string;
      do {
        top = stack.pop()!;
        onStack.delete(top);
        component.push(top);
      } while (top !== id);
      const selfLoop = component.length === 1 && (edges.get(id) ?? []).includes(id);
      if (component.length > 1 || selfLoop) for (const member of component) members.add(member);
    }
  };
  for (const spec of ordered) if (!indices.has(spec.id)) connect(spec.id);
  return [...members].sort();
}

/**
 * Structural violations of the ordered member list. Deterministic: violations are
 * emitted in a fixed reason order, refs sorted, duplicates collapsed.
 */
export function queueViolations(ordered: readonly QueueTaskSpec[]): readonly QueueViolation[] {
  const violations: QueueViolation[] = [];
  const byId = new Map<string, QueueTaskSpec>();
  const duplicates = new Set<string>();
  for (const spec of ordered) {
    if (byId.has(spec.id)) duplicates.add(spec.id);
    else byId.set(spec.id, spec);
  }
  if (duplicates.size > 0)
    violations.push({ reason: "queue/duplicate-id", refs: [...duplicates].sort() });
  const active = ordered.filter((spec) => QUEUE_ACTIVE_STATUSES.includes(spec.status));
  if (active.length > 1) {
    violations.push({
      reason: "queue/multiple-active",
      refs: active.map((spec) => spec.id).sort(),
    });
  }
  const epics = epicsOf(ordered);
  const missing = new Set<string>();
  const missingEpics = new Set<string>();
  for (const spec of ordered) {
    for (const ref of spec.dependsOn) {
      if (QUEUE_EPIC_REF_PATTERN.test(ref)) {
        if (!epics.has(ref)) missingEpics.add(ref);
      } else if (!byId.has(ref)) {
        missing.add(ref);
      }
    }
  }
  if (missing.size > 0) violations.push({ reason: "dep/missing", refs: [...missing].sort() });
  if (missingEpics.size > 0)
    violations.push({ reason: "dep/epic-missing", refs: [...missingEpics].sort() });
  const cycle = cycleMembers(ordered, byId, epics);
  if (cycle.length > 0) violations.push({ reason: "dep/cycle", refs: cycle });
  const multiple: string[] = [];
  const notFinal: string[] = [];
  const noneInCompleted: string[] = [];
  for (const [epic, members] of [...epics.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const capstones = members.filter((member) => member.capstone);
    if (capstones.length > 1) multiple.push(epic);
    else if (capstones.length === 1 && capstones[0] !== members.at(-1))
      notFinal.push(capstones[0]!.id);
    else if (capstones.length === 0 && members.every((member) => member.status === "verified")) {
      noneInCompleted.push(epic);
    }
  }
  if (multiple.length > 0) violations.push({ reason: "capstone/multiple", refs: multiple });
  if (notFinal.length > 0) violations.push({ reason: "capstone/not-final", refs: notFinal.sort() });
  if (noneInCompleted.length > 0) {
    violations.push({ reason: "capstone/none-in-completed-epic", refs: noneInCompleted });
  }
  const unreasoned = ordered
    .filter((spec) => isFractionalPriority(spec.priority) && !spec.queueJumpReason)
    .map((spec) => spec.id)
    .sort();
  if (unreasoned.length > 0)
    violations.push({ reason: "priority/fractional-without-reason", refs: unreasoned });
  return violations;
}

export type QueueDecision =
  /** No task is active; `nextEligible` is the first startable task whose dependencies are verified. */
  | { readonly kind: "eligible"; readonly nextEligible: string; readonly inFlight: null }
  /** One task is `in-progress` or `implemented` (or `refuted` with unmet dependencies): nothing else may start. */
  | { readonly kind: "in-flight"; readonly nextEligible: null; readonly inFlight: string }
  /** One task is `refuted` with its dependencies verified: it is the next task, for rework. */
  | { readonly kind: "rework"; readonly nextEligible: string; readonly inFlight: string }
  /** No task is active and nothing is pending: every member is verified. */
  | { readonly kind: "exhausted"; readonly nextEligible: null; readonly inFlight: null }
  /** The queue cannot be decided; there is deliberately no `nextEligible` key. */
  | { readonly kind: "invalid"; readonly violations: readonly QueueViolation[] };

export interface QueueEvaluation {
  readonly ordered: readonly QueueTaskSpec[];
  readonly blocked: ReadonlyMap<string, readonly QueueBlockReason[]>;
  readonly decision: QueueDecision;
}

/**
 * Decide the queue: order, per-task block reasons, and the one answer to "what is next".
 * `violations` from the projector (spec-level problems) are merged with structural ones;
 * any violation makes the decision `invalid`.
 */
export function evaluateQueue(
  specs: readonly QueueTaskSpec[],
  specViolations: readonly QueueViolation[] = [],
): QueueEvaluation {
  const ordered = sortQueue(specs);
  const byId = new Map<string, QueueTaskSpec>();
  for (const spec of ordered) if (!byId.has(spec.id)) byId.set(spec.id, spec);
  const epics = epicsOf(ordered);
  const blocked = new Map<string, readonly QueueBlockReason[]>();
  for (const spec of ordered) blocked.set(spec.id, blockReasons(spec, byId, epics));
  const violations = [...specViolations, ...queueViolations(ordered)];
  const active = ordered.find((spec) => QUEUE_ACTIVE_STATUSES.includes(spec.status));
  const pending = ordered.filter((spec) => spec.status === "pending");
  if (
    violations.length === 0 &&
    active === undefined &&
    pending.length > 0 &&
    !pending.some((spec) => blocked.get(spec.id)!.length === 0)
  ) {
    // Nothing active, nothing startable, work left: a queue that can never advance is a
    // fault to be reported, never "nothing left to do".
    violations.push({ reason: "dep/deadlock", refs: pending.map((spec) => spec.id).sort() });
  }
  if (violations.length > 0) return { ordered, blocked, decision: { kind: "invalid", violations } };
  if (active !== undefined) {
    const reasons = blocked.get(active.id)!;
    if (active.status === "refuted" && dependenciesSatisfied(reasons)) {
      return {
        ordered,
        blocked,
        decision: { kind: "rework", nextEligible: active.id, inFlight: active.id },
      };
    }
    return {
      ordered,
      blocked,
      decision: { kind: "in-flight", nextEligible: null, inFlight: active.id },
    };
  }
  const next = ordered.find(
    (spec) => spec.status === "pending" && blocked.get(spec.id)!.length === 0,
  );
  if (next === undefined)
    return {
      ordered,
      blocked,
      decision: { kind: "exhausted", nextEligible: null, inFlight: null },
    };
  return {
    ordered,
    blocked,
    decision: { kind: "eligible", nextEligible: next.id, inFlight: null },
  };
}
