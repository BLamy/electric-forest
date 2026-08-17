#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const script = join(root, "tools/verify/e4-sync/run.sh");
const golden = join(
  root,
  ".eforest/tasks/epic-4-the-roots/E4-T09-two-machine-harness/evidence/e4-t09-seed-1.transcript",
);
const branchGolden = join(
  root,
  ".eforest/tasks/epic-4-the-roots/E4-T09-two-machine-harness/evidence/e4-t09-seed-1.branch.jsonl",
);
const digestGolden = join(
  root,
  ".eforest/tasks/epic-4-the-roots/E4-T09-two-machine-harness/evidence/e4-t09-seed-1.digest",
);
const scratch = mkdtempSync(join(tmpdir(), "eforest-e4-t09-verify-"));

function run(seed, output, mode = "lockstep", branchOutput) {
  return execFileSync(
    script,
    [
      "--seed",
      String(seed),
      "--mode",
      mode,
      "--out",
      output,
      ...(branchOutput === undefined ? [] : ["--branch-dump", branchOutput]),
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CI: "true" },
      maxBuffer: 2 ** 22,
    },
  );
}

function runMutation(output) {
  const result = spawnSync(
    script,
    ["--seed", "1", "--mode", "lockstep", "--mutate", "docs/renamed.txt", "--out", output],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CI: "true" },
      maxBuffer: 2 ** 22,
    },
  );
  if (result.status === 0) throw new Error("worktree mutation unexpectedly converged");
  if (
    !/convergence mismatch[\s\S]*docs\/renamed\.txt[\s\S]*first-divergent-offset=/.test(
      result.stderr,
    )
  )
    throw new Error(`mutation failure omitted path or bisect evidence: ${result.stderr}`);
  return result.stderr;
}

try {
  const actual = join(scratch, "seed-1.transcript");
  const actualBranch = join(scratch, "seed-1.branch.jsonl");
  const stdout = run(1, actual, "lockstep", actualBranch);
  const expected = readFileSync(golden, "utf8");
  if (stdout !== expected || readFileSync(actual, "utf8") !== expected)
    throw new Error("seed 1 transcript differs from the committed golden");
  if (readFileSync(actualBranch, "utf8") !== readFileSync(branchGolden, "utf8"))
    throw new Error("seed 1 branch dump differs from the committed golden");
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

  const free = join(scratch, "free.transcript");
  run(1, free, "free");

  const repeat1 = join(scratch, "repeat-1.transcript");
  const repeat2 = join(scratch, "repeat-2.transcript");
  run(1, repeat1);
  run(1, repeat2);
  if (readFileSync(repeat1, "utf8") !== readFileSync(repeat2, "utf8"))
    throw new Error("repeated seed 1 runs produced different transcripts");

  runMutation(join(scratch, "mutation.transcript"));

  const corrupt = join(scratch, "corrupt.transcript");
  const bytes = Buffer.from(expected);
  const index = bytes.indexOf(0x61);
  if (index < 0) throw new Error("golden has no byte available for sensitivity mutation");
  bytes[index] ^= 1;
  writeFileSync(corrupt, bytes);
  if (readFileSync(corrupt, "utf8") === expected)
    throw new Error("one-byte transcript mutation was not detected");

  process.stdout.write(
    `e4-sync: lockstep golden matched; free mode converged; repeat matched; seed 2 diverged; worktree mutation reported path and bisect offset\n`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
