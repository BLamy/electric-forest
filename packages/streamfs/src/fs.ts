import { createHash } from "node:crypto";
import { canonicalJson, isEvent, type Event } from "@eforest/protocol";
import type { StreamRecord } from "@eforest/client";
import { FS_EVENT_VERSION } from "./version.js";
import { isValidFsPath } from "./events.js";
import { listTree, treeDigest, type FsFileState, type FsTree } from "./tree.js";

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

interface ContentEvent extends Event {
  readonly type: "fs.file.content";
  readonly payload: { readonly v: typeof FS_EVENT_VERSION; readonly contentBase64: string };
}

interface JsonResponse {
  readonly response: Response;
  readonly body: unknown;
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

function parseJson(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function request(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit = {},
): Promise<JsonResponse> {
  const response = await fetcher(url, init);
  return { response, body: parseJson(await response.text()) };
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
  if (!isEvent(event) || event.type !== "fs.file.content") return false;
  if (event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return false;
  }
  const payload = event.payload as Record<string, unknown>;
  return (
    Object.keys(payload).sort().join(",") === "contentBase64,v" &&
    payload.v === FS_EVENT_VERSION &&
    typeof payload.contentBase64 === "string"
  );
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
    const { response, body } = await request(this.fetcher, streamUrl(this.baseUrl, id), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: canonicalJson({ type: "fs-meta", version: `fs-v${FS_EVENT_VERSION}` }),
    });
    if (!response.ok) throw new FsHttpError(response.status, body);
    if (response.status !== 201 || typeof body !== "object" || body === null) {
      throw new RepoExistsError(normalizedName);
    }
    return new StreamFsRepo(this.baseUrl, this.fetcher, normalizedName);
  }

  async openRepo(name: string): Promise<StreamFsRepo> {
    const normalizedName = repoName(name);
    const id = metadataStreamId(normalizedName);
    const { response, body } = await request(
      this.fetcher,
      `${streamUrl(this.baseUrl, id)}?offset=-1`,
    );
    if (response.status === 404) throw new RepoNotFoundError(normalizedName);
    if (!response.ok) throw new FsHttpError(response.status, body);
    return new StreamFsRepo(this.baseUrl, this.fetcher, normalizedName);
  }
}

export class StreamFsRepo {
  readonly name: string;
  readonly metadataStreamId: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly contentSequences = new Map<string, number>();
  private nextFileId = 0;

  constructor(baseUrl: string, fetcher: typeof fetch, name: string) {
    this.baseUrl = baseUrl;
    this.fetcher = fetcher;
    this.name = name;
    this.metadataStreamId = metadataStreamId(name);
  }

  async tree(): Promise<FsTree> {
    const { response, body } = await request(
      this.fetcher,
      `${streamUrl(this.baseUrl, this.metadataStreamId)}/state`,
    );
    if (!response.ok) throw new FsHttpError(response.status, body);
    const candidate = body as Record<string, unknown> | null;
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      !Object.hasOwn(candidate, "files") ||
      !Object.hasOwn(candidate, "dirs") ||
      !Object.hasOwn(candidate, "tombstones") ||
      candidate.files === null ||
      typeof candidate.files !== "object" ||
      Array.isArray(candidate.files) ||
      candidate.dirs === null ||
      typeof candidate.dirs !== "object" ||
      Array.isArray(candidate.dirs) ||
      candidate.tombstones === null ||
      typeof candidate.tombstones !== "object" ||
      Array.isArray(candidate.tombstones)
    ) {
      throw new StreamFsError("invalid_state", "metadata state is not a canonical filesystem tree");
    }
    return body as FsTree;
  }

  async digest(): Promise<string> {
    return treeDigest(await this.tree());
  }

  async dump(): Promise<readonly StreamRecord[]> {
    const { response, body } = await request(
      this.fetcher,
      `${streamUrl(this.baseUrl, this.metadataStreamId)}/dump`,
    );
    if (!response.ok) throw new FsHttpError(response.status, body);
    if (Array.isArray(body)) return body as StreamRecord[];
    if (typeof body !== "string") {
      throw new StreamFsError("invalid_dump", "metadata dump is not an array or NDJSON body");
    }
    try {
      return body
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as StreamRecord);
    } catch {
      throw new StreamFsError("invalid_dump", "metadata dump contains invalid JSON");
    }
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
        contentSha256: sha256(content),
        size: content.byteLength,
      },
      ts: Date.now(),
    });
  }

  async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    ensurePath(path);
    const file = treeFile(await this.tree(), path);
    const content = bytesOf(bytes);
    await this.appendContent(file.contentStreamId, content);
    await this.dispatch({
      type: "fs.file.write",
      payload: {
        v: FS_EVENT_VERSION,
        path,
        contentSha256: sha256(content),
        size: content.byteLength,
      },
      ts: Date.now(),
    });
  }

  async readFile(path: string): Promise<Uint8Array> {
    ensurePath(path);
    const file = treeFile(await this.tree(), path);
    const { response, body } = await request(
      this.fetcher,
      `${streamUrl(this.baseUrl, file.contentStreamId)}?offset=-1`,
    );
    if (!response.ok) throw new FsHttpError(response.status, body);
    if (!Array.isArray(body))
      throw new ContentIntegrityError(path, "content stream is not an array");
    const record = body.at(-1);
    if (!isContentEvent(record))
      throw new ContentIntegrityError(path, "content stream has no valid content event");
    let content: Uint8Array;
    try {
      content = bytesOf(Buffer.from(record.payload.contentBase64, "base64"));
    } catch {
      throw new ContentIntegrityError(path, "content event is not base64");
    }
    if (content.toString() === "") {
      const canonicalBase64 = Buffer.from(content).toString("base64");
      if (canonicalBase64 !== record.payload.contentBase64) {
        throw new ContentIntegrityError(path, "content event has non-canonical base64");
      }
    }
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

  private newContentStreamId(path: string): string {
    this.nextFileId += 1;
    const suffix = createHash("sha256")
      .update(`${path}:${this.nextFileId}`)
      .digest("hex")
      .slice(0, 16);
    return `fs:${this.name}:main:file:${this.nextFileId}-${suffix}`;
  }

  private async createContentStream(streamId: string): Promise<void> {
    const { response, body } = await request(this.fetcher, streamUrl(this.baseUrl, streamId), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: canonicalJson({ type: "fs-file-content", version: `fs-v${FS_EVENT_VERSION}` }),
    });
    if (!response.ok) throw new FsHttpError(response.status, body);
  }

  private async appendContent(streamId: string, bytes: Uint8Array): Promise<void> {
    let sequence = this.contentSequences.get(streamId) ?? 0;
    const event: ContentEvent = {
      type: "fs.file.content",
      payload: { v: FS_EVENT_VERSION, contentBase64: Buffer.from(bytes).toString("base64") },
      ts: Date.now(),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { response, body } = await request(this.fetcher, streamUrl(this.baseUrl, streamId), {
        method: "POST",
        headers: { "content-type": "application/json", "stream-seq": String(sequence) },
        body: canonicalJson({ events: [event] }),
      });
      if (response.status === 409) {
        const current = Number(response.headers.get("stream-seq"));
        if (Number.isSafeInteger(current) && current >= -1) {
          sequence = current + 1;
          continue;
        }
      }
      if (!response.ok) throw new FsHttpError(response.status, body);
      this.contentSequences.set(streamId, sequence + 1);
      return;
    }
    throw new FsHttpError(409, { error: "content_stream_sequence_conflict" });
  }

  private async dispatch(event: Event): Promise<FsDispatchReceipt> {
    const { response, body } = await request(
      this.fetcher,
      `${streamUrl(this.baseUrl, this.metadataStreamId)}/dispatch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: canonicalJson(event),
      },
    );
    if (!response.ok) throw new FsHttpError(response.status, body);
    const candidate = body as Record<string, unknown> | null;
    const returnedEvent =
      candidate !== null &&
      typeof candidate === "object" &&
      candidate.event !== null &&
      typeof candidate.event === "object" &&
      !Array.isArray(candidate.event)
        ? (candidate.event as Record<string, unknown>)
        : undefined;
    const eventBody = { ...(returnedEvent ?? {}) };
    delete eventBody.offset;
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      !Object.hasOwn(candidate, "event") ||
      !Object.hasOwn(candidate, "head") ||
      returnedEvent === undefined ||
      !isEvent(eventBody)
    ) {
      throw new StreamFsError("invalid_dispatch_response", "dispatch response is malformed");
    }
    return { event: candidate.event as StreamRecord, head: String(candidate.head) };
  }
}
