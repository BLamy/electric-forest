import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex, type Event } from "@eforest/protocol";
import { FS_EVENT_VERSION, type WorktreeProjection } from "@eforest/streamfs";
import { readWorktree } from "@eforest/streamfs/worktree-node";
import { BASE_NONE } from "@eforest/streamfs";

/** The mutation half of the shared init/uplink tree-upload primitive. */
export interface TreeUploadTransport {
  /** Dispatches one metadata event to the already-created branch stream. */
  readonly dispatch: (event: Event) => Promise<void>;
  /** Creates one content stream before its first content generation. */
  readonly createContentStream: (streamId: string) => Promise<void>;
  /** Appends one content generation to a content stream. */
  readonly appendContent: (streamId: string, event: Event) => Promise<void>;
}

export interface TreeUploadOptions {
  readonly directory: string;
  readonly branchStreamId: string;
  readonly contentStreamPrefix: string;
  readonly transport: TreeUploadTransport;
  readonly now?: () => number;
}

export interface TreeUploadResult {
  readonly projection: WorktreeProjection;
  readonly metadataEvents: number;
  readonly contentStreams: readonly string[];
}

function event(type: string, payload: Record<string, unknown>, now: () => number): Event {
  return { type, payload, ts: now() } as Event;
}

function compareLexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function insertOrdered(
  values: string[],
  value: string,
  compare: (left: string, right: string) => number,
): void {
  let index = 0;
  while (index < values.length && compare(values[index]!, value) < 0) index += 1;
  values.splice(index, 0, value);
}

function ordered(
  values: Iterable<string>,
  compare: (left: string, right: string) => number,
): string[] {
  const result: string[] = [];
  for (const value of values) insertOrdered(result, value, compare);
  return result;
}

function parentDirectories(paths: readonly string[]): readonly string[] {
  const directories = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let count = 1; count < parts.length; count += 1) {
      directories.add(parts.slice(0, count).join("/"));
    }
  }
  return ordered(directories, (left, right) => {
    const depth = (value: string): number => value.split("/").length;
    return depth(left) - depth(right) || compareLexical(left, right);
  });
}

function contentStreamId(prefix: string, path: string, index: number): string {
  // The path digest makes ids stable across retries while the ordinal keeps two
  // distinct paths with the same truncated digest from sharing a stream.
  return `${prefix}${String(index + 1)}-${sha256Hex(Buffer.from(path, "utf8")).slice(0, 24)}`;
}

/**
 * Walk a directory with E4-T01's one frozen enumerator and upload its content
 * through the caller-supplied dispatch door.  No init-specific behavior lives
 * here: E4-T06 can supply the same transport with a non-empty base ledger.
 */
export async function uploadTree(options: TreeUploadOptions): Promise<TreeUploadResult> {
  if (options.branchStreamId.length === 0)
    throw new TypeError("branch stream id must not be empty");
  if (options.contentStreamPrefix.length === 0) {
    throw new TypeError("content stream prefix must not be empty");
  }
  const now = options.now ?? Date.now;
  const projection = readWorktree(options.directory);
  const paths = ordered(Object.keys(projection.files), compareLexical);
  let metadataEvents = 0;

  for (const path of parentDirectories(paths)) {
    await options.transport.dispatch(event("fs.dir.create", { v: FS_EVENT_VERSION, path }, now));
    metadataEvents += 1;
  }

  const contentStreams: string[] = [];
  for (const [index, path] of paths.entries()) {
    const bytes = readFileSync(join(options.directory, ...path.split("/")));
    const streamId = contentStreamId(options.contentStreamPrefix, path, index);
    await options.transport.createContentStream(streamId);
    contentStreams.push(streamId);
    await options.transport.appendContent(
      streamId,
      event(
        "fs.file.content",
        {
          v: FS_EVENT_VERSION,
          contentStreamId: streamId,
          contentBase64: bytes.toString("base64"),
        },
        now,
      ),
    );
    await options.transport.dispatch(
      event("fs.file.create", { v: FS_EVENT_VERSION, path, contentStreamId: streamId }, now),
    );
    metadataEvents += 1;
    await options.transport.dispatch(
      event(
        "fs.file.write",
        {
          v: FS_EVENT_VERSION,
          path,
          base: BASE_NONE,
          contentSha256: projection.files[path]!.contentSha256,
          size: projection.files[path]!.size,
        },
        now,
      ),
    );
    metadataEvents += 1;
  }

  return { projection, metadataEvents, contentStreams };
}
