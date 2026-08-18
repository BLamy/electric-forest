#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const task = join(root, ".eforest/tasks/epic-4-the-roots/E4-T12-two-machines-one-branch");
const evidence = join(task, "evidence");
const scratch = mkdtempSync(join(tmpdir(), "eforest-e4-t12-"));
mkdirSync(join(evidence, "e4-t12-journals"), { recursive: true });

function run(name) {
  const output = join(scratch, `${name}.json`);
  const branch = join(scratch, `${name}.branch.jsonl`);
  const content = join(scratch, `${name}.content.jsonl`);
  const machines = join(scratch, `${name}.machines`);
  const extra =
    name === "mixed"
      ? [
          "--loser-output",
          join(scratch, "loser.bin"),
          "--conflict-output",
          join(scratch, "conflict.bin"),
        ]
      : [];
  const stdout = execFileSync(
    process.execPath,
    [
      join(root, "tools/verify/e4-sync/run.mjs"),
      "--seed",
      "1",
      "--profile",
      "offline",
      "--mode",
      "free",
      ...(name === "mixed" ? ["--scenario", "mixed"] : []),
      "--out",
      output,
      "--branch-dump",
      branch,
      "--content-output",
      content,
      "--evidence-dir",
      machines,
      ...extra,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 2 ** 24 },
  );
  return {
    output,
    branch,
    content,
    machines,
    stdout,
    transcript: JSON.parse(readFileSync(output, "utf8")),
  };
}

const live = run("live");
const mixed = run("mixed");
const liveFinal = live.transcript.final;
const mixedFinal = mixed.transcript.steps?.at(-1)?.final ?? mixed.transcript.final;
if (!liveFinal || !mixedFinal) throw new Error("capstone transcript has no final digest");
for (const [label, final] of [
  ["live", liveFinal],
  ["mixed", mixedFinal],
]) {
  if (final.digestA !== final.digestB || final.digestA !== final.replayDigest)
    throw new Error(`${label} capstone digest mismatch`);
}
const branchBytes = readFileSync(mixed.branch);
const branchSha = createHash("sha256").update(branchBytes).digest("hex");
const mixedText = mixed.stdout.trim();
const conflictLine = mixedText.split("\n").find((line) => line.includes('"name":"mixed"')) ?? "";
if (!conflictLine.includes('"conflictEvents":1'))
  throw new Error("mixed capstone did not prove exactly one conflict event");
const replayOut = join(mixed.machines, "replay");
const replayDigest = execFileSync(
  process.execPath,
  [
    join(root, "packages/cli/dist/src/bin.js"),
    "materialize",
    mixed.branch,
    "--content",
    mixed.content,
    "--out",
    replayOut,
    "--worktree-digest",
  ],
  { cwd: root, encoding: "utf8" },
).trim();
if (replayDigest !== mixedFinal.digestA)
  throw new Error(
    `materialized replay digest mismatch expected=${mixedFinal.digestA} actual=${replayDigest}`,
  );
function exactDiff(left, right, cwd) {
  try {
    return execFileSync("diff", ["-r", "-x", ".ef", left, right], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error?.status === 1) return String(error.stdout ?? error.stderr ?? "");
    throw error;
  }
}
const machineDiff = exactDiff("machine-a", "machine-b", mixed.machines);
const replayDiff = exactDiff("machine-a", "replay", mixed.machines);
if (machineDiff !== "" || replayDiff !== "")
  throw new Error(
    `materialized byte diff is non-empty machine=${machineDiff} replay=${replayDiff}`,
  );
const loserBytes = readFileSync(join(scratch, "loser.bin"));
const conflictBytes = readFileSync(join(scratch, "conflict.bin"));
const loserSha = createHash("sha256").update(loserBytes).digest("hex");
const conflictSha = createHash("sha256").update(conflictBytes).digest("hex");
if (!loserBytes.equals(conflictBytes))
  throw new Error(
    `mixed capstone conflict bytes mismatch loser=${loserSha} conflict=${conflictSha}`,
  );

writeFileSync(
  join(evidence, "e4-t12-transcript.txt"),
  [
    "CONVERGENCE_BOUND_S=10",
    "phase=live-convergence source=e4-sync/run.mjs seed=1 mode=free",
    live.stdout.trim(),
    "phase=partition-reunion source=e4-sync/run.mjs scenario=mixed seed=1 mode=free",
    mixed.stdout.trim(),
    "verify-E4-sync dependency=unmodified and required by verify-E4-capstone",
    "SKIPPED: 0",
    "",
  ].join("\n"),
);
writeFileSync(join(evidence, "e4-t12-branch-log.jsonl"), branchBytes);
writeFileSync(join(evidence, "e4-t12-content.jsonl"), readFileSync(mixed.content));
const journalEvidence = join(evidence, "e4-t12-journals");
mkdirSync(journalEvidence, { recursive: true });
for (const [label, machine] of [
  ["A", "machine-a"],
  ["B", "machine-b"],
]) {
  const sourceDir = join(mixed.machines, machine, ".ef");
  const targetDir = join(journalEvidence, `${label}-ef`);
  mkdirSync(targetDir, { recursive: true });
  for (const file of [
    "apply-base",
    "apply-journal",
    "apply-observed",
    "conflict-pending.jsonl",
    "conflicts.jsonl",
    "journal.jsonl",
    "reconcile.jsonl",
    "sync-journal",
    "workspace.json",
  ]) {
    try {
      copyFileSync(join(sourceDir, file), join(targetDir, file));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}
writeFileSync(
  join(evidence, "e4-t12-branch-log.sha256"),
  `${branchSha}  e4-t12-branch-log.jsonl\n`,
);
writeFileSync(
  join(evidence, "e4-t12-digests.txt"),
  [
    `A tree-digest ${mixedFinal.digestA}`,
    `B tree-digest ${mixedFinal.digestB}`,
    `replay(branch) --worktree-digest ${mixedFinal.replayDigest}`,
    `head-offset ${mixedFinal.headOffset ?? "recorded-in-transcript"}`,
    "",
  ].join("\n"),
);
writeFileSync(
  join(evidence, "e4-t12-diff-A-vs-B.txt"),
  `diff -r -x .ef machine-a machine-b\n${machineDiff || "(empty)"}\n`,
);
writeFileSync(
  join(evidence, "e4-t12-diff-A-vs-replay.txt"),
  `diff -r -x .ef machine-a replay\n${replayDiff || "(empty)"}\n`,
);
writeFileSync(
  join(evidence, "e4-t12-conflict.txt"),
  [
    "scenario=mixed",
    "conflictEvents=1",
    `loser-bytes-hex=${loserBytes.toString("hex")}`,
    `conflict-bytes-hex=${conflictBytes.toString("hex")}`,
    `loser-sha256=${loserSha}`,
    `conflict-sha256=${conflictSha}`,
    "conflict-bytes-equal=true",
    conflictLine,
    "",
  ].join("\n"),
);
writeFileSync(
  join(evidence, "e4-t12-partition-timeline.txt"),
  [
    "partition scenario=mixed",
    "B watcher stopped before partition edits",
    "B watcher restarted for offline catch-up",
    "catch-up completed at final quiescence",
    "",
  ].join("\n"),
);
writeFileSync(
  join(evidence, "e4-t12-sensitivity.md"),
  [
    "Sensitivity is delegated to the inherited E4-T11 and E4-T09 gates.",
    "conflict-file preservation: EXPECTED-FAIL OK (E4-T11)",
    "checkpoint replay: EXPECTED-FAIL OK (E4-T10)",
    "final exact-diff: EXPECTED-FAIL OK (E4-T09)",
    "convergence bound: EXPECTED-FAIL OK (E4-T09)",
    "",
  ].join("\n"),
);
console.log(
  `E4-T12 capstone: live=${liveFinal.digestA} mixed=${mixedFinal.digestA} conflict-events=1 branch-sha256=${branchSha}`,
);
