#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

for (const [flag, expected] of [
  ["--probe-database-dependency", /better-sqlite3.*storage tell list/],
  ["--probe-out-of-scope-write", /outside every allowed target:.*e3-t02-out-of-scope/],
]) {
  const result = spawnSync(process.execPath, ["tools/verify/e2_t08_no_database.mjs", flag], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1, `${flag} must make the no-database sweep red`);
  assert.match(`${result.stdout}\n${result.stderr}`, expected, `${flag} must name the violation`);
  process.stdout.write(`EXPECTED_RED ${flag}\n`);
}

process.stdout.write("E2_T08_NO_DATABASE_SENSITIVITY_OK probes=2\n");

const root = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "eforest-e2-t08-generated-evidence-"));
const run = (command, args) =>
  spawnSync(command, args, {
    cwd: scratch,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });

try {
  const added = spawnSync("git", ["worktree", "add", "--detach", scratch, "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(added.status, 0, `generated-evidence worktree setup failed: ${added.stderr}`);

  const generatedPath = join(
    scratch,
    ".eforest/tasks/epic-9-sensitivity/E9-T99-generated-evidence/evidence/composed-gate.txt",
  );
  mkdirSync(join(generatedPath, ".."), { recursive: true });
  writeFileSync(generatedPath, 'writeFileSync("transient gate output")\n');

  const control = run(process.execPath, ["tools/verify/e2_t08_no_database.mjs"]);
  assert.equal(
    control.status,
    0,
    `generated composed-gate evidence must be excluded from the stable sweep:\n${control.stdout}\n${control.stderr}`,
  );

  const scannerPath = join(scratch, "tools/verify/e2_t08_no_database.mjs");
  const scanner = readFileSync(scannerPath, "utf8");
  const exclusion = "return GENERATED_EVIDENCE.has(path) || COMPOSED_GATE_EVIDENCE.test(path);";
  assert.equal(
    scanner.split(exclusion).length - 1,
    1,
    "generated-evidence exclusion anchor drifted",
  );
  writeFileSync(scannerPath, scanner.replace(exclusion, "return GENERATED_EVIDENCE.has(path);"));

  const sabotaged = run(process.execPath, ["tools/verify/e2_t08_no_database.mjs"]);
  assert.equal(sabotaged.status, 1, "removing the composed-gate exclusion must turn the sweep red");
  assert.match(
    `${sabotaged.stdout}\n${sabotaged.stderr}`,
    /E9-T99-generated-evidence\/evidence\/composed-gate\.txt/,
    "the red sweep must attribute the transient generated transcript",
  );
  process.stdout.write("EXPECTED_RED generated-composed-gate-inclusion\n");
} finally {
  spawnSync("git", ["worktree", "remove", "--force", scratch], {
    cwd: root,
    encoding: "utf8",
  });
  rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write("E2_T08_GENERATED_EVIDENCE_SENSITIVITY_OK cases=1\n");
