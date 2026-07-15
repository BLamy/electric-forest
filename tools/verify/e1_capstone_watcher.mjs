import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  compareOffsets,
  canonicalJson,
  OFFSET_BEFORE_FIRST,
} from "../../packages/protocol/dist/src/index.js";
import { StreamReader } from "../../packages/client/dist/src/index.js";
import {
  assertCompleteMergeStage,
  fsInitialState,
  fsReducer,
  treeDigest,
} from "../../packages/streamfs/dist/src/index.js";

function required(name) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((argument) => argument.startsWith(prefix));
  if (value === undefined || value.slice(prefix.length).length === 0) {
    throw new Error(`missing --${name}`);
  }
  return value.slice(prefix.length);
}

const baseUrl = required("base-url");
const streamId = required("stream-id");
const logPath = required("log");
const checkpointPath = required("checkpoint");
const controlPath = required("control");
const readyPath = required("ready");
const resultPath = required("result");

function atomicWrite(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, value, "utf8");
  renameSync(temporary, path);
}

function readLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function reduce(records) {
  let state = fsInitialState;
  for (const record of records) state = fsReducer(state, record);
  assertCompleteMergeStage(state);
  return state;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const existing = readLines(logPath);
let state = reduce(existing);
let current = existsSync(checkpointPath)
  ? readFileSync(checkpointPath, "utf8").trim()
  : OFFSET_BEFORE_FIRST;
const startedFrom = current;
if (existing.length > 0 && existing.at(-1).offset !== current) {
  throw new Error("watcher checkpoint does not match its received log");
}

const reader = new StreamReader({ baseUrl, streamId });
let ready = false;
let consecutiveFailures = 0;

for (;;) {
  try {
    for await (const batch of reader.read(current)) {
      for (const record of batch.events) {
        if (compareOffsets(record.offset, current) <= 0) {
          throw new Error(`watcher received duplicate/out-of-order offset ${record.offset}`);
        }
        appendFileSync(logPath, `${canonicalJson(record)}\n`, "utf8");
        state = fsReducer(state, record);
        current = record.offset;
      }
      atomicWrite(checkpointPath, `${current}\n`);
    }
    consecutiveFailures = 0;
    if (!ready) {
      atomicWrite(
        readyPath,
        `${canonicalJson({ checkpoint: current, pid: process.pid, startedFrom, streamId })}\n`,
      );
      ready = true;
    }
  } catch (error) {
    consecutiveFailures += 1;
    if (consecutiveFailures > 200) throw error;
  }

  const expected = existsSync(controlPath) ? readFileSync(controlPath, "utf8").trim() : "";
  if (expected.length > 0 && compareOffsets(current, expected) >= 0) {
    if (current !== expected) {
      throw new Error(`watcher passed expected offset ${expected}: ${current}`);
    }
    assertCompleteMergeStage(state);
    const result = {
      checkpoint: current,
      digest: treeDigest(state),
      eventCount: readLines(logPath).length,
      pid: process.pid,
    };
    atomicWrite(resultPath, `${canonicalJson(result)}\n`);
    process.stdout.write(`${canonicalJson(result)}\n`);
    break;
  }
  await sleep(25);
}
