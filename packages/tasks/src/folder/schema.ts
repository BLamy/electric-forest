/**
 * TaskFolderV1 — the frozen syntax-level model of one `.eforest/tasks/<epic>/<id>-<slug>/`
 * folder, exactly as `.eforest/tasks/README.md` describes it: flat YAML frontmatter with
 * eight keys, six required Markdown sections in a fixed order, `evidence/` as durable
 * byte-addressed files, and `work/` as an ephemeral workshop inventory that never enters
 * the durable digest. Nothing here reads a filesystem: a folder is parsed from a
 * `TaskFolderSnapshot`, an inert list of entries, so the same contract applies to a disk
 * directory today and a stream-fs tree in E6-T05.
 */

export const TASK_FOLDER_VERSION = 1 as const;

/** The eight frontmatter keys, in canonical render order. Nothing else is accepted. */
export const TASK_FRONTMATTER_KEYS = [
  "id",
  "epic",
  "title",
  "priority",
  "status",
  "depends_on",
  "estimate",
  "capstone",
] as const;
export type TaskFrontmatterKey = (typeof TASK_FRONTMATTER_KEYS)[number];

/** The six required H2 sections, in the only order accepted. */
export const TASK_SECTIONS = [
  "Goal",
  "Context",
  "Deliverables",
  "Acceptance criteria",
  "Adversarial verification",
  "Verification log",
] as const;
export type TaskSectionName = (typeof TASK_SECTIONS)[number];

export const TASK_FOLDER_STATUSES = [
  "pending",
  "in-progress",
  "implemented",
  "verified",
  "refuted",
  "cancelled",
] as const;
export type TaskFolderStatus = (typeof TASK_FOLDER_STATUSES)[number];

export const TASK_ESTIMATES = ["S", "M", "L"] as const;
export type TaskEstimate = (typeof TASK_ESTIMATES)[number];

/** `E<epic>-T<nn>` with an optional split suffix (`E3-T02a`). */
export const TASK_ID_PATTERN = /^E(0|[1-9][0-9]*)-T([0-9]{2})([a-z])?$/;
/** A dependency is a task id or a bare epic id (`E1` = that epic's capstone). */
export const TASK_DEPENDENCY_PATTERN = /^E(0|[1-9][0-9]*)(-T[0-9]{2}[a-z]?)?$/;
/** The kebab slug after the id in the folder name. */
export const TASK_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Priority is a decimal literal: an integer, or a fraction with no trailing zeros. */
export const TASK_PRIORITY_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/;

export interface TaskFrontmatterV1 {
  readonly id: string;
  readonly epic: number;
  readonly title: string;
  /** Kept as its canonical decimal text so `302.5` and `302` never drift through floats. */
  readonly priority: string;
  readonly status: TaskFolderStatus;
  readonly depends_on: readonly string[];
  readonly estimate: TaskEstimate;
  readonly capstone: boolean;
}

/** A half-open span inside `readme.md`: 1-based lines, 0-based UTF-8 byte offsets. */
export interface ReadmeSpan {
  readonly startLine: number;
  readonly endLine: number;
  readonly startByte: number;
  readonly endByte: number;
}

export interface TaskSectionV1 {
  readonly name: TaskSectionName;
  /** The heading line itself (`## <name>`). */
  readonly heading: ReadmeSpan;
  /** Everything after the heading line up to the next heading (or EOF), verbatim. */
  readonly body: string;
  readonly span: ReadmeSpan;
}

export interface TaskReadmeV1 {
  /** Bytes between the closing `---` line and the first `## Goal`, verbatim. */
  readonly preamble: string;
  readonly sections: readonly TaskSectionV1[];
}

/** One durable evidence file: path under `evidence/`, byte length, SHA-256, bytes. */
export interface EvidenceFileV1 {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

/** The evidence manifest is the byte-addressed view of `evidence/`: no bytes, sorted. */
export interface EvidenceManifestEntryV1 {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

/** One workshop file under `work/`: visible, hashed, never durable. */
export interface WorkshopEntryV1 {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface TaskFolderV1 {
  readonly v: typeof TASK_FOLDER_VERSION;
  readonly folderName: string;
  readonly id: string;
  readonly slug: string;
  readonly frontmatter: TaskFrontmatterV1;
  readonly readme: TaskReadmeV1;
  readonly evidence: readonly EvidenceFileV1[];
  readonly work: readonly WorkshopEntryV1[];
}

/** The durable projection: everything a digest covers. `work/` is absent by construction. */
export interface TaskFolderDurableViewV1 {
  readonly v: typeof TASK_FOLDER_VERSION;
  readonly folderName: string;
  readonly frontmatter: TaskFrontmatterV1;
  /** SHA-256 of the canonically rendered `readme.md`. */
  readonly readmeSha256: string;
  readonly evidence: readonly EvidenceManifestEntryV1[];
}

export type FolderEntryKind = "file" | "directory" | "symlink" | "other";

/**
 * One leaf entry of a folder as the reader saw it, before any validation. `path` is the
 * raw relative path the reader produced (segments joined by `/`); the parser validates
 * it and refuses anything absolute, traversing, or otherwise escaping. Directories are
 * only listed when empty (a non-empty directory is implied by its files).
 */
export interface FolderEntry {
  readonly path: string;
  readonly kind: FolderEntryKind;
  /** Present for files only. */
  readonly bytes?: Uint8Array;
}

export interface TaskFolderSnapshot {
  readonly folderName: string;
  readonly entries: readonly FolderEntry[];
}

/** Every reason a folder can be refused. Frozen; renamed reasons invalidate transcripts. */
export const TASK_FOLDER_REFUSAL_REASONS = [
  "folder/name-invalid",
  "folder/unexpected-entry",
  "folder/readme-missing",
  "folder/readme-not-file",
  "paths/absolute",
  "paths/traversal",
  "paths/empty-segment",
  "paths/forbidden-character",
  "paths/percent-escape",
  "paths/segment-too-long",
  "paths/symlink",
  "paths/unsupported-kind",
  "paths/case-collision",
  "paths/duplicate",
  "evidence/empty-directory",
  "readme/not-utf8",
  "readme/bom",
  "readme/crlf",
  "readme/control-character",
  "readme/no-trailing-newline",
  "frontmatter/missing-open",
  "frontmatter/missing-close",
  "frontmatter/tab",
  "frontmatter/malformed-line",
  "frontmatter/unknown-key",
  "frontmatter/duplicate-key",
  "frontmatter/missing-key",
  "frontmatter/anchor",
  "frontmatter/non-flat",
  "frontmatter/invalid-value",
  "frontmatter/id-mismatch",
  "frontmatter/epic-mismatch",
  "sections/missing",
  "sections/out-of-order",
  "sections/duplicate",
  "sections/unknown",
  "sections/unterminated-fence",
] as const;
export type TaskFolderRefusalReason = (typeof TASK_FOLDER_REFUSAL_REASONS)[number];

/** A refusal names a stable reason, the offending path, and (for readme text) line/column. */
export interface TaskFolderRefusal {
  readonly reason: TaskFolderRefusalReason;
  /** Relative path inside the folder (`readme.md`, `evidence/x`), or `.` for the folder. */
  readonly path: string;
  /** 1-based line inside `readme.md`; 0 when the refusal is not about text. */
  readonly line: number;
  /** 1-based column inside that line; 0 when the refusal is not about text. */
  readonly column: number;
  readonly message: string;
}

export type TaskFolderParseResult =
  | { readonly ok: true; readonly folder: TaskFolderV1 }
  | { readonly ok: false; readonly refusal: TaskFolderRefusal };
