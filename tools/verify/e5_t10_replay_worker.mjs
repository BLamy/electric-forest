#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  attachmentInitialStateForStream,
  attachmentReducer,
  contentInitialStateForStream,
  contentReducer,
} from "../../packages/evidence/dist/src/index.js";
import { canonicalJson, stateDigest } from "../../packages/protocol/dist/src/index.js";

const [kind, goldenPath, streamId] = process.argv.slice(2);
if ((kind !== "evidence" && kind !== "evidence-content") || !goldenPath || !streamId) {
  throw new Error(
    "usage: e5_t10_replay_worker.mjs <evidence|evidence-content> <golden.jsonl> <stream-id>",
  );
}
const source = readFileSync(resolve(goldenPath), "utf8");
if (!source.endsWith("\n") || source.includes("\r")) {
  throw new Error(`${goldenPath}: golden must be LF-delimited with a trailing newline`);
}
const events = source
  .slice(0, -1)
  .split("\n")
  .map((line, index) => {
    const parsed = JSON.parse(line);
    if (canonicalJson(parsed) !== line) {
      throw new Error(`${goldenPath}:${index + 1}: non-canonical JSON`);
    }
    return parsed;
  });
const state =
  kind === "evidence"
    ? events.reduce(attachmentReducer, attachmentInitialStateForStream(streamId))
    : events.reduce(contentReducer, contentInitialStateForStream(streamId));
process.stdout.write(`${canonicalJson({ digest: stateDigest(state), state })}\n`);
