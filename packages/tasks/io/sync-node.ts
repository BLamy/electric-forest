/**
 * Node/real-server glue for the E6-T05 task-folder sync engine. This is the only place
 * the engine touches a network or a filesystem:
 *
 * - branch reads go straight to the durable stream server (`StreamFsRepo`);
 * - every write — fs events onto the branch, task/evidence/content events — goes through
 *   the platform gateway's dispatch door with an offset receipt, so provenance is exact;
 * - the journal is persisted as canonical JSON lines when a path is given.
 *
 * Kept outside `src/` with `io/disk.ts` so the engine core stays free of `node:fs`,
 * `node:http`, and clocks (verify-E6-T01/T02/T05 assert that).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, sha256Hex, type Event, type Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { readDurableJson } from "@eforest/client";
import {
  contentBytes,
  encodeCanonicalBase64,
  reduceContentEvents,
  MAX_CHUNK_BYTES,
} from "@eforest/evidence";
import { BASE_NONE, StreamFsRepo, FS_EVENT_VERSION } from "@eforest/streamfs";
import {
  TASK_SYNC_ROOT,
  TaskFolderSyncEngine,
  TaskSyncJournal,
  parseTaskSyncJournal,
  type BranchChangeRecord,
  type BranchWriteOp,
  type BranchWriteReceipt,
  type TaskSyncBranchPort,
  type TaskSyncDispatchResult,
  type TaskSyncStreamsPort,
} from "../src/folder/index.js";
import type { StreamFsWatcher } from "@eforest/streamfs";

export interface TaskSyncClientOptions {
  readonly org: string;
  readonly repo: string;
  readonly branch: string;
  /** The engine's authenticated principal; also the bearer token subject. */
  readonly actor: string;
  readonly token: string;
  readonly gatewayUrl: string;
  readonly streamServerUrl: string;
  /** Persist the provenance journal to this file (canonical JSON lines). */
  readonly journalPath?: string;
  readonly pollMs?: number;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly onWarning?: (message: string) => void;
  /**
   * Sabotage lever for the verify target only: overrides the engine's
   * `E6_T05_ORIGIN_FILTER_GUARD` default so `verify-E6-T05` can prove the apparatus
   * goes red when provenance-based echo suppression is off.
   */
  readonly originFilter?: boolean;
}

interface OffsetEvent extends Event {
  readonly offset: Offset;
}

function stripServerMetadata(value: Event): Event {
  if (value.payload === null || typeof value.payload !== "object" || Array.isArray(value.payload)) {
    return value;
  }
  const payload = Object.fromEntries(
    Object.entries(value.payload).filter(([key]) => key !== "actor" && key !== "writer"),
  );
  return { type: value.type, payload, ts: value.ts };
}

class GatewayDoor {
  constructor(
    private readonly gatewayUrl: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch,
  ) {}

  async dispatch(
    streamId: string,
    event: Event,
    contentEvent?: Event,
  ): Promise<TaskSyncDispatchResult> {
    const response = await this.fetcher(`${this.gatewayUrl}/api/dispatch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "x-eforest-dispatch-receipt": "offset",
      },
      body: canonicalJson({
        streamId,
        event,
        ...(contentEvent === undefined ? {} : { contentEvent }),
      }),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = undefined;
    }
    if (response.status === 202) {
      const offset = (body as { readonly offset?: unknown } | undefined)?.offset;
      if (typeof offset !== "string") {
        throw new Error(`dispatch accepted without an offset receipt: ${text}`);
      }
      return { ok: true, offset: offset as Offset };
    }
    const reason =
      body !== null && typeof body === "object" && "error" in (body as Record<string, unknown>)
        ? (reasonOf((body as { readonly error: unknown }).error) ?? `HTTP ${response.status}`)
        : `HTTP ${response.status}`;
    return { ok: false, reason };
  }
}

function reasonOf(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const record = error as { readonly reason?: unknown; readonly class?: unknown };
  if (typeof record.reason === "string") return record.reason;
  if (typeof record.class === "string") return record.class;
  return undefined;
}

class NodeStreamsPort implements TaskSyncStreamsPort {
  constructor(
    private readonly door: GatewayDoor,
    private readonly streamServerUrl: string,
    private readonly fetcher: typeof fetch,
    private readonly now: () => number,
  ) {}

  private url(streamId: string): string {
    return `${this.streamServerUrl.replace(/\/+$/, "")}/streams/${encodeURIComponent(streamId)}`;
  }

  async read(streamId: string): Promise<readonly OffsetEvent[]> {
    let values: readonly Event[];
    try {
      values = await readDurableJson<Event>({ url: this.url(streamId), fetch: this.fetcher });
    } catch {
      return [];
    }
    return values.map((value, index) => ({
      ...stripServerMetadata(value),
      offset: offsetForOrdinal(index),
    }));
  }

  async dispatch(streamId: string, event: Event): Promise<TaskSyncDispatchResult> {
    return this.door.dispatch(streamId, event);
  }

  async ensureContent(contentStreamId: string, bytes: Uint8Array, sha256: string): Promise<void> {
    const existing = await this.read(contentStreamId);
    if (existing.length > 0) {
      const state = reduceContentEvents(existing);
      if (!state.sealed || state.sha256 !== sha256) {
        throw new Error(`content stream ${contentStreamId} exists but does not seal to ${sha256}`);
      }
      return;
    }
    let seq = 0;
    for (let start = 0; start < bytes.byteLength; start += MAX_CHUNK_BYTES) {
      const chunk = bytes.slice(start, Math.min(start + MAX_CHUNK_BYTES, bytes.byteLength));
      const result = await this.door.dispatch(contentStreamId, {
        type: "content.chunk",
        payload: { v: 1, seq, bytes: encodeCanonicalBase64(chunk) },
        ts: this.now(),
      });
      if (!result.ok) throw new Error(`content chunk refused: ${result.reason}`);
      seq += 1;
    }
    const sealed = await this.door.dispatch(contentStreamId, {
      type: "content.sealed",
      payload: { v: 1, sha256, size: bytes.byteLength, chunks: seq },
      ts: this.now(),
    });
    if (!sealed.ok) throw new Error(`content seal refused: ${sealed.reason}`);
  }

  async readContent(contentStreamId: string): Promise<Uint8Array> {
    const state = reduceContentEvents(await this.read(contentStreamId));
    if (!state.sealed) throw new Error(`content stream ${contentStreamId} is not validly sealed`);
    return contentBytes(state);
  }
}

class NodeBranchPort implements TaskSyncBranchPort {
  readonly stream: string;

  constructor(
    private readonly repo: StreamFsRepo,
    private readonly door: GatewayDoor,
    private readonly contentStreamPrefix: string,
    private readonly now: () => number,
  ) {
    this.stream = repo.metadataStreamId;
  }

  async filesAt(offset?: Offset): Promise<ReadonlyMap<string, string>> {
    const tree = offset === undefined ? await this.repo.tree() : await this.repo.treeAt(offset);
    const files = new Map<string, string>();
    for (const [path, state] of Object.entries(tree.files)) {
      // A file that is created but not yet written has no committed content generation
      // (its lastContentOffset is still BASE_NONE and its digest is the zero sentinel);
      // it stays invisible until its first `fs.file.write` lands.
      if (
        typeof state.contentSha256 === "string" &&
        /^[0-9a-f]{64}$/.test(state.contentSha256) &&
        state.lastContentOffset !== BASE_NONE
      ) {
        files.set(path, state.contentSha256);
      }
    }
    return files;
  }

  async readFileAt(path: string, offset?: Offset): Promise<Uint8Array> {
    return this.repo.readFileAt(path, offset);
  }

  private async dispatchFs(event: Event, contentEvent?: Event): Promise<Offset> {
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.door.dispatch(this.stream, event, contentEvent);
      if (result.ok) return result.offset;
      if (attempt >= 2) throw new Error(`branch write refused: ${result.reason} (${event.type})`);
    }
  }

  async write(ops: readonly BranchWriteOp[]): Promise<readonly BranchWriteReceipt[]> {
    const receipts: BranchWriteReceipt[] = [];
    const tree = await this.repo.tree();
    const dirs = new Set(Object.keys(tree.dirs));
    const files = new Map(Object.entries(tree.files));
    let createOrdinals: Map<string, number> | undefined;
    for (const op of ops) {
      if (op.kind === "delete") {
        if (!files.has(op.path)) continue;
        const offset = await this.dispatchFs({
          type: "fs.file.delete",
          payload: { v: FS_EVENT_VERSION, path: op.path },
          ts: this.now(),
        });
        files.delete(op.path);
        receipts.push({ offset, path: op.path, type: "fs.file.delete" });
        continue;
      }
      const segments = op.path.split("/");
      for (let depth = 1; depth < segments.length; depth += 1) {
        const dir = segments.slice(0, depth).join("/");
        if (dirs.has(dir)) continue;
        const offset = await this.dispatchFs({
          type: "fs.dir.create",
          payload: { v: FS_EVENT_VERSION, path: dir },
          ts: this.now(),
        });
        dirs.add(dir);
        receipts.push({ offset, path: dir, type: "fs.dir.create" });
      }
      const sha256 = sha256Hex(op.bytes);
      const existing = files.get(op.path);
      let contentStreamId: string;
      let base: string;
      if (existing === undefined) {
        if (createOrdinals === undefined) {
          createOrdinals = new Map();
          for (const record of await this.repo.rawDump()) {
            if (record.type !== "fs.file.create") continue;
            const path = (record.payload as { readonly path?: unknown }).path;
            if (typeof path === "string") {
              createOrdinals.set(path, (createOrdinals.get(path) ?? 0) + 1);
            }
          }
        }
        const ordinal = (createOrdinals.get(op.path) ?? 0) + 1;
        createOrdinals.set(op.path, ordinal);
        contentStreamId = `${this.contentStreamPrefix}sync-${sha256Hex(
          new TextEncoder().encode(op.path),
        ).slice(0, 16)}-${ordinal}`;
        const createOffset = await this.dispatchFs({
          type: "fs.file.create",
          payload: { v: FS_EVENT_VERSION, path: op.path, contentStreamId },
          ts: this.now(),
        });
        receipts.push({ offset: createOffset, path: op.path, type: "fs.file.create" });
        base = BASE_NONE;
      } else {
        contentStreamId = existing.contentStreamId;
        base = existing.lastContentOffset;
      }
      const writeOffset = await this.dispatchFs(
        {
          type: "fs.file.write",
          payload: {
            v: FS_EVENT_VERSION,
            path: op.path,
            base,
            contentSha256: sha256,
            size: op.bytes.byteLength,
          },
          ts: this.now(),
        },
        {
          type: "fs.file.content",
          payload: {
            v: FS_EVENT_VERSION,
            contentStreamId,
            contentBase64: Buffer.from(op.bytes).toString("base64"),
          },
          ts: this.now(),
        },
      );
      receipts.push({ offset: writeOffset, path: op.path, type: "fs.file.write" });
      files.set(op.path, {
        ...(existing ?? {}),
        contentStreamId,
        contentSha256: sha256,
        size: op.bytes.byteLength,
        lastContentOffset: writeOffset,
      } as (typeof tree.files)[string]);
    }
    return receipts;
  }
}

/** One live sync client: engine + watcher + poll loop against real servers. */
export class TaskSyncClient {
  readonly engine: TaskFolderSyncEngine;
  readonly journal: TaskSyncJournal;
  readonly branchStream: string;
  private readonly repo: StreamFsRepo;
  private watcher: StreamFsWatcher | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly options: TaskSyncClientOptions) {
    const fetcher = options.fetcher ?? fetch;
    const now = options.now ?? Date.now;
    const door = new GatewayDoor(options.gatewayUrl, options.token, fetcher);
    this.repo = new StreamFsRepo(
      options.streamServerUrl,
      fetcher,
      `${options.org}/${options.repo}`,
      options.branch,
      now,
    );
    this.branchStream = this.repo.metadataStreamId;
    const journalRecords =
      options.journalPath !== undefined && existsSync(options.journalPath)
        ? parseTaskSyncJournal(readFileSync(options.journalPath, "utf8"))
        : [];
    this.journal = new TaskSyncJournal(journalRecords, (line) => {
      if (this.options.journalPath === undefined) return;
      mkdirSync(dirname(this.options.journalPath), { recursive: true });
      appendFileSync(this.options.journalPath, line);
    });
    this.engine = new TaskFolderSyncEngine({
      org: options.org,
      repo: options.repo,
      actor: options.actor,
      branch: new NodeBranchPort(
        this.repo,
        door,
        `fs:${options.org}/${options.repo}:${options.branch}:file:`,
        now,
      ),
      streams: new NodeStreamsPort(door, options.streamServerUrl, fetcher, now),
      journal: this.journal,
      now,
      ...(options.originFilter === undefined ? {} : { originFilter: options.originFilter }),
      ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
    });
  }

  /** Start the watcher (history replay included) and the task-stream poll loop. */
  async start(): Promise<void> {
    if (this.watcher !== undefined) return;
    this.watcher = this.repo.watch(TASK_SYNC_ROOT);
    this.watcher.onBatch((records) => {
      if (records.length === 0) return;
      const changes: BranchChangeRecord[] = records.map((record) => ({
        event: record.event,
        path: record.path,
        offset: record.offset,
      }));
      this.chain = this.chain.then(() =>
        this.engine
          .handleBranchBatch(changes)
          .catch((error: unknown) => this.options.onWarning?.(`ingest error: ${String(error)}`)),
      );
    });
    this.watcher.on("error", (error) => {
      this.options.onWarning?.(`watch error: ${String(error)}`);
    });
    await this.watcher.ready;
    const pollMs = this.options.pollMs ?? 150;
    this.timer = setInterval(() => {
      if (this.polling) return;
      this.polling = true;
      void this.engine
        .refreshAll()
        .catch((error: unknown) => this.options.onWarning?.(`poll error: ${String(error)}`))
        .finally(() => {
          this.polling = false;
        });
    }, pollMs);
  }

  /** Process everything already queued and return once the engine is idle. */
  async settle(): Promise<void> {
    await this.chain;
    await this.engine.settle();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.watcher?.close();
    this.watcher = undefined;
    await this.settle();
  }
}
