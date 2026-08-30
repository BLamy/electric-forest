/**
 * The queue projector (E6-T04): `projectQueue(sources)` derives a repository's ordered
 * task queue from its source streams alone — the issue catalog `repo-issues:<org>/<repo>`
 * and one task stream `issue:<org>/<repo>/<id>` per catalog entry. It is a pure function
 * of those logs: no database, no side table, no fetch-order dependence (sources may be
 * presented in any order; only each stream's own record order matters), and deleting
 * every derived artifact loses nothing that replay cannot rebuild byte-for-byte.
 *
 * Membership follows E6-T03: an issue is a loop task once any `task.*` event exists on it
 * or once it has ever carried the `task` or `capstone` label. A member's *spec* (epic,
 * priority, title, dependencies, capstone flag) is the E6-T02 task readme carried in the
 * issue body; its *status* is the replayed `tasks/v1` state — the frontmatter `status`
 * key in the body is text, never authority.
 */
import { stateDigest, type Event, type Offset, OFFSET_BEFORE_FIRST } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { repoIdentityFromIssueCatalogStream, replayIssueCatalog } from "@eforest/issues";
import { isTaskActionType } from "../events.js";
import { parseTaskReadme } from "../folder/parse.js";
import { replayTaskLog } from "../reducer.js";
import type { TaskState, TaskStatus } from "../state.js";
import {
  QUEUE_JUMP_REASON_PATTERN,
  evaluateQueue,
  type QueueBlockReason,
  type QueueDecision,
  type QueueTaskSpec,
  type QueueViolation,
} from "./eligibility.js";

export const QUEUE_PROJECTION_VERSION = 1 as const;
/** Registry-style id of the derivation (`queue/v1`); it spans several streams. */
export const QUEUE_PROJECTOR_ID = "queue/v1" as const;

export interface QueueSourceStream {
  readonly stream: string;
  /** Records in stream order, server metadata stripped, each carrying its `offset`. */
  readonly records: readonly Event[];
}

export interface QueueSources {
  readonly catalog: QueueSourceStream;
  /** One entry per task stream, in any order; streams the catalog does not list are ignored. */
  readonly tasks: readonly QueueSourceStream[];
}

export interface QueueSourceHead {
  readonly stream: string;
  readonly offset: Offset | typeof OFFSET_BEFORE_FIRST;
}

export interface QueueTask {
  readonly id: string;
  readonly stream: string;
  readonly head: Offset | typeof OFFSET_BEFORE_FIRST;
  readonly epic: number;
  readonly priority: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly dependsOn: readonly string[];
  readonly capstone: boolean;
  readonly blocked: readonly QueueBlockReason[];
}

export interface QueueProjection {
  readonly v: typeof QUEUE_PROJECTION_VERSION;
  readonly org: string;
  readonly repo: string;
  /** Every source head consumed: the catalog, then each member task stream sorted by stream id. */
  readonly sources: {
    readonly catalog: QueueSourceHead;
    readonly tasks: readonly QueueSourceHead[];
  };
  /** Members with a parseable spec, in queue order. */
  readonly tasks: readonly QueueTask[];
  readonly verified: number;
  readonly decision: QueueDecision;
}

export function queueHeadOf(records: readonly Event[]): Offset | typeof OFFSET_BEFORE_FIRST {
  if (records.length === 0) return OFFSET_BEFORE_FIRST;
  const last = records.at(-1) as Event & { readonly offset?: unknown };
  return typeof last.offset === "string" && last.offset !== OFFSET_BEFORE_FIRST
    ? (last.offset as Offset)
    : offsetForOrdinal(records.length - 1);
}

function everLabeled(records: readonly Event[], label: string): boolean {
  return records.some((record) => {
    if (record.type !== "issue.labeled") return false;
    const payload = record.payload as { readonly label?: unknown } | null;
    return payload !== null && typeof payload === "object" && payload.label === label;
  });
}

/** E6-T03 membership, verbatim: history makes a task, and history is never retracted. */
export function isQueueMember(task: TaskState, records: readonly Event[]): boolean {
  return (
    task.attempts.length > 0 ||
    records.some((record) => isTaskActionType(record.type)) ||
    everLabeled(records, "task") ||
    everLabeled(records, "capstone")
  );
}

interface MemberSpec {
  readonly spec: QueueTaskSpec;
  readonly stream: string;
  readonly head: Offset | typeof OFFSET_BEFORE_FIRST;
}

function specOf(
  task: TaskState,
  stream: string,
  head: Offset | typeof OFFSET_BEFORE_FIRST,
): MemberSpec | QueueViolation {
  const parsed = parseTaskReadme(new TextEncoder().encode(task.issue.body));
  if (!parsed.ok) return { reason: "spec/unparseable", refs: [task.taskId] };
  const { frontmatter, readme } = parsed;
  if (frontmatter.id !== task.taskId) return { reason: "spec/id-mismatch", refs: [task.taskId] };
  const labeledCapstone = task.issue.labels.includes("capstone");
  if (labeledCapstone !== frontmatter.capstone)
    return { reason: "capstone/label-disagrees", refs: [task.taskId] };
  const context = readme.sections.find((section) => section.name === "Context");
  return {
    stream,
    head,
    spec: {
      id: frontmatter.id,
      epic: frontmatter.epic,
      priority: frontmatter.priority,
      title: frontmatter.title,
      status: task.status,
      dependsOn: frontmatter.depends_on,
      capstone: frontmatter.capstone,
      queueJumpReason: context !== undefined && QUEUE_JUMP_REASON_PATTERN.test(context.body),
    },
  };
}

function isViolation(value: MemberSpec | QueueViolation): value is QueueViolation {
  return "reason" in value;
}

/**
 * Derive the queue. The catalog names the task universe; each listed stream is replayed
 * under `tasks/v1`; members are ordered and decided by `evaluateQueue`. Every head that
 * was consumed is recorded so a proof over this projection can be fenced.
 */
export function projectQueue(sources: QueueSources): QueueProjection {
  const identity = repoIdentityFromIssueCatalogStream(sources.catalog.stream);
  if (identity === undefined)
    throw new TypeError(`invalid issue catalog stream: ${sources.catalog.stream}`);
  const byStream = new Map<string, readonly Event[]>();
  for (const source of sources.tasks) byStream.set(source.stream, source.records);
  const catalogHead = {
    stream: sources.catalog.stream,
    offset: queueHeadOf(sources.catalog.records),
  };
  let issueStreams: readonly string[];
  const specViolations: QueueViolation[] = [];
  try {
    const catalog = replayIssueCatalog(sources.catalog.stream, sources.catalog.records);
    issueStreams = Object.keys(catalog.issues).sort();
  } catch {
    issueStreams = [];
    specViolations.push({ reason: "catalog/corrupt", refs: [sources.catalog.stream] });
  }
  const heads: QueueSourceHead[] = [];
  const members: MemberSpec[] = [];
  for (const stream of issueStreams) {
    const records = byStream.get(stream) ?? [];
    const task = replayTaskLog(stream, records);
    if (!isQueueMember(task, records)) continue;
    const head = queueHeadOf(records);
    heads.push({ stream, offset: head });
    const member = specOf(task, stream, head);
    if (isViolation(member)) specViolations.push(member);
    else members.push(member);
  }
  const merged = mergeViolations(specViolations);
  const evaluation = evaluateQueue(
    members.map((member) => member.spec),
    merged,
  );
  const tasks: QueueTask[] = evaluation.ordered.map((spec) => {
    const member = members.find((candidate) => candidate.spec === spec)!;
    return {
      id: spec.id,
      stream: member.stream,
      head: member.head,
      epic: spec.epic,
      priority: spec.priority,
      title: spec.title,
      status: spec.status,
      dependsOn: spec.dependsOn,
      capstone: spec.capstone,
      blocked: evaluation.blocked.get(spec.id) ?? [],
    };
  });
  return {
    v: QUEUE_PROJECTION_VERSION,
    org: identity.org,
    repo: identity.repo,
    sources: { catalog: catalogHead, tasks: heads },
    tasks,
    verified: tasks.filter((task) => task.status === "verified").length,
    decision: evaluation.decision,
  };
}

/** Collapse same-reason spec violations into one entry with sorted refs. */
function mergeViolations(violations: readonly QueueViolation[]): readonly QueueViolation[] {
  const order = [
    "catalog/corrupt",
    "spec/unparseable",
    "spec/id-mismatch",
    "capstone/label-disagrees",
  ] as const;
  const merged: QueueViolation[] = [];
  for (const reason of order) {
    const refs = violations
      .filter((violation) => violation.reason === reason)
      .flatMap((violation) => violation.refs);
    if (refs.length > 0) merged.push({ reason, refs: [...new Set(refs)].sort() });
  }
  return merged;
}

/** The queue digest: SHA-256 over the canonical JSON of the projection. */
export function queueDigest(projection: QueueProjection): string {
  return stateDigest(projection);
}
