import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  BUILD_QUEUE_GENERATOR_LINE,
  generateQueueGraph,
  graphReadme,
  normalizeQueueDecision,
  projectQueue,
  queueSourcesFromGraph,
  renderQueueMarkdown,
  type QueueGraph,
} from "../src/index.js";
import { ORG, REPO, expectedArtifact, frozenGraph, frozenGraphNames } from "./queue-fixture.js";

const NORMALIZER = fileURLToPath(
  new URL("../../../tools/verify/queue_differential.py", import.meta.url),
);
const scratch = mkdtempSync(join(tmpdir(), "e6-t04-differential-"));
const FUZZ_SEEDS = 30;

interface PythonDecision {
  readonly gate: string | null;
  readonly nextUp: readonly string[];
  readonly selected: string | null;
  readonly tuples: readonly unknown[];
  readonly unlocks: readonly string[];
  readonly markdown: string;
  readonly warnings: readonly string[];
}

/** Render the graph as a task-folder tree and run the real build_queue.py over it. */
function python(graph: QueueGraph): PythonDecision {
  const tree = join(scratch, graph.name);
  rmSync(tree, { recursive: true, force: true });
  for (const task of graph.tasks) {
    const folder = join(tree, `epic-${task.epic}`, task.id);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "readme.md"), graphReadme(task));
  }
  const result = spawnSync("python3", [NORMALIZER, "--tree", tree], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as PythonDecision;
}

function normalizedPair(graph: QueueGraph): {
  readonly ts: string;
  readonly py: string;
  readonly python: PythonDecision;
} {
  const python_ = python(graph);
  const projection = projectQueue(queueSourcesFromGraph(ORG, REPO, graph));
  const ts = normalizeQueueDecision(projection);
  const markdownTs = renderQueueMarkdown(projection, BUILD_QUEUE_GENERATOR_LINE);
  const view = (value: Omit<PythonDecision, "warnings">) =>
    JSON.stringify({
      gate: value.gate,
      nextUp: value.nextUp,
      selected: value.selected,
      tuples: value.tuples,
      unlocks: value.unlocks,
      markdown: value.markdown,
    });
  return { ts: view({ ...ts, markdown: markdownTs }), py: view(python_), python: python_ };
}

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("Python/TypeScript queue differential (E6-T04)", () => {
  it("selects the same task and renders the same tuples and markdown for every valid frozen graph", () => {
    let compared = 0;
    for (const name of frozenGraphNames()) {
      const graph = frozenGraph(name);
      if (!graph.valid) continue;
      const { ts, py, python: live } = normalizedPair(graph);
      expect(ts, name).toBe(py);
      expect(live.warnings, `${name}: build_queue.py warned`).toEqual([]);
      // The committed Python output is frozen; a live run must still produce it.
      const frozen = JSON.parse(expectedArtifact(name, "python.json")) as PythonDecision;
      expect(JSON.stringify(live), `${name}: frozen python.json drifted`).toBe(
        JSON.stringify(frozen),
      );
      compared += 1;
    }
    expect(compared).toBeGreaterThanOrEqual(12);
  });

  it("agrees with build_queue.py on random DAGs", () => {
    for (let seed = 1; seed <= FUZZ_SEEDS; seed += 1) {
      const graph = generateQueueGraph(seed);
      const { ts, py } = normalizedPair(graph);
      expect(ts, graph.name).toBe(py);
    }
  });
});
