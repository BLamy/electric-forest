import assert from "node:assert/strict";
import {
  existsSync,
  cpSync,
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
    label: "downlink writer filter removed",
    file: "packages/cli/src/sync/downlink.ts",
    before: "if (ownWriterId !== undefined && writerId === ownWriterId) {",
    after: "if (false) {",
  },
  {
    label: "uplink apply-journal consultation removed",
    file: "packages/cli/src/sync/duplex.ts",
    before: "return this.applyJournalMatchesPath(path);",
    after: "return false;",
  },
  {
    label: "suppressed sync-journal disposition dropped",
    file: "packages/cli/src/sync/duplex.ts",
    before: "disposition: notice.disposition,",
    after: 'disposition: notice.disposition === "suppressed" ? "applied" : notice.disposition,',
  },
  {
    label: "one echo per idle minute",
    file: "packages/cli/test/watch-duplex.test.ts",
    before: 'const idleWindowMs = Number(process.env.EFOREST_E4_T08_IDLE_MS ?? "65050");',
    after:
      'setTimeout(() => { void repo.createFile("slow-echo.txt", new TextEncoder().encode("slow echo\\n")); }, 60_000);\n      const idleWindowMs = Number(process.env.EFOREST_E4_T08_IDLE_MS ?? "65050");',
    slow: true,
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

const selectedLabel = process.env.EFOREST_E4_T08_SENSITIVITY_LABEL;
for (const mutation of mutations.filter(
  (candidate) => selectedLabel === undefined || candidate.label === selectedLabel,
)) {
  const worktree = mkdtempSync(join(tmpdir(), "eforest-e4-t08-sabotage-"));
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
    const environment = {
      ...process.env,
      CI: "true",
      EFOREST_E4_T08_IDLE_MS: mutation.slow ? "65050" : "10050",
    };
    delete environment.EFOREST_E4_T08_EVIDENCE_DIR;
    const startedAt = Date.now();
    const result = spawnSync(
      vitest,
      ["run", "--maxWorkers=1", "packages/cli/test/watch-duplex.test.ts"],
      {
        cwd: worktree,
        encoding: "utf8",
        env: environment,
        // A sabotage mutation is expected to go red, but a broken watcher must
        // not be allowed to strand the entire verification spine forever.
        timeout: mutation.slow ? 120_000 : 30_000,
        killSignal: "SIGKILL",
      },
    );
    const elapsedMs = Date.now() - startedAt;
    assert.notEqual(result.status, 0, `${mutation.label} unexpectedly stayed green`);
    if (mutation.slow) {
      assert.ok(
        elapsedMs >= 60_000,
        `${mutation.label} failed before the delayed echo fired (${elapsedMs}ms):\n${result.stdout}\n${result.stderr}`,
      );
      assert.match(
        `${result.stdout}\n${result.stderr}`,
        /AssertionError|expected .* to be/,
        `${mutation.label} did not fail at a behavioral assertion`,
      );
    }
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
