/**
 * Path containment for task folders. Every entry path a reader hands the parser is
 * checked here before anything is read from it: absolute paths, `.`/`..` traversal,
 * empty segments, backslashes, percent escapes, control characters, non-ASCII, and
 * over-long segments are refused with a stable reason. The parser never resolves a
 * path against a filesystem, so "read outside the task root" is impossible by
 * construction; this module makes the refusal explicit and byte-stable.
 */
import type { TaskFolderRefusal, TaskFolderRefusalReason } from "./schema.js";

export const MAX_PATH_SEGMENT_LENGTH = 255;

/** Segment charset: ASCII letters, digits, `.`, `_`, `-`. Nothing else, ever. */
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

export type PathCheck =
  | { readonly ok: true; readonly segments: readonly string[] }
  | {
      readonly ok: false;
      readonly reason: TaskFolderRefusalReason;
      readonly message: string;
    };

/**
 * Validate one raw relative path. Accepts only `seg(/seg)*` where each segment is a
 * non-empty ASCII `[A-Za-z0-9._-]` run that is neither `.` nor `..`, does not end in
 * `.`, and contains no `%`.
 */
export function checkRelativePath(raw: string): PathCheck {
  if (raw.length === 0) return refuse("paths/empty-segment", "empty path");
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || raw.startsWith("\\")) {
    return refuse("paths/absolute", `absolute path ${JSON.stringify(raw)}`);
  }
  if (raw.includes("\\")) {
    return refuse("paths/forbidden-character", `backslash in ${JSON.stringify(raw)}`);
  }
  const segments = raw.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      return refuse("paths/empty-segment", `empty segment in ${JSON.stringify(raw)}`);
    }
    if (segment === "." || segment === "..") {
      return refuse("paths/traversal", `traversal segment in ${JSON.stringify(raw)}`);
    }
    if (segment.includes("%")) {
      return refuse("paths/percent-escape", `percent escape in ${JSON.stringify(raw)}`);
    }
    if (!SEGMENT_PATTERN.test(segment)) {
      return refuse(
        "paths/forbidden-character",
        `segment ${JSON.stringify(segment)} is not ASCII [A-Za-z0-9._-]`,
      );
    }
    if (segment.endsWith(".")) {
      return refuse("paths/forbidden-character", `segment ${JSON.stringify(segment)} ends in "."`);
    }
    if (segment.length > MAX_PATH_SEGMENT_LENGTH) {
      return refuse("paths/segment-too-long", `segment longer than ${MAX_PATH_SEGMENT_LENGTH}`);
    }
  }
  return { ok: true, segments };
}

/** Case-insensitive key used to detect collisions on case-folding filesystems. */
export function caseFoldKey(path: string): string {
  return path.toLowerCase();
}

/** Byte-order comparison of paths (UTF-8 == code unit order for ASCII paths). */
export function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function pathRefusal(
  reason: TaskFolderRefusalReason,
  path: string,
  message: string,
): TaskFolderRefusal {
  return { reason, path, line: 0, column: 0, message };
}

function refuse(reason: TaskFolderRefusalReason, message: string): PathCheck {
  return { ok: false, reason, message };
}
