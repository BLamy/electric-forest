import {
  sha256Hex,
  canonicalJson,
  compareOffsets,
  isSnapshotEvent,
  OFFSET_BEFORE_FIRST,
  SNAPSHOT_FORMAT_VERSION,
  type Event,
  type Offset,
} from "@eforest/protocol";
import { readDurableJson, type StreamRecord } from "@eforest/client";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";
import {
  isFsFileContentEvent,
  isFsEvent,
  isFsMergeChangeEvent,
  isFsMergeConflictPayload,
} from "./events.js";
import { applyPatch, patchResultSize } from "./patch/ops.js";
import { fsInitialState, fsReducer } from "./reducer.js";
import {
  contentMap,
  assertCompleteMergeStage,
  unresolvedMergeConflicts,
  withContentMap,
  withMergeConflicts,
  treeDigest,
  type FsFileState,
  type FsTree,
} from "./tree.js";
import { expandThreeWayMergeRecords } from "./merge-records.js";

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
  readonly resolvedDump?: (until?: Offset) => Promise<readonly StreamRecord[]>;
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

export interface BootstrapReadOptions {
  /**
   * Metadata writes and content writes are committed to separate streams. A
   * branch handoff briefly exposes the metadata write before its new stream is
   * attached, so the append validator may need the structural state without
   * requiring the final bytes. Public readers remain strict by default.
   */
  readonly validateContent?: boolean;
}

export interface StreamDumpResult {
  readonly records: readonly StreamRecord[];
  /** Opaque provider cursors aligned one-to-one with records when advertised. */
  readonly transportOffsets?: readonly Offset[];
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
  return sha256Hex(bytes);
}

function snapshotContentRef(contentRef: string, streamId: string): string {
  return `${contentRef}:file:${sha256(new TextEncoder().encode(streamId)).slice(0, 24)}`;
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
  const records = await readStreamDump(root, streamId);
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

/**
 * Providers that physically compact a stream may expose the retained prefix via
 * `/dump`; the published client route remains the fallback for providers that
 * only implement the Durable Streams read surface. Keeping this discovery in
 * the snapshot path lets a retained snapshot bootstrap without asking for the
 * discarded prefix at `?offset=-1`.
 */
function parseDumpRecords(text: string): readonly StreamRecord[] {
  if (text.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed as StreamRecord[];
  } catch {
    // The retained dump endpoint is newline-delimited JSON on the original
    // provider contract; fall through to that parser below.
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as StreamRecord);
}

function parseTransportOffsets(
  response: Response,
  recordCount: number,
): readonly Offset[] | undefined {
  const header = response.headers.get("stream-dump-offsets");
  if (header === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(header);
  } catch {
    throw new Error("stream dump advertised invalid transport offsets");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== recordCount ||
    parsed.some((offset) => typeof offset !== "string" || !isWellFormedOffset(offset))
  ) {
    throw new Error("stream dump transport offsets do not align with records");
  }
  return parsed as Offset[];
}

export async function readStreamDumpWithTransportOffsets(
  root: SnapshotRoot,
  streamId = root.metadataStreamId,
): Promise<StreamDumpResult> {
  const response = await root.fetcher(`${streamUrl(root, streamId)}/dump`);
  if (response.ok) {
    const records = parseDumpRecords(await response.text());
    const transportOffsets = parseTransportOffsets(response, records.length);
    return transportOffsets === undefined ? { records } : { records, transportOffsets };
  }
  if (response.status !== 404) {
    const error = new Error(`stream dump failed with HTTP ${response.status}`) as Error & {
      readonly status?: number;
    };
    Object.defineProperty(error, "status", { value: response.status });
    throw error;
  }
  return {
    records: await readDurableJson<StreamRecord>({
      url: streamUrl(root, streamId),
      fetch: root.fetcher,
    }),
  };
}

export async function readStreamDump(
  root: SnapshotRoot,
  streamId = root.metadataStreamId,
): Promise<readonly StreamRecord[]> {
  return (await readStreamDumpWithTransportOffsets(root, streamId)).records;
}

function reduceMetadata(records: readonly StreamRecord[]): FsTree {
  let state = fsInitialState;
  for (const record of records) {
    if (!isFsEvent(eventWithoutOffset(record))) {
      throw new Error(`snapshot source contains an invalid fs event at ${record.offset}`);
    }
    state = fsReducer(state, record);
  }
  assertCompleteMergeStage(state);
  return state;
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
    readonly mergeConflicts?: unknown;
  };
  if (
    candidate.mergeConflicts !== undefined &&
    (!Array.isArray(candidate.mergeConflicts) ||
      !candidate.mergeConflicts.every(isFsMergeConflictPayload))
  ) {
    throw new Error("snapshot artifact contains invalid merge conflicts");
  }
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

interface ExpectedContent {
  readonly digest: string;
  readonly size: number;
}

function moveSnapshotPaths<T>(paths: Map<string, T>, from: string, to: string): void {
  const prefix = `${from}/`;
  for (const [path, value] of [...paths.entries()]) {
    if (path === from) {
      paths.delete(path);
      paths.set(to, value);
    } else if (path.startsWith(prefix)) {
      paths.delete(path);
      paths.set(`${to}${path.slice(from.length)}`, value);
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

function consumeSnapshotContent(
  contentRecords: readonly StreamRecord[],
  startIndex: number,
  expected: ExpectedContent,
  contentRef: string,
  snapshotOffset: Offset,
): { readonly content: Uint8Array; readonly nextIndex: number } {
  for (let index = startIndex; index < contentRecords.length; index += 1) {
    const content = snapshotContentRecord(contentRecords[index]!, contentRef, snapshotOffset);
    if (content.byteLength === expected.size && sha256(content) === expected.digest) {
      return { content, nextIndex: index + 1 };
    }
  }
  throw new SnapshotIntegrityError(expected.digest, "content-event-missing", snapshotOffset);
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
  const expectedContents = new Map<string, ExpectedContent>();
  let content: Uint8Array | undefined;
  let contentIndex = 0;
  for (const record of expandThreeWayMergeRecords(records)) {
    const event = eventWithoutOffset(record);
    if (!isFsEvent(event)) continue;
    switch (event.type) {
      case "fs.file.create": {
        const previous = paths.get(event.payload.path);
        if (
          previous !== undefined &&
          previous !== event.payload.contentStreamId &&
          event.payload.contentStreamId === file.contentStreamId
        ) {
          const expected = expectedContents.get(event.payload.path);
          if (expected === undefined) {
            throw new SnapshotIntegrityError(
              "content-handoff-expectation",
              "missing",
              snapshotOffset,
            );
          }
          const consumed = consumeSnapshotContent(
            contentRecords,
            contentIndex,
            expected,
            file.contentStreamId,
            snapshotOffset,
          );
          content = consumed.content;
          contentIndex = consumed.nextIndex;
        } else if (previous === undefined) {
          expectedContents.delete(event.payload.path);
        }
        paths.set(event.payload.path, event.payload.contentStreamId);
        break;
      }
      case "fs.file.write": {
        const expected = {
          digest: event.payload.contentSha256,
          size: event.payload.size,
        };
        expectedContents.set(event.payload.path, expected);
        if (paths.get(event.payload.path) !== file.contentStreamId) break;
        const consumed = consumeSnapshotContent(
          contentRecords,
          contentIndex,
          expected,
          file.contentStreamId,
          snapshotOffset,
        );
        content = consumed.content;
        contentIndex = consumed.nextIndex;
        break;
      }
      case "fs.file.patch": {
        const previousExpected = expectedContents.get(event.payload.path);
        if (
          previousExpected === undefined ||
          previousExpected.digest !== event.payload.baseDigest
        ) {
          throw new SnapshotIntegrityError(
            event.payload.baseDigest,
            previousExpected?.digest ?? "missing",
            snapshotOffset,
          );
        }
        let resultSize: number;
        if (paths.get(event.payload.path) === file.contentStreamId) {
          if (content === undefined || sha256(content) !== event.payload.baseDigest) {
            throw new SnapshotIntegrityError(
              event.payload.baseDigest,
              content === undefined ? "missing" : sha256(content),
              snapshotOffset,
            );
          }
          try {
            content = applyPatch(content, event.payload.ops);
            resultSize = content.byteLength;
          } catch (error) {
            throw new SnapshotIntegrityError(
              "patchable-content",
              "invalid",
              snapshotOffset,
              error instanceof Error ? error.message : "invalid file patch",
            );
          }
          if (sha256(content) !== event.payload.resultDigest) {
            throw new SnapshotIntegrityError(
              event.payload.resultDigest,
              sha256(content),
              snapshotOffset,
            );
          }
        } else {
          try {
            resultSize = patchResultSize(previousExpected.size, event.payload.ops);
          } catch (error) {
            throw new SnapshotIntegrityError(
              "patchable-content",
              "invalid",
              snapshotOffset,
              error instanceof Error ? error.message : "invalid file patch",
            );
          }
        }
        expectedContents.set(event.payload.path, {
          digest: event.payload.resultDigest,
          size: resultSize,
        });
        break;
      }
      case "fs.file.delete":
        paths.delete(event.payload.path);
        expectedContents.delete(event.payload.path);
        break;
      case "fs.rename":
        moveSnapshotPaths(paths, event.payload.from, event.payload.to);
        moveSnapshotPaths(expectedContents, event.payload.from, event.payload.to);
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
  const digest = treeDigest(state);
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
  assertCompleteMergeStage(state);
  return state;
}

export async function bootstrapRead(root: SnapshotRoot): Promise<BootstrapReadResult> {
  return bootstrapReadAt(root);
}

/**
 * Read the newest usable snapshot and only the metadata tail through `until`.
 *
 * `until` is an application offset, not a Durable Streams transport cursor.
 * Keeping the cut here (rather than asking the transport for a second live
 * read) is what makes a clone's sampled checkpoint an honest boundary when a
 * writer appends while the materialization is in flight.
 */
export async function bootstrapReadAt(
  root: SnapshotRoot,
  until?: Offset,
  options: BootstrapReadOptions = {},
): Promise<BootstrapReadResult> {
  const records = await fetchRecords(root, root.metadataStreamId);
  const target = until ?? records.at(-1)?.offset ?? OFFSET_BEFORE_FIRST;
  const foundRecord = [...records].reverse().find((record) => {
    const event = eventWithoutOffset(record);
    return (
      isSnapshotEvent(event) &&
      (compareOffsets(record.offset, target) <= 0 ||
        compareOffsets(event.payload.snapshotOffset, target) <= 0) &&
      compareOffsets(event.payload.snapshotOffset, target) <= 0
    );
  });
  if (foundRecord === undefined) throw new Error("stream has no snapshot event");
  const found = { record: foundRecord };
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
    actualDigest = treeDigest(state);
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
  if (root.resolvedDump !== undefined) {
    const conflictRecords = await root.resolvedDump(event.payload.snapshotOffset);
    const firstConflictRecord = conflictRecords[0];
    if (
      firstConflictRecord === undefined ||
      compareOffsets(firstConflictRecord.offset, event.payload.snapshotOffset) < 0
    ) {
      const conflictState = reduceMetadata(conflictRecords);
      withMergeConflicts(state, unresolvedMergeConflicts(conflictState));
    }
  }
  const resolved =
    root.resolvedDump === undefined
      ? await fetchRecords(
          root,
          root.metadataStreamId,
          `?offset=${encodeURIComponent(found.record.offset)}&inclusive=1`,
        )
      : await root.resolvedDump(target);
  const tail = resolved.filter((record) => compareOffsets(record.offset, found.record.offset) > 0);
  const hydrated = await hydrateTailContent(
    root,
    state,
    tail,
    event.payload.snapshotOffset,
    options.validateContent ?? true,
  );
  const reduced = hydrated;
  return {
    snapshotOffset: event.payload.snapshotOffset,
    snapshotEventOffset: found.record.offset,
    stateDigest: treeDigest(reduced),
    state: reduced,
    tail,
  };
}

async function contentGeneration(
  root: SnapshotRoot,
  streamId: string,
  expected: ExpectedContent,
  snapshotOffset: Offset,
): Promise<Uint8Array> {
  const records = await fetchRecords(root, streamId);
  for (const record of records) {
    const event = eventWithoutOffset(record) as unknown as Event;
    if (!isFsFileContentEvent(event) || event.payload.contentStreamId !== streamId) {
      throw new SnapshotIntegrityError("content-event", "invalid", snapshotOffset);
    }
    const bytes = snapshotContentRecord(record, streamId, snapshotOffset);
    if (bytes.byteLength === expected.size && sha256(bytes) === expected.digest) return bytes;
  }
  throw new SnapshotIntegrityError(expected.digest, "content-generation-missing", snapshotOffset);
}

async function optionalContentGeneration(
  root: SnapshotRoot,
  streamId: string,
  expected: ExpectedContent,
  snapshotOffset: Offset,
): Promise<Uint8Array | undefined> {
  try {
    return await contentGeneration(root, streamId, expected, snapshotOffset);
  } catch (error) {
    if (error instanceof SnapshotIntegrityError && error.actual === "content-generation-missing") {
      return undefined;
    }
    throw error;
  }
}

/** Hydrate writes and patch chains that occur after the snapshot artifact. */
async function hydrateTailContent(
  root: SnapshotRoot,
  artifact: FsTree,
  tail: readonly StreamRecord[],
  snapshotOffset: Offset,
  validateContent: boolean,
): Promise<FsTree> {
  const contents = contentMap(artifact);
  const expectedContents = new Map<string, ExpectedContent>();
  for (const [path, file] of Object.entries(artifact.files)) {
    expectedContents.set(path, { digest: file.contentSha256, size: file.size });
  }
  let state = withContentMap(artifact, contents);
  for (const record of tail) {
    const event = eventWithoutOffset(record) as unknown as Event;
    if (isSnapshotEvent(event)) {
      continue;
    }
    if (isFsFileContentEvent(event)) {
      state = fsReducer(state, record);
      contents.clear();
      for (const [streamId, bytes] of contentMap(state)) contents.set(streamId, bytes);
      continue;
    }
    if (!isFsEvent(event)) {
      throw new SnapshotIntegrityError("fs-event", "invalid", snapshotOffset);
    }
    if (isFsMergeChangeEvent(event)) {
      const change = event.payload.change;
      if (change.type === "fs.file.write") {
        expectedContents.set(change.payload.path, {
          digest: change.payload.contentSha256,
          size: change.payload.size,
        });
      } else if (change.type === "fs.file.patch") {
        const file = state.files[change.payload.path];
        if (file === undefined) {
          throw new SnapshotIntegrityError("file-state", "missing", snapshotOffset);
        }
        const previous = expectedContents.get(change.payload.path) ?? {
          digest: file.contentSha256,
          size: file.size,
        };
        if (previous.digest !== change.payload.baseDigest) {
          throw new SnapshotIntegrityError(
            change.payload.baseDigest,
            previous.digest,
            snapshotOffset,
          );
        }
        expectedContents.set(change.payload.path, {
          digest: change.payload.resultDigest,
          size: patchResultSize(previous.size, change.payload.ops),
        });
      } else if (change.type === "fs.file.create") {
        if (state.files[change.payload.path] === undefined) {
          expectedContents.delete(change.payload.path);
        }
      } else if (change.type === "fs.file.delete") {
        expectedContents.delete(change.payload.path);
      } else if (change.type === "fs.rename") {
        moveSnapshotPaths(expectedContents, change.payload.from, change.payload.to);
      }
      const next = fsReducer(withContentMap(state, contents), record);
      contents.clear();
      for (const [streamId, bytes] of contentMap(next)) contents.set(streamId, bytes);
      state = withContentMap(next, contents);
      continue;
    }
    if (event.type === "fs.file.write") {
      const file = state.files[event.payload.path];
      if (file === undefined)
        throw new SnapshotIntegrityError("file-state", "missing", snapshotOffset);
      const expected = { digest: event.payload.contentSha256, size: event.payload.size };
      expectedContents.set(event.payload.path, expected);
      const bytes = await optionalContentGeneration(
        root,
        file.contentStreamId,
        expected,
        snapshotOffset,
      );
      if (bytes !== undefined) contents.set(file.contentStreamId, bytes);
    } else if (event.type === "fs.file.patch") {
      const file = state.files[event.payload.path];
      if (file === undefined)
        throw new SnapshotIntegrityError("file-state", "missing", snapshotOffset);
      const previous = expectedContents.get(event.payload.path) ?? {
        digest: file.contentSha256,
        size: file.size,
      };
      if (previous.digest !== event.payload.baseDigest) {
        throw new SnapshotIntegrityError(event.payload.baseDigest, previous.digest, snapshotOffset);
      }
      let base = contents.get(file.contentStreamId);
      if (base === undefined) {
        base = await optionalContentGeneration(
          root,
          file.contentStreamId,
          previous,
          snapshotOffset,
        );
      }
      const resultSize = patchResultSize(previous.size, event.payload.ops);
      expectedContents.set(event.payload.path, {
        digest: event.payload.resultDigest,
        size: resultSize,
      });
      if (base !== undefined) {
        if (sha256(base) !== event.payload.baseDigest) {
          throw new SnapshotIntegrityError(event.payload.baseDigest, sha256(base), snapshotOffset);
        }
        let result: Uint8Array;
        try {
          result = applyPatch(base, event.payload.ops);
        } catch (error) {
          throw new SnapshotIntegrityError(
            "patchable-content",
            "invalid",
            snapshotOffset,
            error instanceof Error ? error.message : "invalid file patch",
          );
        }
        if (sha256(result) !== event.payload.resultDigest) {
          throw new SnapshotIntegrityError(
            event.payload.resultDigest,
            sha256(result),
            snapshotOffset,
          );
        }
      }
    } else if (event.type === "fs.file.create") {
      const previous = state.files[event.payload.path];
      if (previous !== undefined && previous.contentStreamId !== event.payload.contentStreamId) {
        const expected = expectedContents.get(event.payload.path);
        if (expected !== undefined) {
          const bytes = await optionalContentGeneration(
            root,
            event.payload.contentStreamId,
            expected,
            snapshotOffset,
          );
          if (bytes !== undefined) contents.set(event.payload.contentStreamId, bytes);
        }
      } else if (previous === undefined) {
        expectedContents.delete(event.payload.path);
      }
    } else if (event.type === "fs.file.delete") {
      expectedContents.delete(event.payload.path);
    } else if (event.type === "fs.rename") {
      moveSnapshotPaths(expectedContents, event.payload.from, event.payload.to);
    }
    const next = fsReducer(withContentMap(state, contents), record);
    contents.clear();
    for (const [streamId, bytes] of contentMap(next)) contents.set(streamId, bytes);
    state = withContentMap(next, contents);
  }
  if (!validateContent) return withContentMap(state, contents);
  for (const [path, file] of Object.entries(state.files)) {
    const expected = expectedContents.get(path) ?? {
      digest: file.contentSha256,
      size: file.size,
    };
    let bytes = contents.get(file.contentStreamId);
    if (
      bytes === undefined ||
      bytes.byteLength !== expected.size ||
      sha256(bytes) !== expected.digest
    ) {
      bytes = await contentGeneration(root, file.contentStreamId, expected, snapshotOffset);
      contents.set(file.contentStreamId, bytes);
    }
    if (
      bytes === undefined ||
      bytes.byteLength !== file.size ||
      sha256(bytes) !== file.contentSha256
    ) {
      throw new SnapshotIntegrityError(
        file.contentSha256,
        bytes === undefined ? "missing" : sha256(bytes),
        snapshotOffset,
      );
    }
  }
  return withContentMap(state, contents);
}
