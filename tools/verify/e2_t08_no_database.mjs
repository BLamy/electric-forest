#!/usr/bin/env node
// E2-T08 no-database sweep: scan this task's full diff (E2-T07 verified base
// → HEAD + working tree) for every storage tell — storage-engine names,
// filesystem writes, and new workspace dependencies one by one — and exit
// NONZERO on any write outside {the E0-T07 stream store, evidence/,
// gitignored test scratch} or any unwaived new dependency. Waivers are
// committed lines in THIS script, each with a stated reason; "classified but
// tolerated" is not a pass — every hit is either allowed by frozen category,
// waived by name, or fatal.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
/** The E2-T07 verified head this task stacks on. */
const BASE = "e23d04f5754dc3cb74d12ffcdd05fa1a774b07f6";
const evidencePath = resolve(
  root,
  ".eforest/tasks/epic-2-the-gates/E2-T08-registry-derived-index/evidence/e2-t08-no-database.txt",
);
const update = process.argv.includes("--update-evidence");

/**
 * Committed waivers — every entry names the file, the tell, and the reason.
 * A tell without a matching waiver (and outside the allowed categories) is
 * fatal.
 */
const WAIVERS = [
  {
    file: "packages/cli/package.json",
    tell: "new-workspace-dependency:@eforest/platform",
    reason:
      "ef registry rebuild consumes the projector/reducer library; streams-only code, not a storage engine",
  },
  {
    file: "packages/cli/package.json",
    tell: "new-workspace-dependency:@eforest/server",
    reason:
      "ef registry rebuild opens the stream-store data dir through Electric's reference Durable Streams server — the store's own surface IS the E0-T07 stream store (promoted from devDependencies)",
  },
];

const STORAGE_TELLS =
  /\b(sqlite|better-sqlite3|postgres(?:ql)?|\bpg\b|mysql|leveldb|lowdb|redis|mongodb|mongoose|knex|prisma|typeorm|sequelize)\b/i;
const FS_WRITE_TELLS =
  /\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|mkdirSync|mkdtempSync|cpSync|renameSync|truncateSync|openSync)\b|fs\.promises\.(write|append|mkdir)/;

/** Frozen allowed categories for filesystem-write tells. */
function allowedCategory(path) {
  if (/^packages\/[^/]+\/test\//.test(path)) return "test scratch (mkdtemp under tmpdir, removed)";
  if (/\.test\.ts$/.test(path)) return "test scratch (mkdtemp under tmpdir, removed)";
  if (/^tools\/verify\//.test(path)) return "verify harness (writes evidence/ + mkdtemp scratch)";
  if (/^\.eforest\/tasks\/[^/]+\/[^/]+\/evidence\//.test(path)) return "committed evidence";
  if (/^packages\/platform\/fixtures\//.test(path)) return "frozen committed fixture data";
  if (/\.md$/.test(path)) return "documentation";
  return null;
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

const lines = [
  "E2-T08 no-database sweep",
  `base=${BASE} (E2-T07 verified head)`,
  "allowed write targets: the E0-T07 stream store (via the Durable Streams server), evidence/, gitignored test scratch",
  "",
];

// Every file this task touched: committed diff plus working tree.
const changed = new Set(
  git(["diff", "--name-only", BASE, "--"]).trim().split("\n").filter(Boolean),
);
for (const path of git(["ls-files", "--others", "--exclude-standard"]).trim().split("\n")) {
  if (path) changed.add(path);
}
const files = [...changed]
  .filter(
    (path) =>
      // Dependency stores and build output are not this task's diff: the
      // lockfile-addressed pnpm store and node_modules are package caches,
      // dist/ is compiled output of the scanned sources.
      !path.startsWith(".pnpm-store/") &&
      !path.includes("node_modules/") &&
      !/(^|\/)dist\//.test(path),
  )
  .filter((path) => existsSync(resolve(root, path)))
  .sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
assert.ok(files.length > 0, "no files entered the sweep");

let violations = 0;
const usedWaivers = new Set();

// 1. New workspace dependencies, one by one.
lines.push("== new dependencies (each package.json in the diff) ==");
for (const path of files.filter((p) => p.endsWith("package.json"))) {
  const now = JSON.parse(readFileSync(resolve(root, path), "utf8"));
  let before = {};
  const shown = spawnSync("git", ["show", `${BASE}:${path}`], { cwd: root, encoding: "utf8" });
  if (shown.status === 0) before = JSON.parse(shown.stdout);
  const nowDeps = { ...(now.dependencies ?? {}), ...(now.devDependencies ?? {}) };
  const beforeDeps = { ...(before.dependencies ?? {}), ...(before.devDependencies ?? {}) };
  const beforeRuntime = before.dependencies ?? {};
  for (const name of Object.keys(nowDeps).sort()) {
    const isNew = !(name in beforeDeps);
    const promoted =
      name in (now.dependencies ?? {}) && !(name in beforeRuntime) && name in beforeDeps;
    if (!isNew && !promoted) continue;
    const tell = `new-workspace-dependency:${name}`;
    const waiver = WAIVERS.find((entry) => entry.file === path && entry.tell === tell);
    if (STORAGE_TELLS.test(name) && waiver === undefined) {
      lines.push(`FATAL ${path}: new dependency ${name} matches the storage tell list, unwaived`);
      violations += 1;
      continue;
    }
    if (waiver === undefined) {
      lines.push(`FATAL ${path}: new dependency ${name} has no committed waiver`);
      violations += 1;
      continue;
    }
    usedWaivers.add(waiver);
    lines.push(
      `waived ${path}: ${isNew ? "new" : "promoted"} dependency ${name} — ${waiver.reason}`,
    );
  }
}

// 2. Storage-engine and filesystem-write tells in every changed file.
lines.push("", "== storage & write tells in changed files ==");
for (const path of files) {
  if (path.endsWith(".jsonl") || path.endsWith(".lock") || path.includes("pnpm-lock")) continue;
  // The sweep's own output cannot stabilize if it scans itself.
  if (resolve(root, path) === evidencePath) continue;
  const text = readFileSync(resolve(root, path), "utf8");
  const hits = [];
  for (const [kind, pattern] of [
    ["storage-engine", STORAGE_TELLS],
    ["fs-write", FS_WRITE_TELLS],
  ]) {
    for (const [index, line] of text.split("\n").entries()) {
      if (pattern.test(line)) hits.push({ kind, line: index + 1, text: line.trim().slice(0, 120) });
    }
  }
  if (hits.length === 0) continue;
  const category = allowedCategory(path);
  if (category !== null) {
    lines.push(`allowed ${path}: ${hits.length} tell(s) — ${category}`);
    continue;
  }
  for (const hit of hits) {
    const tell = `${hit.kind}:${hit.line}`;
    const waiver = WAIVERS.find((entry) => entry.file === path && entry.tell === tell);
    if (waiver !== undefined) {
      usedWaivers.add(waiver);
      lines.push(`waived ${path}:${hit.line} ${hit.kind} — ${waiver.reason}`);
      continue;
    }
    lines.push(`FATAL ${path}:${hit.line} ${hit.kind} outside every allowed target: ${hit.text}`);
    violations += 1;
  }
}

for (const waiver of WAIVERS) {
  if (!usedWaivers.has(waiver)) {
    lines.push(`FATAL stale waiver (nothing matched it): ${waiver.file} ${waiver.tell}`);
    violations += 1;
  }
}

// 3. The restart proof is part of this criterion: assert the destruction
//    transcript carries the stream-store-copy door-equality lines.
lines.push("", "== restart proof cross-check ==");
const destruction = readFileSync(
  resolve(
    root,
    ".eforest/tasks/epic-2-the-gates/E2-T08-registry-derived-index/evidence/e2-t08-destruction.txt",
  ),
  "utf8",
);
assert.match(destruction, /server killed with SIGKILL/);
assert.match(destruction, /restart-on-stream-store-copy doors-identical=true/);
lines.push(
  "restart proof: kill -9 + stream-store-copy door equality recorded in e2-t08-destruction.txt (doors-identical=true)",
);

lines.push(
  "",
  `violations=${violations}`,
  violations === 0 ? "E2_T08_NO_DATABASE_OK" : "E2_T08_NO_DATABASE_FAILED",
);

const transcript = lines.join("\n") + "\n";
if (update) {
  writeFileSync(evidencePath, transcript);
  process.stdout.write(`updated ${evidencePath}\n`);
} else {
  assert.equal(readFileSync(evidencePath, "utf8"), transcript, "no-database evidence drifted");
}
process.stdout.write(transcript);
if (violations > 0) process.exit(1);
