import { readWorktree } from "@eforest/streamfs/worktree-node";
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
 * filesystem mtimes are not classification inputs.  The shared E4-T01 walk
 * supplies the same root-.ef exclusion and path validation as tree-digest.
 */
export function classifyWorkingTree(
  rootDir: string,
  ledger: WorkspaceState,
): WorkingTreeClassification {
  const current = readWorktree(rootDir).files;
  const base = ledger.files;
  const paths = new Set([...Object.keys(base), ...Object.keys(current)]);
  const ordered = [...paths].sort(compareUtf8);
  const added: string[] = [];
  const deleted: string[] = [];
  const modified: string[] = [];
  const clean: string[] = [];

  for (const path of ordered) {
    const expected = base[path];
    const actual = current[path];
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

  return { added, deleted, modified, clean };
}

/** Sort paths by their UTF-8 byte sequence, not locale or UTF-16 code units. */
export function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}
