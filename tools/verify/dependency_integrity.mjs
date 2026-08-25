#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = "eforest.dependency-integrity.v1";

function normalizedRelative(root, path) {
  const value = relative(root, path).split(sep).join("/");
  if (value === "" || value === ".." || value.startsWith("../")) {
    throw new Error(`dependency path escaped repository root: ${path}`);
  }
  return value;
}

function fileDigest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function describe(path, relativePath) {
  const stat = lstatSync(path);
  if (stat.isDirectory()) return { path: relativePath, type: "directory" };
  if (stat.isFile()) return { path: relativePath, sha256: fileDigest(path), type: "file" };
  if (stat.isSymbolicLink()) {
    return { path: relativePath, target: readlinkSync(path), type: "symlink" };
  }
  throw new Error(`unsupported installed dependency entry type: ${relativePath}`);
}

function walk(root, start, entries, skip) {
  const relativeStart = normalizedRelative(root, start);
  entries.set(relativeStart, describe(start, relativeStart));
  if (!lstatSync(start).isDirectory()) return;

  for (const child of readdirSync(start).sort()) {
    const path = join(start, child);
    const relativePath = normalizedRelative(root, path);
    if (skip(relativePath)) continue;
    const entry = describe(path, relativePath);
    entries.set(relativePath, entry);
    if (entry.type === "directory") walkChildren(root, path, entries, skip);
  }
}

function walkChildren(root, directory, entries, skip) {
  for (const child of readdirSync(directory).sort()) {
    const path = join(directory, child);
    const relativePath = normalizedRelative(root, path);
    if (skip(relativePath)) continue;
    const entry = describe(path, relativePath);
    entries.set(relativePath, entry);
    if (entry.type === "directory") walkChildren(root, path, entries, skip);
  }
}

function isGeneratedViteCache(path) {
  const parts = path.split("/");
  let cacheIndex;
  if (parts[0] === "node_modules") {
    cacheIndex = 1;
  } else if ((parts[0] === "apps" || parts[0] === "packages") && parts[2] === "node_modules") {
    cacheIndex = 3;
  } else {
    return false;
  }
  return parts[cacheIndex] === ".vite" || parts[cacheIndex] === ".vite-temp";
}

function workspaceDependencyRoots(root) {
  const roots = [];
  for (const group of ["apps", "packages"]) {
    const groupRoot = join(root, group);
    let workspaces;
    try {
      workspaces = readdirSync(groupRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue;
      const dependencyRoot = join(groupRoot, workspace.name, "node_modules");
      try {
        lstatSync(dependencyRoot);
        roots.push(dependencyRoot);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return roots.sort();
}

export function createDependencyManifest(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const rootDependencies = join(root, "node_modules");
  const virtualStore = join(rootDependencies, ".pnpm");
  const entries = new Map();

  lstatSync(virtualStore);
  walk(root, virtualStore, entries, () => false);
  walk(
    root,
    rootDependencies,
    entries,
    (path) => path === "node_modules/.pnpm" || isGeneratedViteCache(path),
  );
  for (const dependencyRoot of workspaceDependencyRoots(root)) {
    walk(root, dependencyRoot, entries, isGeneratedViteCache);
  }

  return {
    entries: [...entries.values()].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
    schema: SCHEMA,
  };
}

function validateManifest(manifest) {
  if (manifest?.schema !== SCHEMA || !Array.isArray(manifest.entries)) {
    throw new Error(`invalid dependency manifest schema (expected ${SCHEMA})`);
  }
  let previous = "";
  for (const entry of manifest.entries) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.path !== "string" ||
      !["directory", "file", "symlink"].includes(entry.type) ||
      (entry.type === "file" && !/^[a-f0-9]{64}$/.test(entry.sha256)) ||
      (entry.type === "symlink" && typeof entry.target !== "string") ||
      entry.path <= previous
    ) {
      throw new Error(`invalid or unsorted dependency manifest entry: ${JSON.stringify(entry)}`);
    }
    previous = entry.path;
  }
}

function renderedEntry(entry) {
  if (entry.type === "file") return `file sha256=${entry.sha256}`;
  if (entry.type === "symlink") return `symlink target=${JSON.stringify(entry.target)}`;
  return "directory";
}

export function compareDependencyManifest(repositoryRoot, expected) {
  validateManifest(expected);
  const actual = createDependencyManifest(repositoryRoot);
  const expectedByPath = new Map(expected.entries.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.entries.map((entry) => [entry.path, entry]));
  const missing = [];
  const added = [];
  const changed = [];

  for (const entry of expected.entries) {
    const observed = actualByPath.get(entry.path);
    if (observed === undefined) missing.push(entry);
    else if (JSON.stringify(observed) !== JSON.stringify(entry)) changed.push([entry, observed]);
  }
  for (const entry of actual.entries) {
    if (!expectedByPath.has(entry.path)) added.push(entry);
  }

  return { added, changed, missing };
}

function argument(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || index === args.length - 1) throw new Error(`missing ${name}`);
  return args[index + 1];
}

function reportComparison(comparison) {
  const { added, changed, missing } = comparison;
  if (missing.length === 0 && added.length === 0 && changed.length === 0) {
    process.stdout.write("DEPENDENCY_INTEGRITY_OK\n");
    return 0;
  }

  process.stderr.write(
    `DEPENDENCY_INTEGRITY_MISMATCH missing=${missing.length} added=${added.length} changed=${changed.length}\n`,
  );
  for (const entry of missing) {
    process.stderr.write(`MISSING ${entry.path} expected=${renderedEntry(entry)}\n`);
  }
  for (const entry of added) {
    process.stderr.write(`ADDED ${entry.path} actual=${renderedEntry(entry)}\n`);
  }
  for (const [expected, actual] of changed) {
    process.stderr.write(
      `CHANGED ${expected.path} expected=${renderedEntry(expected)} actual=${renderedEntry(actual)}\n`,
    );
  }
  return 1;
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const root = resolve(argument(args, "--root"));

  if (command === "write") {
    const output = resolve(argument(args, "--output"));
    const manifest = createDependencyManifest(root);
    writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(
      `DEPENDENCY_INTEGRITY_MANIFEST entries=${manifest.entries.length} output=${output}\n`,
    );
    return 0;
  }
  if (command === "compare") {
    const manifestPath = resolve(argument(args, "--manifest"));
    const expected = JSON.parse(readFileSync(manifestPath, "utf8"));
    return reportComparison(compareDependencyManifest(root, expected));
  }
  throw new Error(
    "usage: dependency_integrity.mjs write --root <repo> --output <manifest> | compare --root <repo> --manifest <manifest>",
  );
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(
      `DEPENDENCY_INTEGRITY_ERROR ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
