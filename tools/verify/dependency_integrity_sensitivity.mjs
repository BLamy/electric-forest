#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tool = join(sourceRoot, "tools/verify/dependency_integrity.mjs");
const scratch = mkdtempSync(join(tmpdir(), "eforest-dependency-integrity-"));
const repository = join(scratch, "repo");
const manifest = join(scratch, "dependencies.json");

function run(...args) {
  return spawnSync(process.execPath, [tool, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function compare() {
  return run("compare", "--root", repository, "--manifest", manifest);
}

function expectMismatch(label, pattern) {
  const result = compare();
  assert.equal(result.status, 1, `${label} unexpectedly passed: ${result.stdout}${result.stderr}`);
  assert.match(`${result.stdout}${result.stderr}`, pattern, `${label} was not attributed`);
  process.stdout.write(`EXPECTED_RED ${label}\n`);
}

try {
  const packageOne = join(repository, "node_modules/.pnpm/example@1.0.0/node_modules/example");
  const packageTwo = join(repository, "node_modules/.pnpm/example@2.0.0/node_modules/example");
  const installedFile = join(packageOne, "index.js");
  mkdirSync(packageOne, { recursive: true });
  mkdirSync(packageTwo, { recursive: true });
  writeFileSync(installedFile, "export const version = 1;\n");
  writeFileSync(join(packageTwo, "index.js"), "export const version = 2;\n");
  symlinkSync(".pnpm/example@1.0.0/node_modules/example", join(repository, "node_modules/example"));
  mkdirSync(join(repository, "packages/cli/node_modules"), { recursive: true });
  symlinkSync(
    "../../../node_modules/.pnpm/example@1.0.0/node_modules/example",
    join(repository, "packages/cli/node_modules/example"),
  );
  mkdirSync(join(repository, "apps/web/node_modules"), { recursive: true });
  mkdirSync(join(repository, "vendor/emulate/node_modules/ignored"), { recursive: true });
  writeFileSync(join(repository, "vendor/emulate/node_modules/ignored/index.js"), "baseline\n");

  const written = run("write", "--root", repository, "--output", manifest);
  assert.equal(written.status, 0, `${written.stdout}${written.stderr}`);
  const parsed = JSON.parse(readFileSync(manifest, "utf8"));
  const paths = parsed.entries.map((entry) => entry.path);
  assert.deepEqual(paths, [...paths].sort(), "manifest paths must be sorted");
  assert.equal(
    paths.some((path) => path.startsWith("vendor/emulate/")),
    false,
    "vendor/emulate dependencies must be excluded",
  );

  const unchanged = compare();
  assert.equal(unchanged.status, 0, `${unchanged.stdout}${unchanged.stderr}`);
  assert.match(unchanged.stdout, /DEPENDENCY_INTEGRITY_OK/);

  const viteCacheFiles = [
    join(repository, "node_modules/.vite/vitest/results.json"),
    join(repository, "node_modules/.vite-temp/config.mjs"),
    join(repository, "apps/web/node_modules/.vite-temp/config.mjs"),
    join(repository, "packages/cli/node_modules/.vite/deps.json"),
  ];
  for (const path of viteCacheFiles) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "generated\n");
  }
  const viteCachesIgnored = compare();
  assert.equal(
    viteCachesIgnored.status,
    0,
    `${viteCachesIgnored.stdout}${viteCachesIgnored.stderr}`,
  );

  const cacheNeighbor = join(repository, "apps/web/node_modules/.vite-neighbor.js");
  writeFileSync(cacheNeighbor, "must remain attributed\n");
  expectMismatch(
    "neighboring-non-cache-file",
    /ADDED apps\/web\/node_modules\/\.vite-neighbor\.js/,
  );
  unlinkSync(cacheNeighbor);

  const original = readFileSync(installedFile);
  unlinkSync(installedFile);
  expectMismatch("missing-installed-file", /MISSING .*example@1\.0\.0.*index\.js/);
  writeFileSync(installedFile, original);

  writeFileSync(installedFile, Buffer.concat([original.subarray(0, -1), Buffer.from("!\n")]));
  expectMismatch("changed-installed-byte", /CHANGED .*example@1\.0\.0.*index\.js/);
  writeFileSync(installedFile, original);

  const added = join(packageOne, "added.js");
  writeFileSync(added, "unexpected\n");
  expectMismatch("added-installed-file", /ADDED .*example@1\.0\.0.*added\.js/);
  unlinkSync(added);

  const rootLink = join(repository, "node_modules/example");
  unlinkSync(rootLink);
  symlinkSync(".pnpm/example@2.0.0/node_modules/example", rootLink);
  expectMismatch("retargeted-dependency-symlink", /CHANGED node_modules\/example .*symlink/);
  unlinkSync(rootLink);
  symlinkSync(".pnpm/example@1.0.0/node_modules/example", rootLink);

  writeFileSync(join(repository, "vendor/emulate/node_modules/ignored/index.js"), "changed\n");
  const vendorIgnored = compare();
  assert.equal(vendorIgnored.status, 0, `${vendorIgnored.stdout}${vendorIgnored.stderr}`);

  process.stdout.write("DEPENDENCY_INTEGRITY_SENSITIVITY_OK cases=8\n");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
