import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const harness = join(root, "tools/verify/e1_capstone.mjs");
const evidence = join(
  root,
  ".eforest/tasks/epic-1-the-trunk/E1-T11-the-first-repo/evidence/sabotage-summary.json",
);
const updateEvidence = process.argv.includes("--update-evidence");
assert.deepEqual(
  process.argv.slice(2).filter((argument) => argument !== "--update-evidence"),
  [],
  "usage: node tools/verify/e1_capstone_sabotage.mjs [--update-evidence]",
);

const attacks = [
  ["evidence-drift", /fresh capstone evidence drifted: transcript/],
  ["event-mutation", /strictly unequal/],
  ["invalid-merge", /strictly equal/],
  ["materialized-output", /strictly equal/],
  ["restart-storage", /repo_not_found|repository .*not found/i],
  ["transport-closure", /expected to not match/],
  ["watcher-order", /strictly equal/],
  ["writer-race", /Missing expected rejection/],
];
const results = [];

for (const [name, expected] of attacks) {
  const result = spawnSync(process.execPath, [harness, `--sabotage=${name}`], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    timeout: 60_000,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.notEqual(result.status, 0, `${name} unexpectedly passed\n${output}`);
  assert.match(output, expected, `${name} failed outside its intended sensor`);
  results.push({ failureMatched: true, name });
  process.stderr.write(`${name}: verifier rejected sabotage\n`);
}

const runtimePath = join(root, "packages/cli/dist/src/materialize-command.js");
const runtimeBytes = readFileSync(runtimePath);
try {
  appendFileSync(runtimePath, "\n// E1-T11 executed-runtime provenance sensor\n", "utf8");
  const result = spawnSync(process.execPath, [harness], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    timeout: 60_000,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.notEqual(result.status, 0, `runtime-closure unexpectedly passed\n${output}`);
  assert.match(
    output,
    /fresh capstone evidence drifted: transport-provenance\.json/,
    "runtime-closure failed outside its intended sensor",
  );
  results.push({ failureMatched: true, name: "runtime-closure" });
  process.stderr.write("runtime-closure: verifier rejected mutated executed module\n");
} finally {
  writeFileSync(runtimePath, runtimeBytes);
}

const summary = `${canonicalJson({ results })}\n`;
if (updateEvidence) {
  mkdirSync(dirname(evidence), { recursive: true });
  writeFileSync(evidence, summary, "utf8");
} else {
  assert.ok(existsSync(evidence), "missing committed sabotage summary");
  assert.equal(summary, readFileSync(evidence, "utf8"), "sabotage evidence drifted");
}
process.stdout.write(summary);
