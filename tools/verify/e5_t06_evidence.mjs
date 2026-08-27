#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { attachmentInitialStateForStream } from "../../packages/evidence/dist/src/index.js";
import {
  PrMergeRefusalError,
  executeMerge,
  meadowPrInitialStateForStream,
  meadowPrReducer,
} from "../../packages/meadow/dist/src/index.js";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";
import { fsInitialState, fsReducer, treeDigest } from "../../packages/streamfs/dist/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidenceRoot = resolve(
  root,
  ".eforest/tasks/epic-5-the-meadow/E5-T06-pr-merge-execution/evidence",
);
const worker = resolve(root, "tools/verify/e5_t06_digest_worker.mjs");

const streams = {
  recoveryTargetBefore: "streams/recovery-target-before.jsonl",
  recoveryTargetAfter: "streams/recovery-target-after.jsonl",
  recoveryPrBefore: "streams/recovery-pr-before.jsonl",
  recoveryPrAfter: "streams/recovery-pr-after.jsonl",
  conflictTargetBefore: "streams/conflict-target-before.jsonl",
  conflictTargetAfter: "streams/conflict-target-after.jsonl",
  conflictPrBefore: "streams/conflict-pr-before.jsonl",
  conflictPrAfter: "streams/conflict-pr-after.jsonl",
  refusalTargetBefore: "streams/refusal-target-before.jsonl",
  refusalTargetAfter: "streams/refusal-target-after.jsonl",
  refusalPrBefore: "streams/refusal-pr-before.jsonl",
  refusalPrAfter: "streams/refusal-pr-after.jsonl",
};

const prStreamIds = {
  recovery: "pr:maple/recovery-before-outcome/42",
  conflict: "pr:maple/conflict-proof/7",
  refusal: "pr:maple/refusal-proof/8",
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function load(relativePath) {
  const path = resolve(evidenceRoot, relativePath);
  const source = readFileSync(path, "utf8");
  const lines = source.trimEnd().split("\n");
  assert.equal(source, `${lines.join("\n")}\n`, `${relativePath}: newline framing drifted`);
  const records = lines.map((line) => {
    const record = JSON.parse(line);
    assert.equal(canonicalJson(record), line, `${relativePath}: non-canonical record`);
    return record;
  });
  return { path, records, source };
}

function replay(kind, records, streamId) {
  return kind === "target"
    ? records.reduce(fsReducer, fsInitialState)
    : records.reduce(meadowPrReducer, meadowPrInitialStateForStream(streamId));
}

function verifyIndependentReplay(label, kind, relativePath, streamId) {
  const loaded = load(relativePath);
  const state = replay(kind, loaded.records, streamId);
  const direct = sha256(canonicalJson(state));
  const relativeToRoot = loaded.path.slice(root.length + 1);
  const independent = JSON.parse(
    execFileSync(
      process.execPath,
      [worker, kind, relativeToRoot, ...(streamId === undefined ? [] : [streamId])],
      { cwd: root, encoding: "utf8" },
    ),
  );
  assert.equal(independent.digest, direct, `${label}: independent replay digest mismatch`);
  assert.deepEqual(independent.state, state, `${label}: independent replay state mismatch`);
  process.stdout.write(
    `REPLAY stream=${label} direct=${direct} independent=${independent.digest} file-sha256=${sha256(loaded.source)} OK\n`,
  );
  return { ...loaded, state, digest: direct };
}

const recoveryTargetBefore = verifyIndependentReplay(
  "recovery-target-before",
  "target",
  streams.recoveryTargetBefore,
);
const recoveryTargetAfter = verifyIndependentReplay(
  "recovery-target-after",
  "target",
  streams.recoveryTargetAfter,
);
const recoveryPrBefore = verifyIndependentReplay(
  "recovery-pr-before",
  "pr",
  streams.recoveryPrBefore,
  prStreamIds.recovery,
);
const recoveryPrAfter = verifyIndependentReplay(
  "recovery-pr-after",
  "pr",
  streams.recoveryPrAfter,
  prStreamIds.recovery,
);
const conflictTargetBefore = verifyIndependentReplay(
  "conflict-target-before",
  "target",
  streams.conflictTargetBefore,
);
const conflictTargetAfter = verifyIndependentReplay(
  "conflict-target-after",
  "target",
  streams.conflictTargetAfter,
);
const conflictPrBefore = verifyIndependentReplay(
  "conflict-pr-before",
  "pr",
  streams.conflictPrBefore,
  prStreamIds.conflict,
);
const conflictPrAfter = verifyIndependentReplay(
  "conflict-pr-after",
  "pr",
  streams.conflictPrAfter,
  prStreamIds.conflict,
);
const refusalTargetBefore = verifyIndependentReplay(
  "refusal-target-before",
  "target",
  streams.refusalTargetBefore,
);
verifyIndependentReplay("refusal-target-after", "target", streams.refusalTargetAfter);
const refusalPrBefore = verifyIndependentReplay(
  "refusal-pr-before",
  "pr",
  streams.refusalPrBefore,
  prStreamIds.refusal,
);
verifyIndependentReplay("refusal-pr-after", "pr", streams.refusalPrAfter, prStreamIds.refusal);

const recoveryMergeEvents = recoveryTargetAfter.records.filter(
  ({ type }) => type === "fs.branch.merge",
);
const recoveryOutcomes = recoveryPrAfter.records.filter(({ type }) => type === "pr.merged");
assert.equal(recoveryMergeEvents.length, 1);
assert.equal(recoveryOutcomes.length, 1);
assert.equal(
  recoveryPrAfter.records.some(({ type }) => type === "pr.merge"),
  false,
);
assert.equal(recoveryPrAfter.state.status, "merged");
assert.equal(
  recoveryOutcomes[0].payload.targetMergeOffset,
  recoveryMergeEvents[0].offset,
  "recovery outcome must cite the sole target merge",
);
assert.equal(
  recoveryOutcomes[0].payload.resultTreeDigest,
  treeDigest(recoveryTargetAfter.state),
  "recovery outcome tree digest must match target replay",
);
process.stdout.write(
  `RECOVERY target-merges=1 pr-outcomes=1 commands=0 target-offset=${recoveryMergeEvents[0].offset} pr-offset=${recoveryOutcomes[0].offset} OK\n`,
);

let common = 0;
while (
  common < recoveryTargetBefore.records.length &&
  common < recoveryTargetAfter.records.length &&
  canonicalJson(recoveryTargetBefore.records[common]) ===
    canonicalJson(recoveryTargetAfter.records[common])
) {
  common += 1;
}
const firstDivergent = recoveryTargetAfter.records[common];
assert.equal(firstDivergent.type, "fs.branch.merge");
assert.equal(firstDivergent.offset, recoveryMergeEvents[0].offset);
process.stdout.write(
  `BISECT fixture=recovery-fast-forward offset=${firstDivergent.offset} merge-event-offset=${recoveryMergeEvents[0].offset} common-records=${common} OK\n`,
);

const targetConflictEvents = conflictTargetAfter.records.filter(
  ({ type }) => type === "fs/merge-conflict",
);
const targetConflictMerge = conflictTargetAfter.records.find(
  ({ type }) => type === "fs.branch.merge",
);
const prConflictOutcome = conflictPrAfter.records.find(
  ({ type }) => type === "pr.merge-conflicted",
);
assert.ok(targetConflictMerge);
assert.ok(prConflictOutcome);
assert.equal(targetConflictEvents.length, 1);
assert.deepEqual(
  targetConflictMerge.payload.conflicts,
  targetConflictEvents.map(({ payload }) => payload),
);
assert.deepEqual(
  prConflictOutcome.payload.conflicts,
  targetConflictEvents.map(({ payload }) => ({ path: payload.path, kind: payload.kind })),
);
assert.equal(prConflictOutcome.payload.targetMergeOffset, targetConflictMerge.offset);
assert.equal(conflictPrAfter.state.status, "conflicted");
assert.equal(treeDigest(conflictTargetBefore.state), treeDigest(conflictTargetAfter.state));
process.stdout.write(
  `CONFLICT target-merge-offset=${targetConflictMerge.offset} pr-target-merge-offset=${prConflictOutcome.payload.targetMergeOffset} target-conflicts=1 pr-conflicts=1 tree-before=${treeDigest(conflictTargetBefore.state)} tree-after=${treeDigest(conflictTargetAfter.state)} state=conflicted OK\n`,
);

const refusalTarget = structuredClone(refusalTargetBefore.records);
const refusalPr = structuredClone(refusalPrBefore.records);
const refusalTargetBytes = canonicalJson(refusalTarget);
const refusalPrBytes = canonicalJson(refusalPr);
let refusalReason;
try {
  await executeMerge(
    {
      readPr: async () => ({
        state: refusalPr.reduce(
          meadowPrReducer,
          meadowPrInitialStateForStream(prStreamIds.refusal),
        ),
        records: refusalPr,
        headOffset: refusalPr.at(-1).offset,
      }),
      readEvidence: async (streamId) => ({
        state: attachmentInitialStateForStream(streamId),
        records: [],
      }),
      resolveBranch: async (streamId) => ({
        metadataStreamId: streamId,
        rawDump: async () => refusalTarget,
        treeAt: async () => fsInitialState,
      }),
      appendPrOutcome: async () => {
        throw new Error("refusal appended a PR outcome");
      },
      operations: {
        mergeFastForward: async () => {
          throw new Error("refusal reached target mutation");
        },
      },
    },
    prStreamIds.refusal,
  );
} catch (error) {
  assert.ok(error instanceof PrMergeRefusalError);
  refusalReason = error.reason;
}
assert.equal(refusalReason, "pr/merge-not-approved");
assert.equal(canonicalJson(refusalTarget), refusalTargetBytes);
assert.equal(canonicalJson(refusalPr), refusalPrBytes);
assert.equal(load(streams.refusalTargetAfter).source, refusalTargetBefore.source);
assert.equal(load(streams.refusalPrAfter).source, refusalPrBefore.source);
process.stdout.write(
  `REFUSAL case=unapproved reason=${refusalReason} pr-head=unchanged target-head=unchanged pr-digest=${refusalPrBefore.digest} target-digest=${refusalTargetBefore.digest} OK\n`,
);

assert.notEqual(recoveryPrBefore.digest, recoveryPrAfter.digest);
assert.notEqual(conflictPrBefore.digest, conflictPrAfter.digest);
const mutationOffset = recoveryPrAfter.source.indexOf(recoveryOutcomes[0].payload.resultTreeDigest);
assert.ok(mutationOffset >= 0);
const mutatedSource =
  recoveryPrAfter.source.slice(0, mutationOffset) +
  (recoveryPrAfter.source[mutationOffset] === "0" ? "1" : "0") +
  recoveryPrAfter.source.slice(mutationOffset + 1);
const mutatedRecords = mutatedSource
  .trimEnd()
  .split("\n")
  .map((line) => JSON.parse(line));
const mutatedDigest = sha256(
  canonicalJson(
    mutatedRecords.reduce(meadowPrReducer, meadowPrInitialStateForStream(prStreamIds.recovery)),
  ),
);
assert.notEqual(mutatedDigest, recoveryPrAfter.digest);
process.stdout.write(
  `MUTATION fixture=recovery-pr byte=${mutationOffset} digest-mismatch EXPECTED-FAIL OK\n`,
);
const perturbedExpected =
  (recoveryPrAfter.digest[0] === "0" ? "1" : "0") + recoveryPrAfter.digest.slice(1);
assert.notEqual(perturbedExpected, recoveryPrAfter.digest);
process.stdout.write("MUTATION-EXPECTED EXPECTED-FAIL OK\n");
process.stdout.write(
  "E5_T06_STREAM_PROOF_OK recovery=exactly-once conflict=mirrored bisect=pinned refusal=neutral independent-replays=12 mutations=2\n",
);
