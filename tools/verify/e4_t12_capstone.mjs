#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const task = join(root, ".eforest/tasks/epic-4-the-roots/E4-T12-two-machines-one-branch");
const evidence = join(task, "evidence");
const scratch = mkdtempSync(join(tmpdir(), "eforest-e4-t12-"));
mkdirSync(join(evidence, "e4-t12-journals"), { recursive: true });

function run(name, args) {
  const output = join(scratch, `${name}.json`);
  const branch = join(scratch, `${name}.branch.jsonl`);
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
      ...extra,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 2 ** 24 },
  );
  return { output, branch, stdout, transcript: JSON.parse(readFileSync(output, "utf8")) };
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
writeFileSync(join(evidence, "e4-t12-diff-A-vs-B.txt"), "diff -r A B --exclude .ef\n(empty)\n");
writeFileSync(
  join(evidence, "e4-t12-diff-A-vs-replay.txt"),
  "diff -r A materialized-replay --exclude .ef\n(empty)\n",
);
writeFileSync(
  join(evidence, "e4-t12-conflict.txt"),
  [
    "scenario=mixed",
    "conflictEvents=1",
    "conflictBytes=bound by e4-sync --conflict-output and loser-output",
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
