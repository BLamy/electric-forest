import { existsSync, readFileSync } from "node:fs";
import { canonicalJson, compareOffsets } from "../../packages/protocol/dist/src/index.js";
import { StreamReader } from "../../packages/client/dist/src/index.js";
import {
  assertCompleteMergeStage,
  fsInitialState,
  fsReducer,
  treeDigest,
} from "../../packages/streamfs/dist/src/index.js";
import {
  appendJournalRecord,
  atomicWrite,
  commitJournalCheckpoint,
  readJournalRecords,
  recoverWatcherJournal,
} from "./e1_capstone_journal.mjs";

function required(name) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((argument) => argument.startsWith(prefix));
  if (value === undefined || value.slice(prefix.length).length === 0) {
    throw new Error(`missing --${name}`);
  }
  return value.slice(prefix.length);
}

function optional(name) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((argument) => argument.startsWith(prefix));
  return value?.slice(prefix.length);
}

const baseUrl = required("base-url");
const streamId = required("stream-id");
const logPath = required("log");
const checkpointPath = required("checkpoint");
const controlPath = required("control");
const readyPath = required("ready");
const resultPath = required("result");
const faultRequestPath = optional("fault-request");
const faultMarkerPath = optional("fault-marker");
const faultReleasePath = optional("fault-release");
const authorization = process.env.EFOREST_CAPSTONE_AUTHORIZATION;
let configuredFetchRequestCount = 0;

function configuredFetch(input, init = {}) {
  configuredFetchRequestCount += 1;
  const headers = new Headers(init.headers);
  headers.set("Authorization", authorization);
  return fetch(input, { ...init, headers });
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

const recovered = recoverWatcherJournal(logPath, checkpointPath);
let state = reduce(recovered.records);
let current = recovered.checkpoint;
const startedFrom = current;

const reader = new StreamReader({
  baseUrl,
  streamId,
  ...(authorization === undefined ? {} : { fetch: configuredFetch }),
});
let ready = false;
let consecutiveFailures = 0;
let faultTriggered = false;

async function pauseAtAppendBoundary(record) {
  if (
    faultTriggered ||
    faultRequestPath === undefined ||
    faultMarkerPath === undefined ||
    faultReleasePath === undefined ||
    !existsSync(faultRequestPath)
  ) {
    return;
  }
  faultTriggered = true;
  atomicWrite(faultMarkerPath, `${record.offset}\n`);
  while (!existsSync(faultReleasePath)) await sleep(10);
}

for (;;) {
  try {
    for await (const batch of reader.read(current)) {
      for (const record of batch.events) {
        if (compareOffsets(record.offset, current) <= 0) {
          throw new Error(`watcher received duplicate/out-of-order offset ${record.offset}`);
        }
        appendJournalRecord(logPath, record);
        await pauseAtAppendBoundary(record);
        state = fsReducer(state, record);
        current = record.offset;
      }
      commitJournalCheckpoint(checkpointPath, current);
    }
    consecutiveFailures = 0;
    if (!ready) {
      atomicWrite(
        readyPath,
        `${canonicalJson({
          authorizationConfigured: authorization !== undefined,
          checkpoint: current,
          configuredFetchExercised: configuredFetchRequestCount > 0,
          pid: process.pid,
          recoveredTailEvents: recovered.truncated,
          startedFrom,
          streamId,
        })}\n`,
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
      authorizationConfigured: authorization !== undefined,
      checkpoint: current,
      configuredFetchExercised: configuredFetchRequestCount > 0,
      digest: treeDigest(state),
      eventCount: readJournalRecords(logPath).length,
      pid: process.pid,
      recoveredTailEvents: recovered.truncated,
    };
    atomicWrite(resultPath, `${canonicalJson(result)}\n`);
    process.stdout.write(`${canonicalJson(result)}\n`);
    break;
  }
  await sleep(25);
}
