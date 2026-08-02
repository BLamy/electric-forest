#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson, OFFSET_BEFORE_FIRST } from "../../packages/protocol/dist/src/index.js";
import { offsetForOrdinal } from "../../packages/protocol/dist/src/offset-allocation.js";
import { replayWithReducer, requireReducer } from "../../packages/reducers/dist/src/index.js";
import { treeDigest } from "../../packages/streamfs/dist/src/tree.js";

const root = resolve(import.meta.dirname, "../..");
const evidence = resolve(root, ".eforest/tasks/epic-3-the-canopy/E3-T08-branch-switcher/evidence");
const browserText = await readFile(resolve(evidence, "e3-t08-browser.txt"), "utf8");
const digestText = await readFile(resolve(evidence, "e3-t08-digests.json"), "utf8");
const eventText = await readFile(resolve(evidence, "e3-t08-events.json"), "utf8");

for (const marker of [
  "delayed-old-feature-frame ignored-after-rebind=true",
  "feature inherited=true branch-only=true",
  "blob feature branch-owned-content=true parent-bytes-not-leaked=true",
  "branch-only-path-on-main missing=true stale-content=false",
  "feature-reconnect-after-write converged=true branch-live=true main-live-leaked=false",
  "rapid-switch-main-feature retained-checkpoint=true late-frame-isolated=true",
  "independent-replay=equal console-errors=0 page-errors=0",
]) {
  assert.ok(browserText.includes(marker), `browser evidence missing ${marker}`);
}

const digests = JSON.parse(digestText);
assert.equal(digestText, `${canonicalJson(digests)}\n`);
const events = JSON.parse(eventText);
assert.equal(eventText, `${canonicalJson(events)}\n`);
assert.ok(Array.isArray(events.main));
assert.ok(Array.isArray(events.feature));
assert.ok(events.feature.length > events.main.length);

function assertContiguous(records) {
  for (const [index, record] of records.entries()) {
    assert.equal(record.offset, offsetForOrdinal(index));
  }
  assert.equal(
    records.at(-1)?.offset ?? OFFSET_BEFORE_FIRST,
    records.length === 0 ? OFFSET_BEFORE_FIRST : offsetForOrdinal(records.length - 1),
  );
}

assertContiguous(events.main);
assertContiguous(events.feature);
const mainReplay = replayWithReducer(
  requireReducer("streamfs", "fs:maple/reading-room:main:meta"),
  events.main,
);
const featureReplay = replayWithReducer(
  requireReducer("streamfs", "fs:maple/reading-room:feature:meta"),
  events.feature,
);
assert.equal(mainReplay.digest, digests.main.digest);
assert.equal(featureReplay.digest, digests.finalFeature.digest);
assert.equal(treeDigest(featureReplay.state), digests.featureTreeDigest);
assert.ok(featureReplay.state.files["docs/feature.md"]);
assert.ok(!mainReplay.state.files["docs/feature.md"]);

const tampered = structuredClone(events.feature);
tampered[0].payload.path = "tampered";
assert.throws(
  () =>
    replayWithReducer(requireReducer("streamfs", "fs:maple/reading-room:feature:meta"), tampered),
  /orphaned path/,
  "tampering must refute the independent branch replay",
);

process.stdout.write(
  `E3_T08_INDEPENDENT_REPLAY_OK main=${events.main.length} feature=${events.feature.length} checkpoint=${digests.finalFeature.checkpoint} digest=${featureReplay.digest}\n`,
);
