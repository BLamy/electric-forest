import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scopeBase = "4b70c57b5f1d21ac7a914c18faae11dee12d777c";
const evidenceRoot = ".eforest/tasks/epic-1-the-trunk/E1-T11-the-first-repo/evidence";
const provenancePath = `${evidenceRoot}/transport-provenance.json`;
const manifestPath = `${evidenceRoot}/evidence-manifest.json`;
const expectedChangedInputs = [
  "Makefile",
  "package.json",
  "packages/cli/package.json",
  "packages/cli/dist/src/bin.js",
  "packages/cli/dist/src/bin.js.map",
  "packages/cli/dist/src/cli.d.ts.map",
  "packages/cli/dist/src/cli.js",
  "packages/cli/dist/src/cli.js.map",
  "packages/cli/dist/src/index.d.ts",
  "packages/cli/dist/src/index.d.ts.map",
  "packages/cli/dist/src/index.js",
  "packages/cli/dist/src/index.js.map",
  // E3/E4 standing re-pins: the executed CLI and protocol/StreamFS runtime
  // changed after the original E2 refresh and remain inside E1's closure.
  "packages/cli/dist/src/materialize-command.d.ts",
  "packages/cli/dist/src/materialize-command.d.ts.map",
  "packages/cli/dist/src/materialize-command.js",
  "packages/cli/dist/src/materialize-command.js.map",
  // E5-T01 extends custom replay reducers with explicit stream-aware
  // initialization. Keep the source, its direct regression test, and the
  // executed worker bytes inside the exact provenance refresh boundary.
  "packages/cli/dist/src/reducer-worker.js",
  "packages/cli/dist/src/reducer-worker.js.map",
  "packages/cli/dist/src/replay-command.d.ts",
  "packages/cli/dist/src/replay-command.d.ts.map",
  "packages/cli/dist/src/replay-command.js",
  "packages/cli/dist/src/replay-command.js.map",
  "packages/cli/dist/tsconfig.build.tsbuildinfo",
  "packages/cli/src/bin.ts",
  "packages/cli/src/cli.test.ts",
  "packages/cli/src/cli.ts",
  "packages/cli/src/index.ts",
  "packages/cli/src/materialize-command.ts",
  // E5-T02 standing-gate repair: this process-level transport integration
  // inherits the repository's 120-second contended-host timeout.
  "packages/cli/src/official.integration.test.ts",
  "packages/cli/src/reducer-worker.ts",
  "packages/cli/src/replay-command.ts",
  "packages/client/dist/src/durable.d.ts",
  "packages/client/dist/src/durable.d.ts.map",
  "packages/client/dist/src/durable.js",
  "packages/client/dist/src/durable.js.map",
  "packages/client/dist/src/index.d.ts",
  "packages/client/dist/src/index.d.ts.map",
  "packages/client/dist/src/index.js",
  "packages/client/dist/src/index.js.map",
  "packages/client/dist/tsconfig.build.tsbuildinfo",
  "packages/client/src/durable.ts",
  "packages/client/src/index.ts",
  "packages/protocol/dist/src/digest.d.ts",
  "packages/protocol/dist/src/digest.d.ts.map",
  "packages/protocol/dist/src/digest.js",
  "packages/protocol/dist/src/digest.js.map",
  "packages/protocol/dist/src/index.d.ts",
  "packages/protocol/dist/src/index.d.ts.map",
  "packages/protocol/dist/src/index.js",
  "packages/protocol/dist/src/index.js.map",
  "packages/protocol/dist/src/offset-allocation.d.ts",
  "packages/protocol/dist/src/offset-allocation.d.ts.map",
  "packages/protocol/dist/src/offset-allocation.js",
  "packages/protocol/dist/src/offset-allocation.js.map",
  "packages/protocol/dist/tsconfig.build.tsbuildinfo",
  "packages/protocol/src/digest.ts",
  "packages/protocol/src/index.ts",
  "packages/protocol/src/offset-allocation.test.ts",
  "packages/protocol/src/offset-allocation.ts",
  "packages/server/dist/tsconfig.build.tsbuildinfo",
  "packages/server/package.json",
  "packages/streamfs/dist/src/fs.d.ts.map",
  "packages/streamfs/dist/src/events.d.ts",
  "packages/streamfs/dist/src/events.d.ts.map",
  "packages/streamfs/dist/src/events.js",
  "packages/streamfs/dist/src/events.js.map",
  "packages/streamfs/dist/src/fs.js",
  "packages/streamfs/dist/src/fs.js.map",
  "packages/streamfs/dist/src/fs.d.ts",
  "packages/streamfs/dist/src/index.d.ts",
  "packages/streamfs/dist/src/index.d.ts.map",
  "packages/streamfs/dist/src/index.js",
  "packages/streamfs/dist/src/index.js.map",
  "packages/streamfs/dist/src/merge-integrity.d.ts.map",
  "packages/streamfs/dist/src/merge-integrity.js",
  "packages/streamfs/dist/src/merge-integrity.js.map",
  "packages/streamfs/dist/src/patch/ops.js",
  "packages/streamfs/dist/src/patch/ops.js.map",
  "packages/streamfs/dist/src/snapshot.d.ts.map",
  "packages/streamfs/dist/src/snapshot.d.ts",
  "packages/streamfs/dist/src/snapshot.js",
  "packages/streamfs/dist/src/snapshot.js.map",
  "packages/streamfs/dist/src/reducer.d.ts.map",
  "packages/streamfs/dist/src/reducer.js",
  "packages/streamfs/dist/src/reducer.js.map",
  "packages/streamfs/dist/src/watch.d.ts.map",
  "packages/streamfs/dist/src/watch.js",
  "packages/streamfs/dist/src/watch.js.map",
  "packages/streamfs/dist/tsconfig.build.tsbuildinfo",
  "packages/streamfs/package.json",
  "packages/streamfs/src/fs.ts",
  "packages/streamfs/src/events.ts",
  "packages/streamfs/src/index.ts",
  "packages/streamfs/src/merge-integrity.ts",
  "packages/streamfs/src/patch/ops.ts",
  "packages/streamfs/src/snapshot.ts",
  "packages/streamfs/src/reducer.ts",
  "packages/streamfs/src/watch.ts",
  "pnpm-lock.yaml",
].sort();
const expectedE1Changes = [manifestPath, provenancePath].sort();
const expectedPostE1ClosureAdditions = [
  "packages/cli/dist/src/branch-checkout-command.d.ts",
  "packages/cli/dist/src/branch-checkout-command.d.ts.map",
  "packages/cli/dist/src/branch-checkout-command.js",
  "packages/cli/dist/src/branch-checkout-command.js.map",
  "packages/cli/dist/src/checkout-marker.d.ts",
  "packages/cli/dist/src/checkout-marker.d.ts.map",
  "packages/cli/dist/src/checkout-marker.js",
  "packages/cli/dist/src/checkout-marker.js.map",
  "packages/cli/dist/src/classify.d.ts",
  "packages/cli/dist/src/classify.d.ts.map",
  "packages/cli/dist/src/classify.js",
  "packages/cli/dist/src/classify.js.map",
  "packages/cli/dist/src/clone-command.d.ts",
  "packages/cli/dist/src/clone-command.d.ts.map",
  "packages/cli/dist/src/clone-command.js",
  "packages/cli/dist/src/clone-command.js.map",
  "packages/cli/dist/src/commands/login.d.ts",
  "packages/cli/dist/src/commands/login.d.ts.map",
  "packages/cli/dist/src/commands/login.js",
  "packages/cli/dist/src/commands/login.js.map",
  "packages/cli/dist/src/credentials.d.ts",
  "packages/cli/dist/src/credentials.d.ts.map",
  "packages/cli/dist/src/credentials.js",
  "packages/cli/dist/src/credentials.js.map",
  "packages/cli/dist/src/dispatch-command.d.ts",
  "packages/cli/dist/src/dispatch-command.d.ts.map",
  "packages/cli/dist/src/dispatch-command.js",
  "packages/cli/dist/src/dispatch-command.js.map",
  "packages/cli/dist/src/init-command.d.ts",
  "packages/cli/dist/src/init-command.d.ts.map",
  "packages/cli/dist/src/init-command.js",
  "packages/cli/dist/src/init-command.js.map",
  "packages/cli/dist/src/status.d.ts",
  "packages/cli/dist/src/status.d.ts.map",
  "packages/cli/dist/src/status.js",
  "packages/cli/dist/src/status.js.map",
  "packages/cli/dist/src/sync/apply-journal.d.ts",
  "packages/cli/dist/src/sync/apply-journal.d.ts.map",
  "packages/cli/dist/src/sync/apply-journal.js",
  "packages/cli/dist/src/sync/apply-journal.js.map",
  "packages/cli/dist/src/sync/apply-observed.d.ts",
  "packages/cli/dist/src/sync/apply-observed.d.ts.map",
  "packages/cli/dist/src/sync/apply-observed.js",
  "packages/cli/dist/src/sync/apply-observed.js.map",
  "packages/cli/dist/src/sync/coalesce.d.ts",
  "packages/cli/dist/src/sync/coalesce.d.ts.map",
  "packages/cli/dist/src/sync/coalesce.js",
  "packages/cli/dist/src/sync/coalesce.js.map",
  "packages/cli/dist/src/sync/conflict.d.ts",
  "packages/cli/dist/src/sync/conflict.d.ts.map",
  "packages/cli/dist/src/sync/conflict.js",
  "packages/cli/dist/src/sync/conflict.js.map",
  "packages/cli/dist/src/sync/downlink.d.ts",
  "packages/cli/dist/src/sync/downlink.d.ts.map",
  "packages/cli/dist/src/sync/downlink.js",
  "packages/cli/dist/src/sync/downlink.js.map",
  "packages/cli/dist/src/sync/duplex.d.ts",
  "packages/cli/dist/src/sync/duplex.d.ts.map",
  "packages/cli/dist/src/sync/duplex.js",
  "packages/cli/dist/src/sync/duplex.js.map",
  "packages/cli/dist/src/sync/journal.d.ts",
  "packages/cli/dist/src/sync/journal.d.ts.map",
  "packages/cli/dist/src/sync/journal.js",
  "packages/cli/dist/src/sync/journal.js.map",
  "packages/cli/dist/src/sync/reconcile.d.ts",
  "packages/cli/dist/src/sync/reconcile.d.ts.map",
  "packages/cli/dist/src/sync/reconcile.js",
  "packages/cli/dist/src/sync/reconcile.js.map",
  "packages/cli/dist/src/sync/sync-journal.d.ts",
  "packages/cli/dist/src/sync/sync-journal.d.ts.map",
  "packages/cli/dist/src/sync/sync-journal.js",
  "packages/cli/dist/src/sync/sync-journal.js.map",
  "packages/cli/dist/src/sync/tree-upload.d.ts",
  "packages/cli/dist/src/sync/tree-upload.d.ts.map",
  "packages/cli/dist/src/sync/tree-upload.js",
  "packages/cli/dist/src/sync/tree-upload.js.map",
  "packages/cli/dist/src/sync/uplink.d.ts",
  "packages/cli/dist/src/sync/uplink.d.ts.map",
  "packages/cli/dist/src/sync/uplink.js",
  "packages/cli/dist/src/sync/uplink.js.map",
  "packages/cli/dist/src/sync/watch-command.d.ts",
  "packages/cli/dist/src/sync/watch-command.d.ts.map",
  "packages/cli/dist/src/sync/watch-command.js",
  "packages/cli/dist/src/sync/watch-command.js.map",
  "packages/cli/dist/src/sync/watch-state.d.ts",
  "packages/cli/dist/src/sync/watch-state.d.ts.map",
  "packages/cli/dist/src/sync/watch-state.js",
  "packages/cli/dist/src/sync/watch-state.js.map",
  "packages/cli/dist/src/tree-materializer.d.ts",
  "packages/cli/dist/src/tree-materializer.d.ts.map",
  "packages/cli/dist/src/tree-materializer.js",
  "packages/cli/dist/src/tree-materializer.js.map",
  "packages/cli/src/commands/login.ts",
  "packages/cli/src/credentials.ts",
  "packages/cli/src/dispatch-command.ts",
  "packages/cli/src/branch-checkout-command.ts",
  "packages/cli/src/checkout-marker.ts",
  "packages/cli/src/classify.ts",
  "packages/cli/src/clone-command.ts",
  "packages/cli/src/clone.test.ts",
  "packages/cli/src/init-command.ts",
  "packages/cli/src/init.test.ts",
  // E2-T08: `ef registry rebuild` — the registry-derived-index CLI door.
  "packages/cli/dist/src/registry-command.d.ts",
  "packages/cli/dist/src/registry-command.d.ts.map",
  "packages/cli/dist/src/registry-command.js",
  "packages/cli/dist/src/registry-command.js.map",
  "packages/cli/src/registry-command.ts",
  "packages/cli/src/status.test.ts",
  "packages/cli/src/status.ts",
  "packages/cli/src/sync/apply-journal.ts",
  "packages/cli/src/sync/apply-observed.ts",
  "packages/cli/src/sync/coalesce.ts",
  "packages/cli/src/sync/conflict.ts",
  "packages/cli/src/sync/downlink.ts",
  "packages/cli/src/sync/duplex.ts",
  "packages/cli/src/sync/journal.ts",
  "packages/cli/src/sync/reconcile.ts",
  "packages/cli/src/sync/sync-journal.ts",
  "packages/cli/src/sync/tree-upload.ts",
  "packages/cli/src/sync/uplink.ts",
  "packages/cli/src/sync/watch-command.ts",
  "packages/cli/src/sync/watch-state.ts",
  "packages/cli/src/tree-materializer.ts",
  // E4-T01: worktree digest CLI and its StreamFS projection implementation.
  "packages/cli/dist/src/worktree-command.d.ts",
  "packages/cli/dist/src/worktree-command.d.ts.map",
  "packages/cli/dist/src/worktree-command.js",
  "packages/cli/dist/src/worktree-command.js.map",
  "packages/cli/src/worktree-command.ts",
  "packages/cli/src/worktree.test.ts",
  "packages/protocol/src/digest.test.ts",
  "packages/streamfs/dist/src/worktree-node.d.ts",
  "packages/streamfs/dist/src/worktree-node.d.ts.map",
  "packages/streamfs/dist/src/worktree-node.js",
  "packages/streamfs/dist/src/worktree-node.js.map",
  "packages/streamfs/dist/src/worktree.d.ts",
  "packages/streamfs/dist/src/worktree.d.ts.map",
  "packages/streamfs/dist/src/worktree.js",
  "packages/streamfs/dist/src/worktree.js.map",
  "packages/streamfs/src/worktree-node.ts",
  "packages/streamfs/src/worktree.test.ts",
  "packages/streamfs/src/worktree.ts",
].sort();
const refreshApprovedE2 = process.argv.length === 3 && process.argv[2] === "--refresh-approved-e2";
assert.equal(
  process.argv.length === 2 || refreshApprovedE2,
  true,
  "usage: verify-provenance-refresh.mjs [--refresh-approved-e2]",
);

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitBytes(arguments_, label) {
  const result = spawnSync("git", arguments_, {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `${label}: ${result.stdout.toString("utf8")}${result.stderr.toString("utf8")}`,
  );
  return result.stdout;
}

function fromCommit(path) {
  return gitBytes(["show", `${scopeBase}:${path}`], `read ${path} at scope base`);
}

function filesBelow(directory) {
  const paths = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const stats = lstatSync(path);
    assert.equal(stats.isSymbolicLink(), false, `closure path must not be a symlink: ${path}`);
    if (stats.isDirectory()) paths.push(...filesBelow(path));
    else {
      assert.equal(stats.isFile(), true, `closure path must be a regular file: ${path}`);
      paths.push(path);
    }
  }
  return paths;
}

function assertRepositoryAncestors(path, label) {
  const repositoryRelative = relative(root, path);
  assert.equal(
    repositoryRelative === ".." ||
      repositoryRelative.startsWith(`..${sep}`) ||
      isAbsolute(repositoryRelative),
    false,
    `${label} must be inside the repository: ${path}`,
  );

  let ancestor = root;
  const rootStats = lstatSync(ancestor);
  assert.equal(
    rootStats.isSymbolicLink(),
    false,
    `${label} ancestor must not be a symlink: ${ancestor}`,
  );
  assert.equal(rootStats.isDirectory(), true, `${label} ancestor must be a directory: ${ancestor}`);
  const ancestorRelative = relative(root, dirname(path));
  for (const component of ancestorRelative.split(sep).filter(Boolean)) {
    ancestor = join(ancestor, component);
    const stats = lstatSync(ancestor);
    assert.equal(
      stats.isSymbolicLink(),
      false,
      `${label} ancestor must not be a symlink: ${ancestor}`,
    );
    assert.equal(stats.isDirectory(), true, `${label} ancestor must be a directory: ${ancestor}`);
  }
}

function assertRegularFile(path, label) {
  assertRepositoryAncestors(path, label);
  const stats = lstatSync(path);
  assert.equal(stats.isSymbolicLink(), false, `${label} must not be a symlink: ${path}`);
  assert.equal(stats.isFile(), true, `${label} must be a regular file: ${path}`);
}

function assertRepositoryDirectory(path, label) {
  assertRepositoryAncestors(path, label);
  const stats = lstatSync(path);
  assert.equal(stats.isSymbolicLink(), false, `${label} must not be a symlink: ${path}`);
  assert.equal(stats.isDirectory(), true, `${label} must be a directory: ${path}`);
}

function repoPathsBelow(directory) {
  const directoryRoot = join(root, directory);
  assertRepositoryDirectory(directoryRoot, "repository closure root");
  return filesBelow(directoryRoot)
    .map((path) => relative(root, path).split("\\").join("/"))
    .sort();
}

function installedPackageRoot(packageRoot, installedPackage, allowPatchedSlot = false) {
  const { name: packageName, version } = installedPackage;
  assert.match(
    packageName,
    /^(?:@[^/]+\/)?[^/]+$/,
    `invalid installed package name: ${packageName}`,
  );
  assert.equal(
    typeof version === "string" &&
      version.length > 0 &&
      !version.includes("/") &&
      !version.includes("\\"),
    true,
    `invalid installed package version: ${version}`,
  );
  assertRepositoryAncestors(packageRoot, "installed package root");
  const stats = lstatSync(packageRoot);
  assert.equal(
    stats.isSymbolicLink() || stats.isDirectory(),
    true,
    `installed package root must be a directory or pnpm symlink: ${packageRoot}`,
  );
  const resolvedRoot = realpathSync(packageRoot);
  if (stats.isSymbolicLink()) {
    const storeRoot = join(realpathSync(root), "node_modules", ".pnpm");
    const storeRelative = relative(storeRoot, resolvedRoot);
    assert.equal(
      storeRelative === ".." || storeRelative.startsWith(`..${sep}`) || isAbsolute(storeRelative),
      false,
      `installed package symlink must resolve inside the repository pnpm store: ${packageRoot}`,
    );
    const expectedStoreRelative = join(
      `${packageName.replaceAll("/", "+")}@${version}`,
      "node_modules",
      ...packageName.split("/"),
    );
    assert.equal(
      allowPatchedSlot
        ? storeRelative.startsWith(
            `${packageName.replaceAll("/", "+")}@${version}_patch_hash=${""}`,
          ) && storeRelative.endsWith(join("node_modules", ...packageName.split("/")))
        : storeRelative === expectedStoreRelative,
      true,
      `installed package symlink must resolve to the frozen pnpm slot ${packageName}@${version}: ${packageRoot}`,
    );
  }
  assertRepositoryDirectory(resolvedRoot, "resolved installed package root");
  return resolvedRoot;
}

function assertUnique(paths, label) {
  assert.equal(new Set(paths).size, paths.length, `${label} contains duplicate paths`);
}

function parseCanonical(bytes, label) {
  const text = bytes.toString("utf8");
  const parsed = JSON.parse(text);
  assert.equal(text, `${JSON.stringify(parsed)}\n`, `${label} is not canonical exact JSON`);
  return parsed;
}

function directoryClosure(path) {
  return path.match(/^(packages\/[^/]+\/(?:dist|src))(?:\/|$)/)?.[1];
}

const baseProvenanceBytes = fromCommit(provenancePath);
const baseProvenance = parseCanonical(baseProvenanceBytes, "base E1 provenance");
const currentProvenanceBytes = readFileSync(join(root, provenancePath));
const currentProvenance = JSON.parse(currentProvenanceBytes.toString("utf8"));
assert.ok(Array.isArray(baseProvenance.files), "base E1 provenance files must be an array");
assert.ok(Array.isArray(currentProvenance.files), "current E1 provenance files must be an array");

const baseFilePaths = baseProvenance.files.map(({ path }) => path);
const currentArtifactPaths = currentProvenance.files.map(({ path }) => path);
assertUnique(baseFilePaths, "base E1 provenance");
assertUnique(currentArtifactPaths, "current E1 provenance");

const closureDirectories = [
  ...new Set(baseFilePaths.map(directoryClosure).filter((path) => path !== undefined)),
].sort();
const explicitClosurePaths = baseFilePaths.filter((path) => directoryClosure(path) === undefined);
for (const path of explicitClosurePaths) {
  assertRegularFile(join(root, path), "explicit provenance closure path");
}
const currentClosurePaths = [
  ...explicitClosurePaths,
  ...closureDirectories.flatMap((directory) => repoPathsBelow(directory)),
].sort();
assertUnique(currentClosurePaths, "current E1 provenance closure");
const baseFilePathSet = new Set(baseFilePaths);
const retainedE1Closure = currentClosurePaths.filter((path) => baseFilePathSet.has(path));
const postE1ClosureAdditions = currentClosurePaths.filter((path) => !baseFilePathSet.has(path));
assert.deepEqual(retainedE1Closure, [...baseFilePaths].sort(), "E1 provenance file set changed");
assert.deepEqual(
  postE1ClosureAdditions,
  expectedPostE1ClosureAdditions,
  "post-E1 closure additions differ from the exact approved provenance file set",
);

const approvedChanges = new Set(expectedChangedInputs);
const expectedFiles = baseProvenance.files.map((file) => {
  const currentDigest = digest(readFileSync(join(root, file.path)));
  const expectedDigest = approvedChanges.has(file.path) ? currentDigest : file.sha256;
  assert.equal(
    currentDigest,
    expectedDigest,
    `${file.path} drifted outside the exact human-approved provenance refresh`,
  );
  return { ...file, sha256: expectedDigest };
});
expectedFiles.push(
  ...expectedPostE1ClosureAdditions.map((path) => ({
    path,
    sha256: digest(readFileSync(join(root, path))),
  })),
);
// Match E1's canonical closure ordering (`Array.prototype.sort()` on paths),
// rather than locale-dependent collation (which moves `e1_capstone.mjs` after
// its suffixed siblings on this runtime).
expectedFiles.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
const actualChangedInputs = expectedFiles
  .filter((file) => {
    const baseFile = baseProvenance.files.find(({ path }) => path === file.path);
    return baseFile !== undefined && file.sha256 !== baseFile.sha256;
  })
  .map(({ path }) => path)
  .sort();
assert.deepEqual(
  actualChangedInputs,
  expectedChangedInputs,
  "exactly the human-approved provenance inputs must change E1 provenance",
);

assert.ok(
  Array.isArray(baseProvenance.installedPackages),
  "base E1 provenance installedPackages must be an array",
);
assert.ok(
  Array.isArray(currentProvenance.installedPackages),
  "current E1 provenance installedPackages must be an array",
);
assertUnique(
  baseProvenance.installedPackages.map(({ name }) => name),
  "base E1 installed package closure",
);
assertUnique(
  currentProvenance.installedPackages.map(({ name }) => name),
  "current E1 installed package closure",
);
for (const installedPackage of baseProvenance.installedPackages) {
  const approvedInstalledPackage =
    installedPackage.name === "@durable-streams/server" &&
    approvedChanges.has("packages/server/package.json")
      ? currentProvenance.installedPackages.find(({ name }) => name === installedPackage.name)
      : installedPackage;
  assert.ok(
    approvedInstalledPackage,
    `missing approved installed package: ${installedPackage.name}`,
  );
  const workspacePackage = approvedInstalledPackage.name.split("/").at(-1);
  assert.ok(workspacePackage, `invalid installed package name ${installedPackage.name}`);
  const packageRoot = join(
    root,
    "packages",
    workspacePackage,
    "node_modules",
    installedPackage.name,
  );
  const resolvedPackageRoot = installedPackageRoot(
    packageRoot,
    approvedInstalledPackage,
    approvedInstalledPackage !== installedPackage,
  );
  const expectedPaths = approvedInstalledPackage.files.map(({ path }) => path);
  assertUnique(expectedPaths, `${installedPackage.name} provenance`);
  const actualPaths = filesBelow(resolvedPackageRoot)
    .map((path) => relative(resolvedPackageRoot, path).split("\\").join("/"))
    .filter((path) => !path.split("/").includes("node_modules"))
    .sort();
  assertUnique(actualPaths, `${installedPackage.name} installed closure`);
  assert.deepEqual(
    actualPaths,
    [...expectedPaths].sort(),
    `${installedPackage.name} file set drifted`,
  );
  for (const file of approvedInstalledPackage.files) {
    assert.equal(
      digest(readFileSync(join(resolvedPackageRoot, file.path))),
      file.sha256,
      `${installedPackage.name}/${file.path} bytes drifted`,
    );
  }
}

const expectedProvenance = structuredClone(baseProvenance);
expectedProvenance.files = expectedFiles;
expectedProvenance.installedPackages = expectedProvenance.installedPackages.map(
  (installedPackage) =>
    installedPackage.name === "@durable-streams/server" &&
    approvedChanges.has("packages/server/package.json")
      ? currentProvenance.installedPackages.find(({ name }) => name === installedPackage.name)
      : installedPackage,
);
const expectedProvenanceBytes = Buffer.from(`${JSON.stringify(expectedProvenance)}\n`);
if (refreshApprovedE2) writeFileSync(join(root, provenancePath), expectedProvenanceBytes);
assert.ok(
  readFileSync(join(root, provenancePath)).equals(expectedProvenanceBytes),
  "E1 provenance is not the exact canonical base artifact with only approved hashes and additions refreshed",
);

const baseManifestBytes = fromCommit(manifestPath);
const baseManifest = parseCanonical(baseManifestBytes, "base E1 evidence manifest");
const currentManifestBytes = readFileSync(join(root, manifestPath));
const expectedManifest = structuredClone(baseManifest);
expectedManifest.artifacts["transport-provenance.json"] = digest(expectedProvenanceBytes);
const expectedManifestBytes = Buffer.from(`${JSON.stringify(expectedManifest)}\n`);
if (refreshApprovedE2) writeFileSync(join(root, manifestPath), expectedManifestBytes);
assert.ok(
  readFileSync(join(root, manifestPath)).equals(expectedManifestBytes),
  "E1 evidence manifest is not the exact canonical base artifact with only the provenance digest refreshed",
);

const baseEvidencePaths = gitBytes(
  ["ls-tree", "-r", "-z", "--name-only", scopeBase, "--", evidenceRoot],
  "enumerate base E1 evidence",
)
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .sort();
const currentEvidencePaths = repoPathsBelow(evidenceRoot);
assertUnique(baseEvidencePaths, "base E1 evidence");
assertUnique(currentEvidencePaths, "current E1 evidence");
assert.deepEqual(
  currentEvidencePaths,
  baseEvidencePaths,
  "E1 evidence file set changed, including an untracked or ignored path",
);
const changedE1Paths = currentEvidencePaths
  .filter((path) => !readFileSync(join(root, path)).equals(fromCommit(path)))
  .sort();
assert.deepEqual(
  changedE1Paths,
  expectedE1Changes,
  "only the two human-approved derived E1 artifacts may change",
);

const verifierPaths = baseFilePaths.filter((path) => path.startsWith("tools/verify/")).sort();
assert.equal(
  verifierPaths.length,
  7,
  "frozen E1 provenance must contain all seven verifier inputs",
);

process.stdout.write(
  `${JSON.stringify({
    changedE1Paths,
    changedInputs: actualChangedInputs,
    installedPackages: baseProvenance.installedPackages.map(({ name }) => name),
    manifestProvenanceDigest: expectedManifest.artifacts["transport-provenance.json"],
    provenanceClosureFiles: expectedFiles.length,
    scopeBase,
    verifierPaths,
  })}\n`,
);
