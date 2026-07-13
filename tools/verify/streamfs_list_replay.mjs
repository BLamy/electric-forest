import { readFileSync } from "node:fs";
import { replay } from "../../packages/protocol/dist/src/index.js";
import { listTree } from "../../packages/streamfs/dist/src/index.js";
import { fsInitialState, fsReducer } from "../../packages/streamfs/dist/src/reducer.js";

const path = process.argv[2];
if (!path) throw new Error("missing golden path");
const records = readFileSync(path, "utf8")
  .trimEnd()
  .split("\n")
  .map((line) => JSON.parse(line));
const state = replay(records, fsReducer, fsInitialState);
process.stdout.write(`${listTree(state).join("\n")}\n`);
