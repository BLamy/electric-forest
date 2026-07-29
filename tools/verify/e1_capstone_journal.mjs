import { createHash } from "node:crypto";
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

function journalSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJournalBytes(bytes) {
  if (bytes.byteLength === 0) return [];
  if (bytes.at(-1) !== 0x0a) throw new Error("watcher journal has a truncated final record");
  const records = [];
  let previous = OFFSET_BEFORE_FIRST;
  let start = 0;
  let index = 0;
  while (start < bytes.byteLength) {
    const end = bytes.indexOf(0x0a, start);
    if (end < 0) throw new Error("watcher journal has a truncated final record");
    let line;
    try {
      line = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, end));
    } catch {
      throw new Error(`watcher journal line ${index + 1} is not UTF-8`);
    }
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
    start = end + 1;
    index += 1;
  }
  return records;
}

export function readJournalRecords(path) {
  return existsSync(path) ? parseJournalBytes(readFileSync(path)) : [];
}

export function readJournalCheckpoint(path) {
  if (!existsSync(path)) {
    return {
      byteLength: 0,
      offset: OFFSET_BEFORE_FIRST,
      sha256: journalSha256(Buffer.alloc(0)),
    };
  }
  const text = readFileSync(path, "utf8");
  if (!text.endsWith("\n")) throw new Error("watcher checkpoint is truncated");
  const line = text.slice(0, -1);
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("watcher checkpoint is not JSON");
  }
  if (
    canonicalJson(value) !== line ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 0 ||
    typeof value.offset !== "string" ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    throw new Error("watcher checkpoint is not a canonical byte-prefix record");
  }
  return { byteLength: value.byteLength, offset: value.offset, sha256: value.sha256 };
}

function discardedSegments(bytes) {
  if (bytes.byteLength === 0) return 0;
  let segments = 0;
  for (const byte of bytes) if (byte === 0x0a) segments += 1;
  return segments + (bytes.at(-1) === 0x0a ? 0 : 1);
}

export function recoverWatcherJournal(logPath, checkpointPath) {
  const log = existsSync(logPath) ? readFileSync(logPath) : Buffer.alloc(0);
  const checkpoint = readJournalCheckpoint(checkpointPath);
  if (checkpoint.byteLength > log.byteLength) {
    throw new Error(
      `watcher checkpoint ${checkpoint.offset} byte prefix ${checkpoint.byteLength} exceeds journal length ${log.byteLength}`,
    );
  }
  const committedBytes = log.subarray(0, checkpoint.byteLength);
  const committedSha256 = journalSha256(committedBytes);
  if (committedSha256 !== checkpoint.sha256) {
    throw new Error(
      `watcher checkpoint ${checkpoint.offset} prefix digest ${checkpoint.sha256} does not match committed bytes ${committedSha256}`,
    );
  }
  const records = parseJournalBytes(committedBytes);
  const committedHead = records.at(-1)?.offset ?? OFFSET_BEFORE_FIRST;
  if (committedHead !== checkpoint.offset) {
    throw new Error(
      `watcher checkpoint ${checkpoint.offset} does not match committed journal head ${committedHead}`,
    );
  }
  const suffix = log.subarray(checkpoint.byteLength);
  const truncated = discardedSegments(suffix);
  if (suffix.byteLength > 0) atomicWrite(logPath, committedBytes);
  return {
    checkpoint: checkpoint.offset,
    committedBytes: checkpoint.byteLength,
    committedSha256,
    records,
    truncated,
    truncatedBytes: suffix.byteLength,
  };
}

export function appendJournalRecord(path, record) {
  appendFileSync(path, `${canonicalJson(record)}\n`, "utf8");
}

export function commitJournalCheckpoint(path, checkpoint, logPath) {
  const log = existsSync(logPath) ? readFileSync(logPath) : Buffer.alloc(0);
  const records = parseJournalBytes(log);
  const head = records.at(-1)?.offset ?? OFFSET_BEFORE_FIRST;
  if (head !== checkpoint) {
    throw new Error(`cannot checkpoint ${checkpoint}; journal head is ${head}`);
  }
  atomicWrite(
    path,
    `${canonicalJson({
      byteLength: log.byteLength,
      offset: checkpoint,
      sha256: journalSha256(log),
    })}\n`,
  );
}
