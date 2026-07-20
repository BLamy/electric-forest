#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const base = "defbb46f9d2ecbebae3373bffdeb816448ce3698";
const recoveryControlCommit = "211384e6a81180fe2a7703b84483871fec766832";
const recoveryControlParent = "f1f21df7ad71bb1978ef0dd12081ddc425368e3c";
const secondRecoveryControlCommit = "6c925ef0aeee4edcb89beb27521acda3ca60a635";
const secondRecoveryControlParent = "441e8372e12aad69a68540cfb0e83be3fdfec114";
const recoveryControlPaths = [
  ".claude/workflows/work-queue.js",
  ".eforest/loop.md",
  "AGENTS.md",
  "packages/identity/scripts/verify-work-queue-policy.mjs",
  "packages/identity/scripts/work-queue-snapshot-lib.mjs",
  "packages/identity/scripts/work-queue-snapshot.mjs",
].sort();
const task = ".eforest/tasks/epic-2-the-gates/E2-T06-stream-namespaces";
const allowlistPath = resolve(root, task, "evidence/e2-t06-no-database-allowlist.txt");
const evidencePath = resolve(root, task, "evidence/e2-t06-no-database.txt");
const update = process.argv.includes("--update-evidence");
const checkOnly = process.argv.includes("--check-only");
assert.deepEqual(
  process.argv
    .slice(2)
    .filter((argument) => !["--update-evidence", "--check-only"].includes(argument)),
  [],
  "usage: node tools/verify/e2_t06_no_database.mjs [--update-evidence|--check-only]",
);
assert.ok(!(update && checkOnly), "--update-evidence and --check-only are mutually exclusive");

function git(args, options = {}) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", ...options });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stdout}${result.stderr}`);
  return result.stdout;
}

assert.equal(git(["merge-base", "--is-ancestor", base, "HEAD"]), "");
assert.equal(git(["merge-base", "--is-ancestor", recoveryControlCommit, "HEAD"]), "");
assert.equal(git(["rev-parse", `${recoveryControlCommit}^`]).trim(), recoveryControlParent);
assert.deepEqual(
  git(["diff-tree", "--no-commit-id", "--name-only", "-r", recoveryControlCommit])
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort(),
  recoveryControlPaths,
  "authorized recovery control commit escaped its exact path set",
);
assert.equal(git(["merge-base", "--is-ancestor", secondRecoveryControlCommit, "HEAD"]), "");
assert.equal(
  git(["rev-parse", `${secondRecoveryControlCommit}^`]).trim(),
  secondRecoveryControlParent,
);
assert.deepEqual(
  git(["diff-tree", "--no-commit-id", "--name-only", "-r", secondRecoveryControlCommit])
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort(),
  recoveryControlPaths,
  "second authorized recovery control commit escaped its exact path set",
);
const changed = git(["diff", "--name-only", base, "--"])
  .trim()
  .split("\n")
  .filter((path) => path.length > 0 && !recoveryControlPaths.includes(path));
const untracked = git(["ls-files", "--others", "--exclude-standard"])
  .trim()
  .split("\n")
  .filter(Boolean);
const platformFiles = git(["ls-files", "packages/platform"]).trim().split("\n").filter(Boolean);
for (const path of untracked) if (path.startsWith("packages/platform/")) platformFiles.push(path);

const paths = [...new Set([...changed, ...untracked, ...platformFiles])]
  .filter((path) => {
    const absolute = resolve(root, path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) return false;
    return ![".zip", ".png", ".mp4", ".webm"].includes(extname(path));
  })
  .sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
assert.ok(paths.length > 0, "no files entered the no-database sweep");

const rules = [
  [
    "database-package",
    /\b(?:better-sqlite3|sqlite|postgres(?:ql)?|mysql|redis|lowdb|leveldb|typeorm|prisma|drizzle|knex)\b/i,
  ],
  [
    "filesystem-write",
    /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|openSync|writeSync|renameSync|truncateSync)\b|\bfs\.promises\.open\b/,
  ],
  ["mutable-map", /\bnew\s+Map\s*</],
  [
    "mutable-object",
    /^(?:export\s+)?const\s+\w*(?:State|Store|Cache|Table|Registry|Index)\w*\s*(?::[^=]+)?=\s*\{/,
  ],
];
assert.ok(rules.length >= 4, "storage-tell pattern list must not be empty or weakened");

const candidates = [];
for (const path of paths) {
  let text;
  try {
    text = readFileSync(resolve(root, path), "utf8");
  } catch {
    continue;
  }
  for (const [index, line] of text.split("\n").entries()) {
    for (const [rule, pattern] of rules) {
      if (pattern.test(line)) candidates.push(`${path}:${index + 1}:${rule}`);
    }
  }
}

function packageJsonAt(ref, path) {
  const result = spawnSync("git", ["show", `${ref}:${path}`], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return JSON.parse(result.stdout);
}
function dependencyNames(value) {
  if (value === undefined) return [];
  return Object.keys({
    ...value.dependencies,
    ...value.devDependencies,
    ...value.optionalDependencies,
  });
}
for (const path of ["package.json", "packages/platform/package.json"]) {
  const before = new Set(dependencyNames(packageJsonAt(base, path)));
  const after = dependencyNames(JSON.parse(readFileSync(resolve(root, path), "utf8")));
  for (const name of after) if (!before.has(name)) candidates.push(`dependency:${name}`);
}
candidates.sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));

const allowlist = readFileSync(allowlistPath, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"));
assert.equal(new Set(allowlist).size, allowlist.length, "duplicate no-database allowlist entry");
const candidateSet = new Set(candidates);
const allowSet = new Set(allowlist);
const stale = allowlist.filter((entry) => !candidateSet.has(entry));
const unallowed = candidates.filter((entry) => !allowSet.has(entry));

const lines = [
  "E2-T06 no-database sweep",
  `base=${base}`,
  `files-scanned=${paths.length}`,
  `patterns=${rules.map(([name]) => name).join(",")}`,
  ...candidates.map(
    (candidate) => `${allowSet.has(candidate) ? "ALLOW" : "UNALLOWLISTED"} ${candidate}`,
  ),
  ...stale.map((entry) => `STALE ${entry}`),
  `unallowlisted=${unallowed.length}`,
  `stale=${stale.length}`,
  ...(unallowed.length === 0 && stale.length === 0 ? ["E2_T06_NO_DATABASE_OK"] : []),
  "",
];
const transcript = lines.join("\n");
process.stdout.write(transcript);
assert.equal(unallowed.length, 0, `unallowlisted storage tells:\n${unallowed.join("\n")}`);
assert.equal(stale.length, 0, `stale no-database allowlist entries:\n${stale.join("\n")}`);
if (!checkOnly) {
  if (update) writeFileSync(evidencePath, transcript);
  else assert.equal(readFileSync(evidencePath, "utf8"), transcript, "no-database evidence drifted");
}
