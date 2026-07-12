import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";

const repo = resolve(new URL("../..", import.meta.url).pathname);
const task = join(repo, ".eforest/tasks/epic-0-the-seed/E0-T08-client-and-writer");
const evidence = join(task, "evidence");
const work = join(task, "work");
mkdirSync(work, { recursive: true });

const strictTest = spawnSync(join(repo, "node_modules/.bin/vitest"), [
  "run",
  "packages/client/test/client.test.ts",
], {
  cwd: repo,
  env: { ...process.env, NODE_OPTIONS: "--unhandled-rejections=strict" },
  stdio: "inherit",
});
if (strictTest.status !== 0) process.exit(strictTest.status ?? 1);

const required = [
  "e0-t08-batched-dump.jsonl",
  "e0-t08-unbatched-dump.jsonl",
  "e0-t08-cold-read.jsonl",
  "e0-t08-tail-longpoll-prefix.jsonl",
  "e0-t08-tail-longpoll-suffix.jsonl",
  "e0-t08-tail-sse-prefix.jsonl",
  "e0-t08-tail-sse-suffix.jsonl",
  "e0-t08-checkpoints.jsonl",
  "e0-t08-fencing-contested-dump.jsonl",
  "e0-t08-fencing-winner-control-dump.jsonl",
  "e0-t08-fencing-settlements.jsonl",
  "e0-t08-wire-roundtrip-client-to-raw.jsonl",
  "e0-t08-wire-roundtrip-raw-to-client.jsonl",
  "e0-t08-digests.txt",
];
for (const name of required) {
  const path = join(evidence, name);
  if (!readFileSync(path, "utf8")) throw new Error(`missing or empty evidence file: ${name}`);
}

function replay(path) {
  const result = spawnSync("node", ["packages/cli/dist/src/bin.js", "replay", path, "--digest"], {
    cwd: repo,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`ef replay failed for ${path}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function records(name) {
  return readFileSync(join(evidence, name), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertEqual(label, left, right) {
  if (left !== right) throw new Error(`${label}: ${left} !== ${right}`);
  process.stdout.write(`${label}: ${left}\n`);
}

function digestLine(label, left, right) {
  const line = readFileSync(join(evidence, "e0-t08-digests.txt"), "utf8")
    .split("\n")
    .find((entry) => entry.startsWith(`${label}\t`));
  if (!line) throw new Error(`missing digest line: ${label}`);
  const [, savedLeft, savedRight] = line.split("\t");
  if (savedLeft !== left || savedRight !== right) {
    throw new Error(`${label}: saved digest line does not match ef replay output`);
  }
}

const batched = join(evidence, "e0-t08-batched-dump.jsonl");
const unbatched = join(evidence, "e0-t08-unbatched-dump.jsonl");
const batchingLeft = replay(batched);
const batchingRight = replay(unbatched);
assertEqual("batching digest", batchingLeft, batchingRight);
digestLine("batching", batchingLeft, batchingRight);

const cold = join(evidence, "e0-t08-cold-read.jsonl");
for (const mode of ["longpoll", "sse"]) {
  const prefix = records(`e0-t08-tail-${mode}-prefix.jsonl`);
  const suffix = records(`e0-t08-tail-${mode}-suffix.jsonl`);
  const concat = join(work, `e0-t08-tail-${mode}-concat.jsonl`);
  writeFileSync(concat, [...prefix, ...suffix].map((record) => `${canonicalJson(record)}\n`).join(""));
  const resumed = replay(concat);
  const uninterrupted = replay(cold);
  assertEqual(`${mode} resume digest`, resumed, uninterrupted);
  digestLine(`resume-${mode === "longpoll" ? "long-poll" : "sse"}`, resumed, uninterrupted);
}

const fencingLeft = replay(join(evidence, "e0-t08-fencing-contested-dump.jsonl"));
const fencingRight = replay(join(evidence, "e0-t08-fencing-winner-control-dump.jsonl"));
assertEqual(
  "fencing dump digest",
  fencingLeft,
  fencingRight,
);
digestLine("fencing", fencingLeft, fencingRight);
const settlements = records("e0-t08-fencing-settlements.jsonl");
if (settlements.length !== 2 || settlements.some((entry) => entry.status !== "rejected")) {
  throw new Error("fencing settlement transcript did not reject every pending append");
}
if (!readFileSync(join(evidence, "e0-t08-checkpoints.jsonl"), "utf8").includes("yieldedCheckpoint")) {
  throw new Error("checkpoint evidence did not record a yielded checkpoint");
}
process.stdout.write("verify-E0-T08 evidence: OK\n");
