#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("../..", import.meta.url).pathname);
const vitest = resolve(root, "node_modules/.bin/vitest");
const mutations = [
  {
    label: "conflict-file write disabled",
    file: "packages/cli/src/sync/conflict.ts",
    before: "renameSync(temporary, target);",
    after: "unlinkSync(temporary);",
    tests: ["packages/cli/test/conflict.test.ts"],
  },
  {
    label: "write ordering inverted",
    file: "packages/cli/src/sync/conflict.ts",
    before: "renameSync(temporary, target);",
    after:
      'writeSync(openSync(target, "w"), Uint8Array.from([9]), 0, 1, 0); throw new Error("sabotaged ordering");',
    tests: ["packages/cli/test/conflict.test.ts"],
  },
  {
    label: "sync/conflict dispatch disabled",
    file: "packages/cli/src/sync/uplink.ts",
    before: "const result = await this.server.dispatch(streamId, value);",
    after: 'const result = { conflict: { reason: "sabotaged dispatch" } };',
    tests: ["packages/cli/test/watch-duplex.test.ts"],
    timeout: 120_000,
  },
  {
    label: "conflictFileName offset mangled",
    file: "packages/cli/src/sync/conflict.ts",
    before: "return `${path}.conflict-${escapedOffset(offset)}`;",
    after: "return `${path}.conflict-mangled`;",
    tests: ["packages/cli/test/conflict.test.ts"],
  },
  {
    label: "echo discrimination disabled",
    file: "packages/cli/src/classify.ts",
    before: "if (conflictOffset(path, rememberedConflicts) === undefined) added.push(path);",
    after: "if (true) added.push(path);",
    tests: ["packages/cli/src/status.test.ts"],
  },
  {
    label: "sync/conflict reducer made tree-mutating",
    file: "packages/cli/src/sync/downlink.ts",
    before: 'case "sync/conflict":\n        case "fs.snapshot":\n          break;',
    after:
      'case "sync/conflict":\n          throw new Error("sabotaged conflict reducer");\n        case "fs.snapshot":\n          break;',
    tests: ["packages/cli/test/downlink.test.ts"],
  },
];

function linkDependencies(worktree) {
  symlinkSync(join(root, "node_modules"), join(worktree, "node_modules"), "dir");
  for (const group of ["packages", "apps"]) {
    for (const name of readdirSync(join(root, group))) {
      const source = join(root, group, name, "node_modules");
      const target = join(worktree, group, name, "node_modules");
      if (existsSync(source) && !existsSync(target)) symlinkSync(source, target, "dir");
      const sourceDist = join(root, group, name, "dist");
      const targetDist = join(worktree, group, name, "dist");
      if (existsSync(sourceDist) && !existsSync(targetDist))
        cpSync(sourceDist, targetDist, { recursive: true });
    }
  }
}

const selectedLabel = process.env.EFOREST_E4_T11_SENSITIVITY_LABEL;
for (const mutation of mutations.filter(
  (candidate) => selectedLabel === undefined || candidate.label === selectedLabel,
)) {
  const worktree = mkdtempSync(join(tmpdir(), "eforest-e4-t11-sabotage-"));
  let added = false;
  try {
    const add = spawnSync("git", ["worktree", "add", "--detach", worktree, "HEAD"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(add.status, 0, add.stderr);
    added = true;
    linkDependencies(worktree);
    const path = join(worktree, mutation.file);
    const source = readFileSync(path, "utf8");
    assert.ok(source.includes(mutation.before), `${mutation.file} mutation anchor disappeared`);
    writeFileSync(path, source.replace(mutation.before, mutation.after));
    const result = spawnSync(vitest, ["run", "--maxWorkers=1", ...mutation.tests], {
      cwd: worktree,
      encoding: "utf8",
      env: { ...process.env, EFOREST_TEST_PREBUILT: "1" },
      timeout: mutation.timeout ?? 30_000,
      killSignal: "SIGKILL",
    });
    assert.notEqual(
      result.status,
      0,
      `${mutation.label} unexpectedly stayed green:\n${result.stdout}\n${result.stderr}`,
    );
    const detail = (result.stderr + "\n" + result.stdout)
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .find(
        (line) =>
          line.length > 0 &&
          !/warning|failed tests|test files|tests \d+ passed/i.test(line) &&
          /error|assertionerror|sabotaged|expected|received|tobe/i.test(line),
      );
    assert.ok(detail, `${mutation.label} produced no named failure detail`);
    console.log(`${mutation.label}: ${detail}: EXPECTED-FAIL OK`);
  } finally {
    if (added) {
      const removed = spawnSync("git", ["worktree", "remove", "--force", worktree], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(removed.status, 0, removed.stderr);
    }
  }
}
