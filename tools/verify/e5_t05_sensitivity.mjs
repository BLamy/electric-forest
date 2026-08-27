#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const browserTest = "apps/web/test/issues.pw.ts";
const reusableDist = ["packages/web-hooks/dist", "apps/web/dist"];
const sourceOverlays = [
  browserTest,
  "apps/web/src/issues/IssueBoard.tsx",
  "apps/web/src/issues/IssueDetail.tsx",
  "apps/web/src/issues/useIssues.ts",
  "apps/web/src/route-pages.tsx",
  "apps/web/src/routes.tsx",
  "apps/web/src/styles.css",
  "packages/web-hooks/src/useStreamReducer.ts",
];

const mutations = [
  {
    label: "drop-watcher-frame",
    sensor: "watcher-live-sync",
    builds: ["web-hooks", "web"],
    edits: [
      {
        file: "packages/web-hooks/src/useStreamReducer.ts",
        before:
          "  const batch = parseProjectionResponse(response, definition, current.checkpoint);\n  let state = current.state;\n  for (const record of batch.events) {",
        after:
          "  const batch = parseProjectionResponse(response, definition, current.checkpoint);\n  const appliedEvents =\n    current.checkpoint === OFFSET_BEFORE_FIRST ? batch.events : batch.events.slice(1);\n  let state = current.state;\n  for (const record of appliedEvents) {",
      },
      {
        file: "packages/web-hooks/src/useStreamReducer.ts",
        before: "    records: [...current.records, ...batch.events],",
        after: "    records: [...current.records, ...appliedEvents],",
      },
    ],
  },
  {
    label: "stale-board-offset",
    sensor: "board-at-offset-parity",
    builds: ["web"],
    edits: [
      {
        file: "apps/web/src/issues/IssueBoard.tsx",
        before: "      data-ef-offset={binding.projection.checkpoint}",
        after: '      data-ef-offset="0000000000000000_0000000000000006"',
      },
    ],
  },
  {
    label: "phantom-board-card",
    sensor: "board-literal-equality",
    builds: ["web"],
    edits: [
      {
        file: "apps/web/src/issues/IssueBoard.tsx",
        before: "              <ul>\n                {column.issues.map((issueId) => (",
        after:
          '              <ul>\n                {state === "open" ? (\n                  <li data-testid="issue-card" data-issue-id="phantom" data-issue-state="open">\n                    phantom\n                  </li>\n                ) : null}\n                {column.issues.map((issueId) => (',
      },
    ],
  },
];

function copyDependencies(worktree) {
  symlinkSync(join(root, "node_modules"), join(worktree, "node_modules"), "dir");
  for (const group of ["packages", "apps"]) {
    for (const name of readdirSync(join(root, group))) {
      const sourceModules = join(root, group, name, "node_modules");
      const targetModules = join(worktree, group, name, "node_modules");
      if (existsSync(sourceModules)) {
        cpSync(sourceModules, targetModules, {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
        });
      }
      const sourceDist = join(root, group, name, "dist");
      const targetDist = join(worktree, group, name, "dist");
      if (existsSync(sourceDist)) cpSync(sourceDist, targetDist, { recursive: true });
    }
  }
  const targetEmulate = join(worktree, "vendor/emulate");
  rmSync(targetEmulate, { recursive: true, force: true });
  symlinkSync(join(root, "vendor/emulate"), targetEmulate, "dir");
  for (const relative of sourceOverlays) {
    const target = join(worktree, relative);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, relative), target);
  }
}

function restoreBuildInputs(worktree, originals) {
  for (const [file, source] of originals) writeFileSync(join(worktree, file), source);
  for (const relative of reusableDist) {
    const target = join(worktree, relative);
    rmSync(target, { recursive: true, force: true });
    cpSync(join(root, relative), target, { recursive: true });
  }
}

function command(worktree, executable, args, timeout = 60_000) {
  return spawnSync(executable, args, {
    cwd: worktree,
    encoding: "utf8",
    env: { ...process.env, CI: "true", EFOREST_TEST_PREBUILT: "1" },
    killSignal: "SIGKILL",
    timeout,
  });
}

function buildMutation(worktree, builds, label) {
  const commands = [];
  if (builds.includes("web-hooks")) {
    commands.push(["pnpm", ["exec", "tsc", "-p", "packages/web-hooks/tsconfig.build.json"]]);
  }
  if (builds.includes("web")) {
    commands.push(["pnpm", ["--filter", "@eforest/web", "build"]]);
  }
  for (const [executable, args] of commands) {
    const result = command(worktree, executable, args);
    assert.equal(
      result.status,
      0,
      `${label}: targeted build failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
}

const worktree = mkdtempSync(join(tmpdir(), "eforest-e5-t05-sabotage-"));
let added = false;
try {
  const add = spawnSync("git", ["worktree", "add", "--detach", worktree, "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(add.status, 0, add.stderr);
  added = true;
  copyDependencies(worktree);

  const files = new Set(mutations.flatMap((mutation) => mutation.edits.map((edit) => edit.file)));
  const originals = new Map(
    [...files].map((file) => [file, readFileSync(join(worktree, file), "utf8")]),
  );

  for (const mutation of mutations) {
    restoreBuildInputs(worktree, originals);
    for (const edit of mutation.edits) {
      const path = join(worktree, edit.file);
      const source = readFileSync(path, "utf8");
      assert.equal(
        source.split(edit.before).length - 1,
        1,
        `${mutation.label}: mutation anchor count for ${edit.file}`,
      );
      writeFileSync(path, source.replace(edit.before, edit.after));
    }
    buildMutation(worktree, mutation.builds, mutation.label);
    const result = command(
      worktree,
      process.execPath,
      ["--experimental-strip-types", browserTest],
      90_000,
    );
    assert.notEqual(result.status, null, `${mutation.label}: browser oracle timed out`);
    assert.notEqual(
      result.status,
      0,
      `${mutation.label}: browser oracle unexpectedly stayed green`,
    );
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      new RegExp(mutation.sensor),
      `${mutation.label}: causal sensor was absent`,
    );
    process.stdout.write(
      `E5_T05_SENSITIVITY mutation=${mutation.label} sensor=${mutation.sensor} EXPECTED-FAIL OK\n`,
    );
  }
  process.stdout.write(`E5_T05_SENSITIVITY_OK cases=${String(mutations.length)}\n`);
} finally {
  if (added) {
    const removed = spawnSync("git", ["worktree", "remove", "--force", worktree], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(removed.status, 0, removed.stderr);
  }
}
