#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson, OFFSET_BEFORE_FIRST } from "../../packages/protocol/dist/src/index.js";
import { offsetForOrdinal } from "../../packages/protocol/dist/src/offset-allocation.js";
import {
  fileViewStreamId,
  replayWithReducer,
  requireReducer,
} from "../../packages/reducers/dist/src/index.js";
import { resolveBranchLog } from "../../packages/streamfs/dist/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const evidence = resolve(root, ".eforest/tasks/epic-3-the-canopy/E3-T10-the-reading-room/evidence");
const browserText = await readFile(resolve(evidence, "e3-t10-browser.txt"), "utf8");
const eventText = await readFile(resolve(evidence, "e3-t10-events.json"), "utf8");
const digestText = await readFile(resolve(evidence, "e3-t10-digests.json"), "utf8");

for (const marker of [
  "registry route=true",
  "private-cross-tenant-hidden=true",
  "repository-home route=true",
  "main tree=true file=true",
  "second-session-live-edit=true reconnecting=true reconnect-count=1",
  "branch-switch=true",
  "history feature=true",
  "privacy-network=clean browser-origin=platform-only=true console-errors=0 page-errors=0",
]) {
  assert.ok(browserText.includes(marker), `browser evidence missing ${marker}`);
}
assert.doesNotMatch(browserText, /secret-garden|oak/);

const evidenceData = JSON.parse(eventText);
const digests = JSON.parse(digestText);
assert.equal(
  eventText,
  `${canonicalJson(evidenceData)}\n`,
  "event evidence must be canonical JSON",
);
assert.equal(digestText, `${canonicalJson(digests)}\n`, "digest evidence must be canonical JSON");

function replaySnapshot(snapshot, reducerId, streamId) {
  assert.equal(snapshot.reducer.id, reducerId);
  const definition = requireReducer(reducerId, streamId);
  const replay = replayWithReducer(definition, snapshot.events);
  assert.equal(replay.digest, snapshot.digest, `${reducerId} snapshot digest`);
  assert.deepEqual(
    JSON.parse(JSON.stringify(replay.state)),
    snapshot.state,
    `${reducerId} snapshot state`,
  );
  assert.equal(replay.digest, digestsFor(snapshot, reducerId, streamId));
  const expectedCheckpoint = snapshot.events.at(-1)?.offset ?? OFFSET_BEFORE_FIRST;
  assert.equal(snapshot.checkpoint, expectedCheckpoint);
  return replay;
}

function digestsFor(snapshot, reducerId, streamId) {
  if (streamId === "__registry__") return digests.registry.digest;
  if (streamId === "repo-home:maple/reading-room:namespace") return digests.home.namespace.digest;
  if (streamId === "repo-home:maple/reading-room:branches") return digests.home.branches.digest;
  if (streamId === "repo-home:maple/reading-room:status") return digests.home.status.digest;
  if (reducerId === "streamfs" && streamId.endsWith(":main:meta")) return digests.mainTree.digest;
  if (reducerId === "streamfs" && streamId.endsWith(":feature-typography:meta"))
    return digests.featureTree.digest;
  if (reducerId === "file-content" && streamId.includes("/reading-room/main/"))
    return digests.mainFile.digest;
  if (reducerId === "file-content" && streamId.includes("/reading-room/feature-typography/"))
    return digests.featureFile.digest;
  if (reducerId === "history" && streamId.endsWith(":main:meta")) return digests.mainHistory.digest;
  if (reducerId === "history" && streamId.endsWith(":feature-typography:meta"))
    return digests.featureHistory.digest;
  throw new Error(`missing digest mapping for ${reducerId}/${streamId}`);
}

const registry = replaySnapshot(evidenceData.registry, "registry", "__registry__");
assert.ok(registry.state.orgs.maple);
assert.equal(registry.state.orgs.oak, undefined);

const homeNamespace = replaySnapshot(
  evidenceData.home.namespace,
  "repo-namespace",
  "repo-home:maple/reading-room:namespace",
);
const homeBranches = replaySnapshot(
  evidenceData.home.branches,
  "repo-branches",
  "repo-home:maple/reading-room:branches",
);
replaySnapshot(evidenceData.home.status, "repo-status", "repo-home:maple/reading-room:status");
assert.equal(homeNamespace.state.metadata.repo, "reading-room");
assert.ok(homeBranches.state.branches["feature-typography"]);
assert.equal(
  homeBranches.state.branches["feature-typography"].parentStreamId,
  "fs:maple/reading-room:main:meta",
);

const mainTree = replaySnapshot(
  evidenceData.mainTree,
  "streamfs",
  "fs:maple/reading-room:main:meta",
);
const featureTree = replaySnapshot(
  evidenceData.featureTree,
  "streamfs",
  "fs:maple/reading-room:feature-typography:meta",
);
const mainFile = replaySnapshot(
  evidenceData.mainFile,
  "file-content",
  fileViewStreamId("maple", "reading-room", "main", "docs/readme.md"),
);
const featureFile = replaySnapshot(
  evidenceData.featureFile,
  "file-content",
  fileViewStreamId("maple", "reading-room", "feature-typography", "docs/feature.md"),
);
replaySnapshot(evidenceData.mainHistory, "history", "fs:maple/reading-room:main:meta");
replaySnapshot(
  evidenceData.featureHistory,
  "history",
  "fs:maple/reading-room:feature-typography:meta",
);

function stripWriterMetadata(record) {
  if (
    record.payload === null ||
    typeof record.payload !== "object" ||
    Array.isArray(record.payload)
  ) {
    return record;
  }
  return {
    ...record,
    payload: Object.fromEntries(
      Object.entries(record.payload).filter(([key]) => key !== "actor" && key !== "writer"),
    ),
  };
}

function rebase(records) {
  return records.map((record, index) => ({ ...record, offset: offsetForOrdinal(index) }));
}

const mainRaw = evidenceData.rawStreams["fs:maple/reading-room:main:meta"];
const featureRaw = evidenceData.rawStreams["fs:maple/reading-room:feature-typography:meta"];
assert.equal(mainRaw.length, 7);
assert.equal(featureRaw.length, 3);
const expectedMain = rebase(mainRaw.slice(0, 6));
const expectedFeature = rebase(
  resolveBranchLog([
    {
      streamId: "fs:maple/reading-room:feature-typography:meta",
      records: featureRaw.map(stripWriterMetadata),
    },
    {
      streamId: "fs:maple/reading-room:main:meta",
      records: mainRaw.map(stripWriterMetadata),
    },
  ]),
);
assert.deepEqual(
  evidenceData.mainTree.events,
  expectedMain,
  "main tree is an official-stream replay",
);
assert.deepEqual(evidenceData.featureTree.events, expectedFeature, "feature tree is a fork replay");
assert.equal(mainFile.state.text, "# Reading Room\n\nSecond session edit arrived live.\n");
assert.equal(featureFile.state.text, "# Feature Typography\n\nFeature branch text.\n");

const historyEvents = evidenceData.mainHistory.events;
assert.equal(historyEvents.length, mainRaw.length);
for (const [index, record] of historyEvents.entries()) {
  assert.equal(record.offset, offsetForOrdinal(index));
  assert.equal(record.sourceStreamId, "fs:maple/reading-room:main:meta");
  assert.equal(typeof record.actor, "string");
}
assert.ok(
  evidenceData.featureHistory.events.some(
    (record) => record.type === "fs.file.create" && record.payload.path === "docs/feature.md",
  ),
);

const tampered = structuredClone(evidenceData.mainTree.events);
tampered[3].payload.size += 1;
const tamperedReplay = replayWithReducer(
  requireReducer("streamfs", "fs:maple/reading-room:main:meta"),
  tampered,
);
assert.notEqual(tamperedReplay.digest, mainTree.digest, "one payload byte must change tree digest");
assert.doesNotMatch(eventText, /secret-garden|oak/);

process.stdout.write(
  `E3_T10_INDEPENDENT_REPLAY_OK registry=${registry.digest} mainTree=${mainTree.digest} featureTree=${featureTree.digest} mainFile=${mainFile.digest} featureFile=${featureFile.digest}\n`,
);
