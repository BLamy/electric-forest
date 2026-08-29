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
const vitest = join(root, "node_modules/.bin/vitest");
const mutations = [
  {
    label: "merge-without-approval-check-deleted",
    file: "packages/pr/src/validate.ts",
    before:
      '  if (action.type === "pr.merged" && context.state.status !== "approved") {\n    throw new PrRefusalError("pr/merge-without-approval");\n  }\n',
    after: "",
    causalMarker:
      "packages/pr/test/pr-refusals.test.ts::never-approved-merge::expected-202-to-be-409",
    causalCommand: vitest,
    causalArgs: [
      "run",
      "--maxWorkers=1",
      "packages/pr/test/pr-refusals.test.ts",
      "-t",
      "refuses a nonexistent source and a never-approved merge without mutation",
    ],
    causalPatterns: [
      /packages\/pr\/test\/pr-refusals\.test\.ts/,
      /refuses a nonexistent source and a never-approved merge without mutation/,
      /expected 202 to be 409/,
    ],
  },
  {
    label: "changes-requested-no-longer-revokes",
    file: "packages/pr/src/reducer.ts",
    before: '    if (review.kind !== "comment") verdicts.set(review.reviewer, review.kind);',
    after:
      '    if (review.kind !== "comment")\n      verdicts.set(\n        review.reviewer, review.kind === "changes-requested" ? "approved" : review.kind);',
    causalMarker:
      "packages/pr/test/pr-lifecycle.test.ts::approval-revocation::expected-approved-to-be-open",
    causalCommand: vitest,
    causalArgs: [
      "run",
      "--maxWorkers=1",
      "packages/pr/test/pr-lifecycle.test.ts",
      "-t",
      "derives approval down, up, and into a legal close",
    ],
    causalPatterns: [
      /packages\/pr\/test\/pr-lifecycle\.test\.ts/,
      /derives approval down, up, and into a legal close/,
      /expected 'approved' to be 'open'/,
    ],
  },
  {
    label: "golden-lifecycle-one-byte-flip",
    file: ".eforest/tasks/epic-5-the-meadow/E5-T02-pr-event-model/evidence/e5-t02-lifecycle-merged.jsonl",
    before: "Boundary added",
    after: "Boundary adder",
    causalMarker: "e5-t02-lifecycle-merged.jsonl::one-byte-flip::digest-resolution-mismatch",
    causalCommand: process.execPath,
    causalArgs: ["tools/verify/e5_t02_evidence.mjs"],
    causalPatterns: [
      /e5-t02-lifecycle-merged\.jsonl/,
      /process\/cwd\/TZ\/reducer resolution changed the digest/,
    ],
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
    const causal = spawnSync(mutation.causalCommand, mutation.causalArgs, {
      cwd: worktree,
      encoding: "utf8",
      env: environment,
      killSignal: "SIGKILL",
      timeout: 60_000,
    });
    assert.notEqual(causal.status, null, `${mutation.label}: causal oracle timed out`);
    assert.notEqual(
      causal.status,
      0,
      `${mutation.label}: causal oracle unexpectedly stayed green:\n${causal.stdout}\n${causal.stderr}`,
    );
    const causalOutput = `${causal.stdout}\n${causal.stderr}`;
    for (const pattern of mutation.causalPatterns) {
      assert.match(
        causalOutput,
        pattern,
        `${mutation.label}: causal marker ${String(pattern)} was absent`,
      );
    }
    console.log(
      `E5_T02_SENSITIVITY mutation=${mutation.label} core-exit=${result.status} causal=${mutation.causalMarker} EXPECTED-FAIL OK`,
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
