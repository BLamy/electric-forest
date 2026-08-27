#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? resolve(import.meta.dirname, "../.."));
const forbiddenPackage =
  /^(?:pg|postgres|postgres-js|mysql|mysql2|sqlite|sqlite3|better-sqlite3|knex|prisma|@prisma\/client|typeorm|sequelize|mongodb|mongoose|redis|ioredis|level|leveldb)$/i;
const forbiddenSource =
  /(?:\b(?:pg|postgres(?:ql)?|mysql|sqlite|better-sqlite3|knex|prisma|typeorm|sequelize|mongodb|mongoose|redis|ioredis|leveldb)\b|node:sqlite|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/)/i;
const sourceExtension = /\.(?:[cm]?[jt]sx?|sh)$/;
const skippedDirectories = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  "vendor",
  ".pnpm-store",
  "evidence",
  "work",
]);

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

function audit(scanRoot) {
  const files = walk(scanRoot);
  const dependencyHits = [];
  for (const path of files.filter((candidate) => basename(candidate) === "package.json")) {
    const value = JSON.parse(readFileSync(path, "utf8"));
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      for (const name of Object.keys(value[field] ?? {})) {
        if (forbiddenPackage.test(name))
          dependencyHits.push(`${relative(scanRoot, path)}:${field}:${name}`);
      }
    }
  }

  const lock = files.find((path) => relative(scanRoot, path) === "pnpm-lock.yaml");
  if (lock !== undefined) {
    for (const [index, line] of readFileSync(lock, "utf8").split("\n").entries()) {
      const packageName = /^\s{2,}['\"]?((?:@[^/\s]+\/)?[^@'\"\s:]+)@/.exec(line)?.[1];
      if (packageName !== undefined && forbiddenPackage.test(packageName))
        dependencyHits.push(`pnpm-lock.yaml:${index + 1}:${packageName}`);
    }
  }

  const sourceHits = [];
  for (const path of files) {
    const name = basename(path);
    if (!sourceExtension.test(name)) continue;
    const rel = relative(scanRoot, path);
    if (!/^(?:apps|packages|tools)\//.test(rel)) continue;
    if (/(?:^|\/)[^/]*no_database[^/]*\.(?:mjs|sh)$/.test(rel)) continue;
    for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
      if (forbiddenSource.test(line)) sourceHits.push(`${rel}:${index + 1}:${line.trim()}`);
    }
  }
  return { dependencyHits, sourceHits };
}

const scratch = mkdtempSync(join(tmpdir(), "eforest-no-database-probe-"));
try {
  mkdirSync(join(scratch, "apps", "probe"), { recursive: true });
  writeFileSync(
    join(scratch, "apps", "probe", "package.json"),
    `${JSON.stringify({ name: "probe", private: true, dependencies: { pg: "0.0.0" } })}\n`,
  );
  const probe = audit(scratch);
  assert.equal(probe.dependencyHits.length, 1, "planted pg dependency must turn the audit red");
  process.stdout.write("NO-DATABASE EXPECTED-FAIL OK\n");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const result = audit(root);
if (result.dependencyHits.length > 0 || result.sourceHits.length > 0) {
  for (const hit of result.dependencyHits) process.stderr.write(`DATABASE-DEPENDENCY ${hit}\n`);
  for (const hit of result.sourceHits) process.stderr.write(`DATABASE-SOURCE ${hit}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("NO-DATABASE deps=0 sources=0 OK\n");
}

const views = [
  [
    "/issues",
    "repo-issue-board",
    "apps/web/src/issues/useIssues.ts",
    ["repoIssueBoardStreamId", "BOARD_REDUCER"],
  ],
  [
    "/pulls",
    "repo-pr-index",
    "apps/web/src/prs/usePrs.ts",
    ["repoPrIndexStreamId", "PR_INDEX_REDUCER"],
  ],
  ["/pulls/:id/activity", "pr", "apps/web/src/prs/PrDetail.tsx", ["prTimeline", "data-ef-stream"]],
  [
    "/:entity/evidence",
    "evidence",
    "apps/web/src/evidence/EvidencePanel.tsx",
    ["data-ef-stream", "data-ef-reducer"],
  ],
  [
    "/wiki",
    "streamfs@2",
    "apps/web/src/wiki/WikiIndex.tsx",
    ["data-ef-stream", 'data-ef-reducer="streamfs@2"'],
  ],
];
for (const [route, stream, path, needles] of views) {
  const source = readFileSync(resolve(root, path), "utf8");
  for (const needle of needles) assert.ok(source.includes(needle), `${route} must name ${needle}`);
  process.stdout.write(`LIST-VIEW ${route} stream=${stream} OK\n`);
}
