#!/usr/bin/env node
import assert from "node:assert/strict";
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
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const vitest = join(root, "node_modules/vitest/vitest.mjs");
const sourceRoot = join(root, "packages");
const evidencePath = join(
  root,
  ".eforest/tasks/epic-4-the-roots/E4-T05-ef-branch-checkout/evidence/e4-t05-sensitivity.md",
);

function copySourceTree(destination) {
  cpSync(sourceRoot, join(destination, "packages"), {
    recursive: true,
    filter: (path) => !path.includes("/dist") && !path.includes("node_modules"),
  });
  cpSync(join(root, "package.json"), join(destination, "package.json"));
  cpSync(join(root, "tsconfig.base.json"), join(destination, "tsconfig.base.json"));
  cpSync(join(root, "vitest.config.ts"), join(destination, "vitest.config.ts"));
  if (existsSync(join(sourceRoot, "platform", "dist"))) {
    cpSync(
      join(sourceRoot, "platform", "dist"),
      join(destination, "packages", "platform", "dist"),
      { recursive: true },
    );
  }
  symlinkSync(join(root, "node_modules"), join(destination, "node_modules"), "dir");
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageNodeModules = join(sourceRoot, entry.name, "node_modules");
    if (!existsSync(packageNodeModules)) continue;
    symlinkSync(
      packageNodeModules,
      join(destination, "packages", entry.name, "node_modules"),
      "dir",
    );
  }
}

function focusedTest(destination) {
  return spawnSync(
    process.execPath,
    [
      vitest,
      "run",
      "packages/cli/test/branch-checkout.test.ts",
      "--reporter=dot",
      "--pool=threads",
      "--maxWorkers=1",
      "--no-file-parallelism",
      "--no-coverage",
      "--isolate=false",
    ],
    {
      cwd: destination,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
    },
  );
}

function transcript(result, mutationName) {
  const ansiEscape = String.fromCharCode(27);
  const output = `${result.stdout}\n${result.stderr}`
    .replace(new RegExp(`${ansiEscape}\\[[0-9;]*m`, "g"), "")
    .replace(/\/var\/folders\/[^\s]+/g, "<scratch>");
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const normalizedLines = lines.map((line) => line.replace(/\s+/g, " "));
  const summaries = normalizedLines.filter((line) => /^(Test Files|Tests )/.test(line));
  assert.ok(summaries.length >= 2, `${mutationName}: missing focused test summary`);
  const requiredOutput = {
    "status-gate": [
      "refuses a dirty checkout and typed command errors without stdout",
      "modified: expected +0 to be 3",
    ],
    "materializer-deletions": [
      "forks at the workspace checkpoint and round-trips a clean checkout",
      "materializes post-fork writes, deletions, and renames at the target head",
    ],
    "fork-at-head": [
      "forks at the workspace checkpoint and round-trips a clean checkout",
      "expected true to be false",
    ],
  }[mutationName];
  assert.ok(requiredOutput !== undefined);
  for (const needle of requiredOutput) {
    assert.ok(
      normalizedLines.join(" ").includes(needle),
      `${mutationName}: transcript is missing ${needle}`,
    );
  }
  const description = {
    "status-gate": "dirty checkout refusal assertion failed",
    "materializer-deletions": "fresh checkout and post-fork materialization assertions failed",
    "fork-at-head": "fresh checkout retained the post-checkpoint file",
  }[mutationName];
  assert.ok(description !== undefined);
  return `${summaries.slice(0, 2).join(" | ")} | ${description}`;
}

const mutations = [
  {
    name: "status-gate",
    file: "packages/cli/src/branch-checkout-command.ts",
    needle: [
      "    if (",
      "      classification.added.length > 0 ||",
      "      classification.deleted.length > 0 ||",
      "      classification.modified.length > 0",
      "    ) {",
    ].join("\n"),
    replacement: "    if (false) {",
  },
  {
    name: "materializer-deletions",
    file: "packages/cli/src/branch-checkout-command.ts",
    needle: "    clearWorktree(root);",
    replacement: "    // clearWorktree(root);",
  },
  {
    name: "fork-at-head",
    file: "packages/platform/src/official.ts",
    needle: "    const sourceOffset = source.transportOffsets?.[sourceIndex] ?? forkOffset;",
    replacement: "    const sourceOffset = source.transportOffsets?.at(-1) ?? forkOffset;",
  },
];

const baseline = mkdtempSync(join(tmpdir(), "eforest-e4-t05-baseline-"));
const reportLines = ["BASELINE focused integration suite green OK"];
try {
  copySourceTree(baseline);
  const result = focusedTest(baseline);
  assert.equal(
    result.status,
    0,
    `baseline focused integration suite failed\n${result.stdout}\n${result.stderr}`,
  );
  process.stdout.write(`${reportLines[0]}\n`);
} finally {
  rmSync(baseline, { recursive: true, force: true });
}

for (const mutation of mutations) {
  const scratch = mkdtempSync(join(tmpdir(), `eforest-e4-t05-${mutation.name}-`));
  try {
    copySourceTree(scratch);
    const path = join(scratch, mutation.file);
    const source = readFileSync(path, "utf8");
    assert.ok(source.includes(mutation.needle), `${mutation.name}: mutation needle missing`);
    writeFileSync(path, source.replace(mutation.needle, mutation.replacement));
    const result = focusedTest(scratch);
    assert.notEqual(
      result.status,
      0,
      `${mutation.name}: focused integration suite stayed green\n${result.stdout}\n${result.stderr}`,
    );
    const transcriptLine = transcript(result, mutation.name);
    reportLines.push(
      `MUTATION ${mutation.name} red EXPECTED-FAIL OK exit=${result.status}`,
      `TRANSCRIPT ${mutation.name} ${transcriptLine}`,
    );
    process.stdout.write(`${reportLines.at(-2)}\n${reportLines.at(-1)}\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const evidence = readFileSync(evidencePath, "utf8");
for (const line of reportLines) {
  assert.ok(evidence.includes(`${line}\n`), `sensitivity evidence is missing live line: ${line}`);
}
assert.ok(existsSync(vitest));
process.stdout.write("E4_T05_SENSITIVITY_OK\n");
