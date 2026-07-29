#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";
import { reduceWriterLanes } from "../../packages/platform/dist/src/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = path.join(
  root,
  ".eforest/tasks/epic-2-the-gates/E2-T09-writer-scoped-fencing/evidence/e2-t09-interleave.jsonl",
);
const records = (await readFile(evidence, "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.equal(records.length, 4);
assert.deepEqual(reduceWriterLanes(records), { "auth0|alice": 2, "auth0|bob": 2 });
assert.deepEqual(
  records.map((record) => [record.payload.writer.sub, record.payload.writer.seq]),
  [
    ["auth0|alice", 1],
    ["auth0|bob", 1],
    ["auth0|alice", 2],
    ["auth0|bob", 2],
  ],
);
const canonical = records.map(canonicalJson).join("\n") + "\n";
const digest = createHash("sha256").update(canonical).digest("hex");
console.log(
  JSON.stringify({
    status: "E2_T09_EVIDENCE_OK",
    events: records.length,
    globalOrder: "1,1,2,2",
    lanes: reduceWriterLanes(records),
    sha256: digest,
  }),
);
