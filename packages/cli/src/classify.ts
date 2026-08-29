import { readWorktreeEntries } from "@eforest/streamfs/worktree-node";
import type { WorkspaceState } from "@eforest/workspace";
import { readRememberedConflicts } from "./sync/conflict.js";

export interface WorkingTreeClassification {
  readonly added: readonly string[];
  readonly deleted: readonly string[];
  readonly modified: readonly string[];
  readonly clean: readonly string[];
  readonly conflicted: readonly {
    readonly path: string;
    readonly conflictFile: string;
    readonly offset: string;
  }[];
}

function conflictOffset(path: string, remembered: ReadonlySet<string>): string | undefined {
  if (!remembered.has(path)) return undefined;
  const marker = path.lastIndexOf(".conflict-");
  if (marker <= 0) return undefined;
  const target = path.slice(0, marker);
  const encoded = path.slice(marker + ".conflict-".length);
  if (!target || encoded.length === 0) return undefined;
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length;) {
    if (encoded[index] === "%") {
      const hex = encoded.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return undefined;
      bytes.push(Number.parseInt(hex, 16));
      index += 3;
    } else {
      if (!/[A-Za-z0-9._-]/.test(encoded[index]!)) return undefined;
      bytes.push(...Buffer.from(encoded[index]!, "utf8"));
      index += 1;
    }
  }
  const offset = Buffer.from(bytes).toString("utf8");
  return offset;
}

/**
 * Compare the current directory with the E4-T01 base ledger.
 *
 * Classification is deliberately content-only: a path is modified when its
 * current SHA-256 differs from the ledger's SHA-256.  The recorded size and
 * filesystem mtimes are not classification inputs. The shared E4-T01 walk
 * supplies the same root-.ef exclusion and path validation as tree-digest.
 * Empty directories do not participate in the digest, but an on-disk
 * directory that is not required by a ledger file is still an untracked
 * mutation and must block checkout.
 */
export function classifyWorkingTree(
  rootDir: string,
  ledger: WorkspaceState,
  knownDirectories: readonly string[] = [],
): WorkingTreeClassification {
  const current = readWorktreeEntries(rootDir);
  const rememberedConflicts = readRememberedConflicts(rootDir);
  const base = ledger.files;
  const requiredDirectories = new Set(knownDirectories);
  for (const path of [...Object.keys(base), ...Object.keys(current.files)]) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      requiredDirectories.add(segments.slice(0, index).join("/"));
    }
  }
  const paths = new Set([...Object.keys(base), ...Object.keys(current.files)]);
  const ordered = [...paths].sort(compareUtf8);
  const added: string[] = [];
  const deleted: string[] = [];
  const modified: string[] = [];
  const clean: string[] = [];
  const conflicted: { path: string; conflictFile: string; offset: string }[] = [];

  for (const path of ordered) {
    const expected = base[path];
    const actual = current.files[path];
    if (expected === undefined) {
      if (conflictOffset(path, rememberedConflicts) === undefined) added.push(path);
    } else if (actual === undefined) {
      deleted.push(path);
    } else if (actual.contentSha256 !== expected.contentSha256) {
      modified.push(path);
    } else {
      clean.push(path);
    }
  }

  for (const path of current.directories) {
    if (!requiredDirectories.has(path) && !Object.hasOwn(base, path)) added.push(path);
  }
  added.sort(compareUtf8);

  for (const conflictFile of Object.keys(current.files)) {
    const marker = conflictFile.lastIndexOf(".conflict-");
    if (marker <= 0) continue;
    const path = conflictFile.slice(0, marker);
    const offset = conflictOffset(conflictFile, rememberedConflicts);
    if (offset !== undefined) conflicted.push({ path, conflictFile, offset });
  }
  conflicted.sort((left, right) => compareUtf8(left.conflictFile, right.conflictFile));

  return { added, deleted, modified, clean, conflicted };
}

/** Sort paths by their UTF-8 byte sequence, not locale or UTF-16 code units. */
export function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}
