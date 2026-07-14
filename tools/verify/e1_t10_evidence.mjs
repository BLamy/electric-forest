import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";
import {
  fsInitialState,
  fsReducer,
  treeDigest,
} from "../../packages/streamfs/dist/src/index.js";
import { replayDigestLocal } from "../../packages/cli/dist/src/replay-command.js";

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
  return input.reduce((state, event) => fsReducer(state, event), fsInitialState);
}

const cleanPath = join(evidence, "e1-t10-clean.jsonl");
const conflictPath = join(evidence, "e1-t10-conflicts.jsonl");
const cleanA = await replayDigestLocal(cleanPath);
const cleanB = await replayDigestLocal(cleanPath);
const conflict = await replayDigestLocal(conflictPath);
if (cleanA !== summary.clean.digest || cleanB !== cleanA) {
  throw new Error("clean replay digest is not deterministic or does not match live state");
}
if (conflict !== summary.conflicts.digest) {
  throw new Error("conflict replay digest does not match live state");
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
let byteMutationRejected = false;
try {
  reduce(mutatedBytes);
} catch (error) {
  byteMutationRejected = error instanceof Error && error.message.includes("patch/result-mismatch");
}
if (!byteMutationRejected) throw new Error("one-byte patch mutation did not fail reduction");

const corruptedConflict = records("e1-t10-conflicts.jsonl");
const stagedConflict = corruptedConflict.find((event) => event.type === "fs/merge-conflict");
if (stagedConflict === undefined) throw new Error("conflict golden has no staged conflict");
stagedConflict.payload.base.treeDigest = "f".repeat(64);
let referenceMutationRejected = false;
try {
  reduce(corruptedConflict);
} catch (error) {
  referenceMutationRejected =
    error instanceof Error && error.message.includes("merge/staged-record-mismatch");
}
if (!referenceMutationRejected) throw new Error("conflict-reference mutation did not fail replay");

process.stdout.write(
  `${canonicalJson({
    byteDigest,
    byteMutationRejected,
    cleanDigest: cleanA,
    conflictDigest: conflict,
    referenceMutationRejected,
  })}\n`,
);
