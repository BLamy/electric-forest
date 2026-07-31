#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson, OFFSET_BEFORE_FIRST } from "../../packages/protocol/dist/src/index.js";
import { replayWithReducer, requireReducer } from "../../packages/reducers/dist/src/index.js";
import { listTree } from "../../packages/streamfs/dist/src/tree.js";

const root = resolve(import.meta.dirname, "../..");
const evidence = resolve(root, ".eforest/tasks/epic-3-the-canopy/E3-T06-file-tree-live/evidence");
const eventText = await readFile(resolve(evidence, "e3-t06-events.jsonl"), "utf8");
const digestText = await readFile(resolve(evidence, "e3-t06-digests.json"), "utf8");
const records = eventText
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const expected = JSON.parse(digestText);

assert.equal(eventText, `${records.map((record) => canonicalJson(record)).join("\n")}\n`);
assert.equal(digestText, `${canonicalJson(expected)}\n`);
assert.ok(records.length >= 13, "event evidence must include initial and live mutation phases");

const streamId = "fs:maple/reading-room:main:meta";
const replay = replayWithReducer(requireReducer("streamfs", streamId), records);
assert.equal(records.at(-1)?.offset ?? OFFSET_BEFORE_FIRST, expected.final.checkpoint);
assert.equal(replay.digest, expected.final.digest);
const rows = listTree(replay.state);
assert.ok(rows.some((row) => row.startsWith("D archive")));
assert.ok(rows.some((row) => row.startsWith("D archive-docs")));
assert.ok(rows.some((row) => row.startsWith("F guide.md ")));
assert.ok(rows.some((row) => row.startsWith("F obsolete.txt ")));
assert.ok(!rows.some((row) => row.includes("guide-old.md")));
assert.ok(!rows.some((row) => row.includes(" notes")));

const tampered = structuredClone(records);
tampered[0].payload.path = "docs-tampered";
assert.throws(() => replayWithReducer(requireReducer("streamfs", streamId), tampered));
process.stdout.write(`E3_T06_INDEPENDENT_REPLAY_OK events=${records.length} rows=${rows.length}\n`);
