#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const script = join(root, "tools/verify/e4-sync/run.sh");
const golden = join(
  root,
  ".eforest/tasks/epic-4-the-roots/E4-T09-two-machine-harness/evidence/e4-t09-seed-1.transcript",
);
const scratch = mkdtempSync(join(tmpdir(), "eforest-e4-t09-verify-"));

function run(seed, output, mode = "lockstep") {
  return execFileSync(script, ["--seed", String(seed), "--mode", mode, "--out", output], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    maxBuffer: 2 ** 22,
  });
}

try {
  const actual = join(scratch, "seed-1.transcript");
  const stdout = run(1, actual);
  const expected = readFileSync(golden, "utf8");
  if (stdout !== expected || readFileSync(actual, "utf8") !== expected)
    throw new Error("seed 1 transcript differs from the committed golden");

  const other = join(scratch, "seed-2.transcript");
  run(2, other);
  if (readFileSync(other, "utf8") === expected)
    throw new Error("seed variation did not change the canonical transcript");

  const free = join(scratch, "free.transcript");
  run(1, free, "free");

  const corrupt = join(scratch, "corrupt.transcript");
  const bytes = Buffer.from(expected);
  const index = bytes.indexOf(0x61);
  if (index < 0) throw new Error("golden has no byte available for sensitivity mutation");
  bytes[index] ^= 1;
  writeFileSync(corrupt, bytes);
  if (readFileSync(corrupt, "utf8") === expected)
    throw new Error("one-byte transcript mutation was not detected");

  process.stdout.write(
    `e4-sync: lockstep golden matched; free mode converged; seed 2 diverged; one-byte mutation detected\n`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
