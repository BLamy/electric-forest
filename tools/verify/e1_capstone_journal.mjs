import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  canonicalJson,
  compareOffsets,
  OFFSET_BEFORE_FIRST,
} from "../../packages/protocol/dist/src/index.js";

export function atomicWrite(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, value, "utf8");
  renameSync(temporary, path);
}

export function readJournalRecords(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  if (text.length === 0) return [];
  if (!text.endsWith("\n")) throw new Error("watcher journal has a truncated final record");
  const records = [];
  let previous = OFFSET_BEFORE_FIRST;
  for (const [index, line] of text.slice(0, -1).split("\n").entries()) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(`watcher journal line ${index + 1} is not JSON`);
    }
    if (canonicalJson(record) !== line) {
      throw new Error(`watcher journal line ${index + 1} is not canonical JSON`);
    }
    if (typeof record.offset !== "string" || compareOffsets(record.offset, previous) <= 0) {
      throw new Error(`watcher journal line ${index + 1} has a duplicate/out-of-order offset`);
    }
    previous = record.offset;
    records.push(record);
  }
  return records;
}

function writeJournal(path, records) {
  atomicWrite(
    path,
    records.length === 0 ? "" : `${records.map((record) => canonicalJson(record)).join("\n")}\n`,
  );
}

export function recoverWatcherJournal(logPath, checkpointPath) {
  const records = readJournalRecords(logPath);
  const checkpoint = existsSync(checkpointPath)
    ? readFileSync(checkpointPath, "utf8").trim()
    : OFFSET_BEFORE_FIRST;
  if (checkpoint.length === 0) throw new Error("watcher checkpoint is empty");
  if (checkpoint === OFFSET_BEFORE_FIRST) {
    if (records.length > 0) writeJournal(logPath, []);
    return { checkpoint, records: [], truncated: records.length };
  }
  const committedIndex = records.findIndex((record) => record.offset === checkpoint);
  if (committedIndex < 0) {
    throw new Error(`watcher checkpoint ${checkpoint} is not present in its journal`);
  }
  const committed = records.slice(0, committedIndex + 1);
  const truncated = records.length - committed.length;
  if (truncated > 0) writeJournal(logPath, committed);
  return { checkpoint, records: committed, truncated };
}

export function appendJournalRecord(path, record) {
  appendFileSync(path, `${canonicalJson(record)}\n`, "utf8");
}

export function commitJournalCheckpoint(path, checkpoint) {
  atomicWrite(path, `${checkpoint}\n`);
}
