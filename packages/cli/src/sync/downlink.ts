import { StreamReader, type StreamRecord } from "@eforest/client";
import { compareOffsets, type Event, type Offset } from "@eforest/protocol";
import { nextAllocatedOffset } from "@eforest/protocol/offset-allocation";
import {
  applyPatch,
  contentMap,
  digestBytes,
  isBranchContentStreamId,
  isFsEvent,
  isFsFastForwardMergeEvent,
  isFsThreeWayMergeEvent,
  type FsEvent,
  type FsTree,
  StreamFsRepo,
} from "@eforest/streamfs";
import {
  BASE_NONE,
  load as loadWorkspace,
  save as saveWorkspace,
  type WorkspaceFileBase,
  type WorkspaceState,
} from "@eforest/workspace";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { COMPLETE_MARKER } from "../clone-command.js";
import type { CliIo } from "../cli.js";
import { loadCredentials, type StoredCredentials } from "../credentials.js";
import {
  ApplyJournalError,
  ApplyJournalRecord,
  ApplyJournalWriter,
  type ApplyIntent,
  type ApplyIntentInput,
  applyBasePath,
  captureWorktreeSnapshot,
  intentPath,
  journalPath,
  readApplyIntent,
  readApplyBase,
  readApplyJournal,
  removeApplyIntent,
  restoreWorktreeSnapshot,
  snapshotDigest,
  snapshotPathDigest,
  type WorktreeSnapshot,
  verifyApplyJournal,
  writeApplyIntent,
  writeApplyBase,
} from "./apply-journal.js";

export const DOWNLINK_USAGE = "Usage: ef watch --down [--dir <dir>] [--porcelain]";

export type DownlinkErrorCode =
  | "EDIRTY_BASE"
  | "EJOURNAL_CORRUPT"
  | "ECHECKPOINT_MISMATCH"
  | "ECORRUPT_EVENT"
  | "ENO_WORKSPACE"
  | "ENETWORK"
  | "EUSAGE";

export class DownlinkError extends Error {
  readonly code: DownlinkErrorCode;

  constructor(code: DownlinkErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "DownlinkError";
    this.code = code;
  }
}

export type DownlinkPhase =
  "before-intent" | "after-intent" | "after-rename" | "after-journal-commit" | "before-checkpoint";

export interface DownlinkApplyNotice {
  readonly offset: string;
  readonly kind: string;
  readonly paths: readonly string[];
  readonly disposition: "applied" | "suppressed";
  readonly writerId: string;
  readonly event: Event;
  readonly pathFingerprints: readonly {
    readonly path: string;
    readonly fingerprint: string;
  }[];
}

export interface DownlinkEngineOptions {
  readonly root: string;
  readonly streamServerUrl: string;
  readonly accessToken: string;
  readonly fetcher?: typeof fetch;
  readonly writerId?: string;
  readonly writerIdProvider?: () => string | undefined;
  readonly uploadedRecordProvider?: () => readonly {
    readonly offset: string;
    readonly writerId: string;
    readonly path: string;
  }[];
  readonly beforeApply?: (notice: DownlinkApplyNotice) => void | Promise<void>;
  readonly afterCheckpoint?: (notice: DownlinkApplyNotice) => void | Promise<void>;
  readonly onApply?: (record: ApplyJournalRecord) => void;
  readonly onSuppressed?: (record: ApplyJournalRecord) => void;
  readonly onPhase?: (phase: DownlinkPhase, offset: string) => void | Promise<void>;
}

interface FileModel {
  readonly files: Map<string, Uint8Array>;
  readonly directories: Set<string>;
}

interface DownlinkPlan {
  readonly event: Event;
  readonly record: StreamRecord;
  readonly paths: readonly string[];
  readonly before: WorktreeSnapshot;
  readonly after: WorktreeSnapshot;
  readonly beforeWorkspace: WorkspaceState;
  readonly afterWorkspace: WorkspaceState;
  readonly beforeDigest: string;
  readonly afterDigest: string;
  readonly pathDigests: readonly {
    readonly path: string;
    readonly before: string | null;
    readonly after: string | null;
  }[];
}

function trimUrl(value: string): string {
  const result = value.replace(/\/+$/, "");
  if (result.length === 0) throw new DownlinkError("EUSAGE", "stream server URL is empty");
  return result;
}

function authFetch(fetcher: typeof fetch, accessToken: string): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    if (!headers.has("authorization")) headers.set("authorization", `Bearer ${accessToken}`);
    return fetcher(input, { ...init, headers });
  };
}

function streamRepoName(metadataStreamId: string, branch: string): string {
  const suffix = `:${branch}:meta`;
  if (!metadataStreamId.startsWith("fs:") || !metadataStreamId.endsWith(suffix)) {
    throw new DownlinkError(
      "ENO_WORKSPACE",
      `metadata stream id is not a branch stream: ${metadataStreamId}`,
    );
  }
  const name = metadataStreamId.slice(3, -suffix.length);
  if (name.length === 0)
    throw new DownlinkError("ENO_WORKSPACE", "metadata stream id has no repository name");
  return name;
}

function eventOf(record: StreamRecord): Event {
  return { type: record.type, payload: record.payload, ts: record.ts };
}

function eventWriterId(record: StreamRecord): string | undefined {
  const payload = record.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const writer = (payload as { readonly writer?: unknown }).writer;
  if (writer !== null && typeof writer === "object" && !Array.isArray(writer)) {
    const subject = (writer as { readonly sub?: unknown }).sub;
    if (typeof subject === "string" && subject.length > 0) return subject;
  }
  const writerId = (payload as { readonly writerId?: unknown }).writerId;
  return typeof writerId === "string" && writerId.length > 0 ? writerId : undefined;
}

function eventPaths(event: Event): readonly string[] {
  const payload = event.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return [];
  const value = payload as Record<string, unknown>;
  if (typeof value.path === "string") return [value.path];
  const paths: string[] = [];
  if (typeof value.from === "string") paths.push(value.from);
  if (typeof value.to === "string") paths.push(value.to);
  return [...new Set(paths)];
}

function snapshotPathFingerprint(snapshot: WorktreeSnapshot, path: string): string {
  const digest = snapshotPathDigest(snapshot, path);
  if (digest !== null) return `file:${digest}`;
  if (snapshot.directories.includes(path)) return "directory";
  return "missing";
}

function parentPath(path: string): string | undefined {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? undefined : path.slice(0, separator);
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function cloneModel(model: FileModel): FileModel {
  return {
    files: new Map([...model.files].map(([path, bytes]) => [path, cloneBytes(bytes)])),
    directories: new Set(model.directories),
  };
}

function modelFromSnapshot(snapshot: WorktreeSnapshot): FileModel {
  return {
    files: new Map(
      Object.entries(snapshot.files).map(([path, encoded]) => [
        path,
        new Uint8Array(Buffer.from(encoded, "base64")),
      ]),
    ),
    directories: new Set(snapshot.directories),
  };
}

function snapshotFromModel(model: FileModel): WorktreeSnapshot {
  const files: Record<string, string> = {};
  for (const [path, bytes] of [...model.files.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    files[path] = Buffer.from(bytes).toString("base64");
  }
  return {
    files,
    directories: [...model.directories].sort(),
  };
}

function pathList(values: Iterable<string>): readonly string[] {
  return [...new Set(values)].sort((left, right) => {
    const leftParts = left.split("/");
    const rightParts = right.split("/");
    return leftParts.length - rightParts.length || left.localeCompare(right);
  });
}

function descendants(model: FileModel, root: string): readonly string[] {
  const prefix = `${root}/`;
  return pathList([
    ...[...model.files.keys()].filter((path) => path === root || path.startsWith(prefix)),
    ...[...model.directories].filter((path) => path === root || path.startsWith(prefix)),
  ]);
}

function pathIsPresent(model: FileModel, path: string): boolean {
  return model.files.has(path) || model.directories.has(path);
}

function parentExists(model: FileModel, path: string): boolean {
  const parent = parentPath(path);
  return parent === undefined || model.directories.has(parent);
}

function copyWorkspaceFiles(
  files: Readonly<Record<string, WorkspaceFileBase>>,
): Record<string, WorkspaceFileBase> {
  return { ...files };
}

function workspaceWith(
  workspace: WorkspaceState,
  headOffset: string,
  files: Readonly<Record<string, WorkspaceFileBase>>,
): WorkspaceState {
  return { ...workspace, headOffset, files };
}

function workspaceAfterOwnEvent(
  workspace: WorkspaceState,
  record: StreamRecord,
  event: FsEvent,
  snapshot: WorktreeSnapshot,
): WorkspaceState {
  const files = copyWorkspaceFiles(workspace.files);
  switch (event.type) {
    case "fs.file.create":
      files[event.payload.path] ??= emptyLedger();
      break;
    case "fs.file.write":
      files[event.payload.path] = {
        base: record.offset,
        contentSha256: event.payload.contentSha256,
        size: event.payload.size,
      };
      break;
    case "fs.file.patch": {
      const bytes = snapshot.files[event.payload.path];
      files[event.payload.path] = {
        base: record.offset,
        contentSha256: event.payload.resultDigest,
        size: bytes === undefined ? 0 : Buffer.from(bytes, "base64").byteLength,
      };
      break;
    }
    case "fs.file.delete":
      delete files[event.payload.path];
      break;
    default:
      break;
  }
  return workspaceWith(workspace, record.offset, files);
}

function emptyLedger(): WorkspaceFileBase {
  const bytes = new Uint8Array();
  return { base: BASE_NONE, contentSha256: digestBytes(bytes), size: 0 };
}

function isTrackedClean(
  model: FileModel,
  workspace: WorkspaceState,
  path: string,
  offset: string,
): void {
  const ledger = workspace.files[path];
  const bytes = model.files.get(path);
  if (bytes === undefined) {
    throw new DownlinkError(
      "ECORRUPT_EVENT",
      `event ${offset} refers to missing tracked file ${path}`,
    );
  }
  if (ledger === undefined) {
    throw new DownlinkError(
      "EDIRTY_BASE",
      `${path} is an untracked local file at stream offset ${offset}`,
    );
  }
  const actual = digestBytes(bytes);
  if (actual !== ledger.contentSha256 || bytes.byteLength !== ledger.size) {
    throw new DownlinkError(
      "EDIRTY_BASE",
      `${path} is locally modified at stream offset ${offset}`,
    );
  }
}

function assertBase(ledger: WorkspaceFileBase, base: string, path: string, offset: string): void {
  if (ledger.base !== base) {
    throw new DownlinkError(
      "ECORRUPT_EVENT",
      `${path} at ${offset} names base ${base}, local ledger is ${ledger.base}`,
    );
  }
}

function moveMap<T>(map: Map<string, T>, from: string, to: string): void {
  const prefix = `${from}/`;
  for (const [path, value] of [...map.entries()]) {
    if (path === from) {
      map.delete(path);
      map.set(to, value);
    } else if (path.startsWith(prefix)) {
      map.delete(path);
      map.set(`${to}${path.slice(from.length)}`, value);
    }
  }
}

function moveSet(values: Set<string>, from: string, to: string): void {
  const prefix = `${from}/`;
  for (const path of [...values]) {
    if (path === from) {
      values.delete(path);
      values.add(to);
    } else if (path.startsWith(prefix)) {
      values.delete(path);
      values.add(`${to}${path.slice(from.length)}`);
    }
  }
}

function moveWorkspaceFiles(
  files: Record<string, WorkspaceFileBase>,
  from: string,
  to: string,
): void {
  const prefix = `${from}/`;
  for (const [path, value] of Object.entries(files)) {
    if (path === from) {
      delete files[path];
      files[to] = value;
    } else if (path.startsWith(prefix)) {
      delete files[path];
      files[`${to}${path.slice(from.length)}`] = value;
    }
  }
}

function pathDigestChanges(
  before: WorktreeSnapshot,
  after: WorktreeSnapshot,
  paths: readonly string[],
): readonly {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
}[] {
  return paths.map((path) => ({
    path,
    before: snapshotPathDigest(before, path),
    after: snapshotPathDigest(after, path),
  }));
}

function checkWorkspaceMarker(root: string): void {
  const marker = join(root, ".ef", "complete");
  if (!existsSync(marker))
    throw new DownlinkError("ENO_WORKSPACE", `${root} is not a complete ef workspace`);
  let content: string;
  try {
    content = readFileSync(marker, "utf8");
  } catch (error) {
    throw new DownlinkError("ENO_WORKSPACE", `cannot read ${marker}: ${String(error)}`);
  }
  if (content !== COMPLETE_MARKER)
    throw new DownlinkError("ENO_WORKSPACE", `${marker} is not canonical`);
}

function mapJournalError(error: unknown): DownlinkError {
  if (error instanceof DownlinkError) return error;
  if (error instanceof ApplyJournalError)
    return new DownlinkError("EJOURNAL_CORRUPT", error.message);
  return new DownlinkError(
    "EJOURNAL_CORRUPT",
    error instanceof Error ? error.message : String(error),
  );
}

export class DownlinkEngine {
  private readonly root: string;
  private readonly streamServerUrl: string;
  private readonly accessToken: string;
  private readonly fetcher: typeof fetch;
  private readonly writerIdProvider: (() => string | undefined) | undefined;
  private readonly uploadedRecordProvider:
    | (() => readonly {
        readonly offset: string;
        readonly writerId: string;
        readonly path: string;
      }[])
    | undefined;
  private readonly beforeApply: ((notice: DownlinkApplyNotice) => void | Promise<void>) | undefined;
  private readonly afterCheckpoint:
    ((notice: DownlinkApplyNotice) => void | Promise<void>) | undefined;
  private readonly onApply: ((record: ApplyJournalRecord) => void) | undefined;
  private readonly onSuppressed: ((record: ApplyJournalRecord) => void) | undefined;
  private readonly onPhase:
    ((phase: DownlinkPhase, offset: string) => void | Promise<void>) | undefined;
  private readonly abortController = new AbortController();
  private readonly journalFile: string;
  private readonly intentFile: string;
  private readonly baseFile: string;
  private workspace: WorkspaceState | undefined;
  private model: FileModel | undefined;
  private journal: ApplyJournalWriter | undefined;
  private journalRecords: readonly ApplyJournalRecord[] = [];
  private repo: StreamFsRepo | undefined;
  private reader: StreamReader | undefined;
  private started = false;
  private closed = false;

  constructor(options: DownlinkEngineOptions) {
    this.root = resolve(options.root);
    this.streamServerUrl = trimUrl(options.streamServerUrl);
    this.accessToken = options.accessToken;
    this.fetcher = authFetch(options.fetcher ?? fetch, options.accessToken);
    this.writerIdProvider =
      options.writerIdProvider ??
      (options.writerId === undefined ? undefined : () => options.writerId);
    this.uploadedRecordProvider = options.uploadedRecordProvider;
    this.beforeApply = options.beforeApply;
    this.afterCheckpoint = options.afterCheckpoint;
    this.onApply = options.onApply;
    this.onSuppressed = options.onSuppressed;
    this.onPhase = options.onPhase;
    this.journalFile = journalPath(this.root);
    this.intentFile = intentPath(this.root);
    this.baseFile = applyBasePath(this.root);
  }

  get workspaceState(): WorkspaceState {
    if (this.workspace === undefined)
      throw new DownlinkError("ENO_WORKSPACE", "downlink is not started");
    return this.workspace;
  }

  get journalPath(): string {
    return this.journalFile;
  }

  get journalState(): readonly ApplyJournalRecord[] {
    return [...this.journalRecords];
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.closed) throw new DownlinkError("ENO_WORKSPACE", "downlink is closed");
    if (!existsSync(this.root) || !lstatSync(this.root).isDirectory()) {
      throw new DownlinkError("ENO_WORKSPACE", `${this.root} is not a directory`);
    }
    checkWorkspaceMarker(this.root);
    let workspace: WorkspaceState;
    try {
      workspace = loadWorkspace(this.root);
    } catch (error) {
      throw new DownlinkError(
        "ENO_WORKSPACE",
        error instanceof Error ? error.message : String(error),
      );
    }
    let records: readonly ApplyJournalRecord[];
    try {
      records = readApplyJournal(this.journalFile);
      const journalHead = records.at(-1)?.offset ?? readApplyBase(this.baseFile)?.baseOffset;
      if (
        journalHead !== undefined &&
        compareOffsets(journalHead as Offset, workspace.headOffset as Offset) < 0
      ) {
        const uploadedRecords = this.uploadedRecordProvider?.() ?? [];
        const uploaded = new Map<string, (typeof uploadedRecords)[number][]>();
        for (const record of uploadedRecords) {
          const matches = uploaded.get(record.offset) ?? [];
          matches.push(record);
          uploaded.set(record.offset, matches);
        }
        const repoName = streamRepoName(
          workspace.identity.metadataStreamId,
          workspace.identity.branch,
        );
        const recoveryRepo = new StreamFsRepo(
          this.streamServerUrl,
          this.fetcher,
          repoName,
          workspace.identity.branch,
        );
        const streamRecords = new Map(
          (await recoveryRepo.rawDump()).map((record) => [record.offset, record]),
        );
        const writer = new ApplyJournalWriter(this.journalFile);
        const digest = snapshotDigest(captureWorktreeSnapshot(this.root));
        const selfWriterId = this.writerIdProvider?.();
        if (selfWriterId === undefined) {
          throw new DownlinkError(
            "ECHECKPOINT_MISMATCH",
            "checkpoint recovery requires a known local writer identity",
          );
        }
        let offset = nextAllocatedOffset(journalHead as Offset);
        while (compareOffsets(offset, workspace.headOffset as Offset) <= 0) {
          const uploadedMatches = uploaded.get(offset);
          const streamRecord = streamRecords.get(offset);
          if (uploadedMatches?.length !== 1 || streamRecord === undefined) {
            throw new DownlinkError(
              "ECHECKPOINT_MISMATCH",
              `checkpoint gap ${offset} lacks unambiguous ${streamRecord === undefined ? "stream" : "uploaded journal"} evidence`,
            );
          }
          const uploadedRecord = uploadedMatches[0]!;
          const event = eventOf(streamRecord);
          if (
            uploadedRecord.writerId !== selfWriterId ||
            eventWriterId(streamRecord) !== selfWriterId ||
            !eventPaths(event).includes(uploadedRecord.path)
          ) {
            throw new DownlinkError(
              "ECHECKPOINT_MISMATCH",
              `checkpoint gap ${offset} does not match uploaded writer/path`,
            );
          }
          await writer.append({
            offset,
            kind: "suppressed",
            paths: [],
            beforeDigest: digest,
            afterDigest: digest,
            pathDigests: [],
            provenance: { type: streamRecord.type, ts: streamRecord.ts },
          });
          offset = nextAllocatedOffset(offset);
        }
        records = readApplyJournal(this.journalFile);
      }
      const base = readApplyBase(this.baseFile);
      if (base === undefined) {
        if (records.length > 0) {
          throw new DownlinkError(
            "EJOURNAL_CORRUPT",
            "apply journal has no durable base checkpoint",
          );
        }
        await writeApplyBase(this.baseFile, workspace.headOffset);
      }
      const intent = readApplyIntent(this.intentFile);
      if (intent !== undefined) {
        records = await this.recoverIntent(workspace, records, intent);
        workspace = loadWorkspace(this.root);
      }
      records = readApplyJournal(this.journalFile);
    } catch (error) {
      throw mapJournalError(error);
    }
    try {
      const base = readApplyBase(this.baseFile);
      if (base === undefined) throw new ApplyJournalError("apply base disappeared during startup");
      const baseOffset = base.baseOffset as Offset;
      if (records.length === 0) {
        if (workspace.headOffset !== baseOffset) {
          throw new DownlinkError(
            "ECHECKPOINT_MISMATCH",
            `checkpoint ${workspace.headOffset} is ahead of empty journal base ${baseOffset}`,
          );
        }
      } else {
        const expectedFirst = nextAllocatedOffset(baseOffset);
        if (records[0]!.offset !== expectedFirst) {
          throw new DownlinkError(
            "ECHECKPOINT_MISMATCH",
            `journal begins at ${records[0]!.offset}, expected ${expectedFirst} after base ${baseOffset}`,
          );
        }
        for (let index = 1; index < records.length; index += 1) {
          const expected = nextAllocatedOffset(records[index - 1]!.offset as Offset);
          if (records[index]!.offset !== expected) {
            throw new DownlinkError(
              "ECHECKPOINT_MISMATCH",
              `journal has a gap between ${records[index - 1]!.offset} and ${records[index]!.offset}`,
            );
          }
        }
      }
    } catch (error) {
      if (error instanceof DownlinkError) throw error;
      throw mapJournalError(error);
    }
    const last = records.at(-1);
    if (last !== undefined && last.offset !== workspace.headOffset) {
      throw new DownlinkError(
        "ECHECKPOINT_MISMATCH",
        `checkpoint ${workspace.headOffset} does not equal journal head ${last.offset}`,
      );
    }
    const snapshot = captureWorktreeSnapshot(this.root);
    this.workspace = workspace;
    this.model = modelFromSnapshot(snapshot);
    this.journalRecords = records;
    this.journal = new ApplyJournalWriter(this.journalFile);
    const fetcher = this.fetcher;
    const repoName = streamRepoName(workspace.identity.metadataStreamId, workspace.identity.branch);
    this.repo = new StreamFsRepo(
      this.streamServerUrl,
      fetcher,
      repoName,
      workspace.identity.branch,
    );
    this.reader = new StreamReader({
      baseUrl: this.streamServerUrl,
      streamId: workspace.identity.metadataStreamId,
      fetch: fetcher,
    });
    this.started = true;
  }

  private async phase(phase: DownlinkPhase, offset: string, applyOrdinal: number): Promise<void> {
    await this.onPhase?.(phase, offset);
    const failpoint = process.env.EFOREST_DOWNLINK_FAILPOINT;
    const [targetPhase, targetOrdinal] = failpoint?.split("@") ?? [];
    if (
      targetPhase === phase &&
      (targetOrdinal === undefined || Number.parseInt(targetOrdinal, 10) === applyOrdinal)
    ) {
      process.kill(process.pid, "SIGKILL");
    }
  }

  private async recoverIntent(
    workspace: WorkspaceState,
    records: readonly ApplyJournalRecord[],
    intent: ApplyIntent,
  ): Promise<readonly ApplyJournalRecord[]> {
    const committed = records.find((record) => record.offset === intent.offset);
    if (committed !== undefined) {
      if (
        committed.afterDigest !== intent.afterDigest ||
        committed.beforeDigest !== intent.beforeDigest ||
        committed.kind !== intent.kind ||
        JSON.stringify(committed.paths) !== JSON.stringify(intent.paths)
      ) {
        throw new DownlinkError(
          "EJOURNAL_CORRUPT",
          `journal commit does not match intent ${intent.offset}`,
        );
      }
      restoreWorktreeSnapshot(this.root, intent.after);
      saveWorkspace(this.root, intent.afterWorkspace);
    } else {
      if (
        records.some(
          (record) => compareOffsets(record.offset as Offset, intent.offset as Offset) > 0,
        )
      ) {
        throw new DownlinkError(
          "ECHECKPOINT_MISMATCH",
          `journal passed unresolved intent ${intent.offset}`,
        );
      }
      restoreWorktreeSnapshot(this.root, intent.before);
      saveWorkspace(this.root, intent.beforeWorkspace);
    }
    await removeApplyIntent(this.intentFile);
    return readApplyJournal(this.journalFile);
  }

  private requireStarted(): {
    readonly workspace: WorkspaceState;
    readonly model: FileModel;
    readonly journal: ApplyJournalWriter;
    readonly repo: StreamFsRepo;
  } {
    if (
      !this.started ||
      this.workspace === undefined ||
      this.model === undefined ||
      this.journal === undefined ||
      this.repo === undefined
    ) {
      throw new DownlinkError("ENO_WORKSPACE", "downlink is not started");
    }
    return { workspace: this.workspace, model: this.model, journal: this.journal, repo: this.repo };
  }

  private async remoteBytes(repo: StreamFsRepo, path: string, offset: Offset): Promise<Uint8Array> {
    try {
      const bytes = await repo.readFileAt(path, offset);
      return new Uint8Array(bytes);
    } catch (error) {
      throw new DownlinkError(
        "ECORRUPT_EVENT",
        `cannot materialize ${path} at ${offset}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async applyRemoteTree(
    model: FileModel,
    workspace: WorkspaceState,
    tree: FsTree,
    offset: Offset,
  ): Promise<{
    readonly model: FileModel;
    readonly workspace: WorkspaceState;
    readonly paths: readonly string[];
  }> {
    const after = cloneModel(model);
    const files = copyWorkspaceFiles(workspace.files);
    const contents = contentMap(tree);
    const remote = new Map<string, Uint8Array>();
    for (const [path, file] of Object.entries(tree.files)) {
      const cached = contents.get(file.contentStreamId);
      const bytes =
        cached !== undefined &&
        digestBytes(cached) === file.contentSha256 &&
        cached.byteLength === file.size
          ? cloneBytes(cached)
          : await this.remoteBytes(this.repo!, path, offset);
      if (digestBytes(bytes) !== file.contentSha256 || bytes.byteLength !== file.size) {
        throw new DownlinkError("ECORRUPT_EVENT", `remote tree content mismatch for ${path}`);
      }
      remote.set(path, bytes);
    }
    const affected = new Set<string>([
      ...Object.keys(workspace.files),
      ...Object.keys(tree.files),
      ...Object.keys(tree.dirs),
    ]);
    for (const path of Object.keys(workspace.files)) {
      if (!remote.has(path)) {
        isTrackedClean(model, workspace, path, offset);
        after.files.delete(path);
        delete files[path];
      }
    }
    for (const [path, bytes] of remote) {
      const existingFile = model.files.get(path);
      const existingDirectory = model.directories.has(path);
      if (existingDirectory)
        throw new DownlinkError("ECORRUPT_EVENT", `remote file collides with directory ${path}`);
      if (existingFile !== undefined && workspace.files[path] === undefined) {
        throw new DownlinkError(
          "EDIRTY_BASE",
          `remote merge would overwrite untracked file ${path}`,
        );
      }
      if (existingFile !== undefined) isTrackedClean(model, workspace, path, offset);
      after.files.set(path, bytes);
    }
    for (const path of Object.keys(tree.dirs)) {
      if (after.files.has(path))
        throw new DownlinkError("ECORRUPT_EVENT", `remote directory collides with file ${path}`);
      after.directories.add(path);
    }
    for (const path of Object.keys(tree.files)) {
      const file = tree.files[path]!;
      files[path] = {
        base: file.lastContentOffset || BASE_NONE,
        contentSha256: file.contentSha256,
        size: file.size,
      };
    }
    return {
      model: after,
      workspace: workspaceWith(workspace, offset, files),
      paths: pathList(affected),
    };
  }

  private async planEvent(record: StreamRecord, before: WorktreeSnapshot): Promise<DownlinkPlan> {
    const { workspace, model, repo } = this.requireStarted();
    const event = eventOf(record);
    if (!isFsEvent(event))
      throw new DownlinkError("ECORRUPT_EVENT", `invalid fs event at ${record.offset}`);
    const afterModel = cloneModel(model);
    const files = copyWorkspaceFiles(workspace.files);
    const affected = new Set<string>();
    let afterWorkspace: WorkspaceState = workspaceWith(workspace, record.offset, files);
    const fsEvent = event as FsEvent;

    try {
      switch (fsEvent.type) {
        case "fs.file.create": {
          const { path, contentStreamId } = fsEvent.payload;
          affected.add(path);
          if (!parentExists(afterModel, path))
            throw new DownlinkError("ECORRUPT_EVENT", `parent directory is missing for ${path}`);
          if (afterModel.directories.has(path))
            throw new DownlinkError("ECORRUPT_EVENT", `file collides with directory ${path}`);
          if (afterModel.files.has(path)) {
            if (!isBranchContentStreamId(contentStreamId))
              throw new DownlinkError("ECORRUPT_EVENT", `duplicate file create ${path}`);
            isTrackedClean(afterModel, workspace, path, record.offset);
            const bytes = await this.remoteBytes(repo, path, record.offset as Offset);
            afterModel.files.set(path, bytes);
          } else {
            afterModel.files.set(path, new Uint8Array());
            files[path] = emptyLedger();
          }
          break;
        }
        case "fs.file.write": {
          const { path, base, contentSha256, size } = fsEvent.payload;
          affected.add(path);
          if (afterModel.directories.has(path) || !afterModel.files.has(path))
            throw new DownlinkError("ECORRUPT_EVENT", `write target is not a file: ${path}`);
          const ledger = workspace.files[path];
          if (ledger === undefined)
            throw new DownlinkError("ECORRUPT_EVENT", `write target is not tracked: ${path}`);
          isTrackedClean(afterModel, workspace, path, record.offset);
          assertBase(ledger, base, path, record.offset);
          const bytes = await this.remoteBytes(repo, path, record.offset as Offset);
          if (bytes.byteLength !== size || digestBytes(bytes) !== contentSha256)
            throw new DownlinkError("ECORRUPT_EVENT", `write content mismatch for ${path}`);
          afterModel.files.set(path, bytes);
          files[path] = { base: record.offset, contentSha256, size };
          break;
        }
        case "fs.file.patch": {
          const { path, base, baseDigest, ops, resultDigest } = fsEvent.payload;
          affected.add(path);
          if (afterModel.directories.has(path) || !afterModel.files.has(path))
            throw new DownlinkError("ECORRUPT_EVENT", `patch target is not a file: ${path}`);
          const ledger = workspace.files[path];
          if (ledger === undefined)
            throw new DownlinkError("ECORRUPT_EVENT", `patch target is not tracked: ${path}`);
          isTrackedClean(afterModel, workspace, path, record.offset);
          assertBase(ledger, base, path, record.offset);
          if (ledger.contentSha256 !== baseDigest)
            throw new DownlinkError("ECORRUPT_EVENT", `patch base digest mismatch for ${path}`);
          let bytes: Uint8Array;
          try {
            bytes = applyPatch(afterModel.files.get(path)!, ops);
          } catch (error) {
            throw new DownlinkError("ECORRUPT_EVENT", `patch failed for ${path}: ${String(error)}`);
          }
          if (digestBytes(bytes) !== resultDigest)
            throw new DownlinkError("ECORRUPT_EVENT", `patch result digest mismatch for ${path}`);
          afterModel.files.set(path, bytes);
          files[path] = {
            base: record.offset,
            contentSha256: resultDigest,
            size: bytes.byteLength,
          };
          break;
        }
        case "fs.file.delete": {
          const { path } = fsEvent.payload;
          affected.add(path);
          if (afterModel.directories.has(path) || !afterModel.files.has(path))
            throw new DownlinkError("ECORRUPT_EVENT", `delete target is not a file: ${path}`);
          isTrackedClean(afterModel, workspace, path, record.offset);
          afterModel.files.delete(path);
          delete files[path];
          break;
        }
        case "fs.dir.create": {
          const { path } = fsEvent.payload;
          affected.add(path);
          if (!parentExists(afterModel, path))
            throw new DownlinkError("ECORRUPT_EVENT", `parent directory is missing for ${path}`);
          if (pathIsPresent(afterModel, path))
            throw new DownlinkError("ECORRUPT_EVENT", `directory already exists: ${path}`);
          afterModel.directories.add(path);
          break;
        }
        case "fs.dir.remove": {
          const { path } = fsEvent.payload;
          affected.add(path);
          if (!afterModel.directories.has(path))
            throw new DownlinkError("ECORRUPT_EVENT", `directory does not exist: ${path}`);
          if (descendants(afterModel, path).some((candidate) => candidate !== path))
            throw new DownlinkError("ECORRUPT_EVENT", `directory is not empty: ${path}`);
          afterModel.directories.delete(path);
          break;
        }
        case "fs.rename": {
          const { from, to } = fsEvent.payload;
          if (from === to || to.startsWith(`${from}/`))
            throw new DownlinkError("ECORRUPT_EVENT", `invalid rename ${from} -> ${to}`);
          if (!pathIsPresent(afterModel, from) || pathIsPresent(afterModel, to))
            throw new DownlinkError("ECORRUPT_EVENT", `invalid rename ${from} -> ${to}`);
          if (!parentExists(afterModel, to))
            throw new DownlinkError(
              "ECORRUPT_EVENT",
              `rename destination parent is missing: ${to}`,
            );
          const moved = descendants(afterModel, from);
          for (const path of moved) {
            affected.add(path);
            if (afterModel.files.has(path))
              isTrackedClean(afterModel, workspace, path, record.offset);
          }
          moveMap(afterModel.files, from, to);
          moveSet(afterModel.directories, from, to);
          moveWorkspaceFiles(files, from, to);
          affected.add(to);
          for (const path of moved) affected.add(`${to}${path.slice(from.length)}`);
          break;
        }
        case "fs.branch.merge": {
          if (isFsThreeWayMergeEvent(event) || isFsFastForwardMergeEvent(event)) {
            const tree = await repo.treeAt(record.offset as Offset);
            const result = await this.applyRemoteTree(
              afterModel,
              workspaceWith(workspace, record.offset, files),
              tree,
              record.offset as Offset,
            );
            for (const path of result.paths) affected.add(path);
            afterWorkspace = result.workspace;
            afterModel.files.clear();
            for (const [path, bytes] of result.model.files) afterModel.files.set(path, bytes);
            afterModel.directories.clear();
            for (const path of result.model.directories) afterModel.directories.add(path);
          }
          break;
        }
        case "fs.branch.genesis":
        case "fs.branch.fork":
        case "fs.file.content":
        case "fs/merge-change":
        case "fs/merge-conflict":
        case "fs/merge-resolve":
        case "fs.snapshot":
          break;
        default: {
          const unsupported = event.type;
          throw new DownlinkError("ECORRUPT_EVENT", `unsupported fs event ${unsupported}`);
        }
      }
    } catch (error) {
      if (error instanceof DownlinkError) throw error;
      throw new DownlinkError(
        "ECORRUPT_EVENT",
        error instanceof Error ? error.message : String(error),
      );
    }
    const after = snapshotFromModel(afterModel);
    const paths = pathList(affected);
    return {
      event,
      record,
      paths,
      before,
      after,
      beforeWorkspace: workspace,
      afterWorkspace,
      beforeDigest: snapshotDigest(before),
      afterDigest: snapshotDigest(after),
      pathDigests: pathDigestChanges(before, after, paths),
    };
  }

  async applyRecord(record: StreamRecord): Promise<boolean> {
    const { workspace, journal } = this.requireStarted();
    const existing = this.journalRecords.find((candidate) => candidate.offset === record.offset);
    if (compareOffsets(record.offset, workspace.headOffset as Offset) <= 0) {
      if (existing !== undefined) {
        const current = captureWorktreeSnapshot(this.root);
        if (snapshotDigest(current) !== existing.afterDigest) {
          throw new DownlinkError(
            "ECHECKPOINT_MISMATCH",
            `already-applied event ${record.offset} no longer matches its journal post-digest`,
          );
        }
        return false;
      }
      throw new DownlinkError(
        "ECHECKPOINT_MISMATCH",
        `event ${record.offset} is at or before checkpoint ${workspace.headOffset}`,
      );
    }
    let expected: Offset;
    try {
      expected = nextAllocatedOffset(workspace.headOffset as Offset);
    } catch (error) {
      throw new DownlinkError("ECHECKPOINT_MISMATCH", String(error));
    }
    if (record.offset !== expected) {
      throw new DownlinkError(
        "ECHECKPOINT_MISMATCH",
        `expected ${expected}, received ${record.offset}`,
      );
    }
    const event = eventOf(record);
    const writerId = eventWriterId(record) ?? "unknown";
    const ownWriterId = this.writerIdProvider?.();
    if (ownWriterId !== undefined && writerId === ownWriterId) {
      const before = captureWorktreeSnapshot(this.root);
      const digest = snapshotDigest(before);
      const previousDigest = this.journalRecords.at(-1)?.afterDigest ?? digest;
      const paths = eventPaths(event);
      const notice: DownlinkApplyNotice = {
        offset: record.offset,
        kind: record.type,
        paths,
        disposition: "suppressed",
        writerId,
        event,
        pathFingerprints: paths.map((path) => ({
          path,
          fingerprint: snapshotPathFingerprint(before, path),
        })),
      };
      await this.beforeApply?.(notice);
      const committed = await journal.append({
        offset: record.offset,
        kind: "suppressed",
        paths: [],
        beforeDigest: previousDigest,
        afterDigest: digest,
        pathDigests: [],
        provenance: { type: record.type, ts: record.ts },
      });
      this.journalRecords = [...this.journalRecords, committed];
      if (!isFsEvent(event))
        throw new DownlinkError("ECORRUPT_EVENT", `invalid fs event at ${record.offset}`);
      const nextWorkspace = workspaceAfterOwnEvent(workspace, record, event as FsEvent, before);
      saveWorkspace(this.root, nextWorkspace);
      this.workspace = nextWorkspace;
      this.model = modelFromSnapshot(before);
      await this.afterCheckpoint?.(notice);
      this.onSuppressed?.(committed);
      return true;
    }
    const before = captureWorktreeSnapshot(this.root);
    this.model = modelFromSnapshot(before);
    const plan = await this.planEvent(record, before);
    if (snapshotDigest(before) !== plan.beforeDigest)
      throw new DownlinkError("EDIRTY_BASE", `worktree changed while planning ${record.offset}`);
    const intent: ApplyIntentInput = {
      v: 1,
      offset: record.offset,
      event: plan.event,
      kind: record.type,
      paths: plan.paths,
      beforeDigest: plan.beforeDigest,
      afterDigest: plan.afterDigest,
      pathDigests: plan.pathDigests,
      provenance: { type: record.type, ts: record.ts },
      before: plan.before,
      after: plan.after,
      beforeWorkspace: plan.beforeWorkspace,
      afterWorkspace: plan.afterWorkspace,
    };
    const paths = plan.paths;
    const notice: DownlinkApplyNotice = {
      offset: record.offset,
      kind: record.type,
      paths,
      disposition: "applied",
      writerId,
      event: plan.event,
      pathFingerprints: paths.map((path) => ({
        path,
        fingerprint: snapshotPathFingerprint(plan.after, path),
      })),
    };
    await this.beforeApply?.(notice);
    const applyOrdinal = this.journalRecords.length + 1;
    await this.phase("before-intent", record.offset, applyOrdinal);
    try {
      await writeApplyIntent(this.intentFile, intent);
    } catch (error) {
      throw new DownlinkError("EJOURNAL_CORRUPT", `cannot write apply intent: ${String(error)}`);
    }
    await this.phase("after-intent", record.offset, applyOrdinal);
    restoreWorktreeSnapshot(this.root, plan.after);
    await this.phase("after-rename", record.offset, applyOrdinal);
    const committed = await journal.append({
      offset: record.offset,
      kind: record.type,
      paths: plan.paths,
      beforeDigest: plan.beforeDigest,
      afterDigest: plan.afterDigest,
      pathDigests: plan.pathDigests,
      provenance: { type: record.type, ts: record.ts },
    });
    this.journalRecords = [...this.journalRecords, committed];
    await this.phase("after-journal-commit", record.offset, applyOrdinal);
    await this.phase("before-checkpoint", record.offset, applyOrdinal);
    saveWorkspace(this.root, plan.afterWorkspace);
    this.workspace = plan.afterWorkspace;
    this.model = modelFromSnapshot(plan.after);
    await removeApplyIntent(this.intentFile);
    await this.afterCheckpoint?.(notice);
    this.onApply?.(committed);
    return true;
  }

  async run(): Promise<void> {
    await this.start();
    const { reader } = this;
    if (reader === undefined)
      throw new DownlinkError("ENO_WORKSPACE", "downlink reader is not ready");
    for await (const batch of reader.read(this.workspaceState.headOffset as Offset)) {
      for (const record of batch.events) await this.applyRecord(record);
    }
    for await (const batch of reader.tail(this.workspaceState.headOffset as Offset, {
      mode: "long-poll",
      signal: this.abortController.signal,
    })) {
      for (const record of batch.events) await this.applyRecord(record);
    }
  }

  /** Apply the finite read window without entering the live tail. */
  async catchUp(): Promise<number> {
    await this.start();
    const { repo } = this;
    if (repo === undefined)
      throw new DownlinkError("ENO_WORKSPACE", "downlink reader is not ready");
    let applied = 0;
    const current = this.workspaceState.headOffset as Offset;
    const dump = await repo.rawDump();
    for (const record of dump) {
      if (compareOffsets(record.offset, current) <= 0) continue;
      if (await this.applyRecord(record)) applied += 1;
    }
    return applied;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abortController.abort();
  }
}

interface DownlinkWatchOptions {
  readonly directory: string;
  readonly porcelain: boolean;
}

function parseDownlinkWatchOptions(args: readonly string[], cwd: string): DownlinkWatchOptions {
  if (args[0] !== "--down") throw new DownlinkError("EUSAGE", DOWNLINK_USAGE);
  let directory = cwd;
  let porcelain = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (
      argument === "--dir" &&
      args[index + 1] !== undefined &&
      !args[index + 1]!.startsWith("--")
    ) {
      directory = resolve(cwd, args[++index]!);
    } else if (argument === "--porcelain" && !porcelain) {
      porcelain = true;
    } else {
      throw new DownlinkError("EUSAGE", DOWNLINK_USAGE);
    }
  }
  return { directory, porcelain };
}

export interface DownlinkWatchDependencies {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetcher?: typeof fetch;
  readonly onApply?: (record: ApplyJournalRecord) => void;
  readonly onPhase?: (phase: DownlinkPhase, offset: string) => void | Promise<void>;
}

export async function runDownlinkWatch(
  args: readonly string[],
  io: CliIo,
  dependencies: DownlinkWatchDependencies = {},
): Promise<number> {
  const environment = dependencies.environment ?? process.env;
  let options: DownlinkWatchOptions;
  try {
    options = parseDownlinkWatchOptions(args, resolve(dependencies.cwd ?? process.cwd()));
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : DOWNLINK_USAGE}\n`);
    return 2;
  }
  let workspace: WorkspaceState;
  try {
    workspace = loadWorkspace(options.directory);
  } catch (error) {
    io.stderr(`ENO_WORKSPACE: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const credentials: StoredCredentials | null = await loadCredentials(environment);
  if (credentials === null) {
    io.stderr("No credentials. Run `ef login`.\n");
    return 10;
  }
  const streamServerUrl =
    environment.EF_STREAM_SERVER_URL ??
    environment.EFOREST_SERVER_URL ??
    environment.EF_SERVER_URL ??
    workspace.identity.server;
  const engine = new DownlinkEngine({
    root: options.directory,
    streamServerUrl,
    accessToken: credentials.accessToken,
    ...(dependencies.fetcher === undefined ? {} : { fetcher: dependencies.fetcher }),
    onApply: (record) => {
      dependencies.onApply?.(record);
      const path = record.paths.length === 0 ? "-" : record.paths.join(",");
      io.stderr(`applied ${record.offset} ${record.kind} ${path}\n`);
      if (options.porcelain) io.stdout(`applied ${record.offset}\n`);
    },
    ...(dependencies.onPhase === undefined ? {} : { onPhase: dependencies.onPhase }),
  });
  try {
    await engine.start();
    await new Promise<void>((resolveStopped, rejectStopped) => {
      let stopping = false;
      const stop = (): void => {
        if (stopping) return;
        stopping = true;
        void engine.close().then(resolveStopped, rejectStopped);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      void engine.run().catch(rejectStopped);
    });
    return 0;
  } catch (error) {
    await engine.close();
    const failure =
      error instanceof DownlinkError ? error : new DownlinkError("ENETWORK", String(error));
    io.stderr(`${failure.message}\n`);
    return 1;
  }
}

export function runJournalVerify(args: readonly string[], io: CliIo): number {
  if (args.length !== 2 || args[0] !== "verify" || args[1]!.startsWith("--")) {
    io.stderr("Usage: ef journal verify <dir>\n");
    return 2;
  }
  const root = resolve(args[1]!);
  try {
    const records = verifyApplyJournal(journalPath(root));
    io.stdout(`verified ${records.length} apply journal entries\n`);
    return 0;
  } catch (error) {
    const failure = mapJournalError(error);
    io.stderr(`${failure.message}\n`);
    return 1;
  }
}
