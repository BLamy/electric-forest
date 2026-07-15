import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";
import {
  appendJournalRecord,
  commitJournalCheckpoint,
  readJournalCheckpoint,
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkpointRecord(log, byteLength, offset) {
  return {
    byteLength,
    offset,
    sha256: sha256(Buffer.from(log).subarray(0, byteLength)),
  };
}

try {
  {
    const path = paths("append-before-checkpoint");
    appendJournalRecord(path.log, record(0));
    commitJournalCheckpoint(path.checkpoint, record(0).offset, path.log);
    appendJournalRecord(path.log, record(1));
    const recovered = recoverWatcherJournal(path.log, path.checkpoint);
    assert.equal(recovered.truncated, 1);
    assert.ok(recovered.truncatedBytes > 0);
    assert.deepEqual(recovered.records, [record(0)]);
    assert.deepEqual(readJournalRecords(path.log), [record(0)]);
    pass("append-before-checkpoint-tail-truncated");
  }
  {
    const path = paths("partial-append-after-checkpoint");
    appendJournalRecord(path.log, record(0));
    commitJournalCheckpoint(path.checkpoint, record(0).offset, path.log);
    const partial = canonicalJson(record(1)).slice(0, 55);
    appendFileSync(path.log, partial, "utf8");
    const recovered = recoverWatcherJournal(path.log, path.checkpoint);
    assert.equal(recovered.truncated, 1);
    assert.equal(recovered.truncatedBytes, Buffer.byteLength(partial));
    assert.deepEqual(readJournalRecords(path.log), [record(0)]);
    pass("partial-append-after-checkpoint-truncated");
  }
  {
    const path = paths("first-partial-append");
    writeFileSync(path.log, canonicalJson(record(0)).slice(0, 17), "utf8");
    const recovered = recoverWatcherJournal(path.log, path.checkpoint);
    assert.equal(recovered.checkpoint, "-1");
    assert.equal(recovered.truncated, 1);
    assert.deepEqual(readJournalRecords(path.log), []);
    pass("first-partial-append-without-checkpoint-truncated");
  }
  {
    const path = paths("checkpoint-at-head");
    appendJournalRecord(path.log, record(0));
    appendJournalRecord(path.log, record(1));
    commitJournalCheckpoint(path.checkpoint, record(1).offset, path.log);
    const recovered = recoverWatcherJournal(path.log, path.checkpoint);
    assert.equal(recovered.truncated, 0);
    assert.deepEqual(recovered.records, [record(0), record(1)]);
    pass("checkpoint-at-head-preserved");
  }
  {
    const path = paths("checkpoint-temp-before-rename");
    appendJournalRecord(path.log, record(0));
    commitJournalCheckpoint(path.checkpoint, record(0).offset, path.log);
    appendJournalRecord(path.log, record(1));
    const fullLength = readFileSync(path.log).byteLength;
    writeFileSync(
      `${path.checkpoint}.interrupted.tmp`,
      `${canonicalJson(checkpointRecord(readFileSync(path.log), fullLength, record(1).offset))}\n`,
      "utf8",
    );
    const recovered = recoverWatcherJournal(path.log, path.checkpoint);
    assert.equal(recovered.checkpoint, record(0).offset);
    assert.equal(recovered.truncated, 1);
    assert.deepEqual(readJournalRecords(path.log), [record(0)]);
    pass("checkpoint-temp-before-rename-keeps-old-prefix");
  }
  {
    const path = paths("checkpoint-after-rename");
    appendJournalRecord(path.log, record(0));
    commitJournalCheckpoint(path.checkpoint, record(0).offset, path.log);
    appendJournalRecord(path.log, record(1));
    commitJournalCheckpoint(path.checkpoint, record(1).offset, path.log);
    const recovered = recoverWatcherJournal(path.log, path.checkpoint);
    assert.equal(recovered.truncated, 0);
    assert.deepEqual(recovered.records, [record(0), record(1)]);
    pass("checkpoint-after-rename-preserves-new-prefix");
  }
  for (const [name, lines, checkpoint, byteAdjustment, expected] of [
    ["duplicate", [record(0), record(0)], record(0).offset, 0, /duplicate\/out-of-order/],
    ["reordered", [record(1), record(0)], record(0).offset, 0, /duplicate\/out-of-order/],
    ["checkpoint-ahead", [record(0)], record(1).offset, 1, /exceeds journal length/],
  ]) {
    const path = paths(name);
    const log = `${lines.map((item) => canonicalJson(item)).join("\n")}\n`;
    writeFileSync(path.log, log, "utf8");
    writeFileSync(
      path.checkpoint,
      `${canonicalJson(
        checkpointRecord(log, Buffer.byteLength(log) + byteAdjustment, checkpoint),
      )}\n`,
      "utf8",
    );
    assert.throws(() => recoverWatcherJournal(path.log, path.checkpoint), expected);
    pass(`${name}-inside-committed-prefix-rejected`);
  }
  {
    const path = paths("partial-committed-record");
    const partial = canonicalJson(record(0)).slice(0, 55);
    writeFileSync(path.log, partial, "utf8");
    writeFileSync(
      path.checkpoint,
      `${canonicalJson(checkpointRecord(partial, Buffer.byteLength(partial), record(0).offset))}\n`,
      "utf8",
    );
    assert.throws(() => recoverWatcherJournal(path.log, path.checkpoint), /truncated/);
    pass("partial-record-inside-committed-prefix-rejected");
  }
  {
    const path = paths("same-length-canonical-mutation");
    appendJournalRecord(path.log, record(0));
    commitJournalCheckpoint(path.checkpoint, record(0).offset, path.log);
    const original = readFileSync(path.log, "utf8");
    const mutated = original.replace('"path":"dir-0"', '"path":"dir-X"');
    assert.equal(Buffer.byteLength(mutated), Buffer.byteLength(original));
    writeFileSync(path.log, mutated, "utf8");
    assert.throws(() => recoverWatcherJournal(path.log, path.checkpoint), /prefix digest/);
    pass("same-length-canonical-committed-mutation-rejected");
  }
  {
    const path = paths("malformed-uncommitted-tail");
    appendJournalRecord(path.log, record(0));
    commitJournalCheckpoint(path.checkpoint, record(0).offset, path.log);
    appendFileSync(path.log, "{not-json\npartial", "utf8");
    const recovered = recoverWatcherJournal(path.log, path.checkpoint);
    assert.equal(recovered.truncated, 2);
    assert.deepEqual(readJournalRecords(path.log), [record(0)]);
    assert.deepEqual(readJournalCheckpoint(path.checkpoint), {
      byteLength: readFileSync(path.log).byteLength,
      offset: record(0).offset,
      sha256: sha256(readFileSync(path.log)),
    });
    pass("every-uncommitted-suffix-shape-truncated");
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
