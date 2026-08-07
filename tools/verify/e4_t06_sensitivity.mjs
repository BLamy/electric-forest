import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("../..", import.meta.url).pathname);
const vitest = resolve(root, "node_modules/.bin/vitest");

const mutations = [
  {
    label: "journal writes disabled",
    file: "packages/cli/src/sync/journal.ts",
    before: 'await handle.write(journalLine(record), undefined, "utf8");',
    after: 'await handle.write("", undefined, "utf8");',
    tests: ["packages/cli/test/uplink.test.ts"],
  },
  {
    label: "base replaced with live-head value",
    file: "packages/cli/src/sync/uplink.ts",
    before: "const base = ledgerEntry?.base ?? entry.base;",
    after: 'const base = "LIVE_HEAD";',
    tests: ["packages/cli/test/uplink.test.ts"],
  },
  {
    label: "final rapid-burst write dropped",
    file: "packages/cli/src/sync/uplink.ts",
    before: "const pending = this.pending;",
    after: "const pending = this.pending.slice(0, -1);",
    tests: ["packages/cli/test/uplink.test.ts"],
  },
  {
    label: ".ef exclusion removed",
    file: "packages/cli/src/sync/coalesce.ts",
    before: 'if (path === ".ef" || path.startsWith(".ef/")) return true;',
    after: "if (false) return true;",
    tests: ["packages/cli/test/coalesce.test.ts"],
  },
  {
    label: "ledger advanced before journal flush",
    file: "packages/cli/src/sync/uplink.ts",
    before:
      "await this.beforeLedgerAdvance(record);\n    const next = update(this.workspaceState, result.offset);\n    saveWorkspace(this.root, next);",
    after:
      "const next = update(this.workspaceState, result.offset);\n    saveWorkspace(this.root, next);\n    await this.beforeLedgerAdvance(record);",
    tests: ["packages/cli/test/uplink.test.ts"],
  },
];

for (const mutation of mutations) {
  const worktree = mkdtempSync(join(tmpdir(), "eforest-e4-t06-sabotage-"));
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
    const result = spawnSync(vitest, ["run", "--maxWorkers=1", ...mutation.tests], {
      cwd: worktree,
      encoding: "utf8",
      env: { ...process.env, EFOREST_TEST_PREBUILT: "1" },
    });
    assert.notEqual(result.status, 0, `${mutation.label} unexpectedly stayed green`);
    console.log(`${mutation.label}: EXPECTED-FAIL OK`);
  } finally {
    if (added) {
      spawnSync("git", ["worktree", "remove", "--force", worktree], {
        cwd: root,
        encoding: "utf8",
      });
    }
  }
}
