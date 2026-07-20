#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

// These broad text tells remain a secondary audit over the entire task diff. The
// namespace proof below does not depend on recognizing storage API spellings.
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
const patternNames = [
  ...rules.map(([name]) => name),
  "namespace-module-state",
  "namespace-runtime-import",
  "namespace-ambient-capability",
  "namespace-top-level-effect",
  "namespace-source-shape",
];
const candidates = new Set();
const addCandidate = (path, line, rule) => candidates.add(`${path}:${line}:${rule}`);

for (const path of paths) {
  if (path.startsWith("packages/platform/src/ns/") && extname(path) !== ".ts") {
    addCandidate(path, 1, "namespace-source-shape");
  }
}

for (const path of paths) {
  let text;
  try {
    text = readFileSync(resolve(root, path), "utf8");
  } catch {
    continue;
  }
  for (const [index, line] of text.split("\n").entries()) {
    for (const [rule, matches] of rules) {
      if (matches(line, path)) addCandidate(path, index + 1, rule);
    }
  }
}

const configPath = resolve(root, "packages/platform/tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
assert.equal(config.error, undefined, "platform tsconfig must parse");
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const approvedRuntimeImports = new Set([
  "@eforest/client",
  "@eforest/protocol",
  "@eforest/protocol/offset-allocation",
]);
const approvedAmbientRuntime = new Set([
  "Array",
  "Error",
  "Object",
  "Promise",
  "Reflect",
  "TypeError",
]);
const approvedAmbientMembers = new Map([
  ["Array", new Set(["isArray"])],
  ["Object", new Set(["entries", "freeze", "hasOwn", "keys"])],
  ["Promise", new Set(["all"])],
  ["Reflect", new Set(["ownKeys"])],
]);
const metaObjectMembers = new Set(["__proto__", "constructor", "prototype"]);

function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function isReferenceRoot(identifier) {
  const parent = identifier.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return false;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isTypeParameterDeclaration(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isExportSpecifier(parent)) &&
    parent.name === identifier
  ) {
    return false;
  }
  if (ts.isBindingElement(parent) && parent.name === identifier) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === identifier) return false;
  for (
    let cursor = parent;
    cursor && cursor !== identifier.getSourceFile();
    cursor = cursor.parent
  ) {
    if (ts.isTypeNode(cursor)) return false;
    if (ts.isExpression(cursor) || ts.isStatement(cursor)) break;
  }
  return true;
}

function ambientValueSymbol(identifier) {
  const symbol = checker.getSymbolAtLocation(identifier);
  const ambient = symbol
    ?.getDeclarations()
    ?.some((declaration) => declaration.getSourceFile().isDeclarationFile);
  return ambient && (symbol.flags & ts.SymbolFlags.Value) !== 0 ? symbol : undefined;
}

function assignedRoot(expression) {
  let current = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current : undefined;
}

function localNamespaceModule(source, specifier) {
  if (!specifier.startsWith("./") || specifier.split("/").includes("..")) return false;
  const sourceSpecifier = specifier.endsWith(".js") ? `${specifier.slice(0, -3)}.ts` : specifier;
  const target = resolve(dirname(source.fileName), sourceSpecifier);
  return target.startsWith(resolve(root, "packages/platform/src/ns/")) && existsSync(target);
}

for (const source of program.getSourceFiles()) {
  const path = source.fileName.startsWith(`${root}/`) ? source.fileName.slice(root.length + 1) : "";
  if (!path.startsWith("packages/platform/src/ns/") || !path.endsWith(".ts")) continue;

  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      addCandidate(path, lineOf(source, statement), "namespace-module-state");
    }
    if (
      ts.isExpressionStatement(statement) ||
      ts.isExportAssignment(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      addCandidate(path, lineOf(source, statement), "namespace-top-level-effect");
    }
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const typeOnly = statement.importClause?.isTypeOnly === true;
      const local = localNamespaceModule(source, specifier);
      if (!typeOnly && !local && !approvedRuntimeImports.has(specifier)) {
        addCandidate(path, lineOf(source, statement), "namespace-runtime-import");
      }
    }
    if (ts.isExportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const local = localNamespaceModule(source, specifier);
      if (!statement.isTypeOnly && !local && !approvedRuntimeImports.has(specifier)) {
        addCandidate(path, lineOf(source, statement), "namespace-runtime-import");
      }
    }
    if (ts.isImportEqualsDeclaration(statement)) {
      addCandidate(path, lineOf(source, statement), "namespace-runtime-import");
    }
  }

  const visit = (node) => {
    if (
      (ts.isPropertyDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isClassStaticBlockDeclaration(node)) &&
      (ts.isClassStaticBlockDeclaration(node) ||
        node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword))
    ) {
      addCandidate(path, lineOf(source, node), "namespace-module-state");
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      addCandidate(path, lineOf(source, node), "namespace-runtime-import");
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (metaObjectMembers.has(node.name.text)) {
        addCandidate(path, lineOf(source, node), "namespace-ambient-capability");
      }
      if (ts.isIdentifier(node.expression) && ambientValueSymbol(node.expression)) {
        const allowed = approvedAmbientMembers.get(node.expression.text);
        if (!allowed?.has(node.name.text)) {
          addCandidate(path, lineOf(source, node), "namespace-ambient-capability");
        }
      }
    }
    if (
      ts.isElementAccessExpression(node) &&
      ((ts.isStringLiteralLike(node.argumentExpression) &&
        metaObjectMembers.has(node.argumentExpression.text)) ||
        (ts.isIdentifier(node.expression) && ambientValueSymbol(node.expression)))
    ) {
      addCandidate(path, lineOf(source, node), "namespace-ambient-capability");
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const rootIdentifier = assignedRoot(node.left);
      const declaration =
        rootIdentifier && checker.getSymbolAtLocation(rootIdentifier)?.valueDeclaration;
      if (
        declaration &&
        (declaration.getSourceFile() === source ||
          ts.isImportClause(declaration) ||
          ts.isImportSpecifier(declaration) ||
          ts.isNamespaceImport(declaration)) &&
        !ts.isVariableDeclaration(declaration) &&
        !ts.isParameter(declaration)
      ) {
        addCandidate(path, lineOf(source, node), "namespace-module-state");
      }
    }
    if (ts.isIdentifier(node) && isReferenceRoot(node)) {
      if (ambientValueSymbol(node) && !approvedAmbientRuntime.has(node.text)) {
        addCandidate(path, lineOf(source, node), "namespace-ambient-capability");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
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
