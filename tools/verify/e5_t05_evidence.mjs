#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const evidence = resolve(root, ".eforest/tasks/epic-5-the-meadow/E5-T05-issues-ui-live/evidence");
const read = (name) => readFile(resolve(evidence, name), "utf8");

const [audit, refusal, digests, events, sensitivity] = await Promise.all([
  read("e5-t05-write-audit.txt"),
  read("e5-t05-refusal.txt"),
  read("e5-t05-digests.txt"),
  read("e5-t05-session.events.jsonl"),
  read("e5-t05-sensitivity.md"),
]);

assert.match(audit, /dispatch-posts=8 accepted=7 refused=1 other-state-writes=0/);
assert.match(audit, /E5_T05_WRITE_AUDIT_OK/);
assert.match(refusal, /code=issue\/illegal-transition/);
assert.match(refusal, /before-after-log-bytes-equal=true/);
assert.match(refusal, /E5_T05_REFUSAL_OK/);

const facts = Object.fromEntries(
  digests
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => line.split(/=(.*)/s).slice(0, 2)),
);
assert.equal(facts["writer-board-digest"], facts["follower-board-digest"]);
assert.equal(facts["follower-board-digest"], facts["endpoint-at-offset-digest"]);
assert.equal(facts["writer-issue-digest"], facts["follower-issue-digest"]);
assert.equal(facts["follower-issue-digest"], facts["replay-issue-digest"]);
assert.match(facts["board-stream"] ?? "", /^issue-board:/);
assert.match(facts["issue-stream"] ?? "", /^issue:/);
assert.ok(
  (facts["latencies-ms"] ?? "")
    .split(",")
    .every((value) => Number.isFinite(Number(value)) && Number(value) <= 2_000),
);
assert.match(digests, /E5_T05_DIGESTS_OK/);

const records = events
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.deepEqual(
  records.map((record) => record.type),
  [
    "issue.opened",
    "issue.commented",
    "issue.commented",
    "issue.labeled",
    "issue.unlabeled",
    "issue.state-changed",
    "issue.state-changed",
  ],
);

const replay = spawnSync(
  process.execPath,
  [
    "packages/cli/dist/src/bin.js",
    "replay",
    resolve(evidence, "e5-t05-session.events.jsonl"),
    "--digest",
    "--reducer",
    "packages/platform/issues-reducer.mjs",
    "--stream-id",
    facts["issue-stream"],
  ],
  { cwd: root, encoding: "utf8" },
);
assert.equal(replay.status, 0, `${replay.stdout}${replay.stderr}`);
assert.equal(replay.stdout.trim(), facts["replay-issue-digest"]);

for (const marker of [
  "drop-watcher-frame sensor=watcher-live-sync",
  "stale-board-offset sensor=board-at-offset-parity",
  "phantom-board-card sensor=board-literal-equality",
]) {
  assert.match(sensitivity, new RegExp(marker));
}
assert.match(sensitivity, /E5_T05_SENSITIVITY_OK cases=3/);

process.stdout.write(
  `E5_T05_EVIDENCE_OK board_offset=${facts["board-offset"]} issue_offset=${facts["issue-offset"]}\n`,
);
