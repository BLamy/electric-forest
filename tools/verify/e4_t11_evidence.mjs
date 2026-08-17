#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(new URL("..", import.meta.url).pathname, "..");
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
const status = JSON.parse(readFileSync(join(evidence, "e4-t11-status.json"), "utf8"));
if (status.v !== 2) throw new Error(`status evidence version is ${status.v}, expected 2`);
const scenarios = readFileSync(join(evidence, "e4-t11-scenarios.txt"), "utf8");
for (const name of ["offline-remote-only", "offline-local-only", "true-conflict", "mixed"]) {
  if (!scenarios.includes(name)) throw new Error(`scenario evidence missing ${name}`);
  const line = scenarios.split("\n").find((candidate) => candidate.startsWith(`${name}:`));
  if (!line?.includes("digestA=") || !line.includes("digestB=") || !line.includes("replayDigest=")) {
    throw new Error(`scenario evidence lacks independent digests: ${name}`);
  }
}
const replay = readFileSync(join(evidence, "e4-t11-replay.md"), "utf8");
if (!/https:\/\/app\.replay\.io\/recording\/[0-9a-f-]+/.test(replay))
  throw new Error("Replay evidence has no durable recording URL");
if (!/console errors or warnings|ConsoleMessages\(summary\)/.test(replay))
  throw new Error("Replay evidence lacks interrogation notes");
console.log(
  "E4-T11 evidence: scenarios=4 conflict-events=1 byte-cmp=equal status-v2 replay-url=present",
);
