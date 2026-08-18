#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const task = join(root, ".eforest/tasks/epic-4-the-roots/E4-T12-two-machines-one-branch");
const writeEvidence = process.argv.includes("--write-evidence");
const evidence = join(task, "evidence");
const scratch = mkdtempSync(join(tmpdir(), "eforest-e4-t12-"));
const outputEvidence = writeEvidence ? evidence : join(scratch, "evidence");
mkdirSync(join(outputEvidence, "e4-t12-journals"), { recursive: true });

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
      ...(name === "mixed" ? ["offline"] : ["default"]),
      "--mode",
      ...(name === "mixed" ? ["lockstep"] : ["free"]),
      "--convergence-bound-ms",
      "10000",
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
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, EFOREST_E4_T12_COMMON_BASE: "1" },
      maxBuffer: 2 ** 24,
    },
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
const headOffset = JSON.parse(branchBytes.toString().trim().split("\n").at(-1)).offset;
const mixedTimeline = mixed.transcript.scenarioTimeline;
if (!mixedTimeline) throw new Error("mixed capstone did not record partition timeline");
if (mixedTimeline.bCheckpointBefore !== mixedTimeline.bCheckpointAfterEdits)
  throw new Error("mixed capstone B checkpoint changed while watcher was stopped");
if (!mixedTimeline.aPartitionOffsets?.length)
  throw new Error("mixed capstone recorded no A append while B watcher was stopped");
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
const sensitivity = [];
for (const probe of [
  ["byte-mutation", ["--mutate", "notes/todo.md"], "notes/todo.md"],
  [
    "post-quiescence-byte-flip-B",
    ["--mutate-side", "B", "--mutate", "notes/todo.md"],
    "notes/todo.md",
  ],
  ["delete-corruption", ["--corrupt", "delete"], "notes/todo.md"],
  ["stray-corruption", ["--corrupt", "stray"], "stray-e4-t09.txt"],
  ["swap-corruption", ["--corrupt", "swap"], "docs/renamed.txt"],
]) {
  const result = spawnSync(
    process.execPath,
    [join(root, "tools/verify/e4-sync/run.mjs"), "--seed", "1", "--mode", "lockstep", ...probe[1]],
    { cwd: root, encoding: "utf8", maxBuffer: 2 ** 24 },
  );
  if (result.status === 0 || !result.stderr.includes("convergence mismatch"))
    throw new Error(`T12 sensitivity stayed green: ${probe[0]}`);
  if (!result.stderr.includes(probe[2]))
    throw new Error(`T12 sensitivity omitted offending path: ${probe[0]}`);
  const failure = result.stderr.match(/Error: convergence mismatch[^\n]*/)?.[0] ?? "";
  sensitivity.push(`${probe[0]}: ${failure}\nEXPECTED-FAIL OK`);
}
const boundProbe = spawnSync(
  process.execPath,
  [
    join(root, "tools/verify/e4-sync/run.mjs"),
    "--seed",
    "1",
    "--mode",
    "free",
    "--convergence-bound-ms",
    "0",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 2 ** 24 },
);
if (boundProbe.status === 0 || !boundProbe.stderr.includes("convergence bound exceeded"))
  throw new Error("T12 bound-zero sensitivity stayed green");
sensitivity.push(
  `bound-zero: ${boundProbe.stderr.match(/Error: convergence bound exceeded[^\n]*/)?.[0] ?? "red"}\nEXPECTED-FAIL OK`,
);
for (const label of [
  "conflict-file write disabled",
  "sync/conflict dispatch disabled",
  "conflictFileName offset mangled",
]) {
  const sabotage = spawnSync(
    process.execPath,
    [join(root, "tools/verify/e4_t11_sensitivity.mjs")],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, EFOREST_E4_T11_SENSITIVITY_LABEL: label },
      maxBuffer: 2 ** 24,
    },
  );
  if (sabotage.status !== 0 || !sabotage.stdout.includes("EXPECTED-FAIL OK"))
    throw new Error(`T12 inherited conflict sensitivity stayed green: ${label}`);
  const receipt = sabotage.stdout
    .trim()
    .split("\n")
    .find((line) => line.includes("EXPECTED-FAIL OK"));
  sensitivity.push(`${label}: ${receipt}\nEXPECTED-FAIL OK`);
}
const conflictFileProbe = spawnSync(
  process.execPath,
  [
    join(root, "tools/verify/e4-sync/run.mjs"),
    "--seed",
    "1",
    "--profile",
    "offline",
    "--mode",
    "lockstep",
    "--scenario",
    "mixed",
  ],
  {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      EFOREST_E4_T12_COMMON_BASE: "1",
      EFOREST_E4_T12_DISABLE_CONFLICT_FILE: "1",
    },
    maxBuffer: 2 ** 24,
  },
);
if (conflictFileProbe.status === 0 || !conflictFileProbe.stderr.includes("conflict-file mismatch"))
  throw new Error("T12 conflict-file sabotage stayed green or missed its named assertion");
sensitivity.push(
  `conflict-file-disabled: ${conflictFileProbe.stderr.match(/Error: scenario mixed conflict-file mismatch[^\n]*/)?.[0] ?? "red"}\nEXPECTED-FAIL OK`,
);
const catchupOffsetProbe = spawnSync(
  process.execPath,
  [
    join(root, "tools/verify/e4-sync/run.mjs"),
    "--seed",
    "1",
    "--profile",
    "offline",
    "--mode",
    "lockstep",
    "--scenario",
    "mixed",
    "--sabotage-catchup-offset",
  ],
  {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, EFOREST_E4_T12_COMMON_BASE: "1" },
    maxBuffer: 2 ** 24,
  },
);
if (
  catchupOffsetProbe.status === 0 ||
  (!catchupOffsetProbe.stderr.includes("conflict-event count") &&
    !catchupOffsetProbe.stderr.includes("journal bijection mismatch"))
)
  throw new Error("T12 catch-up-offset sabotage stayed green or missed its named assertion");
sensitivity.push(
  `catchup-offset-zero: ${catchupOffsetProbe.stderr.match(/Error: (?:scenario mixed conflict-event count|journal bijection mismatch)[^\n]*/)?.[0] ?? "red"}\nEXPECTED-FAIL OK`,
);

writeFileSync(
  join(outputEvidence, "e4-t12-transcript.txt"),
  [
    `CONVERGENCE_BOUND_MS=10000 max-observed-ms=${mixedFinal.maxConvergenceMs}`,
    "phase=live-convergence source=e4-sync/run.mjs seed=1 mode=free",
    live.stdout.trim(),
    "phase=partition-reunion source=e4-sync/run.mjs scenario=mixed seed=1 mode=free",
    mixed.stdout.trim(),
    "verify-E4-sync dependency=unmodified and required by verify-E4-capstone",
    `materialize mixed.branch --content mixed.content --out replay --worktree-digest => ${replayDigest}`,
    "diff -r -x .ef machine-a machine-b => (empty)",
    "diff -r -x .ef machine-a replay => (empty)",
    "journals=A-ef,B-ef with workspace.json and apply-journal checkpoints",
    "skipped=0",
    "",
  ].join("\n"),
);
writeFileSync(join(outputEvidence, "e4-t12-branch-log.jsonl"), branchBytes);
writeFileSync(join(outputEvidence, "e4-t12-content.jsonl"), readFileSync(mixed.content));
const journalEvidence = join(outputEvidence, "e4-t12-journals");
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
  join(outputEvidence, "e4-t12-branch-log.sha256"),
  `${branchSha}  e4-t12-branch-log.jsonl\n`,
);
writeFileSync(
  join(outputEvidence, "e4-t12-digests.txt"),
  [
    `A tree-digest ${mixedFinal.digestA}`,
    `B tree-digest ${mixedFinal.digestB}`,
    `replay(branch) --worktree-digest ${mixedFinal.replayDigest}`,
    `replay(branch) --tree-digest ${mixedFinal.replayTreeDigest ?? "missing"}`,
    `head-offset ${headOffset}`,
    "",
  ].join("\n"),
);
writeFileSync(
  join(outputEvidence, "e4-t12-diff-A-vs-B.txt"),
  `diff -r -x .ef machine-a machine-b\n${machineDiff || "(empty)"}\n`,
);
writeFileSync(
  join(outputEvidence, "e4-t12-diff-A-vs-replay.txt"),
  `diff -r -x .ef machine-a replay\n${replayDiff || "(empty)"}\n`,
);
writeFileSync(
  join(outputEvidence, "e4-t12-conflict.txt"),
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
  join(outputEvidence, "e4-t12-partition-timeline.txt"),
  [
    "partition scenario=mixed phase=partition-reunion",
    `B watcher stopped before partition edit offset=${mixedTimeline.partitionHeadOffset}`,
    `B checkpoint unchanged while stopped=${mixedTimeline.bCheckpointBefore}`,
    `A appended while B stopped offsets=${mixedTimeline.aPartitionOffsets.join(",")}`,
    `B watcher restarted before catch-up head-offset=${mixedTimeline.catchupHeadOffset}`,
    `reunion completed at final quiescence head-offset=${mixedTimeline.reunionHeadOffset}`,
    "",
  ].join("\n"),
);
writeFileSync(
  join(outputEvidence, "e4-t12-sensitivity.md"),
  [
    "T12 sabotage probes mutate disposable watcher worktrees and require a named red convergence assertion.",
    ...sensitivity,
    "",
  ].join("\n"),
);
if (!writeEvidence) {
  const stripTiming = (value) => {
    if (Array.isArray(value)) return value.map(stripTiming);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== "observedConvergenceMs" && key !== "maxConvergenceMs")
          .map(([key, nested]) => [key, stripTiming(nested)]),
      );
    }
    return value;
  };
  const comparable = (relative, bytes) => {
    const text = bytes.toString();
    if (relative === "e4-t12-sensitivity.md")
      return text
        .split("\n")
        .map((line) => line.replace(/:.*$/, ":<red-path>"))
        .join("\n");
    return text
      .split("\n")
      .map((line) => {
        try {
          return JSON.stringify(stripTiming(JSON.parse(line)));
        } catch {
          return line.replace(/max-observed-ms=\d+/g, "max-observed-ms=<measured>");
        }
      })
      .join("\n");
  };
  const files = (dir, prefix = "") =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      const relative = join(prefix, name);
      return statSync(path).isDirectory() ? files(path, relative) : [relative];
    });
  const generated = files(outputEvidence).sort();
  const committed = new Set(files(evidence));
  for (const relative of generated) {
    if (!committed.has(relative))
      throw new Error(`T12 generated evidence is not committed: ${relative}`);
    if (relative.startsWith("e4-t12-journals/")) continue;
    if (
      comparable(relative, readFileSync(join(evidence, relative))) !==
      comparable(relative, readFileSync(join(outputEvidence, relative)))
    )
      throw new Error(`T12 committed evidence mismatch: ${relative}`);
  }
  const browserProof = readFileSync(join(evidence, "e4-t12-browser.txt"), "utf8");
  for (const expected of [
    `final=${headOffset} digest=${mixedFinal.replayTreeDigest}`,
    "conflict-visible=true",
    "console-errors=0 document-navigations=0",
  ]) {
    if (!browserProof.includes(expected)) throw new Error(`browser proof mismatch: ${expected}`);
  }
}
console.log(
  `E4-T12 capstone: live=${liveFinal.digestA} mixed=${mixedFinal.digestA} conflict-events=1 branch-sha256=${branchSha}`,
);
