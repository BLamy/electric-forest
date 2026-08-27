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
const browserTest = "apps/web/test/labels.pw.ts";
const reusableDist = ["packages/issues/dist", "packages/web-hooks/dist", "apps/web/dist"];

const mutations = [
  {
    label: "optimistic-local-apply",
    sensor: "severed-tail-replay-only-label-rows",
    builds: ["web-hooks", "web"],
    edits: [
      {
        file: "packages/web-hooks/src/useDispatch.ts",
        before:
          'export interface DispatchFunction {\n  (action: Event): Promise<DispatchReceipt>;\n  readonly confirmedOffset: Offset | "";\n  readonly counters: DispatchCounters;\n}',
        after:
          'export interface DispatchFunction {\n  (action: Event): Promise<DispatchReceipt>;\n  readonly confirmedOffset: Offset | "";\n  readonly counters: DispatchCounters;\n  readonly optimisticAction: Event | undefined;\n}',
      },
      {
        file: "packages/web-hooks/src/useDispatch.ts",
        before:
          "  const [lifecycle, setLifecycle] = useState<DispatchLifecycle>(initialDispatchLifecycle);\n  const replayedOffset = options.replayedOffset ?? OFFSET_BEFORE_FIRST;",
        after:
          "  const [lifecycle, setLifecycle] = useState<DispatchLifecycle>(initialDispatchLifecycle);\n  const [optimisticAction, setOptimisticAction] = useState<Event>();\n  const replayedOffset = options.replayedOffset ?? OFFSET_BEFORE_FIRST;",
      },
      {
        file: "packages/web-hooks/src/useDispatch.ts",
        before:
          "      setLifecycle((current) =>\n        dispatchConfirmed(current, receipt.offset, replayedOffsetRef.current),\n      );\n      return receipt;",
        after:
          "      setLifecycle((current) =>\n        dispatchConfirmed(current, receipt.offset, replayedOffsetRef.current),\n      );\n      setOptimisticAction(action);\n      return receipt;",
      },
      {
        file: "packages/web-hooks/src/useDispatch.ts",
        before:
          "        confirmedOffset: lifecycle.confirmedOffset,\n        counters: lifecycle.counters,\n      }),\n    [invoke, lifecycle.confirmedOffset, lifecycle.counters],",
        after:
          "        confirmedOffset: lifecycle.confirmedOffset,\n        counters: lifecycle.counters,\n        optimisticAction,\n      }),\n    [invoke, lifecycle.confirmedOffset, lifecycle.counters, optimisticAction],",
      },
      {
        file: "apps/web/src/label-management.tsx",
        before:
          'import { repoLabelsStreamId, type LabelState, type RepoLabel } from "@eforest/reducers";',
        after:
          'import { labelReducer, repoLabelsStreamId, type LabelState, type RepoLabel } from "@eforest/reducers";',
      },
      {
        file: "apps/web/src/label-management.tsx",
        before: "  const rows = labelRows(projection.state.labels);",
        after:
          "  const displayedState =\n    dispatch.optimisticAction === undefined\n      ? projection.state\n      : labelReducer(projection.state, dispatch.optimisticAction);\n  const rows = labelRows(displayedState.labels);",
      },
    ],
  },
  {
    label: "client-only-refusal-server-accepts",
    sensor: "refusal-log-line-count",
    builds: ["issues", "web-hooks", "web"],
    edits: [
      {
        file: "packages/issues/src/labelReducer.ts",
        before:
          '    if (Object.values(state.labels).some((label) => label.name === payload.name))\n      throw new LabelRefusalError("label/duplicate-name");',
        after:
          '    if (false && Object.values(state.labels).some((label) => label.name === payload.name))\n      throw new LabelRefusalError("label/duplicate-name");',
      },
      {
        file: "packages/web-hooks/src/useDispatch.ts",
        before: "  const body = await responseJson(response);\n  if (!response.ok",
        after:
          '  const body = await responseJson(response);\n  if (\n    response.ok &&\n    responseObject(body)?.error === undefined &&\n    action.type === "label.created" &&\n    responseObject(action.payload)?.labelId === "duplicate-name"\n  ) {\n    throw new DispatchRefusalError({\n      code: "label/duplicate-name",\n      message: "label/duplicate-name",\n      refusedAction: action,\n    });\n  }\n  if (!response.ok',
      },
    ],
  },
  {
    label: "hardcoded-confirmed-offset",
    sensor: "confirmed-offset-four-way-equality",
    builds: ["web"],
    edits: [
      {
        file: "apps/web/src/label-management.tsx",
        before: "      data-ef-confirmed-offset={dispatch.confirmedOffset}",
        after: '      data-ef-confirmed-offset="0000000000000000_0000000000000000"',
      },
    ],
  },
  {
    label: "generic-refusal-string",
    sensor: "typed-refusal-code",
    builds: ["web"],
    edits: [
      {
        file: "apps/web/src/label-management.tsx",
        before:
          "        error instanceof DispatchRefusalError\n          ? { code: error.code, message: error.message }",
        after:
          '        error instanceof DispatchRefusalError\n          ? { code: "dispatch-failed", message: String(error) }',
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
  cpSync(join(root, browserTest), join(worktree, browserTest));
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
  if (builds.includes("issues")) {
    commands.push(["pnpm", ["exec", "tsc", "-p", "packages/issues/tsconfig.build.json"]]);
  }
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

const worktree = mkdtempSync(join(tmpdir(), "eforest-e5-t04-sabotage-"));
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
      `E5_T04_SENSITIVITY mutation=${mutation.label} sensor=${mutation.sensor} EXPECTED-FAIL OK\n`,
    );
  }
  process.stdout.write(`E5_T04_SENSITIVITY_OK cases=${String(mutations.length)}\n`);
} finally {
  if (added) {
    const removed = spawnSync("git", ["worktree", "remove", "--force", worktree], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(removed.status, 0, removed.stderr);
  }
}
