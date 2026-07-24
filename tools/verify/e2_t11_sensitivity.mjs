#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const verifier = path.join(ROOT, "tools/verify/e2_t11_evidence.mjs");
const golden = path.join(
  ROOT,
  ".eforest/tasks/epic-2-the-gates/E2-T11-rate-limits-tenant-isolation/evidence/e2-t11-rate-tenant.golden.txt",
);

function run(command, args, cwd = ROOT, environment = {}) {
  return spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...environment },
    encoding: "utf8",
  });
}

function expectRed(name, command, args, cwd = ROOT, environment = {}) {
  const result = run(command, args, cwd, environment);
  assert.notEqual(
    result.status,
    0,
    `${name} unexpectedly stayed green\n${result.stdout}\n${result.stderr}`,
  );
  console.log(`EXPECTED_RED ${name}`);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "e2-t11-sensitivity-"));
const mutationTree = path.join(scratch, "repo");
try {
  const corrupt = path.join(scratch, "corrupt.golden.txt");
  const bytes = Buffer.from(fs.readFileSync(golden));
  bytes[Math.floor(bytes.length / 2)] ^= 1;
  fs.writeFileSync(corrupt, bytes);
  expectRed("one-byte-golden-corruption", process.execPath, [verifier], ROOT, {
    E2_T11_GOLDEN: corrupt,
  });

  const added = run("git", ["worktree", "add", "--detach", mutationTree, "HEAD"]);
  assert.equal(added.status, 0, `could not create mutation worktree: ${added.stderr}`);
  const installed = run("pnpm", ["install", "--offline", "--frozen-lockfile"], mutationTree);
  assert.equal(installed.status, 0, `mutation worktree install failed: ${installed.stderr}`);

  const limiterPath = path.join(mutationTree, "packages/platform/src/rate-limit.ts");
  const pristineLimiter = fs.readFileSync(limiterPath, "utf8");
  const mutantLimiter = pristineLimiter.replace(
    "    if (counter.count >= this.max) {",
    "    if (false) {",
  );
  assert.notEqual(mutantLimiter, pristineLimiter, "limiter mutation seam drifted");
  fs.writeFileSync(limiterPath, mutantLimiter);
  let built = run("pnpm", ["--filter", "@eforest/platform", "build"], mutationTree);
  assert.equal(built.status, 0, `limiter mutant build failed: ${built.stderr}`);
  expectRed(
    "production-limit-bypass",
    process.execPath,
    [path.join(mutationTree, "tools/verify/e2_t11_evidence.mjs")],
    mutationTree,
  );

  fs.writeFileSync(limiterPath, pristineLimiter);
  const tenantPath = path.join(mutationTree, "packages/platform/src/tenant-isolation.ts");
  const pristineTenant = fs.readFileSync(tenantPath, "utf8");
  const mutantTenant = pristineTenant.replace(
    "    allowed: subjectTenants.length === 0 || subjectTenants.includes(targetTenant),",
    "    allowed: true,",
  );
  assert.notEqual(mutantTenant, pristineTenant, "tenant mutation seam drifted");
  fs.writeFileSync(tenantPath, mutantTenant);
  built = run("pnpm", ["--filter", "@eforest/platform", "build"], mutationTree);
  assert.equal(built.status, 0, `tenant mutant build failed: ${built.stderr}`);
  expectRed(
    "production-tenant-bypass",
    process.execPath,
    [path.join(mutationTree, "tools/verify/e2_t11_evidence.mjs")],
    mutationTree,
  );
} finally {
  run("git", ["worktree", "remove", "--force", mutationTree]);
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log("E2_T11_SENSITIVITY_OK attacks=3 source-mutations=2");
