#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const legacyBase = "defbb46f9d2ecbebae3373bffdeb816448ce3698";
const squashedBase = "0bccd2e1fd3a35ffefb589d0ef8fc585f13791aa";
const legacyRecoveryControls = [
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

function isAncestor(commit) {
  return (
    spawnSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).status === 0
  );
}

function objectExists(commit) {
  return (
    spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
      cwd: root,
      encoding: "utf8",
    }).status === 0
  );
}

// GitHub's E2-T06 PR was squash-merged. The pre-squash recovery commits remain
// useful provenance when their lineage is present, but they are not ancestors of
// the published merge commit. Attest that merge explicitly instead of treating a
// legitimate squash as a missing-history failure.
const legacyLineagePresent =
  isAncestor(legacyBase) && legacyRecoveryControls.every(([commit]) => isAncestor(commit));
const historyMode = legacyLineagePresent ? "legacy-lineage" : "squashed-merge";
// The scan scope remains the frozen pre-task base even when the branch carries
// the task through GitHub's squash merge.  This keeps later standing checks from
// silently dropping files that were reviewed before the squash.
const base = legacyBase;
const recoveryControls = legacyRecoveryControls;

if (historyMode === "legacy-lineage") {
  assert.equal(git(["merge-base", "--is-ancestor", base, "HEAD"]), "");
} else {
  assert.ok(objectExists(base), `missing frozen E2-T06 scan base ${base}`);
}
if (historyMode === "squashed-merge") {
  assert.ok(isAncestor(squashedBase), `squashed E2-T06 merge ${squashedBase} is not in HEAD`);
  assert.equal(
    git(["show", "-s", "--format=%s", squashedBase]).trim(),
    "E2-T06: durable stream namespaces (#32)",
  );
  const squashedPaths = git(["diff-tree", "--no-commit-id", "--name-only", "-r", squashedBase])
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const path of recoveryControlPaths) {
    assert.ok(squashedPaths.includes(path), `squashed E2-T06 merge omitted recovery path ${path}`);
  }
}
for (const [commit, parent] of recoveryControls) {
  if (historyMode === "legacy-lineage") {
    assert.equal(git(["merge-base", "--is-ancestor", commit, "HEAD"]), "");
  } else {
    assert.ok(objectExists(commit), `missing recovery provenance object ${commit}`);
  }
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
      (/\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|openSync|writeSync|renameSync|truncateSync|copyFileSync|cpSync|mkdirSync|mkdtempSync|rmSync|rmdirSync|unlinkSync|symlinkSync|linkSync|chmodSync|chownSync|utimesSync)\b/.test(
        line,
      ) ||
        /\bfs\.promises\.\w+|\bgetBuiltinModule\b/.test(line)),
  ],
  [
    "mutable-map",
    (line, path) =>
      storageSourcePath(path) &&
      /\bnew\s+(?:Map|Set|WeakMap|WeakSet)\b|\bObject\.create\s*\(/.test(line),
  ],
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

// ---------------------------------------------------------------------------
// Structural module-scope scan over every production platform source file.
//
// This is fail-closed by construction, not an enumeration of suspicious
// spellings: a module-scope binding is acceptable only when its initializer is
// in the closed immutable whitelist below (primitive literals, functions,
// aliases of existing bindings, and recursively frozen literals). let/var
// bindings, class statics, any other initializer shape (calls, literals,
// factories, Array.from, Object.create, deferred assignment…), and any
// module-scope executable statement are storage tells that must either be
// removed or carry a committed exact disposition in the allowlist. Historical entries
// remain line-anchored; evolving verifier files may instead use a path/rule/content
// fingerprint over the matched line and its immediate neighbors.
// Capability escape is closed at the import: importing any Node module that
// can reach persistence or code execution (fs in every spelling, child
// processes, vm, sqlite, sockets…) is a tell regardless of how members are
// later reached (aliases, destructuring, Reflect.get, computed access), as is
// any dynamic import() or require() in production source.
//
// SCOPE — this guarantee covers MODULE-scope state and capability imports
// only. Instance- and function-scope fields on process-lifetime objects are
// deliberately not flagged (a per-dispatcher promise chain is legitimate
// coordination), so an authoritative decision relocated into instance state
// cannot be caught by this scan. That escape class is guarded behaviorally
// instead: packages/platform/test/ns.test.ts decides duplicate-name refusal
// through a SECOND dispatcher over the same durable store, and
// tools/verify/e2_t06_sensitivity.sh keeps the exact judge-round-9 instance
// side-table sabotage as a permanent expected-red case against that test.
// ---------------------------------------------------------------------------
const CAPABILITY_MODULES = new Set([
  "child_process",
  "cluster",
  "dgram",
  "dns",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "inspector/promises",
  "module",
  "net",
  "os",
  "repl",
  "sqlite",
  "tls",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
]);

function capabilityModule(specifier) {
  const bare = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  return CAPABILITY_MODULES.has(bare);
}

function unwrapExpression(node) {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function isObjectFreezeCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Object" &&
    node.expression.name.text === "freeze" &&
    node.arguments.length === 1
  );
}

function isImmutableInitializer(initializer) {
  if (initializer === undefined) return false;
  const node = unwrapExpression(initializer);
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateExpression(node) ||
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    ts.isRegularExpressionLiteral(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  // Aliases reference an existing binding; a mutable container is flagged
  // where it is created, so the alias itself introduces no new storage.
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) return true;
  if (ts.isPrefixUnaryExpression(node)) return isImmutableInitializer(node.operand);
  if (ts.isConditionalExpression(node)) {
    return isImmutableInitializer(node.whenTrue) && isImmutableInitializer(node.whenFalse);
  }
  if (
    ts.isBinaryExpression(node) &&
    [
      ts.SyntaxKind.QuestionQuestionToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.AmpersandAmpersandToken,
    ].includes(node.operatorToken.kind)
  ) {
    return isImmutableInitializer(node.left) && isImmutableInitializer(node.right);
  }
  if (isObjectFreezeCall(node)) {
    const argument = unwrapExpression(node.arguments[0]);
    if (ts.isObjectLiteralExpression(argument)) {
      return argument.properties.every(
        (property) =>
          (ts.isPropertyAssignment(property) && isImmutableInitializer(property.initializer)) ||
          ts.isShorthandPropertyAssignment(property) ||
          ts.isMethodDeclaration(property),
      );
    }
    if (ts.isArrayLiteralExpression(argument)) {
      return argument.elements.every((element) => isImmutableInitializer(element));
    }
    return false;
  }
  return false;
}

function structuralFindings(path, text) {
  const findings = [];
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const flag = (node, rule) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    findings.push(`${path}:${line}:${rule}`);
  };
  const checkClassStatics = (declaration) => {
    for (const member of declaration.members) {
      if (ts.isClassStaticBlockDeclaration(member)) {
        flag(member, "class-static-state");
        continue;
      }
      if (
        ts.isPropertyDeclaration(member) &&
        (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) !== 0 &&
        member.initializer !== undefined &&
        !isImmutableInitializer(member.initializer)
      ) {
        flag(member, "class-static-state");
      }
    }
  };
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      // Type-only imports are erased at compile time and grant no runtime
      // capability; every value import of a capability module is a tell.
      const typeOnly =
        statement.importClause !== undefined &&
        (statement.importClause.isTypeOnly ||
          (statement.importClause.name === undefined &&
            statement.importClause.namedBindings !== undefined &&
            ts.isNamedImports(statement.importClause.namedBindings) &&
            statement.importClause.namedBindings.elements.length > 0 &&
            statement.importClause.namedBindings.elements.every((element) => element.isTypeOnly)));
      if (
        !typeOnly &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        capabilityModule(statement.moduleSpecifier.text)
      ) {
        flag(statement, "capability-import");
      }
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (
        !statement.isTypeOnly &&
        statement.moduleSpecifier !== undefined &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        capabilityModule(statement.moduleSpecifier.text)
      ) {
        flag(statement, "capability-import");
      }
      continue;
    }
    if (ts.isImportEqualsDeclaration(statement)) {
      flag(statement, "capability-import");
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const declaration of statement.declarationList.declarations) {
        if (!isConst) {
          flag(declaration, "module-scope-mutable-binding");
          continue;
        }
        if (declaration.initializer === undefined) continue;
        const initializer = unwrapExpression(declaration.initializer);
        if (ts.isClassExpression(initializer)) {
          checkClassStatics(initializer);
          continue;
        }
        if (!isImmutableInitializer(declaration.initializer)) {
          flag(declaration, "module-scope-state");
        }
      }
      continue;
    }
    if (ts.isClassDeclaration(statement)) {
      checkClassStatics(statement);
      continue;
    }
    if (ts.isEnumDeclaration(statement)) {
      if ((ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Const) === 0) {
        flag(statement, "module-scope-state");
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      if (!isImmutableInitializer(statement.expression)) flag(statement, "module-scope-state");
      continue;
    }
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      continue;
    }
    // Anything else executing at module scope (expression statements,
    // assignments, loops, conditionals, try/catch, top-level await…) can
    // populate storage that outlives a request. Fail closed.
    flag(statement, "module-scope-execution");
  }
  const visitEverywhere = (node) => {
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        flag(node, "dynamic-import");
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        flag(node, "require-call");
      }
    }
    ts.forEachChild(node, visitEverywhere);
  };
  visitEverywhere(source);
  return findings;
}

for (const path of paths) {
  if (!path.startsWith("packages/platform/src/") || !path.endsWith(".ts")) continue;
  let text;
  try {
    text = readFileSync(resolve(root, path), "utf8");
  } catch {
    continue;
  }
  for (const finding of structuralFindings(path, text)) candidates.add(finding);
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
const pathPrefixEntries = allowlist.filter((entry) => entry.startsWith("path-prefix:"));
const pathPrefixes = pathPrefixEntries.map((entry) => entry.slice("path-prefix:".length));
const candidatePath = (entry) => entry.match(/^(.*?):[0-9]+:[^:]+$/)?.[1] ?? entry;
const allowedByPathPrefix = (entry) =>
  pathPrefixes.some((prefix) => candidatePath(entry).startsWith(prefix));
const fingerprintEntries = allowlist.filter((entry) => entry.startsWith("fingerprint:"));
const fingerprintMatches = fingerprintEntries.map((entry) => {
  const matches = sortedCandidates.filter(
    (candidate) => fingerprintForCandidate(candidate) === entry,
  );
  assert.ok(matches.length <= 1, `ambiguous no-database fingerprint: ${entry}`);
  return [entry, matches[0]];
});
const allowedByFingerprint = fingerprintMatches
  .map(([, candidate]) => candidate)
  .filter((candidate) => candidate !== undefined);
const stale = allowlist.filter((entry) =>
    entry.startsWith("path-prefix:")
    ? !sortedCandidates.some((candidate) => allowedByPathPrefix(candidate))
    : entry.startsWith("fingerprint:")
    ? !fingerprintMatches.some(([fingerprint, candidate]) => fingerprint === entry && candidate)
    : allowedByPathPrefix(entry)
      ? false
      : !candidateSet.has(entry),
);
const unallowed = sortedCandidates.filter(
  (entry) =>
    !allowSet.has(entry) && !allowedByFingerprint.includes(entry) && !allowedByPathPrefix(entry),
);

const lines = [
  "E2-T06 no-database proof",
  `base=${base}`,
  `history-mode=${historyMode}`,
  `files-scanned=${paths.length}`,
  `runtime-boundary-files=${boundaryPaths.length}`,
  `namespace-source-files=${namespaceSourcePaths.length}`,
  `patterns=${rules.map(([name]) => name).join(",")}`,
  `structural-rules=${[
    "module-scope-mutable-binding",
    "module-scope-state",
    "class-static-state",
    "module-scope-execution",
    "capability-import",
    "dynamic-import",
    "require-call",
  ].join(",")}`,
  `structural-files=${paths.filter((path) => path.startsWith("packages/platform/src/") && path.endsWith(".ts")).length}`,
  ...sortedCandidates.map(
    (candidate) =>
      `${allowSet.has(candidate) || allowedByFingerprint.includes(candidate) || allowedByPathPrefix(candidate) ? "ALLOW" : "UNALLOWLISTED"} ${candidate}`,
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

function fingerprintForCandidate(candidate) {
  const match = /^(.+):([0-9]+):([^:]+)$/.exec(candidate);
  if (match === null) return undefined;
  const [, path, lineText, rule] = match;
  const sourceLines = readFileSync(resolve(root, path), "utf8").split("\n");
  const line = Number(lineText) - 1;
  assert.ok(line >= 0 && line < sourceLines.length, `candidate line outside source: ${candidate}`);
  const context = sourceLines.slice(Math.max(0, line - 1), line + 2);
  const digest = createHash("sha256").update(JSON.stringify({ path, rule, context })).digest("hex");
  return `fingerprint:${path}:${rule}:${digest}`;
}
