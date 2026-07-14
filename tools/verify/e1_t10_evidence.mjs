import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";
import {
  assertCompleteMergeStage,
  contentMap,
  fsInitialState,
  fsReducer,
  mergePlanId,
  treeDigest,
  unresolvedMergeConflicts,
} from "../../packages/streamfs/dist/src/index.js";
import { bootstrapDigest, replayDigestLocal } from "../../packages/cli/dist/src/replay-command.js";

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
const renameContentPath = join(evidence, "e1-t10-rename-content.jsonl");
const commonRenameContentPath = join(evidence, "e1-t10-common-rename-content.jsonl");
const siblingRenamesPath = join(evidence, "e1-t10-sibling-renames.jsonl");
const crossRenamePatchesPath = join(evidence, "e1-t10-cross-rename-patches.jsonl");
const equivalentRenamesPath = join(evidence, "e1-t10-equivalent-renames.jsonl");
const cleanA = await replayDigestLocal(cleanPath);
const cleanB = await replayDigestLocal(cleanPath);
const conflict = await replayDigestLocal(conflictPath);
const renameA = await replayDigestLocal(renamePath);
const renameB = await replayDigestLocal(renamePath);
const renameContentA = await replayDigestLocal(renameContentPath);
const renameContentB = await replayDigestLocal(renameContentPath);
const commonRenameContentA = await replayDigestLocal(commonRenameContentPath);
const commonRenameContentB = await replayDigestLocal(commonRenameContentPath);
const siblingRenamesA = await replayDigestLocal(siblingRenamesPath);
const siblingRenamesB = await replayDigestLocal(siblingRenamesPath);
const crossRenamePatchesA = await replayDigestLocal(crossRenamePatchesPath);
const crossRenamePatchesB = await replayDigestLocal(crossRenamePatchesPath);
const equivalentRenamesA = await replayDigestLocal(equivalentRenamesPath);
const equivalentRenamesB = await replayDigestLocal(equivalentRenamesPath);
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
if (
  renameContentA !== summary.renameContent.digest ||
  renameContentB !== renameContentA ||
  summary.renameContent.replayDigest !== renameContentA
) {
  throw new Error("rename-content replay is not deterministic or does not match live state");
}
if (
  commonRenameContentA !== summary.commonRenameContent.digest ||
  commonRenameContentB !== commonRenameContentA ||
  summary.commonRenameContent.replayDigest !== commonRenameContentA
) {
  throw new Error("common-rename content replay is not deterministic or live-equal");
}
if (
  siblingRenamesA !== summary.siblingRenames.digest ||
  siblingRenamesB !== siblingRenamesA ||
  summary.siblingRenames.replayDigest !== siblingRenamesA
) {
  throw new Error("sibling-rename replay is not deterministic or live-equal");
}
if (
  crossRenamePatchesA !== summary.crossRenamePatches.digest ||
  crossRenamePatchesB !== crossRenamePatchesA ||
  summary.crossRenamePatches.replayDigest !== crossRenamePatchesA
) {
  throw new Error("cross-rename patch replay is not deterministic or live-equal");
}
if (
  equivalentRenamesA !== summary.equivalentRenames.digest ||
  equivalentRenamesB !== equivalentRenamesA ||
  summary.equivalentRenames.replayDigest !== equivalentRenamesA
) {
  throw new Error("equivalent-rename replay is not deterministic or live-equal");
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
const renameSource = records("e1-t10-renames-source.jsonl");
const renameForkIndex = renameSource.findIndex((event) => event.type === "fs.branch.fork");
if (renameForkIndex < 0) throw new Error("replacement rename source has no fork event");
if (
  canonicalJson(
    renameSource.slice(renameForkIndex + 1).map(({ type, payload }) => ({ type, payload })),
  ) !==
  canonicalJson([
    { payload: { path: "b.txt", v: 2 }, type: "fs.file.delete" },
    { payload: { from: "a.txt", to: "b.txt", v: 2 }, type: "fs.rename" },
  ])
) {
  throw new Error("replacement rename source does not preserve its causal event order");
}
const renameSourceDigest = treeDigest(reduce(renameSource));
if (renameSourceDigest !== renameTerminal?.payload.sourceTreeDigest) {
  throw new Error("replacement rename source digest does not match the merge reference");
}
let renameSourceOrderRejected = false;
try {
  reduce([...renameSource.slice(0, renameForkIndex + 1), renameSource.at(-1), renameSource.at(-2)]);
} catch (error) {
  renameSourceOrderRejected =
    error instanceof Error && error.message.includes("cannot rename onto existing path b.txt");
}
if (!renameSourceOrderRejected) {
  throw new Error("replacement rename source order mutation did not fail reduction");
}
const renameContentRecords = records("e1-t10-rename-content.jsonl");
const renameContentTerminal = renameContentRecords.find(
  (event) => event.type === "fs.branch.merge",
);
if (
  canonicalJson(renameContentTerminal?.payload.changes) !==
  canonicalJson([
    { payload: { from: "before.txt", to: "after.txt", v: 2 }, type: "fs.rename" },
    {
      payload: {
        base: "0000000000000000_0000000000000001",
        contentSha256: "e65d81abc261d2ce87dfcccb6be9e5249ba780ca0076e37cb7c736c1bbdf00a8",
        path: "after.txt",
        size: 25,
        v: 2,
      },
      type: "fs.file.write",
    },
    {
      payload: {
        contentStreamId: "fs:e1-t10-rename-content-proof:feature:file:1-ff66133d2ce0048a",
        path: "after.txt",
        v: 2,
      },
      type: "fs.file.create",
    },
  ])
) {
  throw new Error("rename-content golden does not preserve ordered rename/write/handoff");
}
const renameContentState = reduce(renameContentRecords);
const renameContentFile = renameContentState.files["after.txt"];
if (renameContentFile === undefined) throw new Error("rename-content golden lost after.txt");
const renameContentBytes = contentMap(renameContentState).get(renameContentFile.contentStreamId);
if (
  renameContentBytes === undefined ||
  new TextDecoder().decode(renameContentBytes) !== "source edit after rename\n"
) {
  throw new Error("rename-content golden does not bundle the adopted source bytes");
}
const renameContentSource = records("e1-t10-rename-content-source.jsonl");
const renameContentForkIndex = renameContentSource.findIndex(
  (event) => event.type === "fs.branch.fork",
);
if (renameContentForkIndex < 0) throw new Error("rename-content source has no fork event");
if (
  canonicalJson(
    renameContentSource
      .slice(renameContentForkIndex + 1)
      .map(({ type, payload }) => ({ type, payload })),
  ) !== canonicalJson(renameContentTerminal?.payload.changes)
) {
  throw new Error("rename-content source history does not match the applied merge program");
}
if (treeDigest(reduce(renameContentSource)) !== renameContentTerminal?.payload.sourceTreeDigest) {
  throw new Error("rename-content source digest does not match the merge reference");
}
const commonRenameRecords = records("e1-t10-common-rename-content.jsonl");
const commonRenameTerminal = commonRenameRecords.find((event) => event.type === "fs.branch.merge");
const commonRenameSource = records("e1-t10-common-rename-content-source.jsonl");
const commonRenameForkIndex = commonRenameSource.findIndex(
  (event) => event.type === "fs.branch.fork",
);
if (commonRenameForkIndex < 0) throw new Error("common-rename source has no fork event");
const commonRenamePostFork = commonRenameSource
  .slice(commonRenameForkIndex + 1)
  .map(({ type, payload }) => ({ type, payload }));
if (
  canonicalJson(commonRenamePostFork[0]) !==
    canonicalJson({
      type: "fs.rename",
      payload: { v: 2, from: "before.txt", to: "after.txt" },
    }) ||
  canonicalJson(commonRenamePostFork.slice(1)) !==
    canonicalJson(commonRenameTerminal?.payload.changes)
) {
  throw new Error("common-rename source does not separate common structure from content delta");
}
if (
  !commonRenameRecords.some(
    (event) =>
      event.type === "fs.rename" &&
      event.payload.from === "before.txt" &&
      event.payload.to === "after.txt",
  )
) {
  throw new Error("common-rename target did not record the shared structural prefix");
}
const commonRenameState = reduce(commonRenameRecords);
const commonRenameFile = commonRenameState.files["after.txt"];
if (commonRenameFile === undefined) throw new Error("common-rename golden lost after.txt");
const commonRenameBytes = contentMap(commonRenameState).get(commonRenameFile.contentStreamId);
if (
  commonRenameBytes === undefined ||
  new TextDecoder().decode(commonRenameBytes) !== "source edit after common rename\n"
) {
  throw new Error("common-rename golden does not bundle the adopted source bytes");
}
if (treeDigest(reduce(commonRenameSource)) !== commonRenameTerminal?.payload.sourceTreeDigest) {
  throw new Error("common-rename source digest does not match the merge reference");
}
const siblingRecords = records("e1-t10-sibling-renames.jsonl");
const siblingTerminal = siblingRecords.find((event) => event.type === "fs.branch.merge");
const siblingSource = records("e1-t10-sibling-renames-source.jsonl");
const siblingForkIndex = siblingSource.findIndex((event) => event.type === "fs.branch.fork");
if (siblingForkIndex < 0) throw new Error("sibling-rename source has no fork event");
const siblingPostFork = siblingSource.slice(siblingForkIndex + 1);
if (
  canonicalJson(siblingPostFork.map(({ type, payload }) => ({ type, payload }))) !==
  canonicalJson(siblingTerminal?.payload.changes)
) {
  throw new Error("sibling-rename source history does not match the applied causal program");
}
const siblingState = reduce(siblingRecords);
for (const [path, expected] of [
  ["dest/x.txt", "X edited\n"],
  ["dest/y.txt", "Y edited\n"],
]) {
  const file = siblingState.files[path];
  const content =
    file === undefined ? undefined : contentMap(siblingState).get(file.contentStreamId);
  if (content === undefined || new TextDecoder().decode(content) !== expected) {
    throw new Error(`sibling-rename golden has wrong bytes for ${path}`);
  }
}
if (treeDigest(reduce(siblingSource)) !== siblingTerminal?.payload.sourceTreeDigest) {
  throw new Error("sibling-rename source digest does not match the merge reference");
}
let siblingOrderRejected = false;
try {
  reduce([
    ...siblingSource.slice(0, siblingForkIndex + 1),
    ...siblingPostFork.slice(0, 3),
    siblingPostFork.at(-1),
    ...siblingPostFork.slice(3, -1),
  ]);
} catch (error) {
  siblingOrderRejected =
    error instanceof Error && error.message.includes("cannot remove non-empty directory src");
}
if (!siblingOrderRejected) {
  throw new Error("sibling-rename ancestor-removal order mutation did not fail reduction");
}

const crossRenameRecords = records("e1-t10-cross-rename-patches.jsonl");
const crossRenameTerminal = crossRenameRecords.find((event) => event.type === "fs.branch.merge");
if (
  crossRenameTerminal?.payload.changes.length !== 1 ||
  crossRenameTerminal.payload.changes[0]?.type !== "fs.file.patch" ||
  crossRenameTerminal.payload.changes[0]?.payload.path !== "after.txt"
) {
  throw new Error("cross-rename patch golden did not compose exactly one final-path patch");
}
const crossRenameSource = records("e1-t10-cross-rename-patches-source.jsonl");
const crossRenameForkIndex = crossRenameSource.findIndex(
  (event) => event.type === "fs.branch.fork",
);
if (crossRenameForkIndex < 0) throw new Error("cross-rename patch source has no fork event");
const crossRenameSourceDelta = crossRenameSource.slice(crossRenameForkIndex + 1);
if (
  canonicalJson(crossRenameSourceDelta.map(({ type }) => type)) !==
    canonicalJson(["fs.rename", "fs.file.patch", "fs.file.create"]) ||
  canonicalJson(crossRenameSourceDelta[0]?.payload) !==
    canonicalJson({ v: 2, from: "before.txt", to: "after.txt" }) ||
  crossRenameSourceDelta[1]?.payload.path !== "after.txt" ||
  crossRenameSourceDelta[2]?.payload.path !== "after.txt"
) {
  throw new Error("cross-rename patch source lost rename-then-patch-handoff order");
}
const crossRenameState = reduce(crossRenameRecords);
const crossRenameFile = crossRenameState.files["after.txt"];
const crossRenameBytes =
  crossRenameFile === undefined
    ? undefined
    : contentMap(crossRenameState).get(crossRenameFile.contentStreamId);
const crossRenameText =
  crossRenameBytes === undefined ? undefined : new TextDecoder().decode(crossRenameBytes);
if (
  !crossRenameText?.includes("target patch before rename") ||
  !crossRenameText.includes("source patch after rename")
) {
  throw new Error("cross-rename patch golden does not bundle both merged edits");
}
if (treeDigest(reduce(crossRenameSource)) !== crossRenameTerminal?.payload.sourceTreeDigest) {
  throw new Error("cross-rename patch source digest does not match the merge reference");
}

const equivalentRenameRecords = records("e1-t10-equivalent-renames.jsonl");
const equivalentRenameTerminal = equivalentRenameRecords.find(
  (event) => event.type === "fs.branch.merge",
);
if (
  canonicalJson(equivalentRenameTerminal?.payload.changes.map(({ type }) => type)) !==
  canonicalJson(["fs.file.write", "fs.file.create"])
) {
  throw new Error("equivalent-rename golden did not isolate the source content delta");
}
const equivalentRenameSource = records("e1-t10-equivalent-renames-source.jsonl");
const equivalentRenameForkIndex = equivalentRenameSource.findIndex(
  (event) => event.type === "fs.branch.fork",
);
if (equivalentRenameForkIndex < 0) throw new Error("equivalent-rename source has no fork event");
const equivalentRenamePostFork = equivalentRenameSource.slice(equivalentRenameForkIndex + 1);
if (
  canonicalJson(
    equivalentRenamePostFork.slice(0, 2).map(({ type, payload }) => ({
      type,
      payload,
    })),
  ) !==
  canonicalJson([
    { type: "fs.rename", payload: { v: 2, from: "a.txt", to: "b.txt" } },
    { type: "fs.rename", payload: { v: 2, from: "b.txt", to: "c.txt" } },
  ])
) {
  throw new Error("equivalent-rename source lost its chained structural program");
}
const equivalentRenameState = reduce(equivalentRenameRecords);
const equivalentRenameFile = equivalentRenameState.files["c.txt"];
const equivalentRenameBytes =
  equivalentRenameFile === undefined
    ? undefined
    : contentMap(equivalentRenameState).get(equivalentRenameFile.contentStreamId);
if (
  equivalentRenameBytes === undefined ||
  new TextDecoder().decode(equivalentRenameBytes) !== "source edit through equivalent chain\n"
) {
  throw new Error("equivalent-rename golden does not bundle the adopted source bytes");
}
if (
  treeDigest(reduce(equivalentRenameSource)) !== equivalentRenameTerminal?.payload.sourceTreeDigest
) {
  throw new Error("equivalent-rename source digest does not match the merge reference");
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
  truncatedBatchRejected =
    error instanceof Error && error.message.includes("merge/incomplete-batch");
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
    commonRenameContentDigest: commonRenameContentA,
    conflictDigest: conflict,
    crossRenamePatchesDigest: crossRenamePatchesA,
    equivalentRenamesDigest: equivalentRenamesA,
    interleavedBatchRejected,
    portableConflictCount: portableConflicts.length,
    renameDigest: renameA,
    renameContentDigest: renameContentA,
    renameSourceDigest,
    renameSourceOrderRejected,
    referenceMutationRejected,
    siblingOrderRejected,
    siblingRenamesDigest: siblingRenamesA,
    truncatedBatchRejected,
  })}\n`,
);
