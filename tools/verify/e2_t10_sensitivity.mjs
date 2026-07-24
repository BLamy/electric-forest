#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const verifier = path.join(ROOT, "tools/verify/e2_t10_authz.mjs");
const golden = path.join(
  ROOT,
  ".eforest/tasks/epic-2-the-gates/E2-T10-authz-conformance-matrix/evidence/e2-t10-authz.golden.txt",
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

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "e2-t10-sensitivity-"));
const mutationTree = path.join(scratch, "repo");
try {
  const corrupt = path.join(scratch, "corrupt.golden.txt");
  const bytes = Buffer.from(fs.readFileSync(golden));
  bytes[Math.floor(bytes.length / 2)] ^= 1;
  fs.writeFileSync(corrupt, bytes);
  expectRed("one-byte-golden-corruption", process.execPath, [verifier], ROOT, {
    E2_T10_GOLDEN: corrupt,
  });

  expectRed("semantic-order-shuffle", process.execPath, [verifier], ROOT, { E2_T10_SHUFFLE: "1" });

  const added = run("git", ["worktree", "add", "--detach", mutationTree, "HEAD"]);
  assert.equal(added.status, 0, `could not create mutation worktree: ${added.stderr}`);
  const installed = run("pnpm", ["install", "--offline", "--frozen-lockfile"], mutationTree);
  assert.equal(installed.status, 0, `mutation worktree install failed: ${installed.stderr}`);

  const decidePath = path.join(mutationTree, "packages/platform/src/authz/decide.ts");
  const pristineDecide = fs.readFileSync(decidePath, "utf8");
  const mutantDecide = pristineDecide.replace(
    '  return refuse("authz/not-found");\n}',
    '  return allow("sandbox", target.streamId);\n}',
  );
  assert.notEqual(mutantDecide, pristineDecide, "decision mutation seam drifted");
  fs.writeFileSync(decidePath, mutantDecide);
  let built = run("pnpm", ["--filter", "@eforest/platform", "build"], mutationTree);
  assert.equal(built.status, 0, `decision mutant build failed: ${built.stderr}`);
  const guard = path.join(mutationTree, "tools/verify/e2_t10_decision_guards.mjs");
  expectRed(
    "real-decision-cross-tenant-golden-guard",
    process.execPath,
    [guard, "--guard=decision"],
    mutationTree,
  );
  expectRed(
    "real-decision-cross-tenant-digest-guard",
    process.execPath,
    [guard, "--guard=digest"],
    mutationTree,
  );

  fs.writeFileSync(decidePath, pristineDecide);
  const topologyPath = path.join(mutationTree, "packages/platform/src/route-topology.ts");
  const pristineTopology = fs.readFileSync(topologyPath, "utf8");
  const mutantTopology = pristineTopology.replace(
    '  { id: "home", match: "exact", path: "/", operation: "page" },',
    '  { id: "home", match: "exact", path: "/", operation: "page" },\n' +
      '  { id: "home", match: "exact", path: "/unlisted", operation: "page" },',
  );
  assert.notEqual(mutantTopology, pristineTopology, "route mutation seam drifted");
  fs.writeFileSync(topologyPath, mutantTopology);
  built = run("pnpm", ["--filter", "@eforest/platform", "build"], mutationTree);
  assert.equal(built.status, 0, `route mutant build failed: ${built.stderr}`);
  expectRed(
    "production-route-topology-mutation",
    process.execPath,
    [path.join(mutationTree, "tools/verify/e2_t10_authz.mjs")],
    mutationTree,
  );
} finally {
  run("git", ["worktree", "remove", "--force", mutationTree]);
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log("E2_T10_SENSITIVITY_OK attacks=5 source-mutations=2");
