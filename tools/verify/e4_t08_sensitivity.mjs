import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("../..", import.meta.url).pathname);
const vitest = resolve(root, "node_modules/.bin/vitest");
const mutations = [
  {
    label: "downlink writer filter removed",
    file: "packages/cli/src/sync/downlink.ts",
    before: "if (ownWriterId !== undefined && writerId === ownWriterId) {",
    after: "if (false) {",
  },
  {
    label: "uplink apply-journal consultation removed",
    file: "packages/cli/src/sync/duplex.ts",
    before: "return this.activeApplyPaths.has(path) || this.applyJournalMatchesPath(path);",
    after: "return false;",
  },
  {
    label: "suppressed sync-journal disposition dropped",
    file: "packages/cli/src/sync/duplex.ts",
    before: "disposition: notice.disposition,",
    after: 'disposition: notice.disposition === "suppressed" ? "applied" : notice.disposition,',
  },
];

for (const mutation of mutations) {
  const worktree = mkdtempSync(join(tmpdir(), "eforest-e4-t08-sabotage-"));
  let added = false;
  try {
    const add = spawnSync("git", ["worktree", "add", "--detach", worktree, "HEAD"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(add.status, 0, add.stderr);
    added = true;
    symlinkSync(join(root, "node_modules"), join(worktree, "node_modules"), "dir");
    const path = join(worktree, mutation.file);
    const source = readFileSync(path, "utf8");
    assert.ok(source.includes(mutation.before), `${mutation.file} mutation anchor disappeared`);
    writeFileSync(path, source.replace(mutation.before, mutation.after));
    const environment = { ...process.env, CI: "true" };
    delete environment.EFOREST_E4_T08_EVIDENCE_DIR;
    const result = spawnSync(
      vitest,
      ["run", "--maxWorkers=1", "packages/cli/test/watch-duplex.test.ts"],
      { cwd: worktree, encoding: "utf8", env: environment },
    );
    assert.notEqual(result.status, 0, `${mutation.label} unexpectedly stayed green`);
    console.log(`${mutation.label}: EXPECTED-FAIL OK`);
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
