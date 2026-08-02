#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson, OFFSET_BEFORE_FIRST } from "../../packages/protocol/dist/src/index.js";
import {
  fileViewStreamId,
  replayWithReducer,
  requireReducer,
} from "../../packages/reducers/dist/src/index.js";

const root = resolve(import.meta.dirname, "../..");
const evidence = resolve(
  root,
  ".eforest/tasks/epic-3-the-canopy/E3-T07-file-viewer-patch-aware/evidence",
);
const browserText = await readFile(resolve(evidence, "e3-t07-browser.txt"), "utf8");
const eventText = await readFile(resolve(evidence, "e3-t07-events.jsonl"), "utf8");
const digestText = await readFile(resolve(evidence, "e3-t07-digests.json"), "utf8");

for (const marker of [
  "initial text=true",
  "live patch=true",
  "full-write-fallback=true",
  "rename=true identity-preserved=true",
  "patch-after-rename=true",
  "delete=true file-deleted-visible=true",
  "binary-state=true bytes-not-coerced=true",
  "oversize-state=true",
  "corrupt-base-refusal=true role=alert=true",
  "transport stream-requests=0",
]) {
  assert.ok(browserText.includes(marker), `browser evidence missing ${marker}`);
}

const body = JSON.parse(eventText.trim());
assert.equal(eventText, `${canonicalJson(body)}\n`);
const expectedDigests = JSON.parse(digestText);
assert.equal(digestText, `${canonicalJson(expectedDigests)}\n`);
assert.equal(body.reducer.id, "file-content");
assert.equal(body.reducer.version, 1);
assert.ok(Array.isArray(body.events));
assert.ok(body.events.length >= 10, "projection evidence must include the live mutation phases");
assert.equal(body.checkpoint, body.events.at(-1)?.offset ?? OFFSET_BEFORE_FIRST);

const streamId = fileViewStreamId("maple", "reading-room", "main", "docs/readme.md");
const replay = replayWithReducer(requireReducer("file-content", streamId), body.events);
assert.equal(replay.digest, expectedDigests.renamed.digest);
assert.equal(replay.state.status, "deleted");
assert.equal(replay.state.currentPath, null);
assert.equal(replay.state.identity, "fs:maple/reading-room:main:file:viewer-readme");
assert.equal(replay.state.size, expectedDigests.renamed.size);

const tampered = structuredClone(body.events);
tampered[0].payload.path = "docs/tampered.md";
const tamperedReplay = replayWithReducer(requireReducer("file-content", streamId), tampered);
assert.notEqual(
  tamperedReplay.digest,
  replay.digest,
  "tampering must change the independent digest",
);

for (const phase of ["initial", "patch", "fallback", "renamed", "binary", "oversize"]) {
  assert.match(expectedDigests[phase].digest, /^[0-9a-f]{64}$/);
  assert.ok(Number.isSafeInteger(expectedDigests[phase].size));
}
assert.equal(expectedDigests.oversize.size, 256 * 1024 + 1);
process.stdout.write(
  `E3_T07_INDEPENDENT_REPLAY_OK events=${body.events.length} checkpoint=${body.checkpoint} digest=${replay.digest}\n`,
);
