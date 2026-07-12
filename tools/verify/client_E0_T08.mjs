import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";

const repo = resolve(new URL("../..", import.meta.url).pathname);
const task = join(repo, ".eforest/tasks/epic-0-the-seed/E0-T08-client-and-writer");
const evidence = join(task, "evidence");
const work = join(task, "work");
mkdirSync(work, { recursive: true });

const test = spawnSync("pnpm", ["exec", "vitest", "run", "packages/client/test/client.test.ts"], {
  cwd: repo,
  env: { ...process.env, EFOREST_EVIDENCE_DIR: evidence },
  stdio: "inherit",
});
if (test.status !== 0) process.exit(test.status ?? 1);

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

const batched = join(evidence, "e0-t08-batched-dump.jsonl");
const unbatched = join(evidence, "e0-t08-unbatched-dump.jsonl");
assertEqual("batching digest", replay(batched), replay(unbatched));

const cold = join(evidence, "e0-t08-cold-read.jsonl");
for (const mode of ["longpoll", "sse"]) {
  const prefix = records(`e0-t08-tail-${mode}-prefix.jsonl`);
  const suffix = records(`e0-t08-tail-${mode}-suffix.jsonl`);
  const concat = join(work, `e0-t08-tail-${mode}-concat.jsonl`);
  writeFileSync(concat, [...prefix, ...suffix].map((record) => `${canonicalJson(record)}\n`).join(""));
  assertEqual(`${mode} resume digest`, replay(concat), replay(cold));
}

assertEqual(
  "fencing dump digest",
  replay(join(evidence, "e0-t08-fencing-contested-dump.jsonl")),
  replay(join(evidence, "e0-t08-fencing-winner-control-dump.jsonl")),
);
const settlements = records("e0-t08-fencing-settlements.jsonl");
if (settlements.length !== 2 || settlements.some((entry) => entry.status !== "rejected")) {
  throw new Error("fencing settlement transcript did not reject every pending append");
}
if (!readFileSync(join(evidence, "e0-t08-checkpoints.jsonl"), "utf8").includes("yieldedCheckpoint")) {
  throw new Error("checkpoint evidence did not record a yielded checkpoint");
}
process.stdout.write("verify-E0-T08 evidence: OK\n");
