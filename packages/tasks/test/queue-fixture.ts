import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "@eforest/protocol";
import { expect } from "vitest";
import {
  projectQueue,
  queueSourcesFromGraph,
  type QueueGraph,
  type QueueProjection,
  type QueueSources,
} from "../src/index.js";

export const E6_T04_EVIDENCE = fileURLToPath(
  new URL(
    "../../../.eforest/tasks/epic-6-the-loop/E6-T04-task-queue-projection/evidence/",
    import.meta.url,
  ),
);
export const GRAPHS = join(E6_T04_EVIDENCE, "fixtures", "graphs");
export const EXPECTED = join(E6_T04_EVIDENCE, "expected");
export const ORG = "maple";
export const REPO = "loom";

export interface FrozenGraph extends QueueGraph {
  readonly valid: boolean;
}

export function frozenGraphNames(): readonly string[] {
  return readdirSync(GRAPHS)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

export function frozenGraph(name: string): FrozenGraph {
  const graph = JSON.parse(readFileSync(join(GRAPHS, `${name}.json`), "utf8")) as FrozenGraph;
  expect(graph.name).toBe(name);
  return graph;
}

export function expectedArtifact(name: string, suffix: string): string {
  return readFileSync(join(EXPECTED, `${name}.${suffix}`), "utf8");
}

export function sourcesOf(graph: QueueGraph): QueueSources {
  return queueSourcesFromGraph(ORG, REPO, graph);
}

export function projectionOf(graph: QueueGraph): QueueProjection {
  return projectQueue(sourcesOf(graph));
}

export function canonical(value: unknown): string {
  return canonicalJson(value);
}
