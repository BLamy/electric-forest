import { sha256Hex, type Event } from "@eforest/protocol";
import type { WorkspaceFileBase } from "@eforest/workspace";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SAFE_OFFSET_BYTE = /^[A-Za-z0-9._-]$/;

function escapedOffset(offset: string): string {
  return [...Buffer.from(offset, "utf8")]
    .map((byte) => {
      const character = String.fromCharCode(byte);
      return SAFE_OFFSET_BYTE.test(character)
        ? character
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

function validRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.endsWith("/") &&
    path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

/** Return the deterministic sibling name for a stream-winning event. */
export function conflictFileName(path: string, offset: string): string {
  if (!validRelativePath(path)) throw new Error(`invalid workspace path: ${path}`);
  return `${path}.conflict-${escapedOffset(offset)}`;
}

export interface SurfaceConflictInput {
  readonly workspaceRoot: string;
  readonly path: string;
  readonly winningOffset: string;
  readonly loserBytes: Uint8Array;
}

export interface SurfaceConflictResult {
  readonly conflictFile: string;
  readonly loserSha256: string;
}

type ConflictMetadata = {
  readonly path: string;
  readonly conflictFile: string;
  readonly winningOffset: string;
};

function conflictMetadataPath(root: string): string {
  return join(root, ".ef", "conflicts.jsonl");
}

/** Persist provenance separately from the worktree so opaque offsets remain opaque. */
export function rememberConflict(input: {
  readonly workspaceRoot: string;
  readonly path: string;
  readonly winningOffset: string;
  readonly conflictFile?: string;
}): void {
  const root = resolve(input.workspaceRoot);
  const conflictFile = input.conflictFile ?? conflictFileName(input.path, input.winningOffset);
  const metadata: ConflictMetadata = {
    path: input.path,
    conflictFile,
    winningOffset: input.winningOffset,
  };
  mkdirSync(join(root, ".ef"), { recursive: true });
  const target = conflictMetadataPath(root);
  let existing = "";
  try {
    existing = readFileSync(target, "utf8");
  } catch {
    // Created on first surfaced conflict.
  }
  const line = JSON.stringify(metadata);
  if (!existing.split("\n").includes(line)) appendFileSync(target, `${line}\n`, { mode: 0o600 });
}

export function readRememberedConflicts(root: string): ReadonlySet<string> {
  try {
    return new Set(
      readFileSync(conflictMetadataPath(resolve(root)), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as ConflictMetadata).conflictFile),
    );
  } catch {
    return new Set();
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Preserve loser bytes before a caller overwrites the contested working path.
 * The only temporary file used by this operation is under .ef/tmp.
 */
export function surfaceConflict(input: SurfaceConflictInput): SurfaceConflictResult {
  const conflictFile = conflictFileName(input.path, input.winningOffset);
  const root = resolve(input.workspaceRoot);
  const target = resolve(root, conflictFile);
  const relativeTarget = relative(root, target);
  if (!validRelativePath(relativeTarget) || relativeTarget !== conflictFile) {
    throw new Error(`conflict target escapes workspace: ${conflictFile}`);
  }
  const parent = dirname(target);
  const tmpDirectory = join(root, ".ef", "tmp");
  mkdirSync(parent, { recursive: true });
  mkdirSync(tmpDirectory, { recursive: true });

  const bytes = Buffer.from(input.loserBytes);
  const loserSha256 = sha256Hex(bytes);
  if (existsSync(target)) {
    if (!lstatSync(target).isFile())
      throw new Error(`conflict target is not a file: ${conflictFile}`);
    const existing = readFileSync(target);
    if (!existing.equals(bytes)) {
      throw new Error(`conflict target contains different bytes: ${conflictFile}`);
    }
    rememberConflict({ ...input, conflictFile });
    return { conflictFile, loserSha256 };
  }

  const temporary = join(
    tmpDirectory,
    `.conflict-${sha256Hex(Buffer.from(conflictFile, "utf8"))}-${loserSha256}.tmp`,
  );
  if (existsSync(temporary)) {
    const staged = readFileSync(temporary);
    if (!staged.equals(bytes)) throw new Error(`conflict staging file contains different bytes`);
    unlinkSync(temporary);
  }
  const descriptor = openSync(temporary, "wx", 0o644);
  try {
    writeSync(descriptor, bytes, 0, bytes.byteLength, 0);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (process.env.EFOREST_CONFLICT_FAILPOINT === "after-flush") {
    throw new Error("injected conflict failure after loser flush");
  }
  if (process.env.EFOREST_CONFLICT_FAILPOINT === "after-flush-kill") {
    process.kill(process.pid, "SIGKILL");
  }
  try {
    renameSync(temporary, target);
    fsyncDirectory(parent);
  } catch (error) {
    if (existsSync(target) && readFileSync(target).equals(bytes)) {
      if (existsSync(temporary)) unlinkSync(temporary);
      rememberConflict({ ...input, conflictFile });
      return { conflictFile, loserSha256 };
    }
    throw error;
  }
  rememberConflict({ ...input, conflictFile });
  return { conflictFile, loserSha256 };
}

export type CollisionKind =
  | "content-vs-modify"
  | "content-vs-add"
  | "delete-vs-modify"
  | "delete-vs-add"
  | "equal-bytes"
  | "delete-vs-delete"
  | "content-vs-delete"
  | "type-collision"
  | "echo"
  | "no-conflict";

export interface CollisionClassification {
  readonly kind: CollisionKind;
  readonly path: string;
  readonly winningOffset: string | undefined;
  readonly preservesLoser: boolean;
}

export interface JournalView {
  readonly offsets?: readonly string[];
  readonly records?: readonly { readonly offset: string; readonly path?: string }[];
  readonly localKind?: "file" | "directory";
}

type RemoteRecord = Event & { readonly offset?: string };

function remotePath(event: RemoteRecord): string | undefined {
  const payload = event.payload as Record<string, unknown>;
  return typeof payload.path === "string" ? payload.path : undefined;
}

function isEcho(
  offset: string | undefined,
  path: string | undefined,
  journal: JournalView,
): boolean {
  if (offset !== undefined && journal.offsets?.includes(offset)) return true;
  return (
    offset !== undefined &&
    journal.records?.some(
      (record) => record.offset === offset && (record.path === undefined || record.path === path),
    ) === true
  );
}

/** Classify a remote file event against the local ledger and current bytes. */
export function classifyCollision(
  remoteEvent: RemoteRecord,
  ledgerEntry: WorkspaceFileBase | undefined,
  workingBytes: Uint8Array | undefined,
  journalView: JournalView = {},
): CollisionClassification {
  const path = remotePath(remoteEvent) ?? "";
  const winningOffset = remoteEvent.offset;
  if (isEcho(winningOffset, path, journalView)) {
    return { kind: "echo", path, winningOffset, preservesLoser: false };
  }
  const remoteIsDelete = remoteEvent.type === "fs.file.delete";
  const remoteIsContent =
    remoteEvent.type === "fs.file.create" ||
    remoteEvent.type === "fs.file.write" ||
    remoteEvent.type === "fs.file.patch";
  const remoteIsDirectory = remoteEvent.type === "fs.dir.create";
  if (
    (remoteIsContent && journalView.localKind === "directory") ||
    (remoteIsDirectory && journalView.localKind === "file")
  ) {
    return {
      kind: "type-collision",
      path,
      winningOffset,
      preservesLoser: workingBytes !== undefined,
    };
  }
  if (!remoteIsDelete && !remoteIsContent) {
    return { kind: "no-conflict", path, winningOffset, preservesLoser: false };
  }
  const localKind =
    workingBytes === undefined
      ? ledgerEntry === undefined
        ? "none"
        : "delete"
      : ledgerEntry === undefined
        ? "add"
        : sha256Hex(workingBytes) === ledgerEntry.contentSha256 &&
            workingBytes.byteLength === ledgerEntry.size
          ? "clean"
          : "modify";
  if (remoteIsDelete) {
    return {
      kind:
        localKind === "delete"
          ? "delete-vs-delete"
          : localKind === "add"
            ? "delete-vs-add"
            : "delete-vs-modify",
      path,
      winningOffset,
      preservesLoser: localKind !== "delete",
    };
  }
  const remoteDigest = (remoteEvent.payload as { readonly contentSha256?: unknown }).contentSha256;
  if (
    typeof remoteDigest === "string" &&
    workingBytes !== undefined &&
    sha256Hex(workingBytes) === remoteDigest
  ) {
    return { kind: "equal-bytes", path, winningOffset, preservesLoser: false };
  }
  if (localKind === "none" || localKind === "clean") {
    return { kind: "no-conflict", path, winningOffset, preservesLoser: false };
  }
  return {
    kind:
      localKind === "delete"
        ? "content-vs-delete"
        : localKind === "add"
          ? "content-vs-add"
          : "content-vs-modify",
    path,
    winningOffset,
    preservesLoser: localKind !== "delete",
  };
}
