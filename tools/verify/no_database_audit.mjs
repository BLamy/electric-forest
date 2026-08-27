#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? resolve(import.meta.dirname, "../.."));
const databasePackage =
  /^(?:pg|postgres|postgres-js|mysql|mysql2|sqlite|sqlite3|better-sqlite3|knex|prisma|@prisma\/client|typeorm|sequelize|mongodb|mongoose|redis|ioredis|level|leveldb|lmdb|@lmdb\/[^/]+)$/i;
const databaseModule =
  /^(?:node:sqlite|pg|postgres|postgres-js|mysql|mysql2|sqlite|sqlite3|better-sqlite3|knex|prisma|@prisma\/client|typeorm|sequelize|mongodb|mongoose|redis|ioredis|level|leveldb|lmdb)(?:\/.*)?$/i;
const connectionString = /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\//i;
const sourceExtension = /\.(?:[cm]?[jt]sx?)$/;
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

function importedModules(source) {
  const modules = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) modules.push(match[1]);
  return modules;
}

function lockPackageNames(lockText) {
  const names = [];
  for (const line of lockText.split("\n")) {
    const match = /^ {2}['"]?((?:@[^/\s]+\/)?[^@'"\s:]+)@[^:]+['"]?:$/.exec(line);
    if (match !== null) names.push(match[1]);
  }
  return names;
}

function durableServerSubstrate(lockText) {
  const lines = lockText.split("\n");
  const headers = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^ {2}['"]?@durable-streams\/server@.+:$/.test(line));
  const dependencySections = headers.map(({ index }) => {
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^ {2}\S/.test(lines[cursor])) {
        end = cursor;
        break;
      }
    }
    return lines.slice(index + 1, end).join("\n");
  });
  const lmdb = dependencySections.some((section) => /^ {6}lmdb:\s*\S+/m.test(section));
  const nativeEntries = lockPackageNames(lockText).filter((name) => name.startsWith("@lmdb/"));
  return { packagePresent: headers.length > 0, lmdb, nativeEntries };
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
        if (databasePackage.test(name)) {
          dependencyHits.push(`${relative(scanRoot, path)}:${field}:${name}`);
        }
      }
    }
  }

  const sourceHits = [];
  const persistenceHits = [];
  for (const path of files) {
    if (!sourceExtension.test(path)) continue;
    const rel = relative(scanRoot, path);
    if (!/^(?:apps|packages|tools)\//.test(rel)) continue;
    if (/(?:^|\/)no_database_audit\.mjs$/.test(rel)) continue;
    const source = readFileSync(path, "utf8");
    for (const moduleName of importedModules(source)) {
      if (databaseModule.test(moduleName)) sourceHits.push(`${rel}:module:${moduleName}`);
    }
    for (const [index, line] of source.split("\n").entries()) {
      if (connectionString.test(line)) {
        persistenceHits.push(`${rel}:${String(index + 1)}:${line.trim()}`);
      }
    }
  }

  const lockPath = files.find((path) => relative(scanRoot, path) === "pnpm-lock.yaml");
  const lockText = lockPath === undefined ? "" : readFileSync(lockPath, "utf8");
  const substrate = durableServerSubstrate(lockText);
  const transitiveDatabasePackages = lockPackageNames(lockText).filter((name) =>
    databasePackage.test(name),
  );
  const unaccountedTransitive = transitiveDatabasePackages.filter(
    (name) => name !== "lmdb" && !name.startsWith("@lmdb/"),
  );
  return {
    dependencyHits,
    sourceHits,
    persistenceHits,
    substrate,
    unaccountedTransitive,
  };
}

function writePackage(directory, dependencies) {
  mkdirSync(join(directory, "apps", "probe"), { recursive: true });
  writeFileSync(
    join(directory, "apps", "probe", "package.json"),
    `${JSON.stringify({ name: "probe", private: true, dependencies })}\n`,
  );
}

const scratch = mkdtempSync(join(tmpdir(), "eforest-no-application-database-probe-"));
try {
  const dependencyProbe = join(scratch, "dependency");
  writePackage(dependencyProbe, { pg: "0.0.0" });
  assert.deepEqual(audit(dependencyProbe).dependencyHits, [
    "apps/probe/package.json:dependencies:pg",
  ]);
  process.stdout.write("NO-APPLICATION-DATABASE EXPECTED-FAIL dependency=pg OK\n");

  const sourceProbe = join(scratch, "source");
  writePackage(sourceProbe, {});
  writeFileSync(join(sourceProbe, "apps", "probe", "index.ts"), 'import db from "node:sqlite";\n');
  assert.deepEqual(audit(sourceProbe).sourceHits, ["apps/probe/index.ts:module:node:sqlite"]);
  process.stdout.write("NO-APPLICATION-DATABASE EXPECTED-FAIL source=node:sqlite OK\n");

  const transportProbe = join(scratch, "transport");
  writePackage(transportProbe, { "@durable-streams/server": "0.3.8" });
  writeFileSync(
    join(transportProbe, "pnpm-lock.yaml"),
    [
      "lockfileVersion: '9.0'",
      "snapshots:",
      "  '@durable-streams/server@0.3.8':",
      "    dependencies:",
      "      lmdb: 3.5.6",
      "  lmdb@3.5.6:",
      "    optionalDependencies:",
      "      '@lmdb/lmdb-darwin-arm64': 3.5.6",
      "  '@lmdb/lmdb-darwin-arm64@3.5.6': {}",
      "",
    ].join("\n"),
  );
  const transport = audit(transportProbe);
  assert.equal(transport.dependencyHits.length, 0);
  assert.equal(transport.substrate.packagePresent, true);
  assert.equal(transport.substrate.lmdb, true);
  assert.deepEqual(transport.unaccountedTransitive, []);
  process.stdout.write("DURABLE-STREAMS-TRANSPORT EXPECTED-ALLOW substrate=lmdb OK\n");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const result = audit(root);
const failures = [
  ...result.dependencyHits.map((hit) => `APPLICATION-DATABASE-DEPENDENCY ${hit}`),
  ...result.sourceHits.map((hit) => `APPLICATION-DATABASE-SOURCE ${hit}`),
  ...result.persistenceHits.map((hit) => `APPLICATION-PERSISTENCE ${hit}`),
  ...result.unaccountedTransitive.map((hit) => `UNACCOUNTED-TRANSITIVE-DATABASE ${hit}`),
];
assert.equal(result.substrate.packagePresent, true, "official Durable Streams server is absent");
assert.equal(
  result.substrate.lmdb,
  true,
  "official Durable Streams server substrate is undisclosed",
);
if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `DURABLE-STREAMS-TRANSPORT package=@durable-streams/server substrate=lmdb native=${String(result.substrate.nativeEntries.length)} transitive=true DISCLOSED\n`,
  );
  process.stdout.write("NO-APPLICATION-DATABASE dependencies=0 sources=0 persistence=0 OK\n");
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
