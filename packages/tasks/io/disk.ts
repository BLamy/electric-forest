/**
 * The one filesystem boundary of `@eforest/tasks`: read a task folder from disk into an
 * inert `TaskFolderSnapshot`, and write a rendered folder out. The reader never follows
 * a symlink (it reports it as a `symlink` entry for the parser to refuse), never resolves
 * a path outside `dir` (it only descends through `readdir` results), and never writes.
 * The writer refuses to touch a non-empty directory, so a refused parse can never leave
 * a half-rendered folder behind. Kept outside `src/` so the parser core stays free of
 * `node:fs` (verify-E6-T01 asserts that).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { RenderedTaskFolder, FolderEntry, TaskFolderSnapshot } from "../src/folder/index.js";

export function readTaskFolderSnapshot(dir: string): TaskFolderSnapshot {
  const entries: FolderEntry[] = [];
  const walk = (relative: string): void => {
    const absolute = relative === "" ? dir : join(dir, relative);
    const children = readdirSync(absolute, { withFileTypes: true });
    if (children.length === 0 && relative !== "") {
      entries.push({ path: relative, kind: "directory" });
      return;
    }
    for (const child of children) {
      const childPath = relative === "" ? child.name : `${relative}/${child.name}`;
      if (child.isSymbolicLink()) entries.push({ path: childPath, kind: "symlink" });
      else if (child.isDirectory()) walk(childPath);
      else if (child.isFile()) {
        entries.push({
          path: childPath,
          kind: "file",
          bytes: new Uint8Array(readFileSync(join(dir, childPath))),
        });
      } else entries.push({ path: childPath, kind: "other" });
    }
  };
  walk("");
  return { folderName: basename(dir), entries };
}

/**
 * Write a rendered folder into `dir` (must not exist or be an empty directory). Files are
 * staged in a sibling temporary directory and moved into place with one rename, so a
 * failure part-way leaves nothing at `dir`.
 */
export function writeRenderedTaskFolder(
  dir: string,
  rendered: RenderedTaskFolder,
): readonly string[] {
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory() || readdirSync(dir).length > 0) {
      throw new Error(`writeRenderedTaskFolder: ${dir} exists and is not an empty directory`);
    }
  }
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, `.${basename(dir)}.staging-`));
  const written: string[] = [];
  try {
    for (const file of rendered.files) {
      const target = join(staging, ...file.path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.bytes, { flag: "wx" });
      written.push(file.path);
    }
    if (existsSync(dir)) rmdirSync(dir);
    renameSync(staging, dir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return written;
}
