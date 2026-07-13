import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { canonicalJson, compareOffsets } from "../../packages/protocol/dist/src/index.js";
import { StreamReader } from "../../packages/client/dist/src/index.js";
import { fsInitialState, fsReducer, watch } from "../../packages/streamfs/dist/src/index.js";

const [role, baseUrl, streamId, mode, checkpointPath, eventsPath, statePath, readyPath] =
  process.argv.slice(2);

if (
  !role ||
  !baseUrl ||
  !streamId ||
  !mode ||
  !checkpointPath ||
  !eventsPath ||
  !statePath ||
  !readyPath ||
  (role !== "live" && role !== "cold")
) {
  throw new Error(
    "usage: convergence-client role baseUrl streamId mode checkpoint events state ready",
  );
}

function readCheckpoint() {
  try {
    const value = JSON.parse(readFileSync(checkpointPath, "utf8"));
    return typeof value.offset === "string" ? value.offset : "-1";
  } catch {
    return "-1";
  }
}

function readRecords() {
  if (!existsSync(eventsPath)) return [];
  const text = readFileSync(eventsPath, "utf8");
  if (text.trim().length === 0) return [];
  return text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function writeCheckpoint(offset) {
  const temporary = `${checkpointPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${canonicalJson({ offset })}\n`);
  renameSync(temporary, checkpointPath);
}

function writeState(state) {
  writeFileSync(statePath, `${canonicalJson(state)}\n`);
}

function eventWithoutOffset(record) {
  const event = { ...record };
  delete event.offset;
  return event;
}

function reduceRecords(records) {
  let state = fsInitialState;
  for (const record of records) state = fsReducer(state, record);
  return state;
}

let checkpoint = readCheckpoint();
let records = readRecords().filter((record) => compareOffsets(record.offset, checkpoint) <= 0);
if (records.length !== readRecords().length) {
  writeFileSync(
    eventsPath,
    records.length === 0 ? "" : `${records.map((record) => canonicalJson(record)).join("\n")}\n`,
  );
}
let state = reduceRecords(records);
let rawSeen = records.length;
writeState(state);
writeCheckpoint(checkpoint);

function appendRecords(nextRecords, nextCheckpoint, suppressIndex) {
  const accepted = [];
  for (const record of nextRecords) {
    rawSeen += 1;
    if (rawSeen === suppressIndex) continue;
    state = fsReducer(state, record);
    records.push(record);
    accepted.push(record);
  }
  if (accepted.length > 0) {
    appendFileSync(eventsPath, `${accepted.map((record) => canonicalJson(record)).join("\n")}\n`);
  }
  checkpoint = nextCheckpoint;
  writeState(state);
  writeCheckpoint(checkpoint);
}

async function readThrough(reader, from, boundary, suppressIndex) {
  const next = [];
  for await (const batch of reader.read(from)) {
    for (const record of batch.events) {
      if (compareOffsets(record.offset, boundary) <= 0) next.push(record);
    }
  }
  appendRecords(next, boundary, suppressIndex);
}

async function runCold() {
  const reader = new StreamReader({ baseUrl, streamId });
  const next = [];
  for await (const batch of reader.read("-1")) next.push(...batch.events);
  state = fsInitialState;
  records = [];
  writeFileSync(eventsPath, "");
  appendRecords(next, next.at(-1)?.offset ?? "-1", undefined);
  writeFileSync(readyPath, `${canonicalJson({ pid: process.pid, role: "cold" })}\n`);
}

async function runLive() {
  const reader = new StreamReader({ baseUrl, streamId, reconnectDelayMs: 0 });
  const suppressIndex = process.env.EF_SUPPRESS_LIVE
    ? Number(process.env.EF_SUPPRESS_LIVE)
    : undefined;
  let queue = Promise.resolve();
  let watcher;
  watcher = watch(".", {
    baseUrl,
    streamId,
    mode,
    from: checkpoint,
    reconnectDelayMs: 0,
  });
  watcher.on("error", (error) => {
    writeFileSync(`${readyPath}.error`, String(error));
  });
  watcher.onBatch((_watchRecords, nextCheckpoint) => {
    queue = queue.then(() => readThrough(reader, checkpoint, nextCheckpoint.offset, suppressIndex));
  });
  await watcher.ready;
  writeFileSync(readyPath, `${canonicalJson({ pid: process.pid, role: "live", mode })}\n`);
  await new Promise((resolve) => {
    const shutdown = async () => {
      await queue;
      await watcher.close();
      resolve();
    };
    process.once("SIGTERM", () => void shutdown());
    process.once("SIGINT", () => void shutdown());
  });
}

try {
  if (role === "cold") await runCold();
  else await runLive();
} catch (error) {
  writeFileSync(
    `${readyPath}.error`,
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
}
