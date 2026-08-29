#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson, stateDigest } from "../../packages/protocol/dist/src/index.js";
import { prInitialState, prReducer } from "../../packages/pr/dist/src/index.js";

const path = process.argv[2];
if (path === undefined) throw new Error("usage: e5_t02_replay_worker.mjs <golden.jsonl>");
const bytes = readFileSync(resolve(path), "utf8");
if (!bytes.endsWith("\n") || bytes.includes("\r")) {
  throw new Error("PR golden must be LF-delimited with a trailing newline");
}
const events = bytes
  .slice(0, -1)
  .split("\n")
  .map((line, index) => {
    const parsed = JSON.parse(line);
    if (canonicalJson(parsed) !== line) {
      throw new Error(`line ${index + 1}: non-canonical JSON`);
    }
    return parsed;
  });
const state = events.reduce(prReducer, prInitialState);
process.stdout.write(`${stateDigest(state)}\n`);
