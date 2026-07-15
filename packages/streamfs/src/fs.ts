import { createHash } from "node:crypto";
import {
  compareOffsets,
  isEvent,
  isSnapshotEvent,
  type Event,
  type Offset,
} from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import {
  appendDurableJson,
  appendDurableJsonBatch,
  createDurableJsonStream,
  forkDurableJsonStream,
  headDurableJsonStream,
  isDurableConflict,
  isDurableExistsConflict,
  isDurableNotFound,
  readDurableJson,
  type StreamRecord,
} from "@eforest/client";
import { FS_EVENT_VERSION } from "./version.js";
import {
  assertFsEvent,
  isFsBranchForkEvent,
  isFsFastForwardMergeEvent,
  isFsBranchMergeEvent,
  isFsFileContentEvent,
  isValidFsPath,
  type FsBranchForkEvent,
  type FsBranchMergeEvent,
  type FsFileContentEvent,
} from "./events.js";
import { chooseWriteEvent } from "./patch/choose.js";
import { applyPatch, patchResultSize } from "./patch/ops.js";
import { BASE_NONE } from "./fencing.js";
import {
  assertCompleteMergeStage,
  contentMap,
  listTree,
  treeDigest,
  type FsFileState,
  type FsTree,
} from "./tree.js";
import {
  branchContentStreamPrefix,
  branchMetadataStreamId,
  createBranch,
  isBranchContentStreamId,
  isBranchName,
  markBranchState,
  type CreateBranchOptions,
  type CreateBranchResult,
} from "./branch.js";
import { fsInitialState, fsReducer } from "./reducer.js";
import { watch, type StreamFsRepoWatchOptions, type StreamFsWatcher } from "./watch.js";
import {
  bootstrapRead as bootstrapSnapshotRead,
  compactSnapshot,
  createSnapshot as createSnapshotForRoot,
  type BootstrapReadResult,
  type SnapshotReceipt,
} from "./snapshot.js";
import { expandThreeWayMergeRecords } from "./merge-records.js";

export interface StreamFsOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
}

export class StreamFsError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StreamFsError";
    this.code = code;
  }
}

export class RepoExistsError extends StreamFsError {
  constructor(name: string) {
    super("repo_exists", `repo ${name} already exists`);
    this.name = "RepoExistsError";
  }
}

export class RepoNotFoundError extends StreamFsError {
  constructor(name: string) {
    super("repo_not_found", `repo ${name} does not exist`);
    this.name = "RepoNotFoundError";
  }
}

export class FileExistsError extends StreamFsError {
  constructor(path: string) {
    super("file_exists", `file ${path} already exists`);
    this.name = "FileExistsError";
  }
}

export class FileNotFoundError extends StreamFsError {
  constructor(path: string) {
    super("file_not_found", `file ${path} does not exist`);
    this.name = "FileNotFoundError";
  }
}

export class DirectoryExistsError extends StreamFsError {
  constructor(path: string) {
    super("directory_exists", `directory ${path} already exists`);
    this.name = "DirectoryExistsError";
  }
}

export class DirectoryNotFoundError extends StreamFsError {
  constructor(path: string) {
    super("directory_not_found", `directory ${path} does not exist`);
    this.name = "DirectoryNotFoundError";
  }
}

export class DirectoryNotEmptyError extends StreamFsError {
  constructor(path: string) {
    super("directory_not_empty", `directory ${path} is not empty`);
    this.name = "DirectoryNotEmptyError";
  }
}

export class InvalidRenameError extends StreamFsError {
  constructor(from: string, to: string, message: string) {
    super("invalid_rename", `cannot rename ${from} to ${to}: ${message}`);
    this.name = "InvalidRenameError";
  }
}

export class InvalidFsPathError extends StreamFsError {
  constructor(path: string) {
    super("invalid_path", `invalid filesystem path ${JSON.stringify(path)}`);
    this.name = "InvalidFsPathError";
  }
}

export class ContentIntegrityError extends StreamFsError {
  readonly path: string;

  constructor(path: string, message: string) {
    super("content_integrity", `content integrity failed for ${path}: ${message}`);
    this.name = "ContentIntegrityError";
    this.path = path;
  }
}

export class FsHttpError extends StreamFsError {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const detail = body !== null && typeof body === "object" ? JSON.stringify(body) : String(body);
    super("http_error", `stream-fs HTTP request failed with ${status}: ${detail}`);
    this.name = "FsHttpError";
    this.status = status;
    this.body = body;
  }
}

export interface FsDispatchReceipt {
  readonly event: StreamRecord;
  readonly head: string;
}

type ContentEvent = FsFileContentEvent;

interface DecodedContentRecord {
  readonly content: Uint8Array;
  readonly digest: string;
  readonly size: number;
}

interface ExpectedContent {
  readonly digest: string;
  readonly size: number;
}

function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.length === 0) throw new TypeError("baseUrl must not be empty");
  return normalized;
}

function repoName(name: string): string {
  if (name.length === 0 || name.includes("/") || name.includes("\0")) {
    throw new StreamFsError("invalid_repo_name", "repo name must be non-empty and slash-free");
  }
  return name;
}

function metadataStreamId(name: string): string {
  return `fs:${name}:main:meta`;
}

function streamUrl(baseUrl: string, streamId: string): string {
  return `${baseUrl}/streams/${encodeURIComponent(streamId)}`;
}

function ensurePath(path: string): void {
  if (!isValidFsPath(path)) throw new InvalidFsPathError(path);
}

function bytesOf(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function offsetOrdinal(offset: string): number {
  if (offset === "-1") return -1;
  const raw = offset.slice(offset.lastIndexOf("_") + 1);
  const ordinal = Number(raw);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new StreamFsError("invalid_offset", `cannot allocate after malformed offset ${offset}`);
  }
  return ordinal;
}

function nextApplicationOffset(records: readonly StreamRecord[]): Offset {
  let ordinal = -1;
  for (const record of records) {
    ordinal = Math.max(ordinal, offsetOrdinal(record.offset));
    if (isFastForwardMergeRecord(record)) {
      ordinal = Math.max(ordinal, offsetOrdinal(record.payload.mergedThroughOffset));
    }
  }
  return offsetForOrdinal(ordinal + 1);
}

function findLastRecordIndex(
  records: readonly StreamRecord[],
  predicate: (record: StreamRecord) => boolean,
): number {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (predicate(records[index]!)) return index;
  }
  return -1;
}

function treeFile(tree: FsTree, path: string): FsFileState {
  const file = tree.files[path];
  if (file === undefined) throw new FileNotFoundError(path);
  return file;
}

function parentPath(path: string): string | undefined {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? undefined : path.slice(0, separator);
}

function ensureParentDirectory(tree: FsTree, path: string): void {
  const parent = parentPath(path);
  if (parent !== undefined && tree.dirs[parent] === undefined) {
    throw new DirectoryNotFoundError(parent);
  }
}

function hasLiveDescendant(tree: FsTree, path: string): boolean {
  const prefix = `${path}/`;
  return [...Object.keys(tree.files), ...Object.keys(tree.dirs)].some((entry) =>
    entry.startsWith(prefix),
  );
}

function isContentEvent(value: unknown): value is ContentEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const event = { ...(value as Record<string, unknown>) };
  delete event.offset;
  return isFsFileContentEvent(event);
}

function isBranchForkRecord(value: StreamRecord): value is StreamRecord & FsBranchForkEvent {
  return isFsBranchForkEvent({ type: value.type, payload: value.payload, ts: value.ts });
}

function isBranchMergeRecord(value: StreamRecord): value is StreamRecord & FsBranchMergeEvent {
  return isFsBranchMergeEvent({ type: value.type, payload: value.payload, ts: value.ts });
}

function isFastForwardMergeRecord(value: StreamRecord): value is StreamRecord &
  FsBranchMergeEvent & {
    readonly payload: {
      readonly v: 1;
      readonly mergedThroughOffset: Offset;
      readonly sourceStreamId: string;
      readonly forkOffset: Offset;
    };
  } {
  return isFsFastForwardMergeEvent({ type: value.type, payload: value.payload, ts: value.ts });
}

function isOwnedBranchContentStreamId(
  repoNameValue: string,
  branchName: string,
  value: unknown,
): value is string {
  return (
    branchName !== "main" &&
    typeof value === "string" &&
    isBranchContentStreamId(value) &&
    value.startsWith(branchContentStreamPrefix(repoNameValue, branchName))
  );
}

function decodeContentRecord(record: ContentEvent, path: string): Uint8Array {
  const content = bytesOf(Buffer.from(record.payload.contentBase64, "base64"));
  if (Buffer.from(content).toString("base64") !== record.payload.contentBase64) {
    throw new ContentIntegrityError(path, "content event has non-canonical base64");
  }
  return content;
}

function decodeContentRecords(
  records: readonly ContentEvent[],
  path: string,
): readonly DecodedContentRecord[] {
  return records.map((record) => {
    const content = decodeContentRecord(record, path);
    return { content, digest: sha256(content), size: content.byteLength };
  });
}

function consumeCommittedContent(
  records: readonly DecodedContentRecord[],
  startIndex: number,
  expected: ExpectedContent,
  path: string,
): { readonly content: Uint8Array; readonly nextIndex: number } {
  for (let index = startIndex; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.digest === expected.digest && record.size === expected.size) {
      return { content: record.content, nextIndex: index + 1 };
    }
  }
  throw new ContentIntegrityError(
    path,
    `full write has no content event matching ${expected.digest}/${expected.size}`,
  );
}

function movePathMap<T>(values: Map<string, T>, from: string, to: string): void {
  const prefix = `${from}/`;
  for (const [path, value] of [...values.entries()]) {
    if (path === from) {
      values.delete(path);
      values.set(to, value);
    } else if (path.startsWith(prefix)) {
      values.delete(path);
      values.set(`${to}${path.slice(from.length)}`, value);
    }
  }
}

export class StreamFs {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: StreamFsOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetcher = options.fetch ?? fetch;
  }

  async createRepo(name: string): Promise<StreamFsRepo> {
    const normalizedName = repoName(name);
    const id = metadataStreamId(normalizedName);
    try {
      const existing = await headDurableJsonStream({
        url: streamUrl(this.baseUrl, id),
        fetch: this.fetcher,
      });
      if (existing.exists) throw new RepoExistsError(normalizedName);
      await createDurableJsonStream({
        url: streamUrl(this.baseUrl, id),
        fetch: this.fetcher,
      });
    } catch (error) {
      if (isDurableExistsConflict(error)) throw new RepoExistsError(normalizedName);
      throw error;
    }
    return new StreamFsRepo(this.baseUrl, this.fetcher, normalizedName);
  }

  async openRepo(name: string): Promise<StreamFsRepo> {
    const normalizedName = repoName(name);
    const id = metadataStreamId(normalizedName);
    try {
      const head = await headDurableJsonStream({
        url: streamUrl(this.baseUrl, id),
        fetch: this.fetcher,
      });
      if (!head.exists) throw new RepoNotFoundError(normalizedName);
    } catch (error) {
      if (isDurableNotFound(error)) throw new RepoNotFoundError(normalizedName);
      throw error;
    }
    return new StreamFsRepo(this.baseUrl, this.fetcher, normalizedName);
  }
}

export class StreamFsRepo {
  readonly name: string;
  readonly branchName: string;
  readonly metadataStreamId: string;
  readonly baseUrl: string;
  readonly fetcher: typeof fetch;
  private nextFileId = 0;

  constructor(baseUrl: string, fetcher: typeof fetch, name: string, branchName = "main") {
    this.baseUrl = baseUrl;
    this.fetcher = fetcher;
    this.name = name;
    this.branchName = branchName;
    this.metadataStreamId =
      branchName === "main" ? metadataStreamId(name) : branchMetadataStreamId(name, branchName);
  }

  async treeAt(until?: Offset): Promise<FsTree> {
    if (this.branchName !== "main" || until !== undefined) {
      const records = await this.resolvedDump(until);
      let state = fsInitialState;
      for (const record of records) state = fsReducer(state, record);
      const fork = [...records].reverse().find((record) => isBranchForkRecord(record));
      if (fork !== undefined && isBranchForkRecord(fork)) {
        markBranchState(state, {
          parentStreamId: fork.payload.parentStreamId,
          forkOffset: fork.payload.forkOffset,
        });
      }
      assertCompleteMergeStage(state);
      return state;
    }
    const metadata = await this.dump();
    let state = fsInitialState;
    const records = metadata.some((record) => isBranchMergeRecord(record))
      ? await this.resolvedDump()
      : metadata;
    for (const record of records) state = fsReducer(state, record);
    assertCompleteMergeStage(state);
    return state;
  }

  async tree(): Promise<FsTree> {
    return this.treeAt();
  }

  async digest(): Promise<string> {
    return treeDigest(await this.tree());
  }

  async createSnapshot(): Promise<SnapshotReceipt> {
    return createSnapshotForRoot(this);
  }

  now(): number {
    return Date.now();
  }

  async writeContent(streamId: string, bytes: Uint8Array): Promise<void> {
    await this.createContentStream(streamId);
    await this.appendContent(streamId, bytes);
  }

  async bootstrapRead(): Promise<BootstrapReadResult> {
    return bootstrapSnapshotRead(this);
  }

  async compactSnapshot(): Promise<{
    readonly snapshotOffset: import("@eforest/protocol").Offset;
  }> {
    return compactSnapshot(this);
  }

  async compact(): Promise<{
    readonly snapshotOffset: import("@eforest/protocol").Offset;
  }> {
    for (const record of [...(await this.dump())].reverse()) {
      const event = { ...record } as Record<string, unknown>;
      delete event.offset;
      if (isSnapshotEvent(event)) return { snapshotOffset: event.payload.snapshotOffset };
    }
    throw new StreamFsError("no_snapshot", "stream has no snapshot event");
  }

  async dump(): Promise<readonly StreamRecord[]> {
    return readDurableJson<StreamRecord>({
      url: streamUrl(this.baseUrl, this.metadataStreamId),
      fetch: this.fetcher,
    });
  }

  /** Read the raw metadata stream, including the fork directive when present. */
  async rawDump(): Promise<readonly StreamRecord[]> {
    return this.dump();
  }

  /** Resolve this branch against its parent chain without touching a server reducer. */
  async resolvedDump(until?: Offset): Promise<readonly StreamRecord[]> {
    const records = await this.dump();
    const resolved: StreamRecord[] = [];
    for (const record of records) {
      if (until !== undefined && compareOffsets(record.offset, until) > 0) break;
      if (!isFastForwardMergeRecord(record)) {
        resolved.push(record);
        continue;
      }
      const source = await this.fetchDump(record.payload.sourceStreamId);
      const forkIndex = findLastRecordIndex(
        source,
        (candidate) =>
          isBranchForkRecord(candidate) &&
          candidate.payload.forkOffset === record.payload.forkOffset,
      );
      if (forkIndex < 0) {
        throw new StreamFsError(
          "merge_source_mismatch",
          `merge source ${record.payload.sourceStreamId} does not fork from this stream`,
        );
      }
      resolved.push(
        ...source
          .slice(forkIndex + 1)
          .filter(
            (candidate) =>
              compareOffsets(candidate.offset, record.payload.mergedThroughOffset) <= 0,
          ),
      );
    }
    return resolved;
  }

  async createBranch(
    branch: string,
    options: CreateBranchOptions = {},
  ): Promise<CreateBranchResult> {
    return createBranch(this, branch, options);
  }

  async openBranch(branch: string): Promise<StreamFsRepo> {
    if (!isBranchName(branch)) throw new StreamFsError("invalid_branch_name", branch);
    const streamId = branchMetadataStreamId(this.name, branch);
    const head = await headDurableJsonStream({
      url: streamUrl(this.baseUrl, streamId),
      fetch: this.fetcher,
    });
    if (!head.exists) throw new RepoNotFoundError(`${this.name}:${branch}`);
    return new StreamFsRepo(this.baseUrl, this.fetcher, this.name, branch);
  }

  async createStream(streamId: string, _config: unknown): Promise<void> {
    await createDurableJsonStream({
      url: streamUrl(this.baseUrl, streamId),
      fetch: this.fetcher,
    });
  }

  async createForkStream(
    streamId: string,
    parentStreamId: string,
    forkOffset: Offset,
    _config: unknown,
  ): Promise<void> {
    const parentRecords = await this.fetchDump(parentStreamId);
    if (parentRecords.at(-1)?.offset !== forkOffset) {
      throw new StreamFsError(
        "historic_fork_requires_offset_mapping",
        "Electric Cloud head forks are supported; historic application offsets require an explicit transport-offset map",
      );
    }
    const parentUrl = streamUrl(this.baseUrl, parentStreamId);
    const parentHead = await headDurableJsonStream({ url: parentUrl, fetch: this.fetcher });
    if (!parentHead.exists || parentHead.offset === undefined) {
      throw new RepoNotFoundError(parentStreamId);
    }
    await forkDurableJsonStream({
      url: streamUrl(this.baseUrl, streamId),
      sourceUrl: parentUrl,
      sourceOffset: parentHead.offset,
      fetch: this.fetcher,
    });
  }

  async dispatchToStream(streamId: string, event: Event): Promise<FsDispatchReceipt> {
    return this.dispatch(event, streamId);
  }

  async appendFencedBatch(
    events: readonly [Event, ...Event[]],
    expectedHead: Offset,
  ): Promise<readonly StreamRecord[]> {
    for (const event of events) assertFsEvent(event);
    const existing = await this.fetchDump(this.metadataStreamId);
    const actualHead = existing.at(-1)?.offset ?? ("-1" as Offset);
    if (actualHead !== expectedHead) {
      throw new FsHttpError(409, {
        error: {
          class: "validator-rejected",
          reason: "merge/target-advanced",
          conflict: { expectedHead, actualHead },
        },
      });
    }
    const planned: StreamRecord[] = [];
    const allocation = [...existing];
    for (const event of events) {
      const record: StreamRecord = {
        offset: nextApplicationOffset(allocation),
        type: event.type,
        payload: event.payload,
        ts: event.ts,
      };
      planned.push(record);
      allocation.push(record);
    }
    let state = await this.tree();
    for (const record of planned) state = fsReducer(state, record);
    try {
      await appendDurableJsonBatch(
        { url: streamUrl(this.baseUrl, this.metadataStreamId), fetch: this.fetcher },
        planned as [StreamRecord, ...StreamRecord[]],
        planned[0]!.offset,
      );
    } catch (error) {
      if (isDurableConflict(error)) {
        const latest = await this.fetchDump(this.metadataStreamId);
        throw new FsHttpError(409, {
          error: {
            class: "validator-rejected",
            reason: "merge/target-advanced",
            conflict: {
              expectedHead,
              actualHead: latest.at(-1)?.offset ?? "-1",
            },
          },
        });
      }
      throw error;
    }
    return planned;
  }

  private async fetchDump(streamId: string): Promise<readonly StreamRecord[]> {
    return readDurableJson<StreamRecord>({
      url: streamUrl(this.baseUrl, streamId),
      fetch: this.fetcher,
    });
  }

  async createFile(path: string, bytes: Uint8Array): Promise<void> {
    ensurePath(path);
    const tree = await this.tree();
    if (tree.files[path] !== undefined) throw new FileExistsError(path);
    if (tree.dirs[path] !== undefined) throw new DirectoryExistsError(path);
    ensureParentDirectory(tree, path);
    const content = bytesOf(bytes);
    const contentStreamId = this.newContentStreamId(path);
    await this.createContentStream(contentStreamId);
    await this.appendContent(contentStreamId, content);
    await this.dispatch({
      type: "fs.file.create",
      payload: { v: FS_EVENT_VERSION, path, contentStreamId },
      ts: Date.now(),
    });
    await this.dispatch({
      type: "fs.file.write",
      payload: {
        v: FS_EVENT_VERSION,
        path,
        base: BASE_NONE,
        contentSha256: sha256(content),
        size: content.byteLength,
      },
      ts: Date.now(),
    });
  }

  async writeFile(
    path: string,
    bytes: Uint8Array,
    options: { readonly forceFull?: boolean } = {},
  ): Promise<void> {
    ensurePath(path);
    const file = treeFile(await this.tree(), path);
    const base = await this.readFile(path);
    const content = bytesOf(bytes);
    const choice = options.forceFull
      ? {
          type: "fs.file.write" as const,
          payload: {
            v: FS_EVENT_VERSION,
            path,
            base: file.lastContentOffset,
            contentSha256: sha256(content),
            size: content.byteLength,
          },
        }
      : chooseWriteEvent(base, content, path, file.lastContentOffset);
    const inherited =
      this.branchName !== "main" &&
      !isOwnedBranchContentStreamId(this.name, this.branchName, file.contentStreamId);
    if (!inherited) {
      if (choice.type === "fs.file.write") {
        await this.appendContent(file.contentStreamId, content);
      }
      await this.dispatch({ ...choice, ts: Date.now() });
      return;
    }

    // A branch-side mutation first records the edit against the inherited file,
    // then records an ownership handoff. Existing v2 payloads remain unchanged;
    // the handoff's branch-owned create event carries the new stream identity.
    const contentStreamId = this.newContentStreamId(path);
    await this.createContentStream(contentStreamId);
    await this.appendContent(contentStreamId, content);
    await this.dispatch({ ...choice, ts: Date.now() });
    await this.dispatch({
      type: "fs.file.create",
      payload: { v: FS_EVENT_VERSION, path, contentStreamId },
      ts: Date.now(),
    });
  }

  async readFile(path: string): Promise<Uint8Array> {
    return this.readFileAt(path);
  }

  async ensureContentGeneration(
    path: string,
    streamId: string,
    bytes: Uint8Array,
    expectedDigest: string,
    expectedSize: number,
  ): Promise<void> {
    const content = bytesOf(bytes);
    if (content.byteLength !== expectedSize || sha256(content) !== expectedDigest) {
      throw new ContentIntegrityError(path, "prepared content does not match its merge dependency");
    }
    const records = await this.fetchDump(streamId);
    for (const record of records) {
      if (!isContentEvent(record) || record.payload.contentStreamId !== streamId) {
        throw new ContentIntegrityError(path, "content stream has an invalid content event");
      }
      const candidate = decodeContentRecord(record, path);
      if (candidate.byteLength === expectedSize && sha256(candidate) === expectedDigest) return;
    }
    await this.appendContent(streamId, content);
  }

  async readFileAt(path: string, until?: Offset): Promise<Uint8Array> {
    ensurePath(path);
    const tree = await this.treeAt(until);
    const file = treeFile(tree, path);
    const snapshotContent = contentMap(tree).get(file.contentStreamId);
    if (
      snapshotContent !== undefined &&
      snapshotContent.byteLength === file.size &&
      sha256(snapshotContent) === file.contentSha256
    ) {
      return bytesOf(snapshotContent);
    }
    const metadata = expandThreeWayMergeRecords(await this.resolvedDump(until));
    const body = await readDurableJson<unknown>({
      url: streamUrl(this.baseUrl, file.contentStreamId),
      fetch: this.fetcher,
    });
    const encodedContentByStream = new Map<string, ContentEvent[]>();
    for (const candidate of body) {
      if (!isContentEvent(candidate)) {
        throw new ContentIntegrityError(path, "content stream has an invalid content event");
      }
      const records = encodedContentByStream.get(candidate.payload.contentStreamId) ?? [];
      records.push(candidate);
      encodedContentByStream.set(candidate.payload.contentStreamId, records);
    }
    const contentByStream = new Map<string, readonly DecodedContentRecord[]>();
    for (const [streamId, records] of encodedContentByStream) {
      contentByStream.set(streamId, decodeContentRecords(records, path));
    }
    const contentIndexes = new Map<string, number>();
    const contents = new Map<string, Uint8Array>();
    const paths = new Map<string, string>();
    const expectedContents = new Map<string, ExpectedContent>();
    const targetStreamId = file.contentStreamId;
    for (const record of metadata) {
      const event = { ...record } as Record<string, unknown>;
      delete event.offset;
      if (!isEvent(event)) continue;
      if (event.type === "fs.file.create") {
        const payload = event.payload as { path: string; contentStreamId: string };
        const previous = paths.get(payload.path);
        if (
          previous !== undefined &&
          previous !== payload.contentStreamId &&
          payload.contentStreamId === targetStreamId
        ) {
          const expected = expectedContents.get(payload.path);
          if (expected === undefined) {
            throw new ContentIntegrityError(path, "content handoff has no committed expectation");
          }
          const consumed = consumeCommittedContent(
            contentByStream.get(payload.contentStreamId) ?? [],
            contentIndexes.get(payload.contentStreamId) ?? 0,
            expected,
            path,
          );
          contents.set(payload.contentStreamId, consumed.content);
          contentIndexes.set(payload.contentStreamId, consumed.nextIndex);
        } else if (previous === undefined) {
          expectedContents.delete(payload.path);
        }
        paths.set(payload.path, payload.contentStreamId);
      } else if (event.type === "fs.file.write") {
        const payload = event.payload as {
          path: string;
          contentSha256: string;
          size: number;
        };
        const expected = { digest: payload.contentSha256, size: payload.size };
        expectedContents.set(payload.path, expected);
        const streamId = paths.get(payload.path);
        if (streamId === undefined || streamId !== targetStreamId) continue;
        const records = contentByStream.get(streamId) ?? [];
        const index = contentIndexes.get(streamId) ?? 0;
        const consumed = consumeCommittedContent(records, index, expected, path);
        contents.set(streamId, consumed.content);
        contentIndexes.set(streamId, consumed.nextIndex);
      } else if (event.type === "fs.file.patch") {
        const payload = event.payload as {
          path: string;
          baseDigest: string;
          resultDigest: string;
          ops: Parameters<typeof applyPatch>[1];
        };
        const streamId = paths.get(payload.path);
        const previousExpected = expectedContents.get(payload.path);
        if (previousExpected === undefined || previousExpected.digest !== payload.baseDigest) {
          throw new ContentIntegrityError(path, "patch base digest does not match metadata");
        }
        let resultSize: number;
        if (streamId === targetStreamId) {
          const base = contents.get(streamId);
          if (base === undefined)
            throw new ContentIntegrityError(path, "patch has no content base");
          if (sha256(base) !== payload.baseDigest) {
            throw new ContentIntegrityError(path, "patch base digest does not match bytes");
          }
          try {
            const result = applyPatch(base, payload.ops);
            resultSize = result.byteLength;
            contents.set(streamId, result);
          } catch (error) {
            throw new ContentIntegrityError(
              path,
              error instanceof Error ? error.message : String(error),
            );
          }
        } else {
          try {
            resultSize = patchResultSize(previousExpected.size, payload.ops);
          } catch (error) {
            throw new ContentIntegrityError(
              path,
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        expectedContents.set(payload.path, { digest: payload.resultDigest, size: resultSize });
        if (
          streamId === targetStreamId &&
          sha256(contents.get(streamId)!) !== payload.resultDigest
        ) {
          throw new ContentIntegrityError(path, "patch result digest does not match bytes");
        }
      } else if (event.type === "fs.file.delete") {
        const deletedPath = (event.payload as { path: string }).path;
        paths.delete(deletedPath);
        expectedContents.delete(deletedPath);
      } else if (event.type === "fs.rename") {
        const payload = event.payload as { from: string; to: string };
        movePathMap(paths, payload.from, payload.to);
        movePathMap(expectedContents, payload.from, payload.to);
      }
    }
    const streamId = paths.get(path);
    const content = streamId === file.contentStreamId ? contents.get(streamId) : undefined;
    if (content === undefined)
      throw new ContentIntegrityError(path, "no reconstructed content for file");
    // A content append can win its stream append and then lose the metadata
    // Stream-Seq race. Such orphaned content is intentionally invisible: the
    // metadata log is the commit record that decides which bytes belong to the file.
    if (content.byteLength !== file.size || sha256(content) !== file.contentSha256) {
      throw new ContentIntegrityError(path, "recorded size or SHA-256 does not match bytes");
    }
    return content;
  }

  async deleteFile(path: string): Promise<void> {
    ensurePath(path);
    treeFile(await this.tree(), path);
    await this.dispatch({
      type: "fs.file.delete",
      payload: { v: FS_EVENT_VERSION, path },
      ts: Date.now(),
    });
  }

  async mkdir(path: string): Promise<void> {
    ensurePath(path);
    const tree = await this.tree();
    if (tree.files[path] !== undefined) throw new FileExistsError(path);
    if (tree.dirs[path] !== undefined) throw new DirectoryExistsError(path);
    ensureParentDirectory(tree, path);
    await this.dispatch({
      type: "fs.dir.create",
      payload: { v: FS_EVENT_VERSION, path },
      ts: Date.now(),
    });
  }

  async rmdir(path: string): Promise<void> {
    ensurePath(path);
    const tree = await this.tree();
    if (tree.dirs[path] === undefined) throw new DirectoryNotFoundError(path);
    if (hasLiveDescendant(tree, path)) throw new DirectoryNotEmptyError(path);
    await this.dispatch({
      type: "fs.dir.remove",
      payload: { v: FS_EVENT_VERSION, path },
      ts: Date.now(),
    });
  }

  async rename(from: string, to: string): Promise<void> {
    ensurePath(from);
    ensurePath(to);
    const tree = await this.tree();
    const sourceIsFile = tree.files[from] !== undefined;
    const sourceIsDir = tree.dirs[from] !== undefined;
    if (!sourceIsFile && !sourceIsDir) throw new FileNotFoundError(from);
    if (tree.files[to] !== undefined) throw new FileExistsError(to);
    if (tree.dirs[to] !== undefined) throw new DirectoryExistsError(to);
    ensureParentDirectory(tree, to);
    if (sourceIsDir && (to === from || to.startsWith(`${from}/`))) {
      throw new InvalidRenameError(from, to, "destination is inside the source directory");
    }
    await this.dispatch({
      type: "fs.rename",
      payload: { v: FS_EVENT_VERSION, from, to },
      ts: Date.now(),
    });
  }

  async list(): Promise<readonly string[]> {
    return listTree(await this.tree());
  }

  watch(root = ".", options: StreamFsRepoWatchOptions = {}): StreamFsWatcher {
    return watch(root, {
      ...options,
      baseUrl: this.baseUrl,
      streamId: this.metadataStreamId,
    });
  }

  private newContentStreamId(path: string): string {
    this.nextFileId += 1;
    const suffix = createHash("sha256")
      .update(`${path}:${this.nextFileId}`)
      .digest("hex")
      .slice(0, 16);
    return `${
      this.branchName === "main"
        ? `fs:${this.name}:main:file:`
        : branchContentStreamPrefix(this.name, this.branchName)
    }${this.nextFileId}-${suffix}`;
  }

  private async createContentStream(streamId: string): Promise<void> {
    await createDurableJsonStream({
      url: streamUrl(this.baseUrl, streamId),
      fetch: this.fetcher,
    });
  }

  private async appendContent(streamId: string, bytes: Uint8Array): Promise<void> {
    const event: ContentEvent = {
      type: "fs.file.content",
      payload: {
        v: FS_EVENT_VERSION,
        contentStreamId: streamId,
        contentBase64: Buffer.from(bytes).toString("base64"),
      },
      ts: Date.now(),
    };
    await this.appendDurable(streamId, event);
  }

  private async dispatch(
    event: Event,
    streamId = this.metadataStreamId,
  ): Promise<FsDispatchReceipt> {
    const record = await this.appendDurable(streamId, event);
    return { event: record, head: record.offset };
  }

  private async appendDurable(streamId: string, event: Event): Promise<StreamRecord> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const records = await this.fetchDump(streamId);
      const record: StreamRecord = {
        offset: nextApplicationOffset(records),
        type: event.type,
        payload: event.payload,
        ts: event.ts,
      };
      if (streamId === this.metadataStreamId) {
        const state = await this.tree();
        const payload =
          event.payload !== null &&
          typeof event.payload === "object" &&
          !Array.isArray(event.payload)
            ? (event.payload as Record<string, unknown>)
            : undefined;
        if ((event.type === "fs.file.write" || event.type === "fs.file.patch") && payload) {
          const path = typeof payload.path === "string" ? payload.path : undefined;
          const actualBase = typeof payload.base === "string" ? payload.base : undefined;
          const expectedBase =
            path === undefined ? undefined : state.files[path]?.lastContentOffset;
          if (path !== undefined && actualBase !== (expectedBase ?? BASE_NONE)) {
            throw new FsHttpError(409, {
              error: {
                class: "validator-rejected",
                reason: "stale-base",
                conflict: {
                  path,
                  expectedBase: expectedBase ?? BASE_NONE,
                  actualBase,
                },
              },
            });
          }
        }
        if (isBranchMergeRecord(record) && record.payload.v === 2) {
          throw new FsHttpError(409, {
            error: { class: "validator-rejected", reason: "merge/batch-required" },
          });
        }
        if (isFastForwardMergeRecord(record)) {
          if (record.payload.sourceStreamId === streamId) {
            throw new FsHttpError(409, {
              error: { class: "validator-rejected", reason: "fs/merge-into-self" },
            });
          }
          if (
            records.some(
              (candidate) => compareOffsets(candidate.offset, record.payload.forkOffset) > 0,
            )
          ) {
            throw new FsHttpError(409, {
              error: { class: "validator-rejected", reason: "fs/merge-not-fast-forward" },
            });
          }
          let sourceRecords: readonly StreamRecord[];
          try {
            sourceRecords = await this.fetchDump(record.payload.sourceStreamId);
          } catch {
            throw new FsHttpError(409, {
              error: { class: "validator-rejected", reason: "fs/merge-source-not-found" },
            });
          }
          const forkIndex = findLastRecordIndex(
            sourceRecords,
            (candidate) =>
              isBranchForkRecord(candidate) &&
              candidate.payload.parentStreamId === streamId &&
              candidate.payload.forkOffset === record.payload.forkOffset,
          );
          if (forkIndex < 0) {
            throw new FsHttpError(409, {
              error: { class: "validator-rejected", reason: "fs/merge-unrelated-source" },
            });
          }
          const sourcePostFork = sourceRecords.slice(forkIndex + 1);
          const expectedThrough = sourcePostFork.at(-1)?.offset ?? record.payload.forkOffset;
          if (expectedThrough !== record.payload.mergedThroughOffset) {
            throw new FsHttpError(409, {
              error: { class: "validator-rejected", reason: "fs/merge-bad-range" },
            });
          }
        }
        fsReducer(state, record);
      }
      try {
        await appendDurableJson(
          { url: streamUrl(this.baseUrl, streamId), fetch: this.fetcher },
          record,
          record.offset,
        );
        return record;
      } catch (error) {
        if (isDurableConflict(error)) continue;
        throw error;
      }
    }
    throw new FsHttpError(409, { error: "durable_stream_sequence_conflict" });
  }

  async dispatchSnapshot(event: Event): Promise<FsDispatchReceipt> {
    return this.dispatch(event);
  }
}
