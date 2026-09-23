/**
 * `renderTaskFolder`: TaskFolderV1 -> the durable file set (`readme.md` + `evidence/**`)
 * as bytes. Frontmatter is re-emitted in canonical key order with canonical scalar
 * quoting; the preamble and every section body are emitted verbatim, so user-authored
 * Markdown (including `---` lines, fences, and an empty Verification log) survives
 * byte-for-byte. `work/` is never rendered: the workshop evaporates.
 */
import { sha256Hex, stateDigest } from "@eforest/protocol";
import { comparePaths } from "./paths.js";
import {
  TASK_FRONTMATTER_KEYS,
  type EvidenceManifestEntryV1,
  type FolderEntry,
  type TaskFolderDurableViewV1,
  type TaskFolderSnapshot,
  type TaskFolderV1,
  type TaskFrontmatterV1,
} from "./schema.js";

export interface RenderedFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface RenderedTaskFolder {
  readonly folderName: string;
  /** Sorted by path: `evidence/**` then `readme.md`. */
  readonly files: readonly RenderedFile[];
}

const PLAIN_UNSAFE_START = new Set([
  '"',
  "'",
  "[",
  "]",
  "{",
  "}",
  "&",
  "*",
  "!",
  "|",
  ">",
  "%",
  "@",
  "`",
  "#",
  ",",
  "?",
  ":",
  "-",
]);

/** Canonical scalar form of a title: plain when unambiguous, else double-quoted. */
export function renderTitle(title: string): string {
  const plainSafe =
    title.length > 0 &&
    !PLAIN_UNSAFE_START.has(title[0]!) &&
    !title.includes(": ") &&
    !title.includes(" #") &&
    !title.includes("\\") &&
    title === title.trim();
  if (plainSafe) return title;
  return `"${title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function renderFrontmatter(frontmatter: TaskFrontmatterV1): string {
  const lines = TASK_FRONTMATTER_KEYS.map((key) => {
    switch (key) {
      case "title":
        return `title: ${renderTitle(frontmatter.title)}`;
      case "depends_on":
        return `depends_on: [${frontmatter.depends_on.join(", ")}]`;
      case "capstone":
        return `capstone: ${frontmatter.capstone ? "true" : "false"}`;
      default:
        return `${key}: ${String(frontmatter[key])}`;
    }
  });
  return `---\n${lines.join("\n")}\n---\n`;
}

export function renderTaskReadme(folder: TaskFolderV1): string {
  const body = folder.readme.sections.map((section) => `## ${section.name}\n${section.body}`);
  return `${renderFrontmatter(folder.frontmatter)}${folder.readme.preamble}${body.join("")}`;
}

export function evidenceManifest(folder: TaskFolderV1): readonly EvidenceManifestEntryV1[] {
  return [...folder.evidence]
    .sort((a, b) => comparePaths(a.path, b.path))
    .map(({ path, size, sha256 }) => ({ path, size, sha256 }));
}

export function renderTaskFolder(folder: TaskFolderV1): RenderedTaskFolder {
  const encoder = new TextEncoder();
  const files: RenderedFile[] = folder.evidence.map((file) => ({
    path: `evidence/${file.path}`,
    bytes: file.bytes,
  }));
  files.push({ path: "readme.md", bytes: encoder.encode(renderTaskReadme(folder)) });
  files.sort((a, b) => comparePaths(a.path, b.path));
  return { folderName: folder.folderName, files };
}

/** Turn a rendered folder back into a snapshot (for round trips without a disk). */
export function snapshotOfRendered(rendered: RenderedTaskFolder): TaskFolderSnapshot {
  const entries: FolderEntry[] = rendered.files.map((file) => ({
    path: file.path,
    kind: "file",
    bytes: file.bytes,
  }));
  return { folderName: rendered.folderName, entries };
}

/** The durable projection: frontmatter, rendered-readme hash, evidence manifest. No work/. */
export function taskFolderDurableView(folder: TaskFolderV1): TaskFolderDurableViewV1 {
  return {
    v: folder.v,
    folderName: folder.folderName,
    frontmatter: folder.frontmatter,
    readmeSha256: sha256Hex(new TextEncoder().encode(renderTaskReadme(folder))),
    evidence: evidenceManifest(folder),
  };
}

/** SHA-256 over the canonical JSON of the durable view. Changing only `work/` cannot move it. */
export function taskFolderDigest(folder: TaskFolderV1): string {
  return stateDigest(taskFolderDurableView(folder));
}

/** The full parsed value minus evidence bytes: what goldens freeze and property tests compare. */
export function taskFolderValue(folder: TaskFolderV1): unknown {
  return {
    ...folder,
    evidence: evidenceManifest(folder),
  };
}
