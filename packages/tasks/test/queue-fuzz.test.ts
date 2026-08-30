import { describe, expect, it } from "vitest";
import { canonicalJson } from "@eforest/protocol";
import {
  checkQueueProof,
  generateQueueGraph,
  permuteSources,
  projectQueue,
  queueDigest,
  queueProof,
  queueSourcesFromGraph,
  renderQueueMarkdown,
  type QueueSources,
} from "../src/index.js";

const ORG = "maple";
const REPO = "loom";
const SEEDS = 150;

function reversed(sources: QueueSources): QueueSources {
  return { catalog: sources.catalog, tasks: [...sources.tasks].reverse() };
}

describe("queue graph fuzz (E6-T04)", () => {
  it("is invariant under every per-stream-consistent permutation of the fetch order", () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      for (const cyclic of [false, true]) {
        const graph = generateQueueGraph(seed, { cyclic });
        const sources = queueSourcesFromGraph(ORG, REPO, graph);
        const reference = projectQueue(sources);
        const json = canonicalJson(reference);
        const markdown = renderQueueMarkdown(reference);
        const digest = queueDigest(reference);
        for (const permuted of [
          reversed(sources),
          permuteSources(sources, seed * 7 + 1),
          permuteSources(sources, seed * 13 + 5),
        ]) {
          const projection = projectQueue(permuted);
          expect(canonicalJson(projection), graph.name).toBe(json);
          expect(renderQueueMarkdown(projection), graph.name).toBe(markdown);
          expect(queueDigest(projection), graph.name).toBe(digest);
        }
      }
    }
  });

  it("decides every random DAG validly and every violation deterministically", () => {
    let eligible = 0;
    let invalid = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const dag = projectQueue(queueSourcesFromGraph(ORG, REPO, generateQueueGraph(seed)));
      expect(dag.decision.kind, `dag-${seed}`).not.toBe("invalid");
      if (dag.decision.kind === "invalid") continue;
      const active = dag.tasks.filter(
        (task) => task.status !== "pending" && task.status !== "verified",
      );
      expect(active.length).toBeLessThanOrEqual(1);
      const nextId = dag.decision.nextEligible;
      if (nextId !== null) {
        const next = dag.tasks.find((task) => task.id === nextId)!;
        expect(next.blocked.filter((reason) => reason.reason !== "status/not-startable")).toEqual(
          [],
        );
        // Nothing eligible precedes the chosen task (a refuted gate outranks priority).
        for (const task of dag.tasks) {
          if (dag.decision.kind === "rework") break;
          if (task === next) break;
          expect(
            task.status === "pending" && task.blocked.length === 0,
            `${task.id} precedes ${next.id}`,
          ).toBe(false);
        }
        eligible += 1;
      }
      const cyclic = projectQueue(
        queueSourcesFromGraph(ORG, REPO, generateQueueGraph(seed, { cyclic: true })),
      );
      if (cyclic.decision.kind === "invalid") {
        invalid += 1;
        expect("nextEligible" in cyclic.decision).toBe(false);
        const again = projectQueue(
          queueSourcesFromGraph(ORG, REPO, generateQueueGraph(seed, { cyclic: true })),
        );
        expect(canonicalJson(again.decision)).toBe(canonicalJson(cyclic.decision));
      }
    }
    expect(eligible).toBeGreaterThan(SEEDS / 5);
    expect(invalid).toBeGreaterThan(SEEDS / 2);
  });

  it("refuses a proof after any single source stream moves, naming that stream", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const sources = queueSourcesFromGraph(ORG, REPO, generateQueueGraph(seed));
      const proof = queueProof(projectQueue(sources));
      expect(checkQueueProof(proof, permuteSources(sources, seed))).toMatchObject({ ok: true });
      for (const [index, task] of sources.tasks.entries()) {
        const moved: QueueSources = {
          catalog: sources.catalog,
          tasks: sources.tasks.map((candidate, at) =>
            at === index
              ? {
                  stream: candidate.stream,
                  records: [
                    ...candidate.records,
                    {
                      type: "issue.commented",
                      payload: { v: 1, commentId: "late", body: "moved" },
                      ts: 999,
                      offset: `0000000000000000_${String(candidate.records.length).padStart(16, "0")}`,
                    },
                  ],
                }
              : candidate,
          ),
        };
        expect(checkQueueProof(proof, moved), `${seed}:${task.stream}`).toMatchObject({
          ok: false,
          reason: "queue/stale-proof",
          stale: { stream: task.stream },
        });
      }
    }
  });
});
