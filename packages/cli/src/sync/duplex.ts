import { canonicalJson, sha256Hex } from "@eforest/protocol";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { journalPath as applyJournalPath, readApplyJournal } from "./apply-journal.js";
import { ObservedApplyJournal, observedApplyPath } from "./apply-observed.js";
import {
  DownlinkEngine,
  type DownlinkApplyNotice,
  type DownlinkEngineOptions,
} from "./downlink.js";
import {
  UplinkEngine,
  type UplinkDispatchStartNotice,
  type UplinkEngineOptions,
  type UplinkUploadedNotice,
} from "./uplink.js";
import { SyncJournalWriter, syncJournalPath, type SyncJournalRecord } from "./sync-journal.js";
import { watchDivergencePath } from "./watch-state.js";

export interface DuplexEngineOptions {
  readonly root: string;
  readonly serverUrl: string;
  readonly streamServerUrl: string;
  readonly accessToken: string;
  readonly writerId?: string;
  readonly debounceMs?: number;
  readonly fetcher?: typeof fetch;
  readonly afterUplinkDispatchAccepted?: UplinkEngineOptions["afterDispatchAccepted"];
}

export class DuplexWatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuplexWatchError";
  }
}

function filePath(root: string, path: string): string {
  return join(root, ...path.split("/"));
}

function pathFingerprint(root: string, path: string): string {
  try {
    const stat = lstatSync(filePath(root, path));
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return `file:${sha256Hex(readFileSync(filePath(root, path)))}`;
    return "other";
  } catch {
    return "missing";
  }
}

function noticePath(notice: DownlinkApplyNotice): string {
  return notice.paths.length === 0 ? "-" : notice.paths.join(",");
}

function eventSignature(event: {
  readonly type: string;
  readonly payload: unknown;
  readonly ts: number;
}): string {
  const payload =
    event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? { ...(event.payload as Record<string, unknown>) }
      : event.payload;
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    delete (payload as Record<string, unknown>).actor;
    delete (payload as Record<string, unknown>).writer;
    delete (payload as Record<string, unknown>).writerId;
  }
  return canonicalJson({ type: event.type, payload, ts: event.ts });
}

function markDiverged(root: string, notice: DownlinkApplyNotice): void {
  writeFileSync(
    watchDivergencePath(root),
    `${canonicalJson({ v: 1, offset: notice.offset, writerId: notice.writerId })}\n`,
    { mode: 0o600 },
  );
}

export class DuplexWatchEngine {
  private readonly root: string;
  private readonly syncJournal: SyncJournalWriter;
  private readonly observedApplies: ObservedApplyJournal;
  private readonly selfWriter: { value: string | undefined };
  private readonly pendingDispatches = new Set<string>();
  private readonly observedFingerprints = new Map<string, string>();
  private readonly uploadWaiters = new Map<
    string,
    {
      readonly promise: Promise<void>;
      readonly resolve: () => void;
      readonly reject: (error: unknown) => void;
    }
  >();
  private readonly uplink: UplinkEngine;
  private readonly downlink: DownlinkEngine;
  private downlinkRun: Promise<void> | undefined;
  private downlinkFailure: unknown;
  private started = false;
  private closing = false;

  constructor(options: DuplexEngineOptions) {
    this.root = options.root;
    this.syncJournal = new SyncJournalWriter(syncJournalPath(options.root));
    this.observedApplies = new ObservedApplyJournal(observedApplyPath(options.root));
    this.selfWriter = { value: options.writerId };

    const uplinkOptions: UplinkEngineOptions = {
      root: options.root,
      serverUrl: options.serverUrl,
      streamServerUrl: options.streamServerUrl,
      accessToken: options.accessToken,
      ...(options.writerId === undefined ? {} : { writerId: options.writerId }),
      ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
      ...(options.afterUplinkDispatchAccepted === undefined
        ? {}
        : { afterDispatchAccepted: options.afterUplinkDispatchAccepted }),
      onWriterId: (writerId) => this.acceptWriterId(writerId),
      onDispatchStarted: (notice) => this.markDispatchStarted(notice),
      onDispatchFinished: (notice) => this.markDispatchFinished(notice),
      onUploaded: (notice) => this.recordUpload(notice),
      isDownstreamApplied: (path) => this.isDownstreamApplied(path),
    };
    this.uplink = new UplinkEngine(uplinkOptions);

    const downlinkOptions: DownlinkEngineOptions = {
      root: options.root,
      streamServerUrl: options.streamServerUrl,
      accessToken: options.accessToken,
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
      writerIdProvider: () => this.selfWriter.value,
      uploadedRecordProvider: () =>
        this.syncJournal.state.filter((record) => record.disposition === "uploaded"),
      beforeApply: (notice) => this.recordDownlink(notice),
      afterCheckpoint: async () => {
        await this.uplink.refreshFromWorkspace();
      },
    };
    this.downlink = new DownlinkEngine(downlinkOptions);
  }

  get writerId(): string | undefined {
    return this.selfWriter.value;
  }

  get syncJournalFile(): string {
    return this.syncJournal.path;
  }

  get syncJournalState(): readonly SyncJournalRecord[] {
    return this.syncJournal.state;
  }

  get workspaceState() {
    return this.uplink.workspaceState;
  }

  get downlinkEngine(): DownlinkEngine {
    return this.downlink;
  }

  get uplinkEngine(): UplinkEngine {
    return this.uplink;
  }

  shouldSuppressUplinkPath(path: string): boolean {
    return this.applyJournalMatchesPath(path);
  }

  private acceptWriterId(writerId: string): void {
    if (this.selfWriter.value !== undefined && this.selfWriter.value !== writerId) {
      throw new DuplexWatchError(
        `duplex/writer-identity-mismatch: expected ${this.selfWriter.value}, server stamped ${writerId}`,
      );
    }
    this.selfWriter.value = writerId;
  }

  private async recordUpload(notice: UplinkUploadedNotice): Promise<void> {
    try {
      if (notice.writerId !== "unknown") this.acceptWriterId(notice.writerId);
      await this.syncJournal.append({
        offset: notice.offset,
        disposition: "uploaded",
        writerId: notice.writerId,
        path: notice.path,
      });
      const waiter = this.uploadWaiters.get(notice.offset);
      if (waiter !== undefined) {
        this.uploadWaiters.delete(notice.offset);
        waiter.resolve();
      }
    } catch (error) {
      const waiter = this.uploadWaiters.get(notice.offset);
      if (waiter !== undefined) {
        this.uploadWaiters.delete(notice.offset);
        waiter.reject(error);
      }
      throw error;
    }
  }

  private markDispatchStarted(notice: UplinkDispatchStartNotice): void {
    this.pendingDispatches.add(eventSignature(notice.event));
  }

  private markDispatchFinished(notice: UplinkDispatchStartNotice): void {
    this.pendingDispatches.delete(eventSignature(notice.event));
  }

  private waitForUpload(offset: string): Promise<void> {
    const existing = this.uploadWaiters.get(offset);
    if (existing !== undefined) return existing.promise;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    this.uploadWaiters.set(offset, { promise, resolve, reject });
    return promise;
  }

  private async recordDownlink(notice: DownlinkApplyNotice): Promise<void> {
    if (
      notice.disposition === "suppressed" &&
      !this.syncJournal.hasOffset(notice.offset, "uploaded") &&
      this.pendingDispatches.has(eventSignature(notice.event))
    ) {
      await this.waitForUpload(notice.offset);
    }
    if (!this.syncJournal.hasOffset(notice.offset, notice.disposition)) {
      await this.syncJournal.append({
        offset: notice.offset,
        disposition: notice.disposition,
        writerId: notice.writerId,
        path: noticePath(notice),
      });
    }
    if (notice.disposition === "suppressed") {
      if (!this.syncJournal.hasOffset(notice.offset, "uploaded")) {
        markDiverged(this.root, notice);
      }
      return;
    }
  }

  private applyJournalMatchesPath(path: string): boolean {
    const records = readApplyJournal(applyJournalPath(this.root));
    const fingerprint = pathFingerprint(this.root, path);
    const observedFingerprint = this.observedFingerprints.get(path);
    if (observedFingerprint === fingerprint) return true;
    if (observedFingerprint !== undefined) this.observedFingerprints.delete(path);
    const record = [...records]
      .reverse()
      .find(
        (candidate) =>
          candidate.paths.includes(path) && !this.observedApplies.has(candidate.offset, path),
      );
    if (record === undefined) return false;
    const pathDigest = record.pathDigests.find((candidate) => candidate.path === path);
    const matches =
      record.kind === "fs.dir.create"
        ? fingerprint === "directory"
        : record.kind === "fs.dir.remove"
          ? fingerprint === "missing"
          : pathDigest !== undefined
            ? pathDigest.after === null
              ? fingerprint === "missing"
              : fingerprint === `file:${pathDigest.after}`
            : false;
    if (!matches) return false;
    const matchedIndex = records.indexOf(record);
    for (const superseded of records.slice(0, matchedIndex + 1)) {
      if (superseded.paths.includes(path) && !this.observedApplies.has(superseded.offset, path)) {
        this.observedApplies.append(superseded.offset, path);
      }
    }
    this.observedFingerprints.set(path, fingerprint);
    return true;
  }

  private isDownstreamApplied(path: string): boolean {
    return this.shouldSuppressUplinkPath(path);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.closing = false;
    await this.downlink.start();
    this.started = true;
    await this.uplink.start();
    this.downlinkRun = this.downlink.run().catch((error: unknown) => {
      this.downlinkFailure = error;
      if (!this.closing) throw error;
    });
  }

  async run(): Promise<void> {
    await this.start();
    await this.downlinkRun;
    if (this.downlinkFailure !== undefined && !this.closing) {
      throw this.downlinkFailure;
    }
  }

  async close(): Promise<void> {
    if (!this.started && this.downlinkRun === undefined) return;
    this.closing = true;
    let failure: unknown;
    try {
      await this.uplink.shutdown();
    } catch (error) {
      failure = error;
    }
    await this.downlink.close();
    try {
      await this.downlinkRun;
    } catch (error) {
      if (failure === undefined) failure = error;
    }
    this.started = false;
    if (failure !== undefined) throw failure;
  }
}
