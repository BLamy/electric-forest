import type { Event, Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { ISSUE_EVENT_VERSION } from "@eforest/issues";
import { taskEvidenceStreamId, type TaskActorRef, type TaskFinding } from "./events.js";
import { TASK_EVENT_VERSION } from "./version.js";

export interface GeneratedTaskLog {
  readonly seed: number;
  readonly streamId: string;
  readonly events: readonly (Event & { readonly offset: Offset })[];
}

/** mulberry32: a tiny deterministic PRNG so every generated sequence is reproducible. */
export function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BUILDERS = ["builder-ash", "builder-birch", "builder-cedar"] as const;
const CRITICS = ["critic-fern", "critic-moss"] as const;
const LABELS = ["bug", "matrix"] as const;

/**
 * One legal loop: opened, optional issue chatter, started, then k rounds of
 * claim -> refute -> rework, ending anywhere from pending through verified. Every
 * produced sequence is accepted event-by-event by `validateTaskEvent` and lands on
 * exactly the status the generator chose.
 */
export function generateLegalTaskLog(seed: number, org = "maple", repo = "reading-room") {
  const random = seededRandom(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const taskId = `E6-T01-seq-${seed.toString(16)}`;
  const streamId = `issue:${org}/${repo}/${taskId}`;
  const evidenceStream = taskEvidenceStreamId(streamId)!;
  const events: (Event & { readonly offset: Offset })[] = [];
  let ts = 1000 + Math.floor(random() * 1000);
  const labels = new Set<string>();
  let comments = 0;
  const push = (type: string, payload: Record<string, unknown>): Offset => {
    const offset = offsetForOrdinal(events.length);
    ts += 1 + Math.floor(random() * 5);
    events.push({ type, payload, ts, offset });
    return offset;
  };
  const chatter = (): void => {
    const rounds = Math.floor(random() * 3);
    for (let index = 0; index < rounds; index += 1) {
      const roll = random();
      if (roll < 0.5) {
        comments += 1;
        push("issue.commented", {
          v: ISSUE_EVENT_VERSION,
          commentId: `c-${comments}`,
          body: `note ${comments}`,
        });
      } else if (roll < 0.8) {
        const label = pick(LABELS);
        if (!labels.has(label)) {
          labels.add(label);
          push("issue.labeled", { v: ISSUE_EVENT_VERSION, label });
        }
      } else if (labels.size > 0) {
        const label = [...labels][0]!;
        labels.delete(label);
        push("issue.unlabeled", { v: ISSUE_EVENT_VERSION, label });
      }
    }
  };
  const actor = (name: string, role: TaskActorRef["role"], run: number): TaskActorRef => ({
    actor: name,
    role,
    run: `agent-run:${org}/${taskId}-run-${run}`,
  });

  push("issue.opened", { v: ISSUE_EVENT_VERSION, title: `Task ${taskId}`, body: "generated" });
  chatter();
  const stopAt = random();
  if (stopAt < 0.05) return { seed, streamId, events } satisfies GeneratedTaskLog;
  let run = 0;
  let builder = pick(BUILDERS);
  run += 1;
  push("task.started", { v: TASK_EVENT_VERSION, by: actor(builder, "builder", run) });
  const rounds = Math.floor(random() * 4);
  let attempt = 1;
  for (let round = 0; round <= rounds; round += 1) {
    chatter();
    if (random() < 0.08) return { seed, streamId, events } satisfies GeneratedTaskLog;
    const branch = {
      stream: `fs:${org}/${repo}:${taskId.toLowerCase()}-a${attempt}:meta`,
      head: offsetForOrdinal(Math.floor(random() * 50)),
    };
    const evidence = {
      stream: evidenceStream,
      attachmentIds: [`log-${attempt}`, ...(random() < 0.5 ? [`replay-${attempt}`] : [])],
    };
    const claim = push("task.claimed", {
      v: TASK_EVENT_VERSION,
      by: actor(builder, "builder", run),
      branch,
      evidence,
      summary: `attempt ${attempt} claim`,
    });
    if (random() < 0.1) return { seed, streamId, events } satisfies GeneratedTaskLog;
    const critic = pick(CRITICS);
    run += 1;
    const verdictBase = {
      v: TASK_EVENT_VERSION,
      by: actor(critic, "critic", run),
      claim: { stream: streamId, offset: claim },
      branch,
      evidence: { stream: evidenceStream, attachmentIds: random() < 0.5 ? [`log-${attempt}`] : [] },
    };
    if (round === rounds) {
      push("task.verified", { ...verdictBase, summary: `attempt ${attempt} verified` });
      return { seed, streamId, events } satisfies GeneratedTaskLog;
    }
    const findings: TaskFinding[] = [
      {
        fingerprint: `finding-${attempt}-digest`,
        summary: `attempt ${attempt} digest diverged`,
        citation: { stream: evidenceStream, attachmentId: `log-${attempt}` },
      },
      ...(random() < 0.5
        ? [
            {
              fingerprint: `finding-${attempt}-coverage`,
              summary: `attempt ${attempt} uncovered hunk`,
              citation: { stream: branch.stream, offset: branch.head },
            },
          ]
        : []),
    ];
    const refutation = push("task.refuted", { ...verdictBase, findings });
    if (random() < 0.1) return { seed, streamId, events } satisfies GeneratedTaskLog;
    builder = random() < 0.3 ? pick(BUILDERS) : builder;
    run += 1;
    push("task.rework-started", {
      v: TASK_EVENT_VERSION,
      by: actor(builder, "builder", run),
      refutation: { stream: streamId, offset: refutation },
    });
    attempt += 1;
  }
  return { seed, streamId, events } satisfies GeneratedTaskLog;
}
