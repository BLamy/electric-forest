import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = resolve(import.meta.dirname, "../..");
const taskRoot = join(
  repoRoot,
  ".eforest/tasks/epic-1-the-trunk/E1-T07-snapshots-and-retention",
);
const evidenceRoot = join(taskRoot, "evidence");
const cli = join(repoRoot, "packages/cli/dist/src/bin.js");
const logPath = join(evidenceRoot, "e1-t07-fs-log.jsonl");
const artifactPath = join(evidenceRoot, "e1-t07-snapshot.bin");
const tailPath = join(evidenceRoot, "e1-t07-compacted-tail.jsonl");
const eventPath = join(evidenceRoot, "e1-t07-snapshot-event.json");
const digestPath = join(evidenceRoot, "e1-t07-digests.txt");

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function runEf(args) {
  try {
    return execFileSync(process.execPath, [cli, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status !== 0) return undefined;
    throw error;
  }
}

const log = readFileSync(logPath, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const snapshotEvent = JSON.parse(readFileSync(eventPath, "utf8"));
const tail = readFileSync(tailPath, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assertCondition(log.filter((record) => record.type === "fs.file.patch").length >= 3, "golden lacks three patch events");
assertCondition(
  log.some(
    (record) =>
      record.type === "fs.rename" &&
      record.payload.from === "src/nested" &&
      record.payload.to === "moved",
  ),
  "golden lacks the subtree rename",
);
const deleted = log.findIndex(
  (record) => record.type === "fs.file.delete" && record.payload.path === "src/a.txt",
);
const recreated = log.findIndex(
  (record) => record.type === "fs.file.create" && record.payload.path === "src/a.txt" && record.payload.contentStreamId === "fs:e1-t07:file:c",
);
assertCondition(deleted >= 0 && recreated > deleted, "golden lacks delete/recreate ordering");
assertCondition(tail[0]?.type === "fs.snapshot", "compacted tail must retain the snapshot event");

const fullDigest = runEf(["replay", logPath, "--digest"]);
const bootstrapDigest = runEf([
  "replay",
  "--bootstrap",
  artifactPath,
  "--tail",
  tailPath,
  "--digest",
]);
const announcedDigest = snapshotEvent.payload.stateDigest;
assertCondition(fullDigest !== undefined, "full golden replay failed");
assertCondition(bootstrapDigest !== undefined, "snapshot-plus-tail replay failed");
assertCondition(fullDigest === bootstrapDigest, "full and bootstrap replay digests diverged");
assertCondition(fullDigest === announcedDigest, "replay digest disagrees with snapshot announcement");

const recorded = readFileSync(digestPath, "utf8")
  .trim()
  .split("\n")
  .map((line) => line.split("\t"));
assertCondition(recorded.length === 3, "digest evidence must contain three rows");
assertCondition(recorded.every((row) => row[1] === fullDigest), "digest evidence is stale");

const artifact = readFileSync(artifactPath);
const temp = mkdtempSync(join(tmpdir(), "eforest-e1-t07-snapshot-"));
try {
  const positions = new Set([0, artifact.length - 1]);
  let seed = 0x7e1a07;
  while (positions.size < 18) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    positions.add(1 + (seed % Math.max(1, artifact.length - 2)));
  }
  for (const position of positions) {
    const mutated = Buffer.from(artifact);
    mutated[position] = (mutated[position] ?? 0) ^ 1;
    const path = join(temp, `flip-${position}.bin`);
    writeFileSync(path, mutated);
    const result = runEf(["replay", "--bootstrap", path, "--tail", tailPath, "--digest"]);
    assertCondition(result === undefined || result !== fullDigest, `artifact flip ${position} was not detected`);
  }
  const truncated = join(temp, "truncated.bin");
  writeFileSync(truncated, artifact.subarray(0, artifact.length - 2));
  const truncatedResult = runEf([
    "replay",
    "--bootstrap",
    truncated,
    "--tail",
    tailPath,
    "--digest",
  ]);
  assertCondition(
    truncatedResult === undefined || truncatedResult !== fullDigest,
    "truncated artifact was not detected",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log(`snapshot golden full=${fullDigest} bootstrap=${bootstrapDigest} announced=${announcedDigest} corruption-sensitivity=OK`);
