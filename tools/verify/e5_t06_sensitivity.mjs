#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const focusedTest = "packages/platform/test/pr-merge-door.test.ts";
const mutations = [
  {
    label: "route-pr-merge-through-generic-writer-recovery",
    file: "packages/platform/src/production.ts",
    before: '      if (operation.event.type === "pr.merge") {',
    after: '      if (false && operation.event.type === "pr.merge") {',
    sensor: "recovers a target-appended merge before the PR outcome",
  },
  {
    label: "ignore-existing-pr-outcome",
    file: "packages/platform/src/gateway.ts",
    before:
      "              readExistingPrOutcome: (streamId: string) =>\n                this.existingPrMergeOutcome(operationId, streamId, subject),",
    after: "              readExistingPrOutcome: async () => undefined,",
    sensor: "recognizes the operation outcome committed before journal completion",
  },
];

function command(worktree, executable, args, timeout = 90_000) {
  return spawnSync(executable, args, {
    cwd: worktree,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    killSignal: "SIGKILL",
    timeout,
  });
}

function copyDependencies(worktree) {
  symlinkSync(join(root, "node_modules"), join(worktree, "node_modules"), "dir");
  for (const name of readdirSync(join(root, "packages"))) {
    const sourceModules = join(root, "packages", name, "node_modules");
    const targetModules = join(worktree, "packages", name, "node_modules");
    if (existsSync(sourceModules)) {
      cpSync(sourceModules, targetModules, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
      });
    }
    const sourceDist = join(root, "packages", name, "dist");
    const targetDist = join(worktree, "packages", name, "dist");
    if (existsSync(sourceDist)) cpSync(sourceDist, targetDist, { recursive: true });
  }
}

const worktree = mkdtempSync(join(tmpdir(), "eforest-e5-t06-sabotage-"));
let added = false;
try {
  const add = spawnSync("git", ["worktree", "add", "--detach", worktree, "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(add.status, 0, add.stderr);
  added = true;
  copyDependencies(worktree);
  const originals = new Map(
    mutations.map(({ file }) => [file, readFileSync(join(worktree, file), "utf8")]),
  );

  for (const mutation of mutations) {
    for (const [file, source] of originals) writeFileSync(join(worktree, file), source);
    const path = join(worktree, mutation.file);
    const source = readFileSync(path, "utf8");
    assert.equal(
      source.split(mutation.before).length - 1,
      1,
      `${mutation.label}: mutation anchor count`,
    );
    writeFileSync(path, source.replace(mutation.before, mutation.after));

    const build = command(worktree, "pnpm", ["--filter", "@eforest/platform", "build"]);
    assert.equal(
      build.status,
      0,
      `${mutation.label}: focused build failed\n${build.stdout}\n${build.stderr}`,
    );
    const result = command(worktree, "pnpm", [
      "exec",
      "vitest",
      "run",
      focusedTest,
      "--reporter=verbose",
    ]);
    assert.notEqual(result.status, null, `${mutation.label}: focused test timed out`);
    assert.notEqual(result.status, 0, `${mutation.label}: focused test unexpectedly stayed green`);
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(mutation.sensor));
    process.stdout.write(
      `E5_T06_SENSITIVITY mutation=${mutation.label} sensor=${mutation.sensor.replaceAll(" ", "-")} EXPECTED-FAIL OK\n`,
    );
  }
  process.stdout.write(`E5_T06_SENSITIVITY_OK cases=${mutations.length}\n`);
} finally {
  if (added) {
    const removed = spawnSync("git", ["worktree", "remove", "--force", worktree], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(removed.status, 0, removed.stderr);
  } else {
    rmSync(worktree, { recursive: true, force: true });
  }
}
