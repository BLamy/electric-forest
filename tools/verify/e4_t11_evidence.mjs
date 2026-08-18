#!/usr/bin/env node
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(new URL("..", import.meta.url).pathname, "..");
const harness = join(root, "tools/verify/e4-sync/run.mjs");
const evidence = process.env.EFOREST_E4_T11_EVIDENCE_DIR
  ? resolve(process.env.EFOREST_E4_T11_EVIDENCE_DIR)
  : join(root, ".eforest/tasks/epic-4-the-roots/E4-T11-conflict-surfacing/evidence");
const required = [
  "e4-t11-branch-log.jsonl",
  "e4-t11-byte-audit.txt",
  "e4-t11-conflict-event.json",
  "e4-t11-conflict-file.bin",
  "e4-t11-digests.txt",
  "e4-t11-loser.bin",
  "e4-t11-replay.md",
  "e4-t11-scenarios.txt",
  "e4-t11-status.json",
];
for (const name of required) {
  if (!readdirSync(evidence).includes(name)) throw new Error(`missing T11 evidence: ${name}`);
}
const lines = readFileSync(join(evidence, "e4-t11-branch-log.jsonl"), "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const conflicts = lines.filter((record) => record.type === "sync/conflict");
if (conflicts.length !== 1)
  throw new Error(`expected one sync/conflict event, got ${conflicts.length}`);
const event = JSON.parse(readFileSync(join(evidence, "e4-t11-conflict-event.json"), "utf8"));
if (JSON.stringify(event) !== JSON.stringify(conflicts[0]))
  throw new Error("event artifact differs from branch dump");
const loser = readFileSync(join(evidence, "e4-t11-loser.bin"));
const surfaced = readFileSync(join(evidence, "e4-t11-conflict-file.bin"));
if (!loser.equals(surfaced)) throw new Error("loser bytes differ from surfaced conflict file");
const loserSha256 = createHash("sha256").update(loser).digest("hex");
if (event.payload.loserSha256 !== loserSha256)
  throw new Error("conflict event loserSha256 mismatch");
const byteAudit = readFileSync(join(evidence, "e4-t11-byte-audit.txt"), "utf8");
const auditedVersions = byteAudit.split("\n").filter((line) => line.startsWith("versionSha256="));
if (auditedVersions.length < 3 || !byteAudit.includes("byte-audit=3-versions accounted=3 lost=0")) {
  throw new Error("byte audit does not account for every captured file version");
}
for (const line of auditedVersions) {
  const match = /^versionSha256=[^:]+:([0-9a-f]{64}) /.exec(line);
  if (match === null) throw new Error(`malformed byte-audit line: ${line}`);
  if (!lines.some((record) => record.payload?.contentSha256 === match[1])) {
    throw new Error(`byte-audit hash is absent from the committed dump: ${match[1]}`);
  }
}
const status = JSON.parse(readFileSync(join(evidence, "e4-t11-status.json"), "utf8"));
if (status.v !== 2) throw new Error(`status evidence version is ${status.v}, expected 2`);
const scenarios = readFileSync(join(evidence, "e4-t11-scenarios.txt"), "utf8");
for (const name of ["offline-remote-only", "offline-local-only", "true-conflict", "mixed"]) {
  if (!scenarios.includes(name)) throw new Error(`scenario evidence missing ${name}`);
  const line = scenarios.split("\n").find((candidate) => candidate.startsWith(`${name}:`));
  if (
    !line?.includes("digestA=") ||
    !line.includes("digestB=") ||
    !line.includes("replayDigest=")
  ) {
    throw new Error(`scenario evidence lacks independent digests: ${name}`);
  }
}
const fresh = mkdtempSync(join(tmpdir(), "eforest-e4-t11-evidence-"));
try {
  for (const name of ["offline-remote-only", "offline-local-only", "true-conflict", "mixed"]) {
    const transcriptPath = join(fresh, `${name}.json`);
    const branchPath = join(fresh, `${name}.jsonl`);
    const loserPath = join(fresh, `${name}.loser.bin`);
    const conflictPath = join(fresh, `${name}.conflict.bin`);
    execFileSync(
      process.execPath,
      [
        harness,
        "--seed",
        "1",
        "--mode",
        "lockstep",
        "--scenario",
        name,
        "--out",
        transcriptPath,
        "--branch-dump",
        branchPath,
        ...(name === "true-conflict" || name === "mixed"
          ? ["--loser-output", loserPath, "--conflict-output", conflictPath]
          : []),
      ],
      { cwd: root, stdio: "ignore" },
    );
    const transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));
    const line = scenarios.split("\n").find((candidate) => candidate.startsWith(`${name}:`));
    const digest = transcript.final?.digestA;
    if (typeof digest !== "string" || !line?.includes(`digestA=${digest}`))
      throw new Error(`fresh ${name} digest is absent from committed scenario evidence`);
    const freshRecords = readFileSync(branchPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const freshConflicts = freshRecords.filter((record) => record.type === "sync/conflict");
    const expectedConflicts = name === "true-conflict" || name === "mixed" ? 1 : 0;
    if (freshConflicts.length !== expectedConflicts)
      throw new Error(`fresh ${name} conflict count is ${freshConflicts.length}`);
    if (expectedConflicts === 1) {
      const freshLoser = readFileSync(loserPath);
      const freshConflict = readFileSync(conflictPath);
      if (!freshLoser.equals(freshConflict)) throw new Error(`fresh ${name} loser bytes changed`);
      const freshEvent = freshConflicts[0];
      if (
        freshEvent.payload?.loserSha256 !== createHash("sha256").update(freshConflict).digest("hex")
      )
        throw new Error(`fresh ${name} loserSha256 is not bound to fresh conflict bytes`);
      if (
        !String(transcript.steps?.[0]?.conflictFiles?.[0]?.[0]).endsWith(
          freshEvent.payload.winningOffset,
        )
      )
        throw new Error(`fresh ${name} conflict filename does not echo winning offset`);
    }
  }
} finally {
  rmSync(fresh, { recursive: true, force: true });
}
console.log("E4-T11 fresh harness provenance: scenarios=4 digests=bound conflict-bytes=bound");
const replay = readFileSync(join(evidence, "e4-t11-replay.md"), "utf8");
if (!/https:\/\/app\.replay\.io\/recording\/[0-9a-f-]+/.test(replay))
  throw new Error("Replay evidence has no durable recording URL");
if (!/console errors or warnings|ConsoleMessages\(summary\)/.test(replay))
  throw new Error("Replay evidence lacks interrogation notes");
const sensitivity = readFileSync(join(evidence, "e4-t11-sensitivity.md"), "utf8");
for (const label of [
  "conflict-file write disabled",
  "write ordering inverted",
  "sync/conflict dispatch disabled",
  "conflictFileName offset mangled",
  "echo discrimination disabled",
  "sync/conflict reducer made tree-mutating",
]) {
  if (!sensitivity.includes(`${label}: EXPECTED-FAIL OK`))
    throw new Error(`sensitivity evidence missing ${label}`);
}
console.log(
  "E4-T11 evidence: scenarios=4 conflict-events=1 byte-cmp=equal status-v2 replay-url=present",
);
