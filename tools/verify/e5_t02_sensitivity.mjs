#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const mutations = [
  {
    label: "merge-without-approval-check-deleted",
    file: "packages/pr/src/validate.ts",
    before:
      '  if (action.type === "pr.merged" && context.state.status !== "approved") {\n    throw new PrRefusalError("pr/merge-without-approval");\n  }\n',
    after: "",
  },
  {
    label: "changes-requested-no-longer-revokes",
    file: "packages/pr/src/reducer.ts",
    before: '    if (review.kind !== "comment") verdicts[review.reviewer] = review.kind;',
    after:
      '    if (review.kind !== "comment")\n      verdicts[review.reviewer] =\n        review.kind === "changes-requested" ? "approved" : review.kind;',
  },
  {
    label: "golden-lifecycle-one-byte-flip",
    file: ".eforest/tasks/epic-5-the-meadow/E5-T02-pr-event-model/evidence/e5-t02-lifecycle-merged.jsonl",
    before: "Boundary added",
    after: "Boundary adder",
  },
];

function linkDependencies(worktree) {
  symlinkSync(join(root, "node_modules"), join(worktree, "node_modules"), "dir");
  for (const group of ["packages", "apps"]) {
    for (const name of readdirSync(join(root, group))) {
      const sourceModules = join(root, group, name, "node_modules");
      const targetModules = join(worktree, group, name, "node_modules");
      if (existsSync(sourceModules) && !existsSync(targetModules)) {
        symlinkSync(sourceModules, targetModules, "dir");
      }
      const sourceDist = join(root, group, name, "dist");
      const targetDist = join(worktree, group, name, "dist");
      if (existsSync(sourceDist) && !existsSync(targetDist)) {
        cpSync(sourceDist, targetDist, { recursive: true });
      }
    }
  }
}

for (const mutation of mutations) {
  const worktree = mkdtempSync(join(tmpdir(), "eforest-e5-t02-sabotage-"));
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
    assert.ok(source.includes(mutation.before), `${mutation.label}: mutation anchor disappeared`);
    writeFileSync(path, source.replace(mutation.before, mutation.after));
    const environment = {
      ...process.env,
      CI: "true",
      EFOREST_TEST_PREBUILT: "1",
    };
    delete environment.NODE_ENV;
    delete environment.NODE_OPTIONS;
    const result = spawnSync("make", ["--no-print-directory", "_verify-E5-T02-inner"], {
      cwd: worktree,
      encoding: "utf8",
      env: environment,
      killSignal: "SIGKILL",
      timeout: 90_000,
    });
    assert.notEqual(result.status, null, `${mutation.label}: core verifier timed out`);
    assert.notEqual(
      result.status,
      0,
      `${mutation.label} unexpectedly stayed green:\n${result.stdout}\n${result.stderr}`,
    );
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /AssertionError|failed|digest process failed|event vocabulary\/order drifted/i,
      `${mutation.label}: red result had no behavioral failure`,
    );
    console.log(
      `E5_T02_SENSITIVITY mutation=${mutation.label} core-exit=${result.status} EXPECTED-FAIL OK`,
    );
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
