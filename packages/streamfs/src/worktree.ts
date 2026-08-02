import { stateDigest } from "@eforest/protocol";
import { isValidFsPath } from "./events.js";
import type { FsFileState, FsTree } from "./tree.js";

export const WORKTREE_DIGEST_VERSION = 1 as const;

export interface WorktreeFileState {
  readonly contentSha256: string;
  readonly size: number;
}

export interface WorktreeProjection {
  readonly files: Readonly<Record<string, WorktreeFileState>>;
}

export type WorktreeDigestErrorCode =
  | "invalid-state"
  | "invalid-path"
  | "invalid-file"
  | "invalid-name"
  | "symlink"
  | "non-regular"
  | "unreadable"
  | "root";

export class WorktreeDigestError extends Error {
  readonly code: WorktreeDigestErrorCode;
  readonly path: string | undefined;

  constructor(code: WorktreeDigestErrorCode, message: string, path?: string) {
    super(message);
    this.name = "WorktreeDigestError";
    this.code = code;
    this.path = path;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertFile(
  path: string,
  value: unknown,
): asserts value is WorktreeFileState | FsFileState {
  if (!isRecord(value)) {
    throw new WorktreeDigestError(
      "invalid-file",
      `worktree file metadata is not an object: ${path}`,
      path,
    );
  }
  if (
    typeof value.contentSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.contentSha256) ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0
  ) {
    throw new WorktreeDigestError(
      "invalid-file",
      `worktree file metadata is invalid: ${path}`,
      path,
    );
  }
}

/**
 * Build the frozen byte-content projection. `contentStreamId` and all other
 * StreamFS bookkeeping are intentionally excluded; bytes and path are the
 * only local-worktree facts that participate in this digest.
 */
export function worktreeProjection(
  state: Pick<FsTree, "files"> | WorktreeProjection,
): WorktreeProjection {
  if (!isRecord(state) || !isRecord(state.files)) {
    throw new WorktreeDigestError("invalid-state", "worktree state must contain a files object");
  }
  const files: Record<string, WorktreeFileState> = {};
  for (const path of Object.keys(state.files).sort()) {
    if (!isValidFsPath(path)) {
      throw new WorktreeDigestError(
        "invalid-path",
        `worktree path is not a valid NFC path: ${path}`,
        path,
      );
    }
    const value = state.files[path];
    assertFile(path, value);
    files[path] = { contentSha256: value.contentSha256, size: value.size };
  }
  return { files };
}

/** Compute WORKTREE_DIGEST_VERSION 1 from a StreamFS tree or projection. */
export function worktreeDigest(state: Pick<FsTree, "files"> | WorktreeProjection): string {
  return stateDigest(worktreeProjection(state));
}
