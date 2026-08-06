import {
  contentMap,
  digestBytes,
  isValidFsPath,
  type FsTree,
  worktreeDigest,
} from "@eforest/streamfs";
import { worktreeDigestDirectory } from "@eforest/streamfs/worktree-node";
import { BASE_NONE, type WorkspaceFileBase, type WorkspaceState } from "@eforest/workspace";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export class TreeMaterializerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TreeMaterializerError";
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

export function orderedTreePaths(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth === 0 ? compareUtf8(left, right) : depth;
  });
}

export function safeTreeTarget(root: string, path: string): string {
  if (!isValidFsPath(path)) {
    throw new TreeMaterializerError(`invalid tree path ${JSON.stringify(path)}`);
  }
  if (path === ".ef" || path.startsWith(".ef/")) {
    throw new TreeMaterializerError(`tree path is reserved: ${path}`);
  }
  const rootPath = resolve(root);
  const target = resolve(rootPath, ...path.split("/"));
  const prefix = `${rootPath}${rootPath.endsWith("/") ? "" : "/"}`;
  if (target !== rootPath && !target.startsWith(prefix)) {
    throw new TreeMaterializerError(`tree path escapes target: ${path}`);
  }
  return target;
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Materialize a complete FsTree into an empty directory. */
export async function materializeTree(
  root: string,
  state: FsTree,
  readFile: (path: string) => Promise<Uint8Array>,
): Promise<void> {
  mkdirSync(root, { recursive: true, mode: 0o755 });
  for (const path of orderedTreePaths(Object.keys(state.dirs))) {
    const target = safeTreeTarget(root, path);
    mkdirSync(target, { recursive: false, mode: 0o755 });
  }
  for (const path of [...Object.keys(state.files)].sort(compareUtf8)) {
    const target = safeTreeTarget(root, path);
    const parent = dirname(target);
    if (!existsSync(parent) || !lstatSync(parent).isDirectory()) {
      throw new TreeMaterializerError(`file parent was not materialized: ${path}`);
    }
    const cached = contentMap(state).get(state.files[path]!.contentStreamId);
    const bytes = cached === undefined ? await readFile(path) : cached;
    const file = state.files[path]!;
    if (bytes.byteLength !== file.size) {
      throw new TreeMaterializerError(`content size mismatch for ${path}`);
    }
    if (digestBytes(bytes) !== file.contentSha256) {
      throw new TreeMaterializerError(`content digest mismatch for ${path}`);
    }
    const fd = openSync(target, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  fsyncDirectory(root);
}

export function verifyMaterializedTree(root: string, state: FsTree): void {
  const expected = worktreeDigest(state);
  const actual = worktreeDigestDirectory(root);
  if (expected !== actual) {
    throw new TreeMaterializerError(`materialized digest ${actual} does not match ${expected}`);
  }
}

export function workspaceFilesFromTree(state: FsTree): Readonly<Record<string, WorkspaceFileBase>> {
  const files = Object.create(null) as Record<string, WorkspaceFileBase>;
  for (const path of [...Object.keys(state.files)].sort(compareUtf8)) {
    const file = state.files[path]!;
    files[path] = {
      base: file.lastContentOffset || BASE_NONE,
      contentSha256: file.contentSha256,
      size: file.size,
    };
  }
  return files;
}

export function workspaceStateFromTree(
  identity: WorkspaceState["identity"],
  headOffset: WorkspaceState["headOffset"],
  state: FsTree,
): WorkspaceState {
  return { v: 1, identity, headOffset, files: workspaceFilesFromTree(state) };
}

/** Remove all materialized worktree entries while preserving the `.ef` control directory. */
export function clearWorktree(root: string): void {
  for (const entry of readdirSync(root)) {
    if (entry === ".ef") continue;
    rmSync(join(root, entry), { recursive: true, force: true });
  }
}

/** Copy a staged tree into a root after the old materialized entries were removed. */
export function copyStagedTree(stage: string, root: string, state: FsTree): void {
  for (const path of orderedTreePaths(Object.keys(state.dirs))) {
    const target = safeTreeTarget(root, path);
    mkdirSync(target, { recursive: false, mode: 0o755 });
  }
  for (const path of [...Object.keys(state.files)].sort(compareUtf8)) {
    const source = safeTreeTarget(stage, path);
    const target = safeTreeTarget(root, path);
    copyFileSync(source, target);
  }
  fsyncDirectory(root);
}
