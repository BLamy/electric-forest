#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const base = "defbb46f9d2ecbebae3373bffdeb816448ce3698";
const recoveryControls = [
  ["211384e6a81180fe2a7703b84483871fec766832", "f1f21df7ad71bb1978ef0dd12081ddc425368e3c"],
  ["6c925ef0aeee4edcb89beb27521acda3ca60a635", "441e8372e12aad69a68540cfb0e83be3fdfec114"],
  ["43527237d6863b43fc6435be679041873f6a3a7e", "f1e72dd0f40089fc1a2d62bec715ca6405e36386"],
  ["ada6e94339ea3c59cc5138e2b299f5f4c32ffd8d", "2b2ab56a8f8b7103eb9625d0e2c96967b5215649"],
];
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
const manifestPath = resolve(root, task, "evidence/e2-t06-runtime-boundary.sha256");
const boundaryPaths = [
  "packages/platform/src/auth/grants.ts",
  "packages/platform/src/gateway.ts",
  "packages/platform/src/namespace-digest.ts",
  "packages/platform/src/namespace-runtime.ts",
  "packages/platform/src/namespace-worker.ts",
  "packages/platform/src/ns/dispatch.ts",
  "packages/platform/src/ns/events.ts",
  "packages/platform/src/ns/reducer.ts",
  "packages/platform/src/ns/resolve.ts",
  "packages/platform/src/production.ts",
  "tools/verify/e2_t06_runtime_boundary.mjs",
  "tools/verify/e2_t06_runtime_boundary_sensitivity.mjs",
].sort();
const namespaceSourcePaths = [
  "packages/platform/src/ns/dispatch.ts",
  "packages/platform/src/ns/events.ts",
  "packages/platform/src/ns/reducer.ts",
  "packages/platform/src/ns/resolve.ts",
];
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
for (const [commit, parent] of recoveryControls) {
  assert.equal(git(["merge-base", "--is-ancestor", commit, "HEAD"]), "");
  assert.equal(git(["rev-parse", `${commit}^`]).trim(), parent);
  assert.deepEqual(
    git(["diff-tree", "--no-commit-id", "--name-only", "-r", commit])
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort(),
    recoveryControlPaths,
    `authorized recovery control commit ${commit} escaped its exact path set`,
  );
}

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

const actualNamespaceSources = [...new Set([...platformFiles, ...untracked])]
  .filter((path) => path.startsWith("packages/platform/src/ns/"))
  .sort();
assert.deepEqual(
  actualNamespaceSources,
  namespaceSourcePaths,
  "isolated namespace source topology changed without a new reviewed runtime boundary",
);

const manifest = readFileSync(manifestPath, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    assert.ok(match, `malformed runtime-boundary manifest line: ${line}`);
    return { digest: match[1], path: match[2] };
  });
assert.deepEqual(
  manifest.map(({ path }) => path).sort(),
  boundaryPaths,
  "runtime-boundary manifest paths drifted",
);
for (const entry of manifest) {
  const digest = createHash("sha256")
    .update(readFileSync(resolve(root, entry.path)))
    .digest("hex");
  assert.equal(digest, entry.digest, `runtime-boundary content drifted: ${entry.path}`);
}

const storageSourcePath = (path) => /(?:^Makefile$|\.(?:[cm]?[jt]sx?|json|sh|ya?ml)$)/.test(path);
const rules = [
  [
    "database-package",
    (line, path) =>
      storageSourcePath(path) &&
      /\b(?:better-sqlite3|sqlite|postgres(?:ql)?|mysql|redis|lowdb|leveldb|typeorm|prisma|drizzle|knex)\b/i.test(
        line,
      ),
  ],
  [
    "filesystem-write",
    (line, path) =>
      storageSourcePath(path) &&
      /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|openSync|writeSync|renameSync|truncateSync)\b|\bfs\.promises\.open\b/.test(
        line,
      ),
  ],
  ["mutable-map", (line, path) => storageSourcePath(path) && /\bnew\s+Map\s*</.test(line)],
];
const candidates = new Set();
for (const path of paths) {
  let text;
  try {
    text = readFileSync(resolve(root, path), "utf8");
  } catch {
    continue;
  }
  for (const [index, line] of text.split("\n").entries()) {
    for (const [rule, matches] of rules) {
      if (matches(line, path)) candidates.add(`${path}:${index + 1}:${rule}`);
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
  for (const name of after) if (!before.has(name)) candidates.add(`dependency:${name}`);
}

const sortedCandidates = [...candidates].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
const allowlist = readFileSync(allowlistPath, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"));
assert.equal(new Set(allowlist).size, allowlist.length, "duplicate no-database allowlist entry");
const candidateSet = new Set(sortedCandidates);
const allowSet = new Set(allowlist);
const stale = allowlist.filter((entry) => !candidateSet.has(entry));
const unallowed = sortedCandidates.filter((entry) => !allowSet.has(entry));

const lines = [
  "E2-T06 no-database proof",
  `base=${base}`,
  `files-scanned=${paths.length}`,
  `runtime-boundary-files=${boundaryPaths.length}`,
  `namespace-source-files=${namespaceSourcePaths.length}`,
  `patterns=${rules.map(([name]) => name).join(",")}`,
  ...sortedCandidates.map(
    (candidate) => `${allowSet.has(candidate) ? "ALLOW" : "UNALLOWLISTED"} ${candidate}`,
  ),
  ...stale.map((entry) => `STALE ${entry}`),
  `unallowlisted=${unallowed.length}`,
  `stale=${stale.length}`,
  ...(unallowed.length === 0 && stale.length === 0
    ? ["E2_T06_RUNTIME_BOUNDARY_ATTESTED", "E2_T06_NO_DATABASE_OK"]
    : []),
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
