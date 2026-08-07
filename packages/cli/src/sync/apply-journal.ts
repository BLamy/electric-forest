import { canonicalJson, sha256Hex, type Event } from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";
import { worktreeDigest } from "@eforest/streamfs";
import { readWorktreeEntries } from "@eforest/streamfs/worktree-node";
import { type WorkspaceState } from "@eforest/workspace";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { clearWorktree, orderedTreePaths, safeTreeTarget } from "../tree-materializer.js";

export const APPLY_JOURNAL_VERSION = 1 as const;
export const APPLY_JOURNAL_NAME = "apply-journal" as const;
export const APPLY_INTENT_NAME = "apply-intent" as const;
export const APPLY_BASE_NAME = "apply-base" as const;

export interface ApplyJournalProvenance {
  /** The event envelope's originating kind. Event envelopes currently carry no client id. */
  readonly type: string;
  /** The event envelope timestamp, retained as provenance without inventing identity. */
  readonly ts: number;
}

export interface ApplyJournalPathDigest {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface ApplyJournalRecord {
  readonly v: typeof APPLY_JOURNAL_VERSION;
  readonly seq: number;
  readonly offset: string;
  readonly kind: string;
  readonly paths: readonly string[];
  readonly beforeDigest: string;
  readonly afterDigest: string;
  readonly pathDigests: readonly ApplyJournalPathDigest[];
  readonly provenance: ApplyJournalProvenance;
  /** SHA-256 over the canonical record without this field. */
  readonly checksum: string;
}

export interface WorktreeSnapshot {
  /** File contents are base64 because the intent must be self-contained. */
  readonly files: Readonly<Record<string, string>>;
  readonly directories: readonly string[];
}

export interface ApplyIntent {
  readonly v: typeof APPLY_JOURNAL_VERSION;
  readonly offset: string;
  readonly event: Event;
  readonly kind: string;
  readonly paths: readonly string[];
  readonly beforeDigest: string;
  readonly afterDigest: string;
  readonly pathDigests: readonly ApplyJournalPathDigest[];
  readonly provenance: ApplyJournalProvenance;
  readonly before: WorktreeSnapshot;
  readonly after: WorktreeSnapshot;
  readonly beforeWorkspace: WorkspaceState;
  readonly afterWorkspace: WorkspaceState;
  /** SHA-256 over the canonical intent without this field. */
  readonly checksum: string;
}

export type ApplyIntentInput = Omit<ApplyIntent, "checksum">;

export interface ApplyBase {
  readonly v: typeof APPLY_JOURNAL_VERSION;
  readonly baseOffset: string;
}

export class ApplyJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplyJournalError";
  }
}

let temporarySequence = 0;

function temporaryPath(path: string): string {
  const directory = dirname(path);
  const name = basename(path);
  while (true) {
    const candidate = join(directory, `.${name}.${temporarySequence}.tmp`);
    temporarySequence += 1;
    if (!existsSync(candidate)) return candidate;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function checksum(value: unknown): string {
  return sha256Hex(Buffer.from(canonicalJson(value), "utf8"));
}

function isPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value === ".ef") return false;
  return (
    !value.startsWith(".ef/") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    value.normalize("NFC") === value &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function parsePathDigest(value: unknown, line: string): ApplyJournalPathDigest {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["after", "before", "path"]) ||
    !isPath(value.path) ||
    (value.before !== null && !isDigest(value.before)) ||
    (value.after !== null && !isDigest(value.after))
  ) {
    throw new ApplyJournalError(`${line} has a malformed path digest`);
  }
  return { path: value.path, before: value.before, after: value.after };
}

function parseProvenance(value: unknown, line: string): ApplyJournalProvenance {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["ts", "type"]) ||
    typeof value.type !== "string" ||
    value.type.length === 0 ||
    typeof value.ts !== "number" ||
    !Number.isFinite(value.ts)
  ) {
    throw new ApplyJournalError(`${line} has malformed provenance`);
  }
  return { type: value.type, ts: value.ts };
}

function parseSnapshot(value: unknown, line: string): WorktreeSnapshot {
  if (!isRecord(value) || !exactKeys(value, ["directories", "files"])) {
    throw new ApplyJournalError(`${line} has malformed worktree snapshot`);
  }
  if (
    !Array.isArray(value.directories) ||
    !value.directories.every(isPath) ||
    new Set(value.directories).size !== value.directories.length ||
    !isRecord(value.files)
  ) {
    throw new ApplyJournalError(`${line} has malformed worktree snapshot entries`);
  }
  for (const [path, content] of Object.entries(value.files)) {
    if (!isPath(path) || typeof content !== "string") {
      throw new ApplyJournalError(`${line} has malformed snapshot file ${path}`);
    }
    try {
      const bytes = Buffer.from(content, "base64");
      if (bytes.toString("base64") !== content) throw new Error("non-canonical base64");
    } catch (error) {
      throw new ApplyJournalError(`${line} has malformed snapshot bytes: ${String(error)}`);
    }
  }
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries(value.files)) files[path] = content as string;
  return { files, directories: [...value.directories].sort() };
}

function parseRecord(value: unknown, line: number): ApplyJournalRecord {
  const label = `apply journal line ${line}`;
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "afterDigest",
      "beforeDigest",
      "checksum",
      "kind",
      "offset",
      "pathDigests",
      "paths",
      "provenance",
      "seq",
      "v",
    ]) ||
    value.v !== APPLY_JOURNAL_VERSION ||
    typeof value.seq !== "number" ||
    !Number.isSafeInteger(value.seq) ||
    typeof value.offset !== "string" ||
    !isWellFormedOffset(value.offset) ||
    value.offset === "-1" ||
    typeof value.kind !== "string" ||
    value.kind.length === 0 ||
    !Array.isArray(value.paths) ||
    !value.paths.every(isPath) ||
    new Set(value.paths).size !== value.paths.length ||
    !isDigest(value.beforeDigest) ||
    !isDigest(value.afterDigest) ||
    !isDigest(value.checksum) ||
    !Array.isArray(value.pathDigests)
  ) {
    throw new ApplyJournalError(`${label} is malformed`);
  }
  const paths = value.paths as string[];
  const pathDigests = value.pathDigests.map((candidate) => parsePathDigest(candidate, label));
  if (
    new Set(pathDigests.map(({ path }) => path)).size !== pathDigests.length ||
    pathDigests.some(({ path }) => !paths.includes(path))
  ) {
    throw new ApplyJournalError(`${label} has path digests outside its affected paths`);
  }
  const recordWithoutChecksum: Omit<ApplyJournalRecord, "checksum"> = {
    v: APPLY_JOURNAL_VERSION,
    seq: value.seq,
    offset: value.offset,
    kind: value.kind,
    paths: [...paths],
    beforeDigest: value.beforeDigest,
    afterDigest: value.afterDigest,
    pathDigests,
    provenance: parseProvenance(value.provenance, label),
  };
  if (checksum(recordWithoutChecksum) !== value.checksum) {
    throw new ApplyJournalError(`${label} checksum does not match its canonical bytes`);
  }
  return { ...recordWithoutChecksum, checksum: value.checksum };
}

function parseJsonLine(source: string, path: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new ApplyJournalError(`${path} is not JSON: ${String(error)}`);
  }
}

function readCanonicalLines(path: string): readonly ApplyJournalRecord[] {
  if (!existsSync(path)) return [];
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    throw new ApplyJournalError(`cannot read ${path}: ${String(error)}`);
  }
  if (source.length === 0) return [];
  if (!source.endsWith("\n") || source.endsWith("\r\n") || source.includes("\r")) {
    throw new ApplyJournalError(`${path} must end with LF-delimited canonical JSON`);
  }
  const records: ApplyJournalRecord[] = [];
  for (const [index, line] of source.slice(0, -1).split("\n").entries()) {
    if (line.length === 0) throw new ApplyJournalError(`${path} line ${index + 1} is empty`);
    const parsed = parseJsonLine(line, `${path} line ${index + 1}`);
    const record = parseRecord(parsed, index + 1);
    if (`${canonicalJson(record)}\n` !== `${line}\n`) {
      throw new ApplyJournalError(`${path} line ${index + 1} is not canonical JSON`);
    }
    const expectedSeq = records.length + 1;
    if (record.seq !== expectedSeq) {
      throw new ApplyJournalError(`${path} sequence expected ${expectedSeq}, got ${record.seq}`);
    }
    const previous = records.at(-1);
    if (previous !== undefined && record.offset <= previous.offset) {
      throw new ApplyJournalError(
        `${path} offset ${record.offset} is not strictly after ${previous.offset}`,
      );
    }
    records.push(record);
  }
  return records;
}

function parseIntent(value: unknown, path: string): ApplyIntent {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "after",
      "afterDigest",
      "afterWorkspace",
      "before",
      "beforeDigest",
      "beforeWorkspace",
      "checksum",
      "event",
      "kind",
      "offset",
      "pathDigests",
      "paths",
      "provenance",
      "v",
    ]) ||
    value.v !== APPLY_JOURNAL_VERSION ||
    typeof value.offset !== "string" ||
    !isWellFormedOffset(value.offset) ||
    value.offset === "-1" ||
    !isRecord(value.event) ||
    typeof value.event.type !== "string" ||
    typeof value.event.ts !== "number" ||
    !Number.isFinite(value.event.ts) ||
    !Array.isArray(value.paths) ||
    !value.paths.every(isPath) ||
    typeof value.kind !== "string" ||
    !isDigest(value.beforeDigest) ||
    !isDigest(value.afterDigest) ||
    !isDigest(value.checksum) ||
    !Array.isArray(value.pathDigests)
  ) {
    throw new ApplyJournalError(`${path} is malformed`);
  }
  const paths = value.paths as string[];
  const pathDigests = value.pathDigests.map((candidate) => parsePathDigest(candidate, path));
  if (
    new Set(paths).size !== paths.length ||
    new Set(pathDigests.map(({ path: pathName }) => pathName)).size !== pathDigests.length ||
    pathDigests.some(({ path: pathName }) => !paths.includes(pathName))
  ) {
    throw new ApplyJournalError(`${path} has inconsistent affected paths`);
  }
  const event: Event = { type: value.event.type, payload: value.event.payload, ts: value.event.ts };
  const intentWithoutChecksum: ApplyIntentInput = {
    v: APPLY_JOURNAL_VERSION,
    offset: value.offset,
    event,
    kind: value.kind,
    paths: [...paths],
    beforeDigest: value.beforeDigest,
    afterDigest: value.afterDigest,
    pathDigests,
    provenance: parseProvenance(value.provenance, path),
    before: parseSnapshot(value.before, path),
    after: parseSnapshot(value.after, path),
    beforeWorkspace: value.beforeWorkspace as WorkspaceState,
    afterWorkspace: value.afterWorkspace as WorkspaceState,
  };
  if (checksum(intentWithoutChecksum) !== value.checksum) {
    throw new ApplyJournalError(`${path} checksum does not match its canonical bytes`);
  }
  return { ...intentWithoutChecksum, checksum: value.checksum };
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeJsonAtomicSync(path: string, value: unknown): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = temporaryPath(path);
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    fsyncDirectory(directory);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary is either renamed or intentionally left for crash forensics.
    }
  }
}

function snapshotFileBytes(root: string, path: string): Uint8Array {
  return new Uint8Array(readFileSync(safeTreeTarget(root, path)));
}

/** Capture all visible worktree bytes while excluding the control directory. */
export function captureWorktreeSnapshot(root: string): WorktreeSnapshot {
  const entries = readWorktreeEntries(root);
  const files: Record<string, string> = {};
  for (const path of Object.keys(entries.files).sort()) {
    files[path] = Buffer.from(snapshotFileBytes(root, path)).toString("base64");
  }
  return {
    files,
    directories: [...entries.directories].sort(),
  };
}

export function snapshotProjection(snapshot: WorktreeSnapshot): {
  readonly files: Readonly<
    Record<string, { readonly contentSha256: string; readonly size: number }>
  >;
} {
  const files: Record<string, { readonly contentSha256: string; readonly size: number }> = {};
  for (const [path, encoded] of Object.entries(snapshot.files)) {
    const bytes = Buffer.from(encoded, "base64");
    files[path] = { contentSha256: sha256Hex(bytes), size: bytes.byteLength };
  }
  return { files };
}

export function snapshotDigest(snapshot: WorktreeSnapshot): string {
  return worktreeDigest(snapshotProjection(snapshot));
}

function writeFileTemp(root: string, path: string, bytes: Uint8Array): void {
  const target = safeTreeTarget(root, path);
  const temporary = temporaryPath(target);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, target);
    fsyncDirectory(dirname(target));
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      // The rename completed or the process was interrupted.
    }
  }
}

/** Restore a complete visible tree with temp-file + rename for every file. */
export function restoreWorktreeSnapshot(root: string, snapshot: WorktreeSnapshot): void {
  clearWorktree(root);
  for (const path of orderedTreePaths(snapshot.directories)) {
    mkdirSync(safeTreeTarget(root, path), { recursive: false, mode: 0o755 });
  }
  for (const path of Object.keys(snapshot.files).sort()) {
    const target = safeTreeTarget(root, path);
    const parent = dirname(target);
    if (!lstatSync(parent).isDirectory())
      throw new ApplyJournalError(`file parent is not a directory: ${path}`);
    writeFileTemp(root, path, Buffer.from(snapshot.files[path]!, "base64"));
  }
  fsyncDirectory(resolve(root));
}

export function journalPath(root: string): string {
  return join(root, ".ef", APPLY_JOURNAL_NAME);
}

export function intentPath(root: string): string {
  return join(root, ".ef", APPLY_INTENT_NAME);
}

export function applyBasePath(root: string): string {
  return join(root, ".ef", APPLY_BASE_NAME);
}

export function readApplyBase(path: string): ApplyBase | undefined {
  if (!existsSync(path)) return undefined;
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    throw new ApplyJournalError(`cannot read ${path}: ${String(error)}`);
  }
  if (!source.endsWith("\n") || source.endsWith("\r\n") || source.includes("\r")) {
    throw new ApplyJournalError(`${path} must be canonical JSON with one trailing LF`);
  }
  const parsed = parseJsonLine(source.slice(0, -1), path);
  if (
    !isRecord(parsed) ||
    !exactKeys(parsed, ["baseOffset", "v"]) ||
    parsed.v !== APPLY_JOURNAL_VERSION ||
    typeof parsed.baseOffset !== "string" ||
    !isWellFormedOffset(parsed.baseOffset)
  ) {
    throw new ApplyJournalError(`${path} is malformed`);
  }
  const result: ApplyBase = { v: APPLY_JOURNAL_VERSION, baseOffset: parsed.baseOffset };
  if (`${canonicalJson(result)}\n` !== source)
    throw new ApplyJournalError(`${path} is not canonical JSON`);
  return result;
}

export async function writeApplyBase(path: string, baseOffset: string): Promise<void> {
  if (!isWellFormedOffset(baseOffset))
    throw new ApplyJournalError(`invalid apply base offset ${baseOffset}`);
  writeJsonAtomicSync(path, { v: APPLY_JOURNAL_VERSION, baseOffset });
}

export function readApplyJournal(path: string): readonly ApplyJournalRecord[] {
  return readCanonicalLines(path);
}

export function readApplyIntent(path: string): ApplyIntent | undefined {
  if (!existsSync(path)) return undefined;
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    throw new ApplyJournalError(`cannot read ${path}: ${String(error)}`);
  }
  if (!source.endsWith("\n") || source.endsWith("\r\n") || source.includes("\r")) {
    throw new ApplyJournalError(`${path} must be canonical JSON with one trailing LF`);
  }
  const json = source.slice(0, -1);
  const parsed = parseJsonLine(json, path);
  if (`${canonicalJson(parsed)}\n` !== source)
    throw new ApplyJournalError(`${path} is not canonical JSON`);
  return parseIntent(parsed, path);
}

export async function writeApplyIntent(path: string, intent: ApplyIntentInput): Promise<void> {
  writeJsonAtomicSync(path, { ...intent, checksum: checksum(intent) });
}

export async function removeApplyIntent(path: string): Promise<void> {
  await rm(path, { force: true });
  try {
    fsyncDirectory(dirname(path));
  } catch {
    // A missing control directory is reported by the next workspace load.
  }
}

export class ApplyJournalWriter {
  private nextSeq: number;

  constructor(readonly path: string) {
    this.nextSeq = readApplyJournal(path).length + 1;
  }

  async append(
    input: Omit<ApplyJournalRecord, "seq" | "v" | "checksum">,
  ): Promise<ApplyJournalRecord> {
    const recordWithoutChecksum: Omit<ApplyJournalRecord, "checksum"> = {
      v: APPLY_JOURNAL_VERSION,
      seq: this.nextSeq,
      ...input,
    };
    const record: ApplyJournalRecord = {
      ...recordWithoutChecksum,
      checksum: checksum(recordWithoutChecksum),
    };
    const line = `${canonicalJson(record)}\n`;
    await mkdir(dirname(this.path), { recursive: true });
    const handle = await open(this.path, "a", 0o600);
    try {
      await handle.write(line, undefined, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.nextSeq += 1;
    return record;
  }
}

export function verifyApplyJournal(path: string): readonly ApplyJournalRecord[] {
  const records = readApplyJournal(path);
  for (const [index, record] of records.entries()) {
    if (index > 0) {
      const previous = records[index - 1]!;
      if (record.beforeDigest !== previous.afterDigest) {
        throw new ApplyJournalError(
          `${path} digest chain breaks between offsets ${previous.offset} and ${record.offset}`,
        );
      }
    }
  }
  return records;
}

export function snapshotPathDigest(snapshot: WorktreeSnapshot, path: string): string | null {
  const encoded = snapshot.files[path];
  return encoded === undefined ? null : sha256Hex(Buffer.from(encoded, "base64"));
}

export function snapshotPaths(snapshot: WorktreeSnapshot): readonly string[] {
  return [...Object.keys(snapshot.files), ...snapshot.directories].sort();
}

export function isApplyIntentPresent(root: string): boolean {
  return existsSync(intentPath(root));
}
