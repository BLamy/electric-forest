#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidenceDir = join(root, ".eforest/tasks/epic-6-the-loop/E6-T07-agent-run-protocol/evidence");
const { canonicalJson } = await import(join(root, "packages/protocol/dist/src/index.js"));
const { isRunEvent, replayRunLog, runLogDigest, runStateDigest } = await import(
  join(root, "packages/loop/dist/src/index.js")
);

const runPath = join(evidenceDir, "e6-t07-run.jsonl");
const digestPath = join(evidenceDir, "e6-t07-digests.json");
const lines = readFileSync(runPath, "utf8").trimEnd().split("\n");
assert.ok(lines.length > 0, "the frozen run stream must not be empty");
const records = lines.map((line, index) => {
  const record = JSON.parse(line);
  assert.equal(canonicalJson(record), line, `run record ${index} is not canonical JSON`);
  const event = { type: record.type, payload: record.payload, ts: record.ts };
  assert.equal(isRunEvent(event), true, `run record ${index} is not a valid run event`);
  return record;
});

const stream = records[0].payload.run;
const first = replayRunLog(stream, records);
const second = replayRunLog(stream, records);
assert.deepEqual(first, second, "replaying the run twice changed the projection");
assert.equal(runStateDigest(first), runStateDigest(second));
assert.equal(runLogDigest(records), runLogDigest(records));
assert.equal(first.status, "completed");
assert.equal(first.inputs, 1);
assert.equal(first.toolResults, 1);
assert.equal(first.gateResults, 1);
assert.equal(first.artifacts, 1);
assert.equal(first.heartbeats, 1);
assert.deepEqual(first.mutationIntents, ["mutation-evidence"]);
assert.deepEqual(first.mutationIds, ["mutation-evidence"]);

const expectedLine = readFileSync(digestPath, "utf8").trim();
const expected = JSON.parse(expectedLine);
assert.equal(canonicalJson(expected), expectedLine, "frozen digest record is not canonical JSON");
assert.deepEqual(expected, {
  events: records.length,
  logDigest: runLogDigest(records),
  mutationDigest: expected.mutationDigest,
  stateDigest: runStateDigest(first),
  stream,
});

const dump = readFileSync(runPath, "utf8");
for (const pattern of [
  /Bearer\s+[A-Za-z0-9._~-]+/i,
  /(?:^|[\s":=])(?:ef_cli_|cap_v1\.|sk-|gh[pousr]_)[A-Za-z0-9._~-]+/i,
]) {
  assert.equal(pattern.test(dump), false, `raw credential matched ${pattern}`);
}
console.log(
  `E6_T07_RUN stream=${stream} events=${records.length} state=${runStateDigest(first)} log=${runLogDigest(records)}`,
);
