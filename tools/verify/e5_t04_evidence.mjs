#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const evidence = resolve(
  root,
  ".eforest/tasks/epic-5-the-meadow/E5-T04-browser-dispatch-hook/evidence",
);

const read = (name) => readFile(resolve(evidence, name), "utf8");
const [audit, refusal, digests, events, sensitivity] = await Promise.all([
  read("e5-t04-write-audit.txt"),
  read("e5-t04-refusal.txt"),
  read("e5-t04-digests.txt"),
  read("e5-t04-session.events.jsonl"),
  read("e5-t04-sensitivity.md"),
]);

assert.match(audit, /dispatch-posts=4 accepted=3 refused=1 other-state-writes=0/);
assert.match(audit, /E5_T04_WRITE_AUDIT_OK/);
assert.match(refusal, /code=label\/duplicate-name/);
assert.match(refusal, /before-after-log-bytes-equal=true/);
assert.match(refusal, /unauthenticated-status=401 append=false/);
assert.match(refusal, /E5_T04_REFUSAL_OK/);

const facts = Object.fromEntries(
  digests
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => line.split(/=(.*)/s).slice(0, 2)),
);
assert.equal(facts["writer-offset"], facts["follower-offset"]);
assert.equal(facts["writer-offset"], facts["confirmed-offset"]);
assert.equal(facts["writer-digest"], facts["follower-digest"]);
assert.equal(facts["writer-digest"], facts["replay-digest"]);
assert.notEqual(facts["board-before"], facts["board-after"]);
assert.ok(Number(facts["follower-latency-ms"]) <= 2_000);
assert.match(digests, /E5_T04_DIGESTS_OK/);

const lines = events.trim().split("\n");
assert.equal(lines.length, 3);
assert.deepEqual(
  lines.map((line) => JSON.parse(line).type),
  ["label.created", "label.renamed", "label.recolored"],
);
const replay = spawnSync(
  process.execPath,
  [
    "packages/cli/dist/src/bin.js",
    "replay",
    resolve(evidence, "e5-t04-session.events.jsonl"),
    "--digest",
    "--reducer",
    "packages/issues/label-reducer.mjs",
  ],
  { cwd: root, encoding: "utf8" },
);
assert.equal(replay.status, 0, `${replay.stdout}${replay.stderr}`);
assert.equal(replay.stdout.trim(), facts["replay-digest"]);

for (const marker of [
  "optimistic-local-apply sensor=severed-tail-replay-only-label-rows",
  "client-only-refusal-server-accepts sensor=refusal-log-line-count",
  "hardcoded-confirmed-offset sensor=confirmed-offset-four-way-equality",
  "generic-refusal-string sensor=typed-refusal-code",
]) {
  assert.match(sensitivity, new RegExp(marker));
}
assert.match(sensitivity, /E5_T04_SENSITIVITY_OK cases=4/);

process.stdout.write(
  `E5_T04_EVIDENCE_OK offset=${facts["writer-offset"]} digest=${facts["writer-digest"]}\n`,
);
