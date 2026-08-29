#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson, OFFSET_BEFORE_FIRST } from "../../packages/protocol/dist/src/index.js";
import { offsetForOrdinal } from "../../packages/protocol/dist/src/offset-allocation.js";
import {
  historyReducerDefinition,
  replayWithReducer,
} from "../../packages/reducers/dist/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const evidence = resolve(
  root,
  ".eforest/tasks/epic-3-the-canopy/E3-T09-history-event-log/evidence",
);
const browserText = await readFile(resolve(evidence, "e3-t09-browser.txt"), "utf8");
const eventText = await readFile(resolve(evidence, "e3-t09-events.json"), "utf8");
const digestText = await readFile(resolve(evidence, "e3-t09-digests.json"), "utf8");

for (const marker of [
  "malformed-history-refusal=true",
  "main rows=5 newest-first=true unknown-raw-citable=true actors-from-writer=true",
  "reload ordering-stable=true",
  "same-timestamp offset-order=true live-events-prepend=true history-preserved=true",
  "same-timestamp-writers=auth0|writer-a,auth0|writer-b",
  "boundary-reconnect=true event-preserved=true status=live",
  "feature inherited=true fork-visible=true branch-local=true sampled-random-row-byte-match=true",
  "console-errors=0 page-errors=0",
]) {
  assert.ok(browserText.includes(marker), `browser evidence missing ${marker}`);
}
assert.match(browserText, /sample-seed=0xe309 sample-indices=\d+(,\d+){0,2} rows=6/);

const events = JSON.parse(eventText);
const digests = JSON.parse(digestText);
assert.equal(eventText, `${canonicalJson(events)}\n`, "event evidence must be canonical JSON");
assert.equal(digestText, `${canonicalJson(digests)}\n`, "digest evidence must be canonical JSON");
assert.ok(Array.isArray(events.main));
assert.ok(Array.isArray(events.feature));
assert.equal(events.main.length, 8);
assert.equal(events.feature.length, 6);

function assertContiguous(records) {
  for (const [index, record] of records.entries()) {
    assert.equal(record.offset, offsetForOrdinal(index));
    assert.equal(typeof record.sourceStreamId, "string");
    assert.equal(typeof record.actor, "string");
  }
  assert.equal(
    records.at(-1)?.offset ?? OFFSET_BEFORE_FIRST,
    records.length === 0 ? OFFSET_BEFORE_FIRST : offsetForOrdinal(records.length - 1),
  );
}

assertContiguous(events.main);
assertContiguous(events.feature);
assert.deepEqual(events.feature.slice(0, 4), events.main.slice(0, 4));
assert.equal(events.feature[4].type, "fs.branch.fork");
assert.equal(events.feature[4].sourceStreamId, "fs:maple/reading-room:feature:meta");
assert.equal(events.feature[4].actor, "unknown-actor");
assert.equal(events.feature[5].sourceStreamId, "fs:maple/reading-room:feature:meta");
assert.equal(events.feature[5].actor, "auth0|ada-history-event-log");

const mainReplay = replayWithReducer(historyReducerDefinition, events.main);
const featureReplay = replayWithReducer(historyReducerDefinition, events.feature);
assert.equal(mainReplay.digest, digests.main.digest);
assert.equal(featureReplay.digest, digests.feature.digest);
assert.deepEqual(mainReplay.state, digests.main.state);
assert.deepEqual(featureReplay.state, digests.feature.state);

const unknown = events.main.find((record) => record.type === "future.event");
assert.ok(unknown, "unknown event is retained");
assert.equal(unknown.payload.v, 99, "higher version remains visible");
assert.equal(unknown.sourceStreamId, "fs:maple/reading-room:main:meta");
assert.equal(unknown.actor, "auth0|ada-history-event-log");
const spoof = events.main.find((record) => record.type === "future.actor-spoof");
assert.ok(spoof, "actor spoof event is retained");
assert.equal(spoof.payload.actor, "auth0|ada-history-event-log");
assert.equal(spoof.actor, "auth0|ada-history-event-log");
const unknownKnownType = events.main.find(
  (record) => record.type === "fs.file.create" && record.payload?.v === 99,
);
assert.ok(unknownKnownType, "higher-version known type is retained");
assert.equal(unknownKnownType.sourceStreamId, "fs:maple/reading-room:main:meta");

const tampered = structuredClone(events.main);
tampered[1].payload.path = "tampered";
const tamperedReplay = replayWithReducer(historyReducerDefinition, tampered);
assert.notEqual(
  tamperedReplay.digest,
  mainReplay.digest,
  "one payload byte must invalidate the digest",
);

process.stdout.write(
  `E3_T09_INDEPENDENT_REPLAY_OK main=${events.main.length} feature=${events.feature.length} mainDigest=${mainReplay.digest} featureDigest=${featureReplay.digest}\n`,
);
