/**
 * E6-T05 projection: the deterministic file set a task's streams imply. Pure function of
 * (replayed task state, live attachment list, content bytes): the readme is the accepted
 * spec text re-rendered with the frontmatter `status` forced to the replayed status —
 * text never outranks replay — and `evidence/**` is exactly the live content attachments
 * by name. Deleting the derived folder and projecting again recreates identical bytes,
 * because nothing here reads the folder: only streams in, bytes out.
 */
import { sha256Hex } from "@eforest/protocol";
import type { TaskState } from "../state.js";
import { checkRelativePath } from "./paths.js";
import { parseTaskFolder } from "./parse.js";
import { renderTaskReadme, type RenderedFile } from "./render.js";
import type { TaskFolderStatus } from "./schema.js";

export interface ProjectedEvidenceSource {
  readonly attachmentId: string;
  /** The attachment's `name`: its path under `evidence/`. */
  readonly name: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface TaskFolderProjectionInput {
  readonly state: TaskState;
  readonly evidence: readonly ProjectedEvidenceSource[];
}

export interface TaskFolderProjection {
  /** `<epic dir>/<id>-<slug>` under `.eforest/tasks/`, from the accepted revision. */
  readonly folderPath: string;
  /** Paths relative to the folder (`readme.md`, `evidence/**`), sorted. */
  readonly files: readonly RenderedFile[];
  readonly readme: string;
}

export class TaskFolderProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskFolderProjectionError";
  }
}

/**
 * Project the folder. Requires an accepted spec (`state.spec`); a task with no revision
 * yet has no folder to project. Every produced path re-passes `checkRelativePath`
 * (the E6-T02 run-2 observation: rendered output is re-gated before any writer sees it).
 */
export function projectTaskFolder(input: TaskFolderProjectionInput): TaskFolderProjection {
  const spec = input.state.spec;
  if (spec === undefined) {
    throw new TaskFolderProjectionError(`task ${input.state.taskId} has no accepted spec revision`);
  }
  const encoder = new TextEncoder();
  const parsed = parseTaskFolder({
    folderName: spec.folder.split("/")[1]!,
    entries: [{ path: "readme.md", kind: "file", bytes: encoder.encode(spec.readme) }],
  });
  if (!parsed.ok) {
    throw new TaskFolderProjectionError(
      `accepted spec of ${input.state.taskId} does not parse: ${parsed.refusal.reason}`,
    );
  }
  const readme = renderTaskReadme({
    frontmatter: { ...parsed.folder.frontmatter, status: input.state.status as TaskFolderStatus },
    readme: parsed.folder.readme,
  });
  const files: RenderedFile[] = [{ path: "readme.md", bytes: encoder.encode(readme) }];
  const seen = new Set<string>(["readme.md"]);
  for (const source of [...input.evidence].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = `evidence/${source.name}`;
    if (seen.has(path)) {
      throw new TaskFolderProjectionError(`duplicate evidence path ${path}`);
    }
    if (sha256Hex(source.bytes) !== source.sha256) {
      throw new TaskFolderProjectionError(
        `evidence ${source.attachmentId} bytes do not hash to their attachment digest`,
      );
    }
    seen.add(path);
    files.push({ path, bytes: source.bytes });
  }
  for (const file of files) {
    const check = checkRelativePath(file.path);
    if (!check.ok) {
      throw new TaskFolderProjectionError(`projected path refused: ${file.path} (${check.reason})`);
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const segment of spec.folder.split("/")) {
    const check = checkRelativePath(segment);
    if (!check.ok) {
      throw new TaskFolderProjectionError(`projected folder refused: ${spec.folder}`);
    }
  }
  return { folderPath: spec.folder, files, readme };
}

export interface ProjectionWritePlan {
  /** Files to create or overwrite, relative to the folder. */
  readonly writes: readonly RenderedFile[];
  /** Managed files (readme.md / evidence/**) present on the branch but not projected. */
  readonly deletes: readonly string[];
}

/**
 * Diff a projection against the branch's current folder bytes (path → SHA-256).
 * Unmanaged paths (`work/**`) are never touched.
 */
export function planProjectionWrites(
  projection: TaskFolderProjection,
  branchFiles: ReadonlyMap<string, string>,
): ProjectionWritePlan {
  const writes: RenderedFile[] = [];
  const projectedPaths = new Set(projection.files.map((file) => file.path));
  for (const file of projection.files) {
    if (branchFiles.get(file.path) !== sha256Hex(file.bytes)) writes.push(file);
  }
  const deletes: string[] = [];
  for (const path of [...branchFiles.keys()].sort()) {
    const managed = path === "readme.md" || path.startsWith("evidence/");
    if (managed && !projectedPaths.has(path)) deletes.push(path);
  }
  return { writes, deletes };
}
