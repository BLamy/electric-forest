#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";
import {
  replayWithReducer,
  streamFsReducerDefinition,
} from "../../packages/reducers/dist/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const evidence = resolve(root, ".eforest/tasks/epic-5-the-meadow/E5-T08-wiki-branch-live/evidence");
const read = (name) => readFile(resolve(evidence, name), "utf8");

const [audit, browserText, digests, events, fence, goldenText, parity, sensitivity] =
  await Promise.all([
    read("e5-t08-write-audit.txt"),
    read("e5-t08-browser-fallback.json"),
    read("e5-t08-digests.txt"),
    read("e5-t08-session.events.jsonl"),
    read("e5-t08-fence.txt"),
    read("e5-t08-golden.digest"),
    read("e5-t08-patch-parity.txt"),
    read("e5-t08-sensitivity.md"),
  ]);

const golden = goldenText.trim();
assert.match(golden, /^[a-f0-9]{64}$/);
assert.equal(goldenText, `${golden}\n`, "golden digest has one terminal newline");

const records = events
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.equal(events, `${records.map((record) => canonicalJson(record)).join("\n")}\n`);
assert.deepEqual(
  records.map((record) => record.type),
  [
    "fs.branch.genesis",
    "fs.file.create",
    "fs.file.write",
    "fs.file.patch",
    "fs.file.create",
    "fs.file.delete",
    "fs.file.create",
    "fs.file.write",
  ],
);

const streamId = "fs:maple/reading-room:wiki:meta";
const replay = replayWithReducer(streamFsReducerDefinition, records, streamId);
assert.equal(replay.digest, golden, "independent replay matches committed golden");
assert.ok(Object.hasOwn(replay.state.tombstones, "disposable.md"));
assert.equal(Object.hasOwn(replay.state.files, "disposable.md"), false);
assert.deepEqual(Object.keys(replay.state.files).sort(), ["home.md", "hostile.md"]);

const facts = Object.fromEntries(
  digests
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => line.split(/=(.*)/s).slice(0, 2)),
);
for (const key of [
  "writer-dom-digest",
  "follower-dom-digest",
  "server-projection-digest",
  "independent-replay-digest",
  "committed-golden-digest",
]) {
  assert.equal(facts[key], golden, `${key} matches golden`);
}
assert.equal(facts["projection-head-offset"], records.at(-1).offset);
assert.equal(facts["page-paths"], "home.md,hostile.md");
assert.match(digests, /E5_T08_DIGEST_PARITY_OK/);

assert.match(audit, /browser-dispatch-posts=7 accepted=5 refused=2 other-state-writes=0/);
assert.match(audit, /refusals=fs\/branch-exists,stale-base/);
assert.match(audit, /E5_T08_WRITE_AUDIT_OK/);
assert.match(fence, /refusal-class=validator-rejected/);
assert.match(fence, /refusal-reason=stale-base/);
assert.match(fence, /log-bytes-before-after-equal=true/);
assert.match(fence, /draft-remained-unapplied=true/);
assert.match(fence, /automatic-retry-count=0/);
assert.match(fence, /E5_T08_FENCE_OK/);
assert.match(parity, new RegExp(`patch-digest=${golden}`));
assert.match(parity, new RegExp(`full-write-digest=${golden}`));
assert.match(parity, /patch-wire-strictly-smaller=true/);
assert.match(parity, /browser-save-event=fs\.file\.patch/);
assert.match(parity, /E5_T08_PATCH_PARITY_OK/);

const browser = JSON.parse(browserText);
assert.equal(browser.sessions, 2);
assert.equal(browser.liveWithinBudget, true);
assert.deepEqual(browser.navigationCounts, { followerView: 0, followerIndex: 0 });
assert.deepEqual(browser.console, {
  writerErrors: 0,
  followerErrors: 0,
  pageErrors: 0,
  expectedCanceledWikiReads: browser.console.expectedCanceledWikiReads,
  unexpectedRequestFailures: 0,
});
assert.ok(browser.console.expectedCanceledWikiReads >= 0);
assert.equal(browser.network.dispatchPosts.length, 7);
assert.equal(browser.network.otherStateWrites, 0);
assert.deepEqual(browser.network.responseReasons, [
  "accepted",
  "accepted",
  "accepted",
  "accepted",
  "accepted",
  "fs/branch-exists",
  "stale-base",
]);
assert.ok(Object.values(browser.assertions).every((value) => value === true));

for (const marker of [
  "one-byte-event-digest sensor=wiki-digest-parity:server-replay EXPECTED-FAIL OK",
  "delayed-writer-tail sensor=no-optimistic-offset,no-optimistic-digest,no-optimistic-revision EXPECTED-FAIL OK",
  "stale-editor sensor=stale-fence-log-bytes,no-auto-retry EXPECTED-FAIL OK",
  "hostile-markdown sensor=window-sentinel,active-dom,dangerous-protocol EXPECTED-FAIL OK",
]) {
  assert.match(sensitivity, new RegExp(marker));
}
assert.match(sensitivity, /E5_T08_SENSITIVITY_OK cases=4/);

const mutated = structuredClone(records);
const hostileWrite = mutated.at(-1);
hostileWrite.payload.contentSha256 = `${hostileWrite.payload.contentSha256.slice(0, -1)}0`;
const mutatedReplay = replayWithReducer(streamFsReducerDefinition, mutated, streamId);
assert.notEqual(mutatedReplay.digest, golden, "one-byte metadata mutation changes the digest");

process.stdout.write(
  `E5_T08_EVIDENCE_OK events=${records.length} head=${records.at(-1).offset} digest=${golden}\n`,
);
