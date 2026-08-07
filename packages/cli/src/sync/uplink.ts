import {
  appendDurableJson,
  createDurableJsonStream,
  readDurableJson,
  type StreamRecord,
} from "@eforest/client";
import { canonicalJson, sha256Hex, type Event } from "@eforest/protocol";
import { isWellFormedOffset, offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import {
  chooseWriteEvent,
  FS_EVENT_VERSION,
  type FsPatchAction,
  type FsWriteAction,
} from "@eforest/streamfs";
import { worktreeDigestDirectory } from "@eforest/streamfs/worktree-node";
import {
  BASE_NONE,
  load as loadWorkspace,
  save as saveWorkspace,
  type WorkspaceFileBase,
  type WorkspaceState,
} from "@eforest/workspace";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { classifyWorkingTree } from "../classify.js";
import type { CliIo } from "../cli.js";
import { loadCredentials, type StoredCredentials } from "../credentials.js";
import {
  coalesce,
  isExcludedUplinkPath,
  type PendingFsEvent,
  type UplinkLedgerView,
  type UplinkPlanEntry,
} from "./coalesce.js";
import { JournalWriter, journalLine, type JournalConflict, type JournalRecord } from "./journal.js";

export const WATCH_USAGE = "Usage: ef watch --up [--quiesce] [--debounce <ms>]";
export const DEFAULT_UPLINK_DEBOUNCE_MS = 120;

export interface UplinkDispatchReceipt {
  readonly offset: string;
}

export interface UplinkDispatchRefusal {
  readonly conflict: JournalConflict;
}

export interface UplinkEngineOptions {
  readonly root: string;
  readonly serverUrl: string;
  readonly streamServerUrl?: string;
  readonly accessToken: string;
  readonly branchStreamId?: string;
  readonly debounceMs?: number;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly onRecord?: (record: JournalRecord) => void;
  /** Test and recovery seam at the production ledger-advance call site. */
  readonly beforeLedgerAdvance?: (record: JournalRecord) => void | Promise<void>;
}

export interface UplinkQuiescence {
  readonly clean: boolean;
  readonly refusals: number;
  readonly workingTreeDigest: string;
}

export class UplinkError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "UplinkError";
  }
}

function trimUrl(value: string, code: string): string {
  const result = value.replace(/\/+$/, "");
  if (result.length === 0) throw new UplinkError(code, "server URL is empty");
  return result;
}

function streamUrl(baseUrl: string, streamId: string): string {
  return `${baseUrl}/streams/${encodeURIComponent(streamId)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function responseConflict(value: unknown): JournalConflict | undefined {
  if (!isObject(value)) return undefined;
  const error = value.error;
  if (!isObject(error) || error.class !== "validator-rejected" || error.reason !== "stale-base") {
    return undefined;
  }
  const conflict = error.conflict;
  if (
    !isObject(conflict) ||
    typeof conflict.path !== "string" ||
    typeof conflict.expectedBase !== "string" ||
    typeof conflict.actualBase !== "string"
  ) {
    throw new UplinkError("uplink/invalid-refusal", "stale-base response has no conflict object");
  }
  return {
    path: conflict.path,
    expectedBase: conflict.expectedBase,
    actualBase: conflict.actualBase,
  };
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function event(type: string, payload: Record<string, unknown>, now: () => number): Event {
  return { type, payload, ts: now() } as Event;
}

function filePath(root: string, path: string): string {
  return join(root, ...path.split("/"));
}

function parentsOf(path: string): string[] {
  const parts = path.split("/");
  const result: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    result.push(parts.slice(0, index).join("/"));
  }
  return result;
}

function branchContentPrefix(streamId: string): string {
  const marker = ":meta";
  if (!streamId.startsWith("fs:") || !streamId.endsWith(marker)) {
    throw new UplinkError("uplink/invalid-stream", `not a branch metadata stream: ${streamId}`);
  }
  const branchStart = streamId.lastIndexOf(":", streamId.length - marker.length - 1);
  if (branchStart < 0) throw new UplinkError("uplink/invalid-stream", streamId);
  const branch = streamId.slice(branchStart + 1, -marker.length);
  const repoPrefix = streamId.slice(0, branchStart);
  return `${repoPrefix}:${branch}:file:`;
}

function branchName(streamId: string): string {
  const marker = ":meta";
  const branchStart = streamId.lastIndexOf(":", streamId.length - marker.length - 1);
  if (branchStart < 0 || !streamId.endsWith(marker)) {
    throw new UplinkError("uplink/invalid-stream", streamId);
  }
  return streamId.slice(branchStart + 1, -marker.length);
}

function copyFiles(
  files: Readonly<Record<string, WorkspaceFileBase>>,
): Record<string, WorkspaceFileBase> {
  return { ...files };
}

function movePath<T>(values: Map<string, T>, from: string, to: string): void {
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

function mapMetadataContentStreams(records: readonly StreamRecord[]): Map<string, string> {
  const paths = new Map<string, string>();
  for (const record of records) {
    if (record.type === "fs.file.create") {
      const payload = record.payload as {
        readonly path?: unknown;
        readonly contentStreamId?: unknown;
      };
      if (typeof payload.path === "string" && typeof payload.contentStreamId === "string") {
        paths.set(payload.path, payload.contentStreamId);
      }
    } else if (record.type === "fs.file.delete") {
      const path = (record.payload as { readonly path?: unknown }).path;
      if (typeof path === "string") paths.delete(path);
    } else if (record.type === "fs.rename") {
      const payload = record.payload as { readonly from?: unknown; readonly to?: unknown };
      if (typeof payload.from === "string" && typeof payload.to === "string") {
        movePath(paths, payload.from, payload.to);
      }
    }
  }
  return paths;
}

class UplinkHttpClient {
  private readonly authorization: string;
  private readonly serverUrl: string;
  private readonly streamServerUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(options: UplinkEngineOptions) {
    this.authorization = `Bearer ${options.accessToken}`;
    this.serverUrl = trimUrl(options.serverUrl, "uplink/server-required");
    this.streamServerUrl = trimUrl(
      options.streamServerUrl ?? options.serverUrl,
      "uplink/stream-server-required",
    );
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private headers(contentType = false): Record<string, string> {
    return {
      authorization: this.authorization,
      ...(contentType ? { "content-type": "application/json" } : {}),
    };
  }

  async metadata(streamId: string): Promise<readonly StreamRecord[]> {
    try {
      return await readDurableJson<StreamRecord>({
        url: streamUrl(this.streamServerUrl, streamId),
        fetch: this.fetcher,
        headers: this.headers(),
      });
    } catch (error) {
      throw new UplinkError(
        "uplink/metadata-read-failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async dispatch(
    streamId: string,
    value: Event,
  ): Promise<UplinkDispatchReceipt | UplinkDispatchRefusal> {
    const response = await this.fetcher(`${this.serverUrl}/api/dispatch`, {
      method: "POST",
      headers: {
        ...this.headers(true),
        // The ordinary dispatch body remains backwards-compatible. Uplink
        // opts into the authoritative application offset receipt so a racing
        // writer can never make the journal cite the wrong head.
        "x-eforest-dispatch-receipt": "offset",
      },
      body: canonicalJson({ streamId, event: value }),
    });
    const body = await responseBody(response);
    if (response.status === 409) {
      const conflict = responseConflict(body);
      if (conflict !== undefined) return { conflict };
    }
    if (!response.ok) {
      const reason =
        isObject(body) && isObject(body.error) && typeof body.error.reason === "string"
          ? body.error.reason
          : `HTTP ${String(response.status)}`;
      throw new UplinkError("uplink/dispatch-failed", `${reason}: ${JSON.stringify(body)}`);
    }
    const offset = isObject(body) && typeof body.offset === "string" ? body.offset : undefined;
    if (offset === undefined || !isWellFormedOffset(offset)) {
      throw new UplinkError(
        "uplink/receipt-missing",
        "dispatch accepted without an application offset receipt",
      );
    }
    return { offset };
  }

  async createContentStream(streamId: string): Promise<void> {
    try {
      await createDurableJsonStream({
        url: streamUrl(this.streamServerUrl, streamId),
        fetch: this.fetcher,
        headers: this.headers(),
      });
    } catch (error) {
      throw new UplinkError(
        "uplink/content-stream-create-failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async appendContent(streamId: string, bytes: Uint8Array): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const records = await this.metadata(streamId);
      const offset = offsetForOrdinal(records.length);
      const content = event(
        "fs.file.content",
        {
          v: FS_EVENT_VERSION,
          contentStreamId: streamId,
          contentBase64: Buffer.from(bytes).toString("base64"),
        },
        this.now,
      );
      try {
        await appendDurableJson(
          {
            url: streamUrl(this.streamServerUrl, streamId),
            fetch: this.fetcher,
            headers: this.headers(),
          },
          { ...content, offset },
          offset,
        );
        return;
      } catch (error) {
        if (error instanceof Error && /409|conflict|sequence/i.test(error.message)) continue;
        throw new UplinkError(
          "uplink/content-append-failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    throw new UplinkError("uplink/content-append-conflict", `could not append ${streamId}`);
  }
}

interface PreparedFile {
  readonly streamId: string;
}

export class UplinkEngine {
  private readonly root: string;
  private readonly server: UplinkHttpClient;
  private readonly branchStreamId: string;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly beforeLedgerAdvance: (record: JournalRecord) => void | Promise<void>;
  private readonly listener: ((record: JournalRecord) => void) | undefined;
  private readonly journalPath: string;
  private readonly baseBytes = new Map<string, Uint8Array>();
  private readonly contentStreams = new Map<string, string>();
  private readonly directories = new Set<string>();
  private readonly pendingCreates = new Map<string, PreparedFile>();
  private pending: PendingFsEvent[] = [];
  private watcher: FSWatcher | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushPromise: Promise<void> = Promise.resolve();
  private startPromise: Promise<void> | undefined;
  private workspace: WorkspaceState | undefined;
  private journal: JournalWriter | undefined;
  private closed = false;
  private failure: unknown;
  private refusals = 0;
  private contentOrdinal = 0;

  constructor(options: UplinkEngineOptions) {
    this.root = resolve(options.root);
    this.server = new UplinkHttpClient(options);
    this.branchStreamId = options.branchStreamId ?? "";
    this.debounceMs = options.debounceMs ?? DEFAULT_UPLINK_DEBOUNCE_MS;
    if (!Number.isSafeInteger(this.debounceMs) || this.debounceMs < 0) {
      throw new UplinkError("uplink/invalid-debounce", "debounce must be a non-negative integer");
    }
    this.now = options.now ?? Date.now;
    this.beforeLedgerAdvance = options.beforeLedgerAdvance ?? (() => undefined);
    this.listener = options.onRecord;
    this.journalPath = join(this.root, ".ef", "journal.jsonl");
  }

  get workspaceState(): WorkspaceState {
    if (this.workspace === undefined)
      throw new UplinkError("uplink/not-started", "engine is not started");
    return this.workspace;
  }

  get journalFile(): string {
    return this.journalPath;
  }

  get refusalCount(): number {
    return this.refusals;
  }

  async start(): Promise<void> {
    if (this.startPromise !== undefined) return this.startPromise;
    this.startPromise = this.startNow();
    try {
      await this.startPromise;
    } catch (error) {
      this.startPromise = undefined;
      throw error;
    }
  }

  private async startNow(): Promise<void> {
    if (this.closed) throw new UplinkError("uplink/closed", "engine is closed");
    const workspace = loadWorkspace(this.root);
    const branchStreamId = this.branchStreamId || workspace.identity.metadataStreamId;
    if (branchStreamId !== workspace.identity.metadataStreamId) {
      throw new UplinkError(
        "uplink/stream-mismatch",
        `${branchStreamId} does not match ${workspace.identity.metadataStreamId}`,
      );
    }
    this.workspace = workspace;
    this.journal = new JournalWriter(this.journalPath);
    const records = await this.server.metadata(branchStreamId);
    for (const [path, streamId] of mapMetadataContentStreams(records)) {
      this.contentStreams.set(path, streamId);
    }
    for (const path of Object.keys(workspace.files)) {
      for (const parent of parentsOf(path)) this.directories.add(parent);
      const target = filePath(this.root, path);
      try {
        const stat = lstatSync(target);
        if (stat.isFile()) {
          const bytes = readFileSync(target);
          if (sha256Hex(bytes) === workspace.files[path]!.contentSha256) {
            this.baseBytes.set(path, new Uint8Array(bytes));
          }
        }
      } catch {
        // E4-T04 classification will turn a missing or unreadable path into a
        // pending mutation; it must not fabricate a patch base.
      }
    }

    const watcher = chokidarWatch(this.root, {
      atomic: false,
      followSymlinks: false,
      ignoreInitial: true,
      ignored: (candidate) => {
        const relativePath = this.relativePath(candidate);
        return relativePath !== undefined && isExcludedUplinkPath(relativePath);
      },
    });
    watcher.on("all", (kind, path) => this.onFilesystemEvent(kind, path));
    watcher.on("error", (error) => {
      this.failure = error;
    });
    this.watcher = watcher;
    await new Promise<void>((resolveReady, reject) => {
      watcher.once("ready", resolveReady);
      watcher.once("error", reject);
    });
    this.queueDirtyStartup();
  }

  private relativePath(candidate: string): string | undefined {
    const relativePath = relative(this.root, resolve(candidate)).split(sep).join("/");
    if (relativePath.length === 0 || relativePath === ".") return undefined;
    if (relativePath === ".." || relativePath.startsWith("../")) return undefined;
    return relativePath;
  }

  private onFilesystemEvent(kind: string, candidate: string): void {
    const path = this.relativePath(candidate);
    if (path === undefined || isExcludedUplinkPath(path)) return;
    if (
      kind !== "add" &&
      kind !== "addDir" &&
      kind !== "change" &&
      kind !== "unlink" &&
      kind !== "unlinkDir"
    ) {
      return;
    }
    this.pending.push({ kind, path });
    this.armTimer();
  }

  private queueDirtyStartup(): void {
    if (this.workspace === undefined) return;
    const classification = classifyWorkingTree(this.root, this.workspace);
    for (const path of classification.added) {
      if (isExcludedUplinkPath(path)) continue;
      const target = filePath(this.root, path);
      try {
        this.pending.push({ kind: lstatSync(target).isDirectory() ? "addDir" : "add", path });
      } catch {
        // A concurrent deletion will be reported by chokidar if it persists.
      }
    }
    for (const path of classification.modified) {
      if (!isExcludedUplinkPath(path)) this.pending.push({ kind: "change", path });
    }
    for (const path of classification.deleted) {
      if (!isExcludedUplinkPath(path)) this.pending.push({ kind: "unlink", path });
    }
    if (this.pending.length > 0) this.armTimer();
  }

  private armTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.enqueueFlush();
    }, this.debounceMs);
  }

  private enqueueFlush(): Promise<void> {
    const run = this.flushPromise.then(() => this.flushPending());
    this.flushPromise = run.catch((error) => {
      this.failure = error;
    });
    return run;
  }

  private async flushPending(): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    const pending = this.pending;
    this.pending = [];
    if (pending.length === 0) return;
    const ledger: UplinkLedgerView = {
      files: this.workspaceState.files,
      directories: [...this.directories],
    };
    const plan = coalesce(pending, ledger);
    const blocked = new Set<string>();
    for (const entry of plan) {
      if (blocked.has(entry.path)) continue;
      const result = await this.execute(entry);
      if (!result) blocked.add(entry.path);
    }
    if (this.pending.length > 0 && this.timer === undefined) this.armTimer();
  }

  private async execute(entry: UplinkPlanEntry): Promise<boolean> {
    switch (entry.kind) {
      case "mkdir":
        return this.dispatchMetadata(
          event("fs.dir.create", { v: FS_EVENT_VERSION, path: entry.path }, this.now),
          entry.path,
          entry.base,
          (state, offset) => {
            this.directories.add(entry.path);
            return { ...state, headOffset: offset };
          },
        );
      case "rmdir":
        return this.dispatchMetadata(
          event("fs.dir.remove", { v: FS_EVENT_VERSION, path: entry.path }, this.now),
          entry.path,
          entry.base,
          (state, offset) => {
            this.directories.delete(entry.path);
            return { ...state, headOffset: offset };
          },
        );
      case "delete":
        return this.dispatchMetadata(
          event("fs.file.delete", { v: FS_EVENT_VERSION, path: entry.path }, this.now),
          entry.path,
          entry.base,
          (state, offset) => {
            const files = copyFiles(state.files);
            delete files[entry.path];
            this.baseBytes.delete(entry.path);
            this.contentStreams.delete(entry.path);
            return { ...state, headOffset: offset, files };
          },
        );
      case "create":
        return this.executeCreate(entry);
      case "write":
        return this.executeWrite(entry);
    }
  }

  private async executeCreate(entry: UplinkPlanEntry): Promise<boolean> {
    const target = filePath(this.root, entry.path);
    if (!existsSync(target)) return true;
    const bytes = new Uint8Array(readFileSync(target));
    const streamId = this.newContentStreamId(entry.path);
    await this.server.createContentStream(streamId);
    await this.server.appendContent(streamId, bytes);
    this.pendingCreates.set(entry.path, { streamId });
    const accepted = await this.dispatchMetadata(
      event(
        "fs.file.create",
        { v: FS_EVENT_VERSION, path: entry.path, contentStreamId: streamId },
        this.now,
      ),
      entry.path,
      BASE_NONE,
      (state, offset) => {
        this.contentStreams.set(entry.path, streamId);
        return { ...state, headOffset: offset };
      },
    );
    if (!accepted) this.pendingCreates.delete(entry.path);
    return accepted;
  }

  private async executeWrite(entry: UplinkPlanEntry): Promise<boolean> {
    const targetPath = filePath(this.root, entry.path);
    if (!existsSync(targetPath)) return true;
    const target = new Uint8Array(readFileSync(targetPath));
    const prepared = this.pendingCreates.get(entry.path);
    const ledgerEntry = this.workspaceState.files[entry.path];
    const base = ledgerEntry?.base ?? entry.base;
    const existingContentStreamId = this.contentStreams.get(entry.path);
    const metadataStreamId = this.branchStreamId || this.workspaceState.identity.metadataStreamId;
    const inherited =
      prepared === undefined &&
      existingContentStreamId !== undefined &&
      branchName(metadataStreamId) !== "main" &&
      !existingContentStreamId.startsWith(branchContentPrefix(metadataStreamId));
    let choice: FsPatchAction | FsWriteAction;
    if (prepared !== undefined) {
      choice = {
        type: "fs.file.write",
        payload: {
          v: FS_EVENT_VERSION,
          path: entry.path,
          base: BASE_NONE,
          contentSha256: sha256Hex(target),
          size: target.byteLength,
        },
      };
    } else {
      const baseBytes = this.baseBytes.get(entry.path);
      if (baseBytes === undefined) {
        choice = {
          type: "fs.file.write",
          payload: {
            v: FS_EVENT_VERSION,
            path: entry.path,
            base,
            contentSha256: sha256Hex(target),
            size: target.byteLength,
          },
        };
      } else {
        choice = chooseWriteEvent(baseBytes, target, entry.path, base);
      }
    }

    let contentStreamId = existingContentStreamId;
    let handoffStreamId: string | undefined;
    if (inherited) {
      handoffStreamId = this.newContentStreamId(entry.path);
      await this.server.createContentStream(handoffStreamId);
      await this.server.appendContent(handoffStreamId, target);
    } else if (choice.type === "fs.file.write" && prepared === undefined) {
      if (contentStreamId === undefined) {
        throw new UplinkError("uplink/content-stream-missing", entry.path);
      }
      await this.server.appendContent(contentStreamId, target);
    }

    const accepted = await this.dispatchMetadata(
      event(choice.type, choice.payload, this.now),
      entry.path,
      choice.payload.base,
      (state, offset) => {
        const files = copyFiles(state.files);
        files[entry.path] = {
          base: offset,
          contentSha256:
            choice.type === "fs.file.patch"
              ? choice.payload.resultDigest
              : choice.payload.contentSha256,
          size: choice.type === "fs.file.patch" ? target.byteLength : choice.payload.size,
        };
        this.baseBytes.set(entry.path, target);
        if (handoffStreamId === undefined && contentStreamId !== undefined) {
          this.contentStreams.set(entry.path, contentStreamId);
        }
        this.pendingCreates.delete(entry.path);
        return { ...state, headOffset: offset, files };
      },
    );
    if (!accepted || handoffStreamId === undefined) return accepted;

    contentStreamId = handoffStreamId;
    const handoffAccepted = await this.dispatchMetadata(
      event("fs.file.create", { v: FS_EVENT_VERSION, path: entry.path, contentStreamId }, this.now),
      entry.path,
      this.workspaceState.files[entry.path]?.base ?? BASE_NONE,
      (state, offset) => {
        this.contentStreams.set(entry.path, contentStreamId!);
        return { ...state, headOffset: offset };
      },
    );
    return handoffAccepted;
  }

  private async dispatchMetadata(
    value: Event,
    path: string,
    base: string,
    update: (state: WorkspaceState, offset: string) => WorkspaceState,
  ): Promise<boolean> {
    const action = value.type as JournalRecord["action"];
    const result = await this.server.dispatch(
      this.branchStreamId || this.workspaceState.identity.metadataStreamId,
      value,
    );
    if ("conflict" in result) {
      const record = await this.journalWriter.append({
        kind: "refused",
        action,
        path,
        base,
        conflict: result.conflict,
      });
      this.refusals += 1;
      this.listener?.(record);
      return false;
    }
    const record = await this.journalWriter.append({
      kind: "accepted",
      action,
      path,
      base,
      offset: result.offset,
    });
    this.listener?.(record);
    await this.beforeLedgerAdvance(record);
    const next = update(this.workspaceState, result.offset);
    saveWorkspace(this.root, next);
    this.workspace = next;
    return true;
  }

  private get journalWriter(): JournalWriter {
    if (this.journal === undefined)
      throw new UplinkError("uplink/not-started", "journal is not ready");
    return this.journal;
  }

  /** Flush the currently observed filesystem burst without waiting for quiescence. */
  async flush(): Promise<void> {
    await this.start();
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.enqueueFlush();
    await this.flushPromise;
    if (this.failure !== undefined) throw this.failure;
  }

  private newContentStreamId(path: string): string {
    const metadataId = this.branchStreamId || this.workspaceState.identity.metadataStreamId;
    const prefix = branchContentPrefix(metadataId);
    for (;;) {
      this.contentOrdinal += 1;
      const digest = sha256Hex(Buffer.from(`${path}:${this.contentOrdinal}`, "utf8")).slice(0, 16);
      const candidate = `${prefix}${this.contentOrdinal}-${digest}`;
      if (![...this.contentStreams.values()].includes(candidate)) return candidate;
    }
  }

  async quiesce(): Promise<UplinkQuiescence> {
    await this.start();
    // Give the native watcher one debounce interval to deliver an edit that
    // raced the caller's quiesce request. Without this settling turn an edit
    // can be visible on disk while its kernel notification is still queued.
    await new Promise<void>((resolveDelay) =>
      setTimeout(resolveDelay, Math.max(2, this.debounceMs + 2)),
    );
    for (;;) {
      if (this.failure !== undefined) throw this.failure;
      if (this.pending.length === 0 && this.timer === undefined) break;
      if (this.timer !== undefined) {
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, this.debounceMs + 2));
      }
      if (this.timer !== undefined) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
      await this.enqueueFlush();
    }
    await this.flushPromise;
    if (this.failure !== undefined) throw this.failure;
    const clean = classifyWorkingTree(this.root, this.workspaceState);
    return {
      clean: clean.added.length === 0 && clean.deleted.length === 0 && clean.modified.length === 0,
      refusals: this.refusals,
      workingTreeDigest: worktreeDigestDirectory(this.root),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    await this.flushPromise;
    await this.watcher?.close();
    this.watcher = undefined;
  }
}

interface WatchOptions {
  readonly quiesce: boolean;
  readonly debounceMs: number;
}

function parseWatchOptions(args: readonly string[]): WatchOptions {
  let up = false;
  let quiesce = false;
  let debounceMs = DEFAULT_UPLINK_DEBOUNCE_MS;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--up" && !up) {
      up = true;
    } else if (argument === "--quiesce" && !quiesce) {
      quiesce = true;
    } else if (argument === "--debounce" && args[index + 1] !== undefined) {
      const value = Number(args[++index]);
      if (!Number.isSafeInteger(value) || value < 0) throw new UplinkError("usage", WATCH_USAGE);
      debounceMs = value;
    } else {
      throw new UplinkError("usage", WATCH_USAGE);
    }
  }
  if (!up) throw new UplinkError("usage", WATCH_USAGE);
  return { quiesce, debounceMs };
}

export interface WatchDependencies {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetcher?: typeof fetch;
}

export async function runWatch(
  args: readonly string[],
  io: CliIo,
  dependencies: WatchDependencies = {},
): Promise<number> {
  let options: WatchOptions;
  try {
    options = parseWatchOptions(args);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : WATCH_USAGE}\n`);
    return 2;
  }
  const environment = dependencies.environment ?? process.env;
  const root = resolve(dependencies.cwd ?? process.cwd());
  let workspace: WorkspaceState;
  try {
    workspace = loadWorkspace(root);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const credentials: StoredCredentials | null = await loadCredentials(environment);
  if (credentials === null) {
    io.stderr("No credentials. Run `ef login`.\n");
    return 10;
  }
  const serverUrl =
    environment.EF_SERVER_URL ??
    environment.EFOREST_SERVER_URL ??
    environment.EF_SERVER ??
    workspace.identity.server;
  const streamServerUrl =
    environment.EF_STREAM_SERVER_URL ?? environment.EFOREST_SERVER_URL ?? serverUrl;
  const engineOptions: UplinkEngineOptions = {
    root,
    serverUrl,
    streamServerUrl,
    accessToken: credentials.accessToken,
    branchStreamId: workspace.identity.metadataStreamId,
    debounceMs: options.debounceMs,
    onRecord: (record) => {
      const line = journalLine(record);
      io.stdout(line);
      if (record.kind === "refused") io.stderr(line);
    },
    ...(dependencies.fetcher === undefined ? {} : { fetcher: dependencies.fetcher }),
  };
  const engine = new UplinkEngine(engineOptions);
  try {
    await engine.start();
    if (options.quiesce) {
      const result = await engine.quiesce();
      await engine.close();
      return result.refusals > 0 || !result.clean ? 3 : 0;
    }
    await new Promise<void>((resolveStopped) => {
      const stop = async (): Promise<void> => {
        await engine.close();
        resolveStopped();
      };
      process.once("SIGINT", () => void stop());
      process.once("SIGTERM", () => void stop());
    });
    return 0;
  } catch (error) {
    await engine.close();
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
