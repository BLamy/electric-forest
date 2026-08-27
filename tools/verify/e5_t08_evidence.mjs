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
const evidence =
  process.env.E5_T08_EVIDENCE_DIR === undefined
    ? resolve(root, ".eforest/tasks/epic-5-the-meadow/E5-T08-wiki-branch-live/evidence")
    : resolve(process.env.E5_T08_EVIDENCE_DIR);
const read = (name) => readFile(resolve(evidence, name), "utf8");

const [audit, browserText, coverage, digests, events, fence, goldenText, parity, sensitivity] =
  await Promise.all([
    read("e5-t08-write-audit.txt"),
    read("e5-t08-browser-fallback.json"),
    read("e5-t08-coverage.md"),
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
    "fs.file.patch",
    "fs.file.write",
    "fs.rename",
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
assert.deepEqual(Object.keys(replay.state.files).sort(), ["guide.md", "hostile.md"]);
assert.equal(records[5].type, "fs.file.write");
assert.equal(records[6].type, "fs.rename");
assert.deepEqual(records[6].payload, {
  v: 2,
  from: "home.md",
  to: "guide.md",
  actor: records[6].payload.actor,
  writer: records[6].payload.writer,
});

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
assert.equal(facts["page-paths"], "guide.md,hostile.md");
assert.match(digests, /E5_T08_DIGEST_PARITY_OK/);

assert.match(audit, /browser-dispatch-posts=10 accepted=8 refused=2 other-state-writes=0/);
assert.match(audit, /accepted-browser-edits=3 patch=2 full-write=1/);
assert.match(audit, /pointer-renames=1 rename-event=fs\.rename old-route=missing new-route=guide/);
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
assert.match(parity, /browser-save-events=fs\.file\.patch,fs\.file\.patch,fs\.file\.write/);
assert.match(parity, /browser-full-write-content-generation=canonical-exact-bytes/);
assert.match(parity, /E5_T08_PATCH_PARITY_OK/);

const browser = JSON.parse(browserText);
const coverageHead = /^candidate-head=([a-f0-9]{40})$/m.exec(coverage)?.[1];
assert.equal(browser.candidateHead, coverageHead, "browser and hunk coverage use one exact head");
assert.equal(browser.sessions, 2);
assert.equal(browser.liveWithinBudget, true);
assert.equal(browser.fullWriteWithinBudget, true);
assert.equal(browser.renameWithinBudget, true);
assert.deepEqual(browser.navigationCounts, { followerView: 0, followerIndex: 0 });
assert.equal(browser.console.writerErrors, 0);
assert.equal(browser.console.followerErrors, 0);
assert.equal(browser.console.pageErrors, 0);
assert.ok(browser.console.writerLog.every((entry) => entry.type !== "error"));
assert.ok(browser.console.followerLog.every((entry) => entry.type !== "error"));
assert.deepEqual(browser.console.pageErrorLog, []);
assert.equal(browser.console.unexpectedRequestFailures, 0);
assert.ok(browser.console.expectedCanceledWikiReads >= 0);
assert.equal(
  browser.console.requestFailureLog.length,
  browser.console.expectedCanceledWikiReads,
  "request failure transcript is complete",
);
assert.equal(browser.network.dispatchPosts.length, 10);
assert.equal(browser.network.requestCount, 10);
assert.equal(browser.network.responseCount, 10);
assert.equal(browser.network.responseLifecycle.length, 10);
assert.equal(browser.network.otherStateWrites, 0);
assert.deepEqual(browser.network.responseReasons, [
  "accepted",
  "accepted",
  "accepted",
  "accepted",
  "accepted",
  "accepted",
  "accepted",
  "accepted",
  "fs/branch-exists",
  "stale-base",
]);
assert.deepEqual(browser.fullWrite, {
  metadataOffset: records[5].offset,
  contentStreamId: "fs:maple/reading-room:wiki:file:00000000-0000-4000-8000-000000000001",
  canonicalContentEvents: 2,
  exactBytes: true,
  writerSourceExact: true,
  followerSourceExact: true,
});
assert.deepEqual(browser.rename, {
  metadataOffset: records[6].offset,
  type: "fs.rename",
  oldPath: "home.md",
  oldRouteMissing: true,
  newPath: "guide.md",
  writerFollowerConverged: true,
});
assert.ok(Object.values(browser.assertions).every((value) => value === true));

for (const marker of [
  "mutation=forced-full-write expected=canonical patch chooser assertion",
  "mutation=optimistic-local-apply expected=no-optimistic-revision",
  "mutation=stripped-base expected=caller base revision assertion",
  "mutation=unsanitized-renderer expected=hostile sanitizer assertion",
  "mutation=corrupted-golden expected=independent replay matches committed golden",
]) {
  assert.match(sensitivity, new RegExp(marker));
}
assert.match(sensitivity, /E5_T08_SENSITIVITY_OK cases=5/);
assert.match(coverage, /E5_T08_COVERAGE_OK/);
assert.match(coverage, /behavior=pointer-rename .*event=fs\.rename/);
assert.match(coverage, /behavior=canonical-full-write .*event=fs\.file\.write/);

const mutated = structuredClone(records);
const hostileWrite = mutated.at(-1);
hostileWrite.payload.contentSha256 = `${hostileWrite.payload.contentSha256[0] === "0" ? "1" : "0"}${hostileWrite.payload.contentSha256.slice(1)}`;
const mutatedReplay = replayWithReducer(streamFsReducerDefinition, mutated, streamId);
assert.notEqual(mutatedReplay.digest, golden, "one-byte metadata mutation changes the digest");

process.stdout.write(
  `E5_T08_EVIDENCE_OK events=${records.length} head=${records.at(-1).offset} digest=${golden}\n`,
);
