/**
 * Graph fixtures (E6-T04): a `QueueGraph` is the smallest description of a task graph —
 * id, epic, priority, title, status, dependencies, capstone flag — from which both
 * implementations under differential test are fed: `queueSourcesFromGraph` turns it into
 * the source streams the TypeScript projector replays, and `graphReadme` renders the
 * `readme.md` bytes a task folder tree carries for `tools/build_queue.py`. The same
 * readme text is the issue body on the stream, so both sides read one spec.
 *
 * `generateQueueGraph(seed)` is a pure seeded generator (no host randomness) producing
 * random DAGs and, with `cyclic`, graphs containing cycles and other violations.
 */
import type { Event, Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { ISSUE_CATALOG_EVENT, repoIssuesStreamId } from "@eforest/issues";
import { taskStreamId } from "../events.js";
import { seededRandom } from "../generate.js";
import { renderFrontmatter } from "../folder/render.js";
import type { TaskEstimate, TaskFrontmatterV1 } from "../folder/schema.js";
import type { TaskStatus } from "../state.js";
import { TASK_EVENT_VERSION } from "../version.js";
import type { QueueSourceStream, QueueSources } from "./projector.js";

export interface QueueGraphTask {
  readonly id: string;
  readonly epic: number;
  readonly priority: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly depends_on: readonly string[];
  readonly estimate: TaskEstimate;
  readonly capstone: boolean;
  /** A `Queue-jump reason:` line for the Context section (fractional priorities). */
  readonly queueJumpReason?: string;
  /** Force the `capstone` label to disagree with the frontmatter (violation fixture). */
  readonly capstoneLabel?: boolean;
  /** Replace the readme body with arbitrary text (`spec/unparseable` fixture). */
  readonly body?: string;
  /** Write a different frontmatter id than the stream id (`spec/id-mismatch` fixture). */
  readonly frontmatterId?: string;
}

export interface QueueGraph {
  readonly name: string;
  readonly tasks: readonly QueueGraphTask[];
}

export const GRAPH_BUILDER = "builder-ada";
export const GRAPH_CRITIC = "critic-bram";

function frontmatterOf(task: QueueGraphTask): TaskFrontmatterV1 {
  return {
    id: task.frontmatterId ?? task.id,
    epic: task.epic,
    title: task.title,
    priority: task.priority,
    status: task.status,
    depends_on: task.depends_on,
    estimate: task.estimate,
    capstone: task.capstone,
  };
}

/** The readme bytes of one graph task: canonical frontmatter plus the six sections. */
export function graphReadme(task: QueueGraphTask): string {
  if (task.body !== undefined) return task.body;
  const reason =
    task.queueJumpReason === undefined ? "" : `Queue-jump reason: ${task.queueJumpReason}\n`;
  return (
    `${renderFrontmatter(frontmatterOf(task))}\n## Goal\n\nThe outcome of ${task.id}.\n\n` +
    `## Context\n\n${reason}Why ${task.id} exists.\n\n## Deliverables\n\n- ${task.id} artifacts.\n\n` +
    `## Acceptance criteria\n\n- [ ] ${task.id} passes.\n\n## Adversarial verification\n\n` +
    `1. Break ${task.id}.\n\n## Verification log\n`
  );
}

interface Stamped extends Event {
  readonly offset: Offset;
}

/** The task stream of one graph task, driven to its status through the `tasks/v1` events. */
export function graphTaskRecords(
  org: string,
  repo: string,
  task: QueueGraphTask,
): readonly Stamped[] {
  const stream = taskStreamId(org, repo, task.id);
  const evidence = { stream: `evidence:${org}/${repo}/issue/${task.id}`, attachmentIds: ["att-1"] };
  const branch = {
    stream: `fs:${org}/${repo}:b-${task.id.toLowerCase()}:meta`,
    head: offsetForOrdinal(3),
  };
  const builder = {
    actor: GRAPH_BUILDER,
    role: "builder" as const,
    run: `agent-run:${org}/${task.id.toLowerCase()}-run-1`,
  };
  const critic = {
    actor: GRAPH_CRITIC,
    role: "critic" as const,
    run: `agent-run:${org}/${task.id.toLowerCase()}-run-2`,
  };
  const raw: Event[] = [
    {
      type: "issue.opened",
      payload: { v: 1, title: task.title, body: graphReadme(task) },
      ts: 100,
    },
    { type: "issue.labeled", payload: { v: 1, label: "task" }, ts: 101 },
  ];
  if (task.capstoneLabel ?? task.capstone)
    raw.push({ type: "issue.labeled", payload: { v: 1, label: "capstone" }, ts: 102 });
  const started = {
    type: "task.started",
    payload: { v: TASK_EVENT_VERSION, by: builder },
    ts: 200,
  };
  if (task.status !== "pending") raw.push(started);
  if (task.status === "implemented" || task.status === "refuted" || task.status === "verified") {
    raw.push({
      type: "task.claimed",
      payload: {
        v: TASK_EVENT_VERSION,
        by: builder,
        branch,
        evidence,
        summary: `${task.id} claim`,
      },
      ts: 201,
    });
  }
  const claimOffset = offsetForOrdinal(raw.length - 1);
  if (task.status === "refuted") {
    raw.push({
      type: "task.refuted",
      payload: {
        v: TASK_EVENT_VERSION,
        by: critic,
        claim: { stream, offset: claimOffset },
        branch,
        evidence,
        findings: [
          {
            fingerprint: "one-finding",
            summary: "refuted",
            citation: { stream: evidence.stream, attachmentId: "att-1" },
          },
        ],
      },
      ts: 202,
    });
  }
  if (task.status === "verified") {
    raw.push({
      type: "task.verified",
      payload: {
        v: TASK_EVENT_VERSION,
        by: critic,
        claim: { stream, offset: claimOffset },
        branch,
        evidence,
        summary: `${task.id} verified`,
      },
      ts: 202,
    });
  }
  return raw.map((event, index) => ({ ...event, offset: offsetForOrdinal(index) }));
}

export function graphCatalogRecords(
  org: string,
  repo: string,
  graph: QueueGraph,
): readonly Stamped[] {
  return graph.tasks.map((task, index) => ({
    type: ISSUE_CATALOG_EVENT,
    payload: {
      v: 1,
      issueStreamId: taskStreamId(org, repo, task.id),
      sourceOffset: offsetForOrdinal(0),
    },
    ts: 50 + index,
    offset: offsetForOrdinal(index),
  }));
}

/** Every source stream of a graph, in the graph's own task order. */
export function queueSourcesFromGraph(org: string, repo: string, graph: QueueGraph): QueueSources {
  return {
    catalog: {
      stream: repoIssuesStreamId(org, repo),
      records: graphCatalogRecords(org, repo, graph),
    },
    tasks: graph.tasks.map((task) => ({
      stream: taskStreamId(org, repo, task.id),
      records: graphTaskRecords(org, repo, task),
    })),
  };
}

/** A per-stream-consistent permutation: the task sources reordered, each stream intact. */
export function permuteSources(sources: QueueSources, seed: number): QueueSources {
  const random = seededRandom(seed);
  const tasks = [...sources.tasks];
  for (let index = tasks.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [tasks[index], tasks[swap]] = [tasks[swap]!, tasks[index]!];
  }
  return { catalog: sources.catalog, tasks: tasks as readonly QueueSourceStream[] };
}

export interface GenerateGraphOptions {
  /** Allow cycles, missing dependencies, doubled capstones, two active tasks, unreasoned fractions. */
  readonly cyclic?: boolean;
}

const STATUSES: readonly TaskStatus[] = [
  "pending",
  "in-progress",
  "implemented",
  "refuted",
  "verified",
];

/**
 * A random graph. Valid mode: 1–4 epics of 1–5 tasks, priorities `epic*100+n` (some
 * fractional with a stated reason), each epic's last task the capstone, dependencies only
 * on earlier tasks or earlier epics (a DAG), at most one active task, and a verified
 * prefix so `verified` tasks never depend on unverified ones (the shape a real loop
 * produces). Cyclic mode relaxes every one of those rules at random.
 */
export function generateQueueGraph(seed: number, options: GenerateGraphOptions = {}): QueueGraph {
  const random = seededRandom(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const cyclic = options.cyclic === true;
  const epicCount = 1 + Math.floor(random() * 4);
  const tasks: QueueGraphTask[] = [];
  const ids: string[] = [];
  let activeUsed = false;
  let frontier = true;
  for (let epic = 1; epic <= epicCount; epic += 1) {
    const size = 1 + Math.floor(random() * 5);
    for (let n = 1; n <= size; n += 1) {
      const id = `E${epic}-T${String(n).padStart(2, "0")}`;
      const fractional = random() < 0.15;
      const priority = fractional
        ? `${epic * 100 + n}.${1 + Math.floor(random() * 9)}`
        : `${epic * 100 + n}`;
      const deps = new Set<string>();
      const depCount = Math.floor(random() * 3);
      for (let k = 0; k < depCount && ids.length > 0; k += 1) {
        if (cyclic && random() < 0.2) {
          deps.add(`E${epic}-T${String(n + 1 + Math.floor(random() * 2)).padStart(2, "0")}`);
        } else if (random() < 0.25 && epic > 1) {
          deps.add(`E${1 + Math.floor(random() * (epic - 1))}`);
        } else {
          deps.add(pick(ids));
        }
      }
      if (cyclic && random() < 0.1) deps.add(`E${epic + 5}`);
      let status: TaskStatus;
      if (cyclic) {
        status = pick(STATUSES);
      } else if (frontier && random() < 0.7) {
        status = "verified";
      } else {
        frontier = false;
        if (!activeUsed && random() < 0.3) {
          activeUsed = true;
          status = pick(["in-progress", "implemented", "refuted"]);
        } else {
          status = "pending";
        }
      }
      const capstone = cyclic ? random() < 0.3 : n === size;
      tasks.push({
        id,
        epic,
        priority,
        title: `Task ${id} does one thing`,
        status,
        depends_on: [...deps].sort(),
        estimate: pick(["S", "M", "L"]),
        capstone,
        ...(fractional && (!cyclic || random() < 0.5)
          ? { queueJumpReason: `regression ahead of ${id}` }
          : {}),
      });
      ids.push(id);
    }
  }
  if (cyclic && random() < 0.3 && tasks.length > 1) {
    // A self-dependency is the smallest cycle.
    const index = Math.floor(random() * tasks.length);
    const victim = tasks[index]!;
    tasks[index] = {
      ...victim,
      depends_on: [...new Set([...victim.depends_on, victim.id])].sort(),
    };
  }
  return { name: `${cyclic ? "cyclic" : "dag"}-${seed}`, tasks };
}
