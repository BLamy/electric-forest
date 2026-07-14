import { createHash } from "node:crypto";
import {
  canonicalJson,
  compareOffsets,
  isSnapshotEvent,
  OFFSET_BEFORE_FIRST,
  SNAPSHOT_FORMAT_VERSION,
  stateDigest,
  type Event,
  type Offset,
} from "@eforest/protocol";
import { readDurableJson, type StreamRecord } from "@eforest/client";
import { isFsFileContentEvent, isFsEvent } from "./events.js";
import { applyPatch } from "./patch/ops.js";
import { fsInitialState, fsReducer } from "./reducer.js";
import { contentMap, withContentMap, type FsFileState, type FsTree } from "./tree.js";

export interface SnapshotRoot {
  readonly baseUrl: string;
  readonly metadataStreamId: string;
  readonly fetcher: typeof fetch;
  readonly now?: () => number;
  readonly writeContent?: (streamId: string, bytes: Uint8Array) => Promise<void>;
  readonly compact?: () => Promise<{ readonly snapshotOffset: Offset }>;
  readonly dispatchSnapshot?: (
    event: Event,
  ) => Promise<{ readonly event: { readonly offset: Offset } }>;
  /** Optional live state/content readers used when the metadata log is compacted. */
  readonly tree?: () => Promise<FsTree>;
  readonly readFile?: (path: string) => Promise<Uint8Array>;
}

export interface SnapshotReceipt {
  readonly snapshotOffset: Offset;
  readonly stateDigest: string;
  readonly contentRef: string;
  readonly snapshotEventOffset: Offset;
}

export interface BootstrapReadResult {
  readonly snapshotOffset: Offset;
  readonly snapshotEventOffset: Offset;
  readonly stateDigest: string;
  readonly state: FsTree;
  readonly tail: readonly StreamRecord[];
}

export class SnapshotIntegrityError extends Error {
  readonly expected: string;
  readonly actual: string;
  readonly snapshotOffset: Offset;

  constructor(expected: string, actual: string, snapshotOffset: Offset, message?: string) {
    super(
      message ??
        `snapshot integrity failed at ${snapshotOffset}: expected ${expected}, got ${actual}`,
    );
    this.name = "SnapshotIntegrityError";
    this.expected = expected;
    this.actual = actual;
    this.snapshotOffset = snapshotOffset;
  }
}

function streamUrl(root: SnapshotRoot, streamId: string): string {
  return `${root.baseUrl.replace(/\/+$/, "")}/streams/${encodeURIComponent(streamId)}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function snapshotContentRef(contentRef: string, streamId: string): string {
  return `${contentRef}:file:${sha256(Buffer.from(streamId, "utf8")).slice(0, 24)}`;
}

function eventWithoutOffset(record: StreamRecord): Record<string, unknown> {
  const event = { type: record.type, payload: record.payload, ts: record.ts };
  return event;
}

async function fetchRecords(
  root: SnapshotRoot,
  streamId: string,
  path = "?offset=-1",
): Promise<readonly StreamRecord[]> {
  const records = await readDurableJson<StreamRecord>({
    url: streamUrl(root, streamId),
    fetch: root.fetcher,
  });
  if (!path.startsWith("?")) return records;
  const params = new URLSearchParams(path.slice(1));
  const offset = params.get("offset") as Offset | null;
  if (offset === null || offset === OFFSET_BEFORE_FIRST) return records;
  const inclusive = params.get("inclusive") === "1";
  return records.filter((record) =>
    inclusive
      ? compareOffsets(record.offset, offset) >= 0
      : compareOffsets(record.offset, offset) > 0,
  );
}

function reduceMetadata(records: readonly StreamRecord[]): FsTree {
  let state = fsInitialState;
  for (const record of records) {
    if (!isFsEvent(eventWithoutOffset(record))) {
      throw new Error(`snapshot source contains an invalid fs event at ${record.offset}`);
    }
    state = fsReducer(state, record);
  }
  return state;
}

function snapshotRecord(
  records: readonly StreamRecord[],
): { readonly record: StreamRecord } | undefined {
  for (const record of [...records].reverse()) {
    const event = eventWithoutOffset(record);
    if (isSnapshotEvent(event)) return { record };
  }
  return undefined;
}

function assertTree(value: unknown): asserts value is FsTree {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Object.hasOwn(value, "files") ||
    !Object.hasOwn(value, "dirs") ||
    !Object.hasOwn(value, "tombstones")
  ) {
    throw new Error("snapshot artifact is not a filesystem tree");
  }
  const candidate = value as {
    readonly files: Record<string, unknown>;
    readonly dirs: Record<string, unknown>;
    readonly tombstones: Record<string, unknown>;
  };
  for (const file of Object.values(candidate.files)) {
    if (
      file === null ||
      typeof file !== "object" ||
      Array.isArray(file) ||
      typeof (file as Record<string, unknown>).contentStreamId !== "string" ||
      typeof (file as Record<string, unknown>).contentSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test((file as Record<string, unknown>).contentSha256 as string) ||
      typeof (file as Record<string, unknown>).lastContentOffset !== "string" ||
      !Number.isSafeInteger((file as Record<string, unknown>).size) ||
      ((file as Record<string, unknown>).size as number) < 0
    ) {
      throw new Error("snapshot artifact contains an invalid file state");
    }
  }
  for (const directory of Object.values(candidate.dirs)) {
    if (directory === null || typeof directory !== "object" || Array.isArray(directory)) {
      throw new Error("snapshot artifact contains an invalid directory state");
    }
  }
  for (const tombstone of Object.values(candidate.tombstones)) {
    if (
      tombstone === null ||
      typeof tombstone !== "object" ||
      Array.isArray(tombstone) ||
      typeof (tombstone as Record<string, unknown>).contentStreamId !== "string"
    ) {
      throw new Error("snapshot artifact contains an invalid tombstone state");
    }
  }
}

async function writeContentStream(
  root: SnapshotRoot,
  contentRef: string,
  bytes: Uint8Array,
): Promise<void> {
  if (root.writeContent === undefined) {
    throw new Error("snapshot root must provide a content-stream writer");
  }
  await root.writeContent(contentRef, bytes);
}

function moveSnapshotPaths(paths: Map<string, string>, from: string, to: string): void {
  const prefix = `${from}/`;
  for (const [path, streamId] of [...paths.entries()]) {
    if (path === from) {
      paths.delete(path);
      paths.set(to, streamId);
    } else if (path.startsWith(prefix)) {
      paths.delete(path);
      paths.set(`${to}${path.slice(from.length)}`, streamId);
    }
  }
}

function snapshotContentRecord(
  record: StreamRecord,
  contentRef: string,
  snapshotOffset: Offset,
): Uint8Array {
  const event = eventWithoutOffset(record);
  if (!isFsFileContentEvent(event) || event.payload.contentStreamId !== contentRef) {
    throw new SnapshotIntegrityError("content-event", "invalid", snapshotOffset);
  }
  const bytes = Buffer.from(event.payload.contentBase64, "base64");
  if (bytes.toString("base64") !== event.payload.contentBase64) {
    throw new SnapshotIntegrityError("canonical-base64", "invalid", snapshotOffset);
  }
  return bytes;
}

async function materializeFileContent(
  root: SnapshotRoot,
  records: readonly StreamRecord[],
  path: string,
  file: FsFileState,
  snapshotOffset: Offset,
): Promise<Uint8Array> {
  const contentRecords = await fetchRecords(root, file.contentStreamId);
  const paths = new Map<string, string>();
  let content: Uint8Array | undefined;
  let contentIndex = 0;
  for (const record of records) {
    const event = eventWithoutOffset(record);
    if (!isFsEvent(event)) continue;
    switch (event.type) {
      case "fs.file.create":
        paths.set(event.payload.path, event.payload.contentStreamId);
        break;
      case "fs.file.write": {
        if (paths.get(event.payload.path) !== file.contentStreamId) break;
        const contentRecord = contentRecords[contentIndex];
        if (contentRecord === undefined) {
          throw new SnapshotIntegrityError("content-event", "missing", snapshotOffset);
        }
        content = snapshotContentRecord(contentRecord, file.contentStreamId, snapshotOffset);
        contentIndex += 1;
        break;
      }
      case "fs.file.patch": {
        if (paths.get(event.payload.path) !== file.contentStreamId || content === undefined) break;
        try {
          content = applyPatch(content, event.payload.ops);
        } catch (error) {
          throw new SnapshotIntegrityError(
            "patchable-content",
            "invalid",
            snapshotOffset,
            error instanceof Error ? error.message : "invalid file patch",
          );
        }
        break;
      }
      case "fs.file.delete":
        paths.delete(event.payload.path);
        break;
      case "fs.rename":
        moveSnapshotPaths(paths, event.payload.from, event.payload.to);
        break;
      default:
        break;
    }
  }
  if (paths.get(path) !== file.contentStreamId || content === undefined) {
    throw new SnapshotIntegrityError("materialized-content", "missing", snapshotOffset);
  }
  if (content.byteLength !== file.size || sha256(content) !== file.contentSha256) {
    throw new SnapshotIntegrityError(file.contentSha256, sha256(content), snapshotOffset);
  }
  return content;
}

export async function createSnapshot(root: SnapshotRoot): Promise<SnapshotReceipt> {
  const records = await fetchRecords(root, root.metadataStreamId);
  const snapshotOffset = records.at(-1)?.offset ?? OFFSET_BEFORE_FIRST;
  const state = root.tree === undefined ? reduceMetadata(records) : await root.tree();
  const artifact = Buffer.from(canonicalJson(state), "utf8");
  const digest = stateDigest(state);
  const contentRef = `${root.metadataStreamId}:snapshot:${sha256(
    Buffer.from(`${snapshotOffset}:${digest}`, "utf8"),
  ).slice(0, 24)}`;
  await writeContentStream(root, contentRef, artifact);
  const knownContents = contentMap(state);
  for (const [path, file] of Object.entries(state.files)) {
    const known = knownContents.get(file.contentStreamId);
    const bytes =
      known !== undefined && known.byteLength === file.size && sha256(known) === file.contentSha256
        ? known
        : root.readFile === undefined
          ? await materializeFileContent(root, records, path, file, snapshotOffset)
          : await root.readFile(path);
    await writeContentStream(root, snapshotContentRef(contentRef, file.contentStreamId), bytes);
  }
  const event = {
    type: "fs.snapshot",
    payload: {
      snapshotOffset,
      stateDigest: digest,
      contentRef,
      formatVersion: SNAPSHOT_FORMAT_VERSION,
    },
    ts: root.now?.() ?? 0,
  };
  if (root.dispatchSnapshot === undefined) {
    throw new Error("snapshot root must provide a metadata dispatcher");
  }
  const dispatched = await root.dispatchSnapshot(event);
  const snapshotEventOffset = dispatched.event.offset;
  return {
    snapshotOffset,
    stateDigest: digest,
    contentRef,
    snapshotEventOffset: snapshotEventOffset as Offset,
  };
}

export async function compactSnapshot(
  root: SnapshotRoot,
): Promise<{ readonly snapshotOffset: Offset }> {
  if (root.compact !== undefined) return root.compact();
  throw new Error("snapshot root must provide a compaction operation");
}

async function readArtifact(
  root: SnapshotRoot,
  contentRef: string,
  snapshotOffset: Offset,
): Promise<FsTree> {
  const records = await fetchRecords(root, contentRef);
  const chunks = records.map((record) => snapshotContentRecord(record, contentRef, snapshotOffset));
  const artifact = Buffer.concat(chunks);
  const actual = sha256(artifact);
  let parsed: unknown;
  try {
    const text = artifact.toString("utf8");
    parsed = JSON.parse(text);
    if (canonicalJson(parsed) !== text) throw new Error("non-canonical artifact");
  } catch (error) {
    throw new SnapshotIntegrityError(
      "valid-canonical-artifact",
      actual,
      snapshotOffset,
      error instanceof Error ? error.message : "invalid snapshot artifact",
    );
  }
  try {
    assertTree(parsed);
  } catch (error) {
    throw new SnapshotIntegrityError(
      "filesystem-tree",
      actual,
      snapshotOffset,
      error instanceof Error ? error.message : "invalid snapshot tree",
    );
  }
  return parsed;
}

export function reduceSnapshotPlusTail(
  artifact: FsTree,
  tailEvents: readonly StreamRecord[],
): FsTree {
  let state = artifact;
  for (const record of tailEvents) {
    const event = eventWithoutOffset(record);
    if (isFsFileContentEvent(event)) continue;
    state = fsReducer(state, record);
  }
  return state;
}

export async function bootstrapRead(root: SnapshotRoot): Promise<BootstrapReadResult> {
  const records = await fetchRecords(root, root.metadataStreamId);
  const found = snapshotRecord(records);
  if (found === undefined) throw new Error("stream has no snapshot event");
  const event = eventWithoutOffset(found.record);
  if (!isSnapshotEvent(event)) throw new Error("invalid snapshot event");
  let artifact: FsTree;
  try {
    artifact = await readArtifact(root, event.payload.contentRef, event.payload.snapshotOffset);
  } catch (error) {
    if (error instanceof SnapshotIntegrityError) throw error;
    throw new SnapshotIntegrityError(
      "valid-canonical-artifact",
      "invalid",
      event.payload.snapshotOffset,
      error instanceof Error ? error.message : "invalid snapshot artifact",
    );
  }
  let state: FsTree;
  try {
    state = await (async () => {
      const contents = contentMap(artifact);
      for (const file of Object.values(artifact.files)) {
        const contentRef = snapshotContentRef(event.payload.contentRef, file.contentStreamId);
        const records = await fetchRecords(root, contentRef);
        if (records.length !== 1) {
          throw new SnapshotIntegrityError(
            "one-content-event",
            "invalid",
            event.payload.snapshotOffset,
          );
        }
        const bytes = snapshotContentRecord(records[0]!, contentRef, event.payload.snapshotOffset);
        if (bytes.byteLength !== file.size || sha256(bytes) !== file.contentSha256) {
          throw new SnapshotIntegrityError(
            file.contentSha256,
            sha256(bytes),
            event.payload.snapshotOffset,
          );
        }
        contents.set(file.contentStreamId, bytes);
      }
      return withContentMap(artifact, contents);
    })();
  } catch (error) {
    if (error instanceof SnapshotIntegrityError) throw error;
    throw new SnapshotIntegrityError(
      "snapshot-file-content",
      "invalid",
      event.payload.snapshotOffset,
      error instanceof Error ? error.message : "invalid snapshot file content",
    );
  }
  let actualDigest: string;
  try {
    actualDigest = stateDigest(state);
  } catch (error) {
    throw new SnapshotIntegrityError(
      event.payload.stateDigest,
      "invalid",
      event.payload.snapshotOffset,
      error instanceof Error ? error.message : "snapshot digest could not be computed",
    );
  }
  if (actualDigest !== event.payload.stateDigest) {
    throw new SnapshotIntegrityError(
      event.payload.stateDigest,
      actualDigest,
      event.payload.snapshotOffset,
    );
  }
  const tail = await fetchRecords(
    root,
    root.metadataStreamId,
    `?offset=${encodeURIComponent(found.record.offset)}&inclusive=1`,
  );
  const reduced = reduceSnapshotPlusTail(state, tail);
  return {
    snapshotOffset: event.payload.snapshotOffset,
    snapshotEventOffset: found.record.offset,
    stateDigest: stateDigest(reduced),
    state: reduced,
    tail,
  };
}
