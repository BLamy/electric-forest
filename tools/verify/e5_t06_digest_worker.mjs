#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  meadowPrInitialStateForStream,
  meadowPrReducer,
} from "../../packages/meadow/dist/src/index.js";
import { stateDigest } from "../../packages/protocol/dist/src/index.js";
import { fsInitialState, fsReducer, treeDigest } from "../../packages/streamfs/dist/src/index.js";

const [kind, relativePath, streamId] = process.argv.slice(2);
if ((kind !== "target" && kind !== "pr") || relativePath === undefined) {
  throw new Error("usage: e5_t06_digest_worker.mjs <target|pr> <dump> [stream-id]");
}

const source = readFileSync(resolve(process.cwd(), relativePath), "utf8");
const records = source
  .trimEnd()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

if (kind === "target") {
  const state = records.reduce(fsReducer, fsInitialState);
  process.stdout.write(
    `${JSON.stringify({ digest: stateDigest(state), state, treeDigest: treeDigest(state) })}\n`,
  );
} else {
  if (streamId === undefined) throw new Error("PR replay requires a stream id");
  const state = records.reduce(meadowPrReducer, meadowPrInitialStateForStream(streamId));
  process.stdout.write(`${JSON.stringify({ digest: stateDigest(state), state })}\n`);
}
