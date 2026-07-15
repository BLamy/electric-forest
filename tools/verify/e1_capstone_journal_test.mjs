import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";
import {
  appendJournalRecord,
  commitJournalCheckpoint,
  readJournalRecords,
  recoverWatcherJournal,
} from "./e1_capstone_journal.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = join(
  root,
  ".eforest/tasks/epic-1-the-trunk/E1-T11-the-first-repo/evidence/journal-contract.json",
);
const updateEvidence = process.argv.includes("--update-evidence");
assert.deepEqual(
  process.argv.slice(2).filter((argument) => argument !== "--update-evidence"),
  [],
  "usage: node tools/verify/e1_capstone_journal_test.mjs [--update-evidence]",
);

const scratch = mkdtempSync(join(tmpdir(), "eforest-e1-t11-journal-"));
const results = [];

function record(ordinal) {
  return {
    offset: `0000000000000000_${String(ordinal).padStart(16, "0")}`,
    payload: { path: `dir-${ordinal}`, v: 2 },
    ts: 0,
    type: "fs.dir.create",
  };
}

function paths(name) {
  const directory = join(scratch, name);
  mkdirSync(directory);
  return { checkpoint: join(directory, "checkpoint"), log: join(directory, "journal.jsonl") };
}

function pass(name) {
  results.push({ name, passed: true });
}

try {
  {
    const path = paths("append-before-checkpoint");
    appendJournalRecord(path.log, record(0));
    commitJournalCheckpoint(path.checkpoint, record(0).offset);
    appendJournalRecord(path.log, record(1));
    const recovered = recoverWatcherJournal(path.log, path.checkpoint);
    assert.equal(recovered.truncated, 1);
    assert.deepEqual(recovered.records, [record(0)]);
    assert.deepEqual(readJournalRecords(path.log), [record(0)]);
    pass("append-before-checkpoint-tail-truncated");
  }
  {
    const path = paths("first-append");
    appendJournalRecord(path.log, record(0));
    const recovered = recoverWatcherJournal(path.log, path.checkpoint);
    assert.equal(recovered.checkpoint, "-1");
    assert.equal(recovered.truncated, 1);
    assert.deepEqual(readJournalRecords(path.log), []);
    pass("first-append-without-checkpoint-truncated");
  }
  {
    const path = paths("checkpoint-at-head");
    appendJournalRecord(path.log, record(0));
    appendJournalRecord(path.log, record(1));
    commitJournalCheckpoint(path.checkpoint, record(1).offset);
    const recovered = recoverWatcherJournal(path.log, path.checkpoint);
    assert.equal(recovered.truncated, 0);
    assert.deepEqual(recovered.records, [record(0), record(1)]);
    pass("checkpoint-at-head-preserved");
  }
  for (const [name, lines, checkpoint, expected] of [
    ["duplicate", [record(0), record(0)], record(0).offset, /duplicate\/out-of-order/],
    ["reordered", [record(1), record(0)], record(0).offset, /duplicate\/out-of-order/],
    ["checkpoint-ahead", [record(0)], record(1).offset, /not present/],
  ]) {
    const path = paths(name);
    writeFileSync(path.log, `${lines.map((item) => canonicalJson(item)).join("\n")}\n`, "utf8");
    commitJournalCheckpoint(path.checkpoint, checkpoint);
    assert.throws(() => recoverWatcherJournal(path.log, path.checkpoint), expected);
    pass(`${name}-rejected`);
  }
  {
    const path = paths("truncated");
    writeFileSync(path.log, canonicalJson(record(0)), "utf8");
    assert.throws(() => recoverWatcherJournal(path.log, path.checkpoint), /truncated/);
    pass("truncated-record-rejected");
  }

  const summary = `${canonicalJson({ results })}\n`;
  if (updateEvidence) {
    mkdirSync(dirname(evidence), { recursive: true });
    writeFileSync(evidence, summary, "utf8");
  } else {
    assert.ok(existsSync(evidence), "missing committed journal contract evidence");
    assert.equal(summary, readFileSync(evidence, "utf8"), "journal contract evidence drifted");
  }
  process.stdout.write(summary);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
