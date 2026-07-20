#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

const existingFilesystemWrite =
  /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|openSync|writeSync|renameSync|truncateSync)\b|\bfs\.promises\.open\b/;
const productionFilesystemMutation =
  /(?<!\.)\b(?:chmod|chmodSync|chown|chownSync|copyFile|copyFileSync|cp|cpSync|fchmod|fchmodSync|fchown|fchownSync|fdatasync|fdatasyncSync|ftruncate|ftruncateSync|futimes|futimesSync|lchmod|lchmodSync|lchown|lchownSync|link|linkSync|lutimes|lutimesSync|mkdir|mkdirSync|mkdtemp|mkdtempSync|open|rename|rm|rmSync|rmdir|rmdirSync|symlink|symlinkSync|truncate|unlink|unlinkSync|utimes|utimesSync|write)\s*\(|\bfs\.promises\.(?:appendFile|chmod|chown|copyFile|cp|lchmod|lchown|link|lutimes|mkdir|mkdtemp|open|rename|rm|rmdir|symlink|truncate|unlink|utimes|writeFile)\s*\(/;
const filesystemMutators = new Set([
  "appendFile",
  "appendFileSync",
  "chmod",
  "chmodSync",
  "chown",
  "chownSync",
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "createWriteStream",
  "fchmod",
  "fchmodSync",
  "fchown",
  "fchownSync",
  "fdatasync",
  "fdatasyncSync",
  "ftruncate",
  "ftruncateSync",
  "futimes",
  "futimesSync",
  "lchmod",
  "lchmodSync",
  "lchown",
  "lchownSync",
  "link",
  "linkSync",
  "lutimes",
  "lutimesSync",
  "mkdir",
  "mkdirSync",
  "mkdtemp",
  "mkdtempSync",
  "open",
  "openSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "symlink",
  "symlinkSync",
  "truncate",
  "truncateSync",
  "unlink",
  "unlinkSync",
  "utimes",
  "utimesSync",
  "write",
  "writeFile",
  "writeFileSync",
  "writeSync",
]);
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
      (existingFilesystemWrite.test(line) ||
        (path.startsWith("packages/platform/src/") && productionFilesystemMutation.test(line))),
  ],
  ["mutable-map", (line, path) => storageSourcePath(path) && /\bnew\s+Map\s*</.test(line)],
];
const patternNames = [...rules.map(([name]) => name), "mutable-object"];
assert.ok(patternNames.length >= 4, "storage-tell pattern list must not be empty or weakened");

const candidates = new Set();
const addCandidate = (path, line, rule) => candidates.add(`${path}:${line}:${rule}`);

function mutableInitializer(initializer) {
  if (initializer === undefined) return false;
  if (
    ts.isParenthesizedExpression(initializer) ||
    ts.isAsExpression(initializer) ||
    ts.isTypeAssertionExpression(initializer) ||
    ts.isSatisfiesExpression(initializer) ||
    ts.isNonNullExpression(initializer)
  ) {
    return mutableInitializer(initializer.expression);
  }
  if (ts.isObjectLiteralExpression(initializer) || ts.isArrayLiteralExpression(initializer)) {
    return true;
  }
  if (
    ts.isCallExpression(initializer) &&
    ts.isPropertyAccessExpression(initializer.expression) &&
    ts.isIdentifier(initializer.expression.expression) &&
    initializer.expression.expression.text === "Object" &&
    initializer.expression.name.text === "create"
  ) {
    return true;
  }
  return (
    ts.isNewExpression(initializer) &&
    ts.isIdentifier(initializer.expression) &&
    ["Array", "Map", "Set", "WeakMap", "WeakSet"].includes(initializer.expression.text)
  );
}

function addProductionAstCandidates(path, text) {
  if (!path.startsWith("packages/platform/src/") || !/\.[cm]?[jt]sx?$/.test(path)) return;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const namespaceBindings = new Set();
  const namedMutators = new Set();

  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (mutableInitializer(declaration.initializer)) {
          addCandidate(
            path,
            source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1,
            "mutable-object",
          );
        }
      }
    }
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      ["node:fs", "node:fs/promises", "fs", "fs/promises"].includes(statement.moduleSpecifier.text)
    ) {
      const clause = statement.importClause;
      if (clause?.name) namespaceBindings.add(clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        namespaceBindings.add(clause.namedBindings.name.text);
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (imported === "promises") namespaceBindings.add(element.name.text);
          if (filesystemMutators.has(imported)) namedMutators.add(element.name.text);
        }
      }
    }
  }

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      let mutation = ts.isIdentifier(expression) && namedMutators.has(expression.text);
      if (ts.isPropertyAccessExpression(expression)) {
        const owner = expression.expression;
        mutation ||=
          filesystemMutators.has(expression.name.text) &&
          ((ts.isIdentifier(owner) && namespaceBindings.has(owner.text)) ||
            (ts.isPropertyAccessExpression(owner) &&
              owner.name.text === "promises" &&
              ts.isIdentifier(owner.expression) &&
              namespaceBindings.has(owner.expression.text)));
      }
      if (mutation) {
        addCandidate(
          path,
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          "filesystem-write",
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

for (const path of paths) {
  let text;
  try {
    text = readFileSync(resolve(root, path), "utf8");
  } catch {
    continue;
  }
  addProductionAstCandidates(path, text);
  for (const [index, line] of text.split("\n").entries()) {
    for (const [rule, matches] of rules) {
      if (typeof matches === "function" ? matches(line, path) : matches.test(line)) {
        addCandidate(path, index + 1, rule);
      }
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
  "E2-T06 no-database sweep",
  `base=${base}`,
  `files-scanned=${paths.length}`,
  `patterns=${patternNames.join(",")}`,
  ...sortedCandidates.map(
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
