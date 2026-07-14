import { compareOffsets, OFFSET_BEFORE_FIRST, type Offset } from "@eforest/protocol";
import {
  checkpoint,
  StreamGoneError,
  StreamReader,
  type StreamCheckpoint,
  type StreamRecord,
} from "@eforest/client";
import {
  assertFsEvent,
  isFsBranchForkEvent,
  isFsBranchMergeEvent,
  isFsEvent,
  type FsEvent,
} from "./events.js";
import { isValidFsPath } from "./events.js";
import { resolveBranchLog, type BranchDump } from "./resolve.js";

export const WATCH_EVENT_NAMES = ["add", "addDir", "change", "unlink", "unlinkDir"] as const;

export type WatchEventName = (typeof WATCH_EVENT_NAMES)[number];

export interface WatchEventRecord {
  readonly event: WatchEventName;
  readonly path: string;
  readonly offset: Offset;
}

export interface FsWatchState {
  readonly files: ReadonlySet<string>;
  readonly dirs: ReadonlySet<string>;
}

export interface WatchMappingResult {
  readonly events: readonly WatchEventRecord[];
  readonly state: FsWatchState;
}

export interface WatchOptions {
  readonly baseUrl: string;
  readonly streamId: string;
  readonly from?: StreamCheckpoint | Offset;
  readonly mode?: "long-poll" | "sse";
  readonly reconnectDelayMs?: number;
  readonly fetch?: typeof fetch;
  readonly bootstrapState?: () => Promise<FsWatchState>;
}

export interface StreamFsRepoWatchOptions {
  readonly from?: StreamCheckpoint | Offset;
  readonly mode?: "long-poll" | "sse";
  readonly reconnectDelayMs?: number;
  readonly fetch?: typeof fetch;
}

type PathListener = (path: string) => void;
type AllListener = (event: WatchEventName, path: string, offset: Offset) => void;
type BatchListener = (records: readonly WatchEventRecord[], checkpoint: StreamCheckpoint) => void;
type CheckpointListener = (checkpoint: StreamCheckpoint) => void;
type ErrorListener = (error: unknown) => void;

export interface StreamFsWatcher {
  readonly ready: Promise<void>;
  on(event: WatchEventName, listener: PathListener): this;
  on(event: "error", listener: ErrorListener): this;
  onAll(listener: AllListener): this;
  onBatch(listener: BatchListener): this;
  onCheckpoint(listener: CheckpointListener): this;
  checkpoint(): StreamCheckpoint;
  close(): Promise<void>;
}

export function emptyFsWatchState(): FsWatchState {
  return { files: new Set(), dirs: new Set() };
}

function isPathInside(root: string, path: string): boolean {
  return root === "." || root.length === 0 || path === root || path.startsWith(`${root}/`);
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepestFirst(left: string, right: string): number {
  return pathDepth(right) - pathDepth(left) || lexical(left, right);
}

function shallowestFirst(left: string, right: string): number {
  return pathDepth(left) - pathDepth(right) || lexical(left, right);
}

function renamedPath(path: string, from: string, to: string): string {
  return path === from ? to : `${to}${path.slice(from.length)}`;
}

function watchRecord(event: WatchEventName, path: string, offset: Offset): WatchEventRecord {
  return { event, path, offset };
}

function cloneState(state: FsWatchState): { files: Set<string>; dirs: Set<string> } {
  return { files: new Set(state.files), dirs: new Set(state.dirs) };
}

function recordEvent(record: StreamRecord): FsEvent | undefined {
  const candidate = { ...record } as Record<string, unknown>;
  delete candidate.offset;
  if (!isFsEvent(candidate)) return undefined;
  assertFsEvent(candidate);
  return candidate;
}

function mapOne(record: StreamRecord, state: FsWatchState): WatchMappingResult {
  const fsEvent = recordEvent(record);
  if (fsEvent === undefined || fsEvent.type === "fs.file.content") {
    return { events: [], state };
  }

  const next = cloneState(state);
  const events: WatchEventRecord[] = [];
  const offset = record.offset;
  switch (fsEvent.type) {
    case "fs.file.create":
      next.files.add(fsEvent.payload.path);
      events.push(watchRecord("add", fsEvent.payload.path, offset));
      break;
    case "fs.file.write":
    case "fs.file.patch":
      if (next.files.has(fsEvent.payload.path)) {
        events.push(watchRecord("change", fsEvent.payload.path, offset));
      }
      break;
    case "fs.file.delete":
      if (next.files.delete(fsEvent.payload.path)) {
        events.push(watchRecord("unlink", fsEvent.payload.path, offset));
      }
      break;
    case "fs.dir.create":
      next.dirs.add(fsEvent.payload.path);
      events.push(watchRecord("addDir", fsEvent.payload.path, offset));
      break;
    case "fs.dir.remove":
      if (next.dirs.delete(fsEvent.payload.path)) {
        events.push(watchRecord("unlinkDir", fsEvent.payload.path, offset));
      }
      break;
    case "fs.rename": {
      const sourceFile = next.files.has(fsEvent.payload.from);
      const sourceDir = next.dirs.has(fsEvent.payload.from);
      if (!sourceFile && !sourceDir) break;

      const oldFiles = [...next.files]
        .filter(
          (path) => path === fsEvent.payload.from || path.startsWith(`${fsEvent.payload.from}/`),
        )
        .sort(deepestFirst);
      const oldDirs = [...next.dirs]
        .filter(
          (path) => path === fsEvent.payload.from || path.startsWith(`${fsEvent.payload.from}/`),
        )
        .sort(deepestFirst);
      const oldPaths = [
        ...oldFiles.map((path) => [path, "file"] as const),
        ...oldDirs.map((path) => [path, "dir"] as const),
      ].sort((left, right) => deepestFirst(left[0], right[0]) || lexical(left[1], right[1]));
      for (const [path, kind] of oldPaths) {
        events.push(watchRecord(kind === "file" ? "unlink" : "unlinkDir", path, offset));
        next.files.delete(path);
        next.dirs.delete(path);
      }

      const movedFiles = oldFiles.map((path) =>
        renamedPath(path, fsEvent.payload.from, fsEvent.payload.to),
      );
      const movedDirs = oldDirs.map((path) =>
        renamedPath(path, fsEvent.payload.from, fsEvent.payload.to),
      );
      const newPaths = [
        ...movedFiles.map((path) => [path, "file"] as const),
        ...movedDirs.map((path) => [path, "dir"] as const),
      ].sort((left, right) => shallowestFirst(left[0], right[0]) || lexical(left[1], right[1]));
      for (const [path, kind] of newPaths) {
        events.push(watchRecord(kind === "file" ? "add" : "addDir", path, offset));
        if (kind === "file") next.files.add(path);
        else next.dirs.add(path);
      }
      break;
    }
  }
  return { events, state: { files: next.files, dirs: next.dirs } };
}

export function fsEventsToWatchEvents(
  fsEvents: readonly StreamRecord[],
  state: FsWatchState = emptyFsWatchState(),
): WatchMappingResult {
  let current = state;
  const events: WatchEventRecord[] = [];
  for (const record of fsEvents) {
    const mapped = mapOne(record, current);
    events.push(...mapped.events);
    current = mapped.state;
  }
  return { events, state: current };
}

function normalizeRoot(root: string): string {
  if (root === "." || root === "") return ".";
  if (!isValidFsPath(root)) throw new TypeError("watch root must be a repo-relative POSIX path");
  return root;
}

function normalizeFrom(value: StreamCheckpoint | Offset | undefined): StreamCheckpoint {
  if (value === undefined) return checkpoint(OFFSET_BEFORE_FIRST);
  return checkpoint(typeof value === "string" ? value : value.offset);
}

export class StreamFsWatcherImpl implements StreamFsWatcher {
  readonly ready: Promise<void>;
  private readonly root: string;
  private readonly reader: StreamReader;
  private readonly baseUrl: string;
  private readonly streamId: string;
  private readonly fetcher: typeof fetch;
  private readonly from: StreamCheckpoint;
  private readonly mode: "long-poll" | "sse";
  private readonly abortController = new AbortController();
  private readonly listeners = new Map<WatchEventName, Set<PathListener>>();
  private readonly allListeners = new Set<AllListener>();
  private readonly batchListeners = new Set<BatchListener>();
  private readonly checkpointListeners = new Set<CheckpointListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly bootstrapState: (() => Promise<FsWatchState>) | undefined;
  private readonly resolveReady: () => void;
  private readonly rejectReady: (error: unknown) => void;
  private currentCheckpoint: StreamCheckpoint;
  private historyTailOffset: Offset | undefined;
  private closed = false;
  private runPromise: Promise<void>;

  constructor(root: string, options: WatchOptions) {
    this.root = normalizeRoot(root);
    this.from = normalizeFrom(options.from);
    this.mode = options.mode ?? "long-poll";
    this.currentCheckpoint = this.from;
    const readerOptions = { baseUrl: options.baseUrl, streamId: options.streamId } as {
      baseUrl: string;
      streamId: string;
      reconnectDelayMs?: number;
      fetch?: typeof fetch;
    };
    if (options.reconnectDelayMs !== undefined)
      readerOptions.reconnectDelayMs = options.reconnectDelayMs;
    if (options.fetch !== undefined) readerOptions.fetch = options.fetch;
    this.reader = new StreamReader(readerOptions);
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.streamId = options.streamId;
    this.fetcher = options.fetch ?? fetch;
    this.bootstrapState = options.bootstrapState;
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.resolveReady = resolveReady;
    this.rejectReady = rejectReady;
    this.runPromise = this.run();
  }

  on(event: WatchEventName | "error", listener: PathListener | ErrorListener): this {
    if (event === "error") this.errorListeners.add(listener as ErrorListener);
    else {
      const registered = this.listeners.get(event) ?? new Set<PathListener>();
      registered.add(listener as PathListener);
      this.listeners.set(event, registered);
    }
    return this;
  }

  onAll(listener: AllListener): this {
    this.allListeners.add(listener);
    return this;
  }

  onBatch(listener: BatchListener): this {
    this.batchListeners.add(listener);
    return this;
  }

  onCheckpoint(listener: CheckpointListener): this {
    this.checkpointListeners.add(listener);
    return this;
  }

  checkpoint(): StreamCheckpoint {
    return this.currentCheckpoint;
  }

  async close(): Promise<void> {
    if (this.closed) return this.runPromise;
    this.closed = true;
    this.abortController.abort();
    await this.runPromise;
  }

  private async run(): Promise<void> {
    try {
      let state = emptyFsWatchState();
      let history: readonly StreamRecord[];
      try {
        history = await this.readHistory();
      } catch (error) {
        if (
          !(error instanceof StreamGoneError) ||
          this.bootstrapState === undefined ||
          compareOffsets(this.from.offset, error.snapshotOffset) < 0
        ) {
          throw error;
        }
        state = await this.bootstrapState();
        this.resolveReady();
        await this.runTail(state, this.from.offset);
        return;
      }
      for (const source of history) {
        const mapped = mapOne(source, state);
        state = mapped.state;
        const pending = mapped.events.filter(
          (record) => compareOffsets(record.offset, this.from.offset) > 0,
        );
        if (pending.length > 0) {
          await this.emitBoundary(pending, source.offset);
        }
      }
      this.resolveReady();
      const tailFrom = this.historyTailOffset ?? history.at(-1)?.offset ?? this.from.offset;
      await this.runTail(state, tailFrom);
    } catch (error) {
      this.rejectReady(error);
      if (!this.closed) {
        for (const listener of this.errorListeners) listener(error);
      }
    }
  }

  private async runTail(state: FsWatchState, tailFrom: Offset): Promise<void> {
    for await (const batch of this.reader.tail(tailFrom, {
      mode: this.mode,
      signal: this.abortController.signal,
    })) {
      if (this.closed) return;
      for (const source of batch.events) {
        const visibleRecords = await this.resolveMerge(source);
        for (const visible of visibleRecords) {
          const mapped = mapOne(visible, state);
          state = mapped.state;
          await this.emitBoundary(mapped.events, visible.offset);
        }
      }
    }
  }

  private async readHistory(): Promise<readonly StreamRecord[]> {
    const records: StreamRecord[] = [];
    for await (const batch of this.reader.read(OFFSET_BEFORE_FIRST)) records.push(...batch.events);
    this.historyTailOffset = records.at(-1)?.offset;
    if (!records.some((record) => isFsBranchMergeEvent(recordEvent(record)))) return records;
    return this.resolveAllMerges(records);
  }

  private async resolveMerge(record: StreamRecord): Promise<readonly StreamRecord[]> {
    const event = recordEvent(record);
    if (!isFsBranchMergeEvent(event)) return [record];
    const source = await this.fetchDump(event.payload.sourceStreamId);
    return resolveBranchLog([{ streamId: this.streamId, records: [record] }], undefined, [
      { streamId: event.payload.sourceStreamId, records: source },
    ]);
  }

  private async resolveAllMerges(
    records: readonly StreamRecord[],
  ): Promise<readonly StreamRecord[]> {
    if (records.some((record) => isFsBranchForkEvent(recordEvent(record)))) return records;
    const sources = new Map<string, readonly StreamRecord[]>();
    for (const record of records) {
      const event = recordEvent(record);
      if (!isFsBranchMergeEvent(event) || sources.has(event.payload.sourceStreamId)) continue;
      sources.set(event.payload.sourceStreamId, await this.fetchDump(event.payload.sourceStreamId));
    }
    const mergeSources: BranchDump[] = [...sources.entries()].map(([streamId, sourceRecords]) => ({
      streamId,
      records: sourceRecords,
    }));
    return resolveBranchLog([{ streamId: this.streamId, records }], undefined, mergeSources);
  }

  private async fetchDump(streamId: string): Promise<readonly StreamRecord[]> {
    const response = await this.fetcher(
      `${this.baseUrl}/streams/${encodeURIComponent(streamId)}/dump`,
    );
    const text = await response.text();
    if (!response.ok) throw new Error(`merge source dump failed with HTTP ${response.status}`);
    if (text.length === 0) return [];
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) throw new Error("merge source dump is not an array");
    return parsed as StreamRecord[];
  }

  private async emitBoundary(records: readonly WatchEventRecord[], offset: Offset): Promise<void> {
    const visible = records.filter((record) => isPathInside(this.root, record.path));
    for (const record of visible) {
      for (const listener of this.listeners.get(record.event) ?? []) listener(record.path);
      for (const listener of this.allListeners) listener(record.event, record.path, record.offset);
    }
    const next = checkpoint(offset);
    for (const listener of this.batchListeners) listener(visible, next);
    this.currentCheckpoint = next;
    for (const listener of this.checkpointListeners) listener(next);
  }
}

export function watch(root: string, options: WatchOptions): StreamFsWatcher {
  return new StreamFsWatcherImpl(root, options);
}
