/**
 * E6-T05 sync engine: joins the `.eforest/tasks` subtree of one StreamFS branch to the
 * task streams of its repository, both directions, without echo.
 *
 * - Ingest (branch → streams): every foreign branch record under the root is classified
 *   and, when it is a valid folder change, becomes validated task/evidence events
 *   through the dispatch door (`planTaskFolderIngest`).
 * - Projection (streams → branch): the folder bytes a task's streams imply
 *   (`projectTaskFolder`) are diffed against the branch and written back.
 *
 * Echo suppression is pure provenance: a projected write's receipt offset is journaled
 * `projected` before any later tail batch is processed, and the tail suppresses exactly
 * the journaled offsets. No debounce, mtime, or content-recency heuristic participates.
 * `E6_T05_ORIGIN_FILTER_GUARD` is the sabotage sentinel: with the guard off, own records
 * are re-ingested and the verify target must go red on exact event counts, journal
 * multiplicity, and quiescence.
 *
 * The engine is pure of environment: filesystem, network, and clock enter only through
 * its ports. All processing is serialized through one internal queue, so a tail batch
 * that arrives during a projection is handled only after the projection's receipts are
 * journaled.
 */
import { sha256Hex, type Event, type Offset } from "@eforest/protocol";
import {
  attachmentInitialStateForStream,
  attachmentReducer,
  type AttachmentListState,
  type ContentAttachment,
} from "@eforest/evidence";
import { issueHasBeenOpened } from "@eforest/issues";
import {
  TASK_SPEC_NO_BASE,
  taskEvidenceStreamId,
  taskStreamId,
  type TaskEvent,
} from "../events.js";
import { taskReducer } from "../reducer.js";
import { taskInitialStateFor, type TaskState } from "../state.js";
import {
  planTaskFolderIngest,
  refusalArtifactJson,
  resolveLifecycleReferences,
  type PlannedDispatch,
  type PlannedRefusal,
  type TaskFolderIngestPlan,
} from "./ingest.js";
import { TaskSyncJournal, type TaskSyncIngestKind } from "./journal.js";
import {
  planProjectionWrites,
  projectTaskFolder,
  type ProjectedEvidenceSource,
} from "./project.js";
import type { FolderEntry, TaskFolderSnapshot } from "./schema.js";

/**
 * Origin-filter sentinel. With this `false`, records the journal proves to be the
 * engine's own projections are treated as foreign input: the engine re-ingests its own
 * writes, `verify-E6-T05` sees extra task events, broken journal multiplicity, and a
 * moving head inside the idle window, and goes red.
 */
export const E6_T05_ORIGIN_FILTER_GUARD = true;

export const TASK_SYNC_ROOT = ".eforest/tasks" as const;

const TASK_FOLDER_NAME_PATTERN = /^(E(?:0|[1-9][0-9]*)-T[0-9]{2}[a-z]?)-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** One branch mutation as the stream-fs watcher reports it. */
export interface BranchChangeRecord {
  readonly event: "add" | "addDir" | "change" | "unlink" | "unlinkDir";
  /** Repo-relative path. */
  readonly path: string;
  readonly offset: Offset;
}

export interface BranchWriteFile {
  readonly kind: "write";
  /** Repo-relative path. */
  readonly path: string;
  readonly bytes: Uint8Array;
}
export interface BranchDeleteFile {
  readonly kind: "delete";
  readonly path: string;
}
export type BranchWriteOp = BranchWriteFile | BranchDeleteFile;

export interface BranchWriteReceipt {
  /** The meta-stream offset one dispatched fs event landed at. */
  readonly offset: Offset;
  /** The path the event concerns (directory or file). */
  readonly path: string;
  readonly type: string;
}

export interface TaskSyncBranchPort {
  /** The branch metadata stream id (`fs:<org>/<repo>:<branch>:meta`). */
  readonly stream: string;
  /** Repo-relative file map (path → content SHA-256) at an offset, or at head. */
  filesAt(offset?: Offset): Promise<ReadonlyMap<string, string>>;
  readFileAt(path: string, offset?: Offset): Promise<Uint8Array>;
  /**
   * Apply writes/deletes. Every fs event this produces (directory creations included)
   * is returned as a receipt, in dispatch order.
   */
  write(ops: readonly BranchWriteOp[]): Promise<readonly BranchWriteReceipt[]>;
}

export type TaskSyncDispatchResult =
  { readonly ok: true; readonly offset: Offset } | { readonly ok: false; readonly reason: string };

export interface TaskSyncStreamsPort {
  /** Offset-stamped records with server metadata (actor/writer) stripped. */
  read(streamId: string): Promise<readonly (Event & { readonly offset: Offset })[]>;
  dispatch(streamId: string, event: Event): Promise<TaskSyncDispatchResult>;
  /** Ensure a sealed content stream with exactly these bytes exists (upload if absent). */
  ensureContent(contentStreamId: string, bytes: Uint8Array, sha256: string): Promise<void>;
  /** The sealed bytes of a content stream. */
  readContent(contentStreamId: string): Promise<Uint8Array>;
}

export interface TaskSyncEngineOptions {
  readonly org: string;
  readonly repo: string;
  /** The engine's authenticated principal: `by.actor` of every lifecycle event. */
  readonly actor: string;
  readonly branch: TaskSyncBranchPort;
  readonly streams: TaskSyncStreamsPort;
  readonly journal: TaskSyncJournal;
  readonly now: () => number;
  /** The origin-filter sentinel; defaults to `E6_T05_ORIGIN_FILTER_GUARD`. */
  readonly originFilter?: boolean;
  readonly onWarning?: (message: string) => void;
}

interface TaskCache {
  readonly taskId: string;
  records: (Event & { readonly offset: Offset })[];
  evidenceRecords: (Event & { readonly offset: Offset })[];
  state: TaskState;
  attachments: AttachmentListState;
  folderPath?: string;
  /**
   * The spec revision the branch's readme bytes currently descend from, maintained in
   * branch-record order. This — never the engine's refreshed state — is the `base` of
   * an ingested revision, so an edit made from a stale readme loses its fence instead
   * of silently overwriting a concurrent revision.
   */
  branchSpecOffset?: Offset;
}

function relativeToRoot(path: string): string | undefined {
  if (!path.startsWith(`${TASK_SYNC_ROOT}/`)) return undefined;
  return path.slice(TASK_SYNC_ROOT.length + 1);
}

export class TaskFolderSyncEngine {
  private readonly org: string;
  private readonly repo: string;
  private readonly actor: string;
  private readonly branch: TaskSyncBranchPort;
  private readonly streams: TaskSyncStreamsPort;
  private readonly journal: TaskSyncJournal;
  private readonly now: () => number;
  private readonly originFilter: boolean;
  private readonly onWarning: (message: string) => void;
  private readonly tasks = new Map<string, TaskCache>();
  private readonly contentBytes = new Map<string, Uint8Array>();
  /** Receipt offsets of projected readme writes → the spec revision they materialized. */
  private readonly projectedReadmeSpec = new Map<Offset, { taskId: string; spec: Offset }>();
  private queue: Promise<void> = Promise.resolve();
  private pauseGate: Promise<void> | undefined;
  private releasePause: (() => void) | undefined;

  constructor(options: TaskSyncEngineOptions) {
    this.org = options.org;
    this.repo = options.repo;
    this.actor = options.actor;
    this.branch = options.branch;
    this.streams = options.streams;
    this.journal = options.journal;
    this.now = options.now;
    this.originFilter = options.originFilter ?? E6_T05_ORIGIN_FILTER_GUARD;
    this.onWarning = options.onWarning ?? (() => undefined);
  }

  /** Serialize work; every external entry point goes through here. */
  private run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      if (this.pauseGate !== undefined) await this.pauseGate;
      return job();
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Hold back processing (queued work waits) — used by tests to stage races. */
  pause(): void {
    if (this.pauseGate !== undefined) return;
    this.pauseGate = new Promise<void>((resolve) => {
      this.releasePause = resolve;
    });
  }

  resume(): void {
    this.releasePause?.();
    this.pauseGate = undefined;
    this.releasePause = undefined;
  }

  /** Wait for every queued job to finish (test synchronization aid). */
  async settle(): Promise<void> {
    await this.run(async () => undefined);
  }

  get taskIds(): readonly string[] {
    return [...this.tasks.keys()];
  }

  /** Feed one watcher batch. Returns when the batch is fully accounted. */
  handleBranchBatch(records: readonly BranchChangeRecord[]): Promise<void> {
    return this.run(async () => {
      for (const record of records) {
        try {
          await this.handleBranchRecord(record);
        } catch (error) {
          // The record stays unaccounted; the journal audit reports it. Loud, not fatal.
          this.onWarning(`branch record ${record.offset} (${record.path}): ${String(error)}`);
        }
      }
    });
  }

  /**
   * Poll the repository catalog and every known task's streams, projecting any news.
   * Discovery is how a client that never touched a folder locally still materializes
   * it: the catalog (`repo-issues:<org>/<repo>`) names every issue stream, and a task
   * with an accepted spec revision projects onto this branch too.
   */
  refreshAll(): Promise<void> {
    return this.run(async () => {
      const catalog = await this.streams.read(`repo-issues:${this.org}/${this.repo}`);
      for (const record of catalog) {
        const issueStreamId = (record.payload as { readonly issueStreamId?: unknown })
          .issueStreamId;
        if (typeof issueStreamId !== "string") continue;
        const taskId = issueStreamId.split("/").at(-1);
        if (taskId !== undefined && taskId.length > 0) this.cacheFor(taskId);
      }
      for (const taskId of this.tasks.keys()) await this.refreshAndProject(taskId);
    });
  }

  /** Register a task the engine should track (e.g. discovered from the catalog). */
  track(taskId: string): Promise<void> {
    return this.run(async () => {
      this.cacheFor(taskId);
      await this.refreshAndProject(taskId);
    });
  }

  private cacheFor(taskId: string): TaskCache {
    const existing = this.tasks.get(taskId);
    if (existing !== undefined) return existing;
    const stream = taskStreamId(this.org, this.repo, taskId);
    const cache: TaskCache = {
      taskId,
      records: [],
      evidenceRecords: [],
      state: taskInitialStateFor(stream, taskId),
      attachments: attachmentInitialStateForStream(taskEvidenceStreamId(stream)!),
    };
    this.tasks.set(taskId, cache);
    return cache;
  }

  private journalIngested(
    record: BranchChangeRecord,
    kinds: readonly TaskSyncIngestKind[],
    effects: readonly string[] = [],
    reason = "",
  ): void {
    if (this.journal.has(this.branch.stream, record.offset, "ingested")) return;
    this.journal.append({
      stream: this.branch.stream,
      offset: record.offset,
      disposition: "ingested",
      subject: record.path,
      kinds,
      effects,
      reason,
    });
  }

  private async handleBranchRecord(record: BranchChangeRecord): Promise<void> {
    const own = this.journal.has(this.branch.stream, record.offset, "projected");
    if (own && this.originFilter) {
      const projected = this.projectedReadmeSpec.get(record.offset);
      if (projected !== undefined) {
        const cache = this.tasks.get(projected.taskId);
        if (cache !== undefined) cache.branchSpecOffset = projected.spec;
        this.projectedReadmeSpec.delete(record.offset);
      }
      if (!this.journal.has(this.branch.stream, record.offset, "suppressed")) {
        this.journal.append({
          stream: this.branch.stream,
          offset: record.offset,
          disposition: "suppressed",
          subject: record.path,
          kinds: [],
          effects: [],
          reason: "",
        });
      }
      return;
    }
    if (
      this.journal.has(this.branch.stream, record.offset, "ingested") ||
      this.journal.has(this.branch.stream, record.offset, "suppressed")
    ) {
      return; // already accounted (restart replay)
    }
    const relative = relativeToRoot(record.path);
    if (relative === undefined) {
      this.journalIngested(record, ["outside"]);
      return;
    }
    if (record.event === "addDir" || record.event === "unlinkDir") {
      this.journalIngested(record, ["directory"]);
      return;
    }
    const segments = relative.split("/");
    if (segments.length < 3) {
      this.journalIngested(record, ["outside"]);
      return;
    }
    const [epicDir, folderName] = segments as unknown as [string, string, ...string[]];
    const inside = segments.slice(2).join("/");
    if (inside.startsWith("work/") || inside === "work") {
      this.journalIngested(record, ["workshop"]);
      return;
    }
    const idMatch = TASK_FOLDER_NAME_PATTERN.exec(folderName);
    const folderPath = `${epicDir}/${folderName}`;
    if (idMatch === null) {
      this.journalIngested(record, ["refused"], [], "folder/name-invalid");
      return;
    }
    const taskId = idMatch[1]!;
    if (record.event === "add") {
      const files = await this.branch.filesAt(record.offset);
      if (!files.has(record.path)) {
        this.journalIngested(record, ["awaiting-content"]);
        return;
      }
    }
    await this.ingestFolder(record, taskId, folderPath);
  }

  private async snapshotFolder(folderPath: string, offset: Offset): Promise<TaskFolderSnapshot> {
    const files = await this.branch.filesAt(offset);
    const prefix = `${TASK_SYNC_ROOT}/${folderPath}/`;
    const entries: FolderEntry[] = [];
    for (const path of [...files.keys()].sort()) {
      if (!path.startsWith(prefix)) continue;
      entries.push({
        path: path.slice(prefix.length),
        kind: "file",
        bytes: await this.branch.readFileAt(path, offset),
      });
    }
    return { folderName: folderPath.split("/")[1]!, entries };
  }

  private liveEvidence(cache: TaskCache): readonly ContentAttachment[] {
    return cache.attachments.attachments.filter(
      (attachment): attachment is ContentAttachment =>
        attachment.type === "content" && attachment.detachedAtOffset === undefined,
    );
  }

  private async ingestFolder(
    record: BranchChangeRecord,
    taskId: string,
    folderPath: string,
  ): Promise<void> {
    const cache = this.cacheFor(taskId);
    cache.folderPath ??= folderPath;
    await this.refreshStreams(cache);
    const snapshot = await this.snapshotFolder(folderPath, record.offset);
    const opened = issueHasBeenOpened(cache.state.issue);
    const prefix = `${TASK_SYNC_ROOT}/${folderPath}/`;
    const plan = planTaskFolderIngest({
      org: this.org,
      repo: this.repo,
      taskId,
      folderPath,
      snapshot,
      ...(opened ? { state: cache.state } : {}),
      liveEvidence: this.liveEvidence(cache).map((attachment) => ({
        attachmentId: attachment.attachmentId,
        name: attachment.name,
        sha256: attachment.sha256,
      })),
      usedAttachmentIds: cache.attachments.attachments.map((entry) => entry.attachmentId),
      actor: this.actor,
      ts: this.now(),
      base: cache.branchSpecOffset ?? cache.state.spec?.offset ?? TASK_SPEC_NO_BASE,
      origin: { stream: this.branch.stream, head: record.offset },
      changedPath: record.path.startsWith(prefix) ? record.path.slice(prefix.length) : "",
    });
    const { effects, refusals } = await this.executePlan(cache, plan, record.offset);
    this.journalIngested(
      record,
      refusals.length > 0 && !plan.kinds.includes("refused")
        ? [...plan.kinds, "refused"]
        : plan.kinds,
      effects,
      refusals.map((refusal) => refusal.reason).join(","),
    );
    await this.writeRefusalArtifacts(folderPath, record.offset, refusals);
    await this.refreshStreams(cache);
    await this.projectTask(cache);
  }

  private async executePlan(
    cache: TaskCache,
    plan: TaskFolderIngestPlan,
    at: Offset,
  ): Promise<{ readonly effects: string[]; readonly refusals: PlannedRefusal[] }> {
    const effects: string[] = [];
    const refusals: PlannedRefusal[] = [...plan.refusals];
    let abortRest = false;
    for (const planned of plan.dispatches) {
      if (abortRest) break;
      const outcome = await this.dispatchPlanned(cache, planned);
      if (outcome.ok) {
        effects.push(`${planned.stream}@${outcome.offset}`);
        this.journal.append({
          stream: planned.stream,
          offset: outcome.offset,
          disposition: "dispatched",
          subject: planned.event.type,
          kinds: [],
          effects: [],
          reason: "",
        });
        if (planned.event.type === "task.spec-revised") {
          cache.branchSpecOffset = outcome.offset;
        }
        await this.refreshStreams(cache);
      } else {
        refusals.push({
          reason: outcome.reason,
          path: `${cache.folderPath ?? cache.taskId}/readme.md`,
          message: `${planned.label} refused at ${at}: ${outcome.reason}`,
          ...(planned.event.type === "task.spec-revised"
            ? {
                retain: new TextEncoder().encode(
                  (planned.event.payload as { readonly readme: string }).readme,
                ),
              }
            : {}),
        });
        // A refused fenced revision invalidates everything planned after it: the folder
        // state it came from lost the race and authority is projected back instead.
        if (planned.event.type === "task.spec-revised") abortRest = true;
      }
    }
    return { effects, refusals };
  }

  private async dispatchPlanned(
    cache: TaskCache,
    planned: PlannedDispatch,
  ): Promise<TaskSyncDispatchResult> {
    if (planned.upload !== undefined) {
      await this.streams.ensureContent(
        planned.upload.contentStreamId,
        planned.upload.bytes,
        planned.upload.sha256,
      );
      this.contentBytes.set(planned.upload.sha256, planned.upload.bytes.slice());
    }
    const event =
      planned.resolve === undefined
        ? planned.event
        : resolveLifecycleReferences(planned.event as TaskEvent, cache.state);
    return this.streams.dispatch(planned.stream, event);
  }

  private async refreshStreams(cache: TaskCache): Promise<void> {
    const stream = taskStreamId(this.org, this.repo, cache.taskId);
    const evidenceStream = taskEvidenceStreamId(stream)!;
    const records = await this.streams.read(stream);
    for (const record of records.slice(cache.records.length)) {
      cache.records.push(record);
      cache.state = taskReducer(cache.state, record);
      if (!this.journal.has(stream, record.offset, "applied")) {
        this.journal.append({
          stream,
          offset: record.offset,
          disposition: "applied",
          subject: record.type,
          kinds: [],
          effects: [],
          reason: "",
        });
      }
    }
    const evidenceRecords = await this.streams.read(evidenceStream);
    for (const record of evidenceRecords.slice(cache.evidenceRecords.length)) {
      cache.evidenceRecords.push(record);
      cache.attachments = attachmentReducer(cache.attachments, record);
      if (!this.journal.has(evidenceStream, record.offset, "applied")) {
        this.journal.append({
          stream: evidenceStream,
          offset: record.offset,
          disposition: "applied",
          subject: record.type,
          kinds: [],
          effects: [],
          reason: "",
        });
      }
    }
    if (cache.state.spec !== undefined) cache.folderPath = cache.state.spec.folder;
  }

  private async refreshAndProject(taskId: string): Promise<void> {
    const cache = this.cacheFor(taskId);
    const before = cache.records.length + cache.evidenceRecords.length;
    await this.refreshStreams(cache);
    const after = cache.records.length + cache.evidenceRecords.length;
    if (after !== before) await this.projectTask(cache);
  }

  /** Write the projected folder bytes to the branch; journal every receipt as own. */
  private async projectTask(cache: TaskCache): Promise<void> {
    if (cache.state.spec === undefined) return;
    const evidence: ProjectedEvidenceSource[] = [];
    for (const attachment of this.liveEvidence(cache)) {
      let bytes = this.contentBytes.get(attachment.sha256);
      if (bytes === undefined) {
        bytes = await this.streams.readContent(attachment.contentStream);
        this.contentBytes.set(attachment.sha256, bytes);
      }
      evidence.push({
        attachmentId: attachment.attachmentId,
        name: attachment.name,
        sha256: attachment.sha256,
        bytes,
      });
    }
    const projection = projectTaskFolder({ state: cache.state, evidence });
    cache.folderPath = projection.folderPath;
    const prefix = `${TASK_SYNC_ROOT}/${projection.folderPath}/`;
    const head = await this.branch.filesAt();
    const branchFiles = new Map<string, string>();
    for (const [path, sha256] of head) {
      if (path.startsWith(prefix)) branchFiles.set(path.slice(prefix.length), sha256);
    }
    const plan = planProjectionWrites(projection, branchFiles);
    const ops: BranchWriteOp[] = [
      ...plan.writes.map((file): BranchWriteOp => ({
        kind: "write",
        path: `${prefix}${file.path}`,
        bytes: file.bytes,
      })),
      ...plan.deletes.map((path): BranchWriteOp => ({ kind: "delete", path: `${prefix}${path}` })),
    ];
    const receipts = await this.writeOwn(ops);
    const specOffset = cache.state.spec.offset;
    for (const receipt of receipts) {
      if (receipt.path === `${prefix}readme.md` && receipt.type === "fs.file.write") {
        this.projectedReadmeSpec.set(receipt.offset, { taskId: cache.taskId, spec: specOffset });
      }
    }
  }

  private async writeOwn(ops: readonly BranchWriteOp[]): Promise<readonly BranchWriteReceipt[]> {
    if (ops.length === 0) return [];
    const receipts = await this.branch.write(ops);
    for (const receipt of receipts) {
      // Ancestor bootstrap directories (e.g. `.eforest` itself) live outside the watch
      // root: the tail never delivers them, so they are not part of the journal universe.
      if (receipt.path !== TASK_SYNC_ROOT && !receipt.path.startsWith(`${TASK_SYNC_ROOT}/`)) {
        continue;
      }
      this.journal.append({
        stream: this.branch.stream,
        offset: receipt.offset,
        disposition: "projected",
        subject: receipt.path,
        kinds: [],
        effects: [],
        reason: "",
      });
    }
    return receipts;
  }

  private async writeRefusalArtifacts(
    folderPath: string,
    offset: Offset,
    refusals: readonly PlannedRefusal[],
  ): Promise<void> {
    const ops: BranchWriteOp[] = [];
    for (const [index, refusal] of refusals.entries()) {
      const conflict = refusal.reason === "task/stale-spec";
      const dir = conflict ? "conflicts" : "refused";
      const base = `${TASK_SYNC_ROOT}/${folderPath}/work/.sync/${dir}/${offset}-${index + 1}`;
      const json = refusalArtifactJson({
        offset,
        reason: refusal.reason,
        path: refusal.path,
        message: refusal.message,
        ...(refusal.retain === undefined ? {} : { retainedSha256: sha256Hex(refusal.retain) }),
      });
      ops.push({ kind: "write", path: `${base}.json`, bytes: new TextEncoder().encode(json) });
      if (refusal.retain !== undefined) {
        ops.push({ kind: "write", path: `${base}.retained`, bytes: refusal.retain });
      }
      this.onWarning(`${refusal.reason}: ${refusal.message}`);
    }
    await this.writeOwn(ops);
  }

  /** The engine's replayed view (test/verify aid): state + attachments per task. */
  view(
    taskId: string,
  ): { readonly state: TaskState; readonly attachments: AttachmentListState } | undefined {
    const cache = this.tasks.get(taskId);
    if (cache === undefined) return undefined;
    return { state: cache.state, attachments: cache.attachments };
  }
}
