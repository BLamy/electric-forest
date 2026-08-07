import { readWorktreeEntries } from "@eforest/streamfs/worktree-node";
import type { WorkspaceState } from "@eforest/workspace";

export interface WorkingTreeClassification {
  readonly added: readonly string[];
  readonly deleted: readonly string[];
  readonly modified: readonly string[];
  readonly clean: readonly string[];
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

  for (const path of ordered) {
    const expected = base[path];
    const actual = current.files[path];
    if (expected === undefined) {
      added.push(path);
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

  return { added, deleted, modified, clean };
}

/** Sort paths by their UTF-8 byte sequence, not locale or UTF-16 code units. */
export function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}
