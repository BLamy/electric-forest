import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { sha256Hex } from "@eforest/protocol";
import { isValidFsPath } from "./events.js";
import {
  WorktreeDigestError,
  worktreeDigest,
  worktreeProjection,
  type WorktreeFileState,
  type WorktreeProjection,
} from "./worktree.js";

function invalidName(path: string): never {
  throw new WorktreeDigestError(
    "invalid-name",
    `worktree entry name is not canonical NFC UTF-8: ${path}`,
    path,
  );
}

export interface WorktreeEntries {
  readonly files: Readonly<Record<string, WorktreeFileState>>;
  readonly directories: readonly string[];
}

function walk(
  root: string,
  current: string,
  files: Record<string, WorktreeFileState>,
  directories: string[],
): void {
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
  } catch (error) {
    const path = relative(root, current) || ".";
    throw new WorktreeDigestError(
      "unreadable",
      `cannot read worktree directory ${path}: ${error instanceof Error ? error.message : String(error)}`,
      path,
    );
  }
  for (const entry of entries) {
    const target = join(current, entry.name);
    const path = relative(root, target).split(sep).join("/");
    // Only the worktree-root `.ef/` directory is reserved. A regular file,
    // symlink, FIFO, or other non-directory named `.ef` must still be
    // certified by the walker rather than silently disappearing from the
    // projection.
    if (path === ".ef" && entry.isDirectory()) continue;
    if (entry.name.normalize("NFC") !== entry.name || !isValidFsPath(path)) {
      invalidName(path);
    }
    let stat;
    try {
      stat = lstatSync(target);
    } catch (error) {
      throw new WorktreeDigestError(
        "unreadable",
        `cannot inspect worktree entry ${path}: ${error instanceof Error ? error.message : String(error)}`,
        path,
      );
    }
    if (stat.isSymbolicLink()) {
      throw new WorktreeDigestError("symlink", `symlink is not allowed in worktree: ${path}`, path);
    }
    if (stat.isDirectory()) {
      directories.push(path);
      walk(root, target, files, directories);
      continue;
    }
    if (!stat.isFile()) {
      throw new WorktreeDigestError("non-regular", `non-regular worktree entry: ${path}`, path);
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(target);
    } catch (error) {
      throw new WorktreeDigestError(
        "unreadable",
        `cannot read worktree file ${path}: ${error instanceof Error ? error.message : String(error)}`,
        path,
      );
    }
    files[path] = { contentSha256: sha256Hex(bytes), size: bytes.byteLength };
  }
}

/** Read files and on-disk directories using the frozen deterministic worktree walk. */
export function readWorktreeEntries(rootPath: string): WorktreeEntries {
  const root = resolve(rootPath);
  let stat;
  try {
    stat = lstatSync(root);
  } catch (error) {
    throw new WorktreeDigestError(
      "root",
      `cannot inspect worktree root ${root}: ${error instanceof Error ? error.message : String(error)}`,
      root,
    );
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new WorktreeDigestError("root", `worktree root must be a directory: ${root}`, root);
  }
  // Keep every valid on-disk name as data, including prototype-looking names.
  const files = Object.create(null) as Record<string, WorktreeFileState>;
  const directories: string[] = [];
  walk(root, root, files, directories);
  return { files: worktreeProjection({ files }).files, directories };
}

/** Read a local directory using the frozen deterministic worktree walk. */
export function readWorktree(rootPath: string): WorktreeProjection {
  return { files: readWorktreeEntries(rootPath).files };
}

export function worktreeDigestDirectory(rootPath: string): string {
  return worktreeDigest(readWorktree(rootPath));
}
