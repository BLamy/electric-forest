#!/usr/bin/env node
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertTranscriptCanon } from "../../../packages/sync-harness/dist/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const script = join(root, "tools/verify/e4-sync/run.sh");
const golden = join(
  root,
  ".eforest/tasks/epic-4-the-roots/E4-T09-two-machine-harness/evidence/golden-transcript.txt",
);
const goldenSeed = join(
  root,
  ".eforest/tasks/epic-4-the-roots/E4-T09-two-machine-harness/evidence/golden-seed.txt",
);
const branchGolden = join(
  root,
  ".eforest/tasks/epic-4-the-roots/E4-T09-two-machine-harness/evidence/golden-branch-dump.jsonl",
);
const digestGolden = join(
  root,
  ".eforest/tasks/epic-4-the-roots/E4-T09-two-machine-harness/evidence/golden-branch.digest",
);
const repro1 = join(
  root,
  ".eforest/tasks/epic-4-the-roots/E4-T09-two-machine-harness/evidence/repro-run-1.txt",
);
const repro2 = join(
  root,
  ".eforest/tasks/epic-4-the-roots/E4-T09-two-machine-harness/evidence/repro-run-2.txt",
);
const sensitivity = join(
  root,
  ".eforest/tasks/epic-4-the-roots/E4-T09-two-machine-harness/evidence/sensitivity-transcript.txt",
);
const scratch = mkdtempSync(join(tmpdir(), "eforest-e4-t09-verify-"));

function run(seed, output, mode = "lockstep", branchOutput, topologyOutput, scenario) {
  return execFileSync(
    script,
    [
      "--seed",
      String(seed),
      "--mode",
      mode,
      ...(scenario === undefined ? [] : ["--scenario", scenario]),
      "--out",
      output,
      ...(branchOutput === undefined ? [] : ["--branch-dump", branchOutput]),
      ...(topologyOutput === undefined ? [] : ["--topology", topologyOutput]),
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CI: "true" },
      maxBuffer: 2 ** 22,
    },
  );
}

function runConflictScenario(name, output, branchOutput) {
  const stdout = run(1, output, "lockstep", branchOutput, undefined, name);
  const transcript = JSON.parse(readFileSync(output, "utf8"));
  const step = transcript.steps?.[0];
  const expectedConflict = name === "true-conflict" || name === "mixed";
  if (step?.conflictEvents !== (expectedConflict ? 1 : 0))
    throw new Error(`${name}: unexpected conflict event count ${step?.conflictEvents}`);
  const expectedFiles = expectedConflict ? 1 : 0;
  if (step?.conflictFiles?.some((files) => files.length !== expectedFiles))
    throw new Error(`${name}: unexpected conflict files ${JSON.stringify(step?.conflictFiles)}`);
  if (!stdout.includes(`"name":"${name}"`) || !stdout.includes(`"type":"scenario"`))
    throw new Error(`${name}: scenario marker absent from transcript`);
  return transcript;
}

function runMutation(output, args = ["--mutate", "notes/todo.md"], mode = "lockstep") {
  const result = spawnSync(script, ["--seed", "1", "--mode", mode, ...args, "--out", output], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    maxBuffer: 2 ** 22,
  });
  if (result.status === 0) throw new Error("worktree mutation unexpectedly converged");
  if (!/convergence mismatch[\s\S]*first-divergent-offset=/.test(result.stderr))
    throw new Error(`mutation failure omitted path or bisect evidence: ${result.stderr}`);
  process.stdout.write("MUTATION worktree convergence-mismatch EXPECTED-FAIL OK\n");
  return result.stderr;
}

function runInterrupted(output) {
  const teardownReport = `${output}.teardown.json`;
  const result = spawnSync(
    script,
    [
      "--seed",
      "1",
      "--mode",
      "lockstep",
      "--interrupt-after",
      "3",
      "--teardown-report",
      teardownReport,
      "--out",
      output,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CI: "true" },
      maxBuffer: 2 ** 22,
    },
  );
  if (result.status === 0) throw new Error("interrupted harness unexpectedly completed green");
  if (
    !/harness interrupted during quiescence|interrupted after schedule step 3/.test(result.stderr)
  )
    throw new Error(`interrupted harness did not fail at the requested step: ${result.stderr}`);
  const teardown = JSON.parse(readFileSync(teardownReport, "utf8"));
  if (teardown.scratchRemoved !== true || teardown.survivingPids.length !== 0)
    throw new Error(`interrupted harness left residue: ${JSON.stringify(teardown)}`);
  process.stdout.write("TEARDOWN interrupted-run EXPECTED-FAIL OK\n");
}

try {
  const actual = join(scratch, "seed-1.transcript");
  const actualBranch = join(scratch, "seed-1.branch.jsonl");
  const topology = join(scratch, "topology.json");
  const stdout = run(1, actual, "lockstep", actualBranch, topology);
  const expected = readFileSync(golden, "utf8");
  if (stdout !== expected || readFileSync(actual, "utf8") !== expected)
    throw new Error("seed 1 transcript differs from the committed golden");
  if (readFileSync(goldenSeed, "utf8").trim() !== "1")
    throw new Error("committed golden seed is not wired to seed 1");
  assertTranscriptCanon(stdout);
  const topologyValue = JSON.parse(readFileSync(topology, "utf8"));
  if (
    topologyValue.branch !== "e4/convergence:main" ||
    topologyValue.server?.store !== "file" ||
    typeof topologyValue.server?.pid !== "number" ||
    topologyValue.machines?.length !== 2 ||
    topologyValue.machines[0].pid === topologyValue.machines[1].pid ||
    topologyValue.machines[0].root === topologyValue.machines[1].root ||
    topologyValue.machines.some(
      (machine) =>
        machine.identity?.branch !== "main" ||
        machine.identity?.repo !== "convergence" ||
        machine.identity?.project !== "convergence" ||
        typeof machine.identity?.metadataStreamId !== "string",
    ) ||
    topologyValue.machines[0].identity.metadataStreamId !==
      topologyValue.machines[1].identity.metadataStreamId
  )
    throw new Error("topology evidence does not prove two distinct watcher processes and roots");
  if (readFileSync(actualBranch, "utf8") !== readFileSync(branchGolden, "utf8"))
    throw new Error("seed 1 branch dump differs from the committed golden");
  if (
    readFileSync(repro1, "utf8") !== readFileSync(repro2, "utf8") ||
    readFileSync(repro1, "utf8") !== expected
  )
    throw new Error("committed reproducibility fixtures do not match the golden");
  if (!readFileSync(sensitivity, "utf8").includes("convergence mismatch"))
    throw new Error("committed sensitivity fixture is not a red convergence run");
  const mutatedRecord = readFileSync(branchGolden, "utf8")
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .findLast((record) => record?.payload?.path === "notes/todo.md");
  if (typeof mutatedRecord?.offset !== "string")
    throw new Error("branch golden has no notes/todo.md offset");
  const replayDigest = execFileSync(
    process.execPath,
    [join(root, "packages/cli/dist/src/bin.js"), "replay", actualBranch, "--worktree-digest"],
    { cwd: root, encoding: "utf8" },
  ).trim();
  if (replayDigest !== readFileSync(digestGolden, "utf8").trim())
    throw new Error("seed 1 branch replay digest differs from the committed golden");

  const other = join(scratch, "seed-2.transcript");
  run(2, other);
  if (readFileSync(other, "utf8") === expected)
    throw new Error("seed variation did not change the canonical transcript");
  for (const seed of [99, 987654321, 2654435769])
    run(seed, join(scratch, `seed-${seed}.transcript`));

  const free = join(scratch, "free.transcript");
  run(1, free, "free");

  const repeat1 = join(scratch, "repeat-1.transcript");
  const repeat2 = join(scratch, "repeat-2.transcript");
  run(1, repeat1);
  run(1, repeat2);
  if (readFileSync(repeat1, "utf8") !== readFileSync(repeat2, "utf8"))
    throw new Error("repeated seed 1 runs produced different transcripts");

  const mutationStderr = runMutation(join(scratch, "mutation.transcript"));
  const bisectMatch = mutationStderr.match(/first-divergent-offset=(\{[^\n]+\})/);
  if (bisectMatch === null || JSON.parse(bisectMatch[1]).aOffset !== mutatedRecord.offset)
    throw new Error("mutation bisect offset does not identify the mutated path event");

  const freeMutation = runMutation(
    join(scratch, "free-mutation.transcript"),
    ["--mutate", "notes/todo.md"],
    "free",
  );
  if (!freeMutation.includes("notes/todo.md"))
    throw new Error("free-mode mutation omitted the offending path");
  for (const [kind, expectedPath] of [
    ["delete", "notes/todo.md"],
    ["stray", "stray-e4-t09.txt"],
    ["swap", "docs/renamed.txt"],
  ]) {
    const structural = runMutation(join(scratch, `corrupt-${kind}.transcript`), [
      "--corrupt",
      kind,
    ]);
    if (!structural.includes(expectedPath))
      throw new Error(`${kind} corruption omitted the offending path`);
  }
  runInterrupted(join(scratch, "interrupted.transcript"));

  const scenarioSummary = [];
  for (const name of ["offline-remote-only", "offline-local-only", "true-conflict", "mixed"]) {
    scenarioSummary.push(
      runConflictScenario(
        name,
        join(scratch, `${name}.transcript`),
        join(scratch, `${name}.branch.jsonl`),
      ),
    );
  }
  if (
    scenarioSummary[2].steps[0].conflictFiles[0][0] !==
    scenarioSummary[2].steps[0].conflictFiles[1][0]
  )
    throw new Error("true-conflict did not propagate the same conflict filename to both machines");

  process.stdout.write(
    `e4-sync: lockstep golden matched; free mode converged; repeat matched; seed 2 diverged; worktree mutation reported path and bisect offset; scenarios=${scenarioSummary.length}\n`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
