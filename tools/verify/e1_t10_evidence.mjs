import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";
import {
  assertCompleteMergeStage,
  fsInitialState,
  fsReducer,
  mergePlanId,
  treeDigest,
  unresolvedMergeConflicts,
} from "../../packages/streamfs/dist/src/index.js";
import {
  bootstrapDigest,
  replayDigestLocal,
} from "../../packages/cli/dist/src/replay-command.js";

const evidence = join(
  process.cwd(),
  ".eforest/tasks/epic-1-the-trunk/E1-T10-three-way-merge-conflicts/evidence",
);
const summary = JSON.parse(readFileSync(join(evidence, "e1-t10-summary.json"), "utf8"));

function records(name) {
  const raw = readFileSync(join(evidence, name), "utf8");
  const parsed = raw.trimEnd().split("\n").map(JSON.parse);
  if (`${parsed.map(canonicalJson).join("\n")}\n` !== raw) {
    throw new Error(`${name} is not canonical JSONL`);
  }
  return parsed;
}

function reduce(input) {
  const state = input.reduce((current, event) => fsReducer(current, event), fsInitialState);
  assertCompleteMergeStage(state);
  return state;
}

const cleanPath = join(evidence, "e1-t10-clean.jsonl");
const conflictPath = join(evidence, "e1-t10-conflicts.jsonl");
const renamePath = join(evidence, "e1-t10-renames.jsonl");
const cleanA = await replayDigestLocal(cleanPath);
const cleanB = await replayDigestLocal(cleanPath);
const conflict = await replayDigestLocal(conflictPath);
const renameA = await replayDigestLocal(renamePath);
const renameB = await replayDigestLocal(renamePath);
if (cleanA !== summary.clean.digest || cleanB !== cleanA) {
  throw new Error("clean replay digest is not deterministic or does not match live state");
}
if (conflict !== summary.conflicts.digest) {
  throw new Error("conflict replay digest does not match live state");
}
if (
  renameA !== summary.renames.digest ||
  renameB !== renameA ||
  summary.renames.replayDigest !== renameA
) {
  throw new Error("replacement rename replay is not deterministic or does not match live state");
}
const renameTerminal = records("e1-t10-renames.jsonl").find(
  (event) => event.type === "fs.branch.merge",
);
if (
  canonicalJson(renameTerminal?.payload.changes) !==
  canonicalJson([
    { payload: { path: "b.txt", v: 2 }, type: "fs.file.delete" },
    { payload: { from: "a.txt", to: "b.txt", v: 2 }, type: "fs.rename" },
  ])
) {
  throw new Error("replacement rename golden does not preserve ordered delete+rename changes");
}

const byteSensitive = records("e1-t10-byte-sensitive.jsonl");
const byteDigest = treeDigest(reduce(byteSensitive));
if (
  byteSensitive.length !== summary.byteSensitivity.eventCount ||
  byteDigest !== summary.byteSensitivity.digest
) {
  throw new Error("byte-sensitive golden does not match its summary");
}
const mutatedBytes = structuredClone(byteSensitive);
const stagedChange = mutatedBytes.find((event) => event.type === "fs/merge-change").payload.change;
const terminalChange = mutatedBytes.find((event) => event.type === "fs.branch.merge").payload
  .changes[0];
for (const change of [stagedChange, terminalChange]) {
  const insertion = change.payload.ops.find(([kind]) => kind === "+");
  if (insertion === undefined || typeof insertion[1] !== "string" || insertion[1].length === 0) {
    throw new Error("byte-sensitive golden has no inserted text to mutate");
  }
  insertion[1] = `${insertion[1][0] === "X" ? "Y" : "X"}${insertion[1].slice(1)}`;
}
const mutatedTerminal = mutatedBytes.find((event) => event.type === "fs.branch.merge").payload;
const mutatedMergeId = mergePlanId({
  base: {
    offset: mutatedTerminal.forkOffset,
    streamId: mutatedTerminal.targetStreamId,
    treeDigest: mutatedTerminal.baseTreeDigest,
  },
  target: {
    offset: mutatedTerminal.targetHeadOffset,
    streamId: mutatedTerminal.targetStreamId,
    treeDigest: mutatedTerminal.targetTreeDigest,
  },
  source: {
    offset: mutatedTerminal.sourceHeadOffset,
    streamId: mutatedTerminal.sourceStreamId,
    treeDigest: mutatedTerminal.sourceTreeDigest,
  },
  changes: mutatedTerminal.changes,
  conflicts: [],
});
mutatedBytes.find((event) => event.type === "fs/merge-change").payload.mergeId = mutatedMergeId;
mutatedTerminal.mergeId = mutatedMergeId;
let byteMutationRejected = false;
try {
  reduce(mutatedBytes);
} catch (error) {
  byteMutationRejected = error instanceof Error && error.message.includes("patch/result-mismatch");
}
if (!byteMutationRejected) throw new Error("one-byte patch mutation did not fail reduction");

const corruptedConflict = records("e1-t10-conflicts.jsonl");
const stagedConflict = corruptedConflict.find((event) => event.type === "fs/merge-conflict");
const terminalConflict = corruptedConflict.find((event) => event.type === "fs.branch.merge")
  ?.payload.conflicts[0];
if (stagedConflict === undefined) throw new Error("conflict golden has no staged conflict");
if (terminalConflict === undefined) throw new Error("conflict golden has no terminal conflict");
stagedConflict.payload.base.treeDigest = "f".repeat(64);
terminalConflict.base.treeDigest = "f".repeat(64);
let referenceMutationRejected = false;
try {
  reduce(corruptedConflict);
} catch (error) {
  referenceMutationRejected =
    error instanceof Error && error.message.includes("merge/reference-mismatch");
}
if (!referenceMutationRejected) throw new Error("conflict-reference mutation did not fail replay");

const conflictRecords = records("e1-t10-conflicts.jsonl");
const firstStagedIndex = conflictRecords.findIndex((event) => event.type === "fs/merge-conflict");
if (firstStagedIndex < 0) throw new Error("conflict golden has no staged prefix");
const stagedPrefix = conflictRecords.slice(0, firstStagedIndex + 1);
let truncatedBatchRejected = false;
try {
  reduce(stagedPrefix);
} catch (error) {
  truncatedBatchRejected = error instanceof Error && error.message.includes("merge/incomplete-batch");
}
if (!truncatedBatchRejected) throw new Error("truncated merge batch did not fail reduction");

const terminalPayload = conflictRecords.find((event) => event.type === "fs.branch.merge")?.payload;
if (terminalPayload === undefined) throw new Error("conflict golden has no terminal payload");
let interleavedBatchRejected = false;
try {
  reduce([
    ...stagedPrefix,
    {
      offset: terminalPayload.targetHeadOffset,
      payload: {
        contentRef: "snapshot:interleaved",
        formatVersion: 1,
        snapshotOffset: terminalPayload.targetHeadOffset,
        stateDigest: terminalPayload.targetTreeDigest,
      },
      ts: 0,
      type: "fs.snapshot",
    },
  ]);
} catch (error) {
  interleavedBatchRejected =
    error instanceof Error && error.message.includes("merge/interleaved-batch");
}
if (!interleavedBatchRejected) throw new Error("interleaved merge batch did not fail reduction");

const conflictState = reduce(conflictRecords);
const portable = JSON.parse(canonicalJson(conflictState));
const portableConflicts = unresolvedMergeConflicts(portable);
if (portableConflicts.length !== summary.conflicts.unresolved.length) {
  throw new Error("serialized conflict state lost unresolved conflicts");
}
const temp = mkdtempSync(join(tmpdir(), "e1-t10-bootstrap-"));
let bootstrapResolutionDigest;
try {
  const artifactPath = join(temp, "artifact.json");
  const tailPath = join(temp, "tail.jsonl");
  writeFileSync(artifactPath, canonicalJson(portable), "utf8");
  writeFileSync(
    tailPath,
    `${canonicalJson({
      offset: "9999999999999999_9999999999999999",
      payload: {
        mergeId: portableConflicts[0].mergeId,
        path: portableConflicts[0].path,
        resolutionDigest: treeDigest(portable),
        v: 1,
      },
      ts: 0,
      type: "fs/merge-resolve",
    })}\n`,
    "utf8",
  );
  bootstrapResolutionDigest = await bootstrapDigest(artifactPath, tailPath);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
if (bootstrapResolutionDigest !== treeDigest(portable)) {
  throw new Error("CLI bootstrap resolution changed the content-tree digest");
}

process.stdout.write(
  `${canonicalJson({
    byteDigest,
    byteMutationRejected,
    cleanDigest: cleanA,
    conflictDigest: conflict,
    interleavedBatchRejected,
    portableConflictCount: portableConflicts.length,
    renameDigest: renameA,
    referenceMutationRejected,
    truncatedBatchRejected,
  })}\n`,
);
