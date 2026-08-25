import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDurableConflict, isDurableExistsConflict, isDurableNotFound } from "@eforest/client";
import {
  boardDigest,
  compareUtf8,
  deriveBoardFromStates,
  issueBelongsToRepo,
  ISSUE_CATALOG_EVENT,
  issueInitialStateForStream,
  isIssueEventShape,
  labelInitialState,
  reduceIssueApplicationEvent,
  reduceIssueLog,
  reduceLabelApplicationEvent,
  repoIdentityFromLabelStream,
  repoIssuesStreamId,
  repoLabelsStreamId,
  replayIssueCatalog,
  type InputRecord,
  type IssueBoard,
  type IssueLog,
  type IssueState,
  type LabelState,
} from "@eforest/issues";
import { canonicalJson, OFFSET_BEFORE_FIRST, type Event, type Offset } from "@eforest/protocol";
import { nextAllocatedOffset, offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import type { StreamAdapter } from "../official.js";

export interface BoardInputProvenance {
  readonly streamId: string;
  readonly offset: Offset;
}

export interface BoardProvenance {
  readonly inputs: readonly BoardInputProvenance[];
}

export interface BoardEndpointBody {
  readonly board: IssueBoard;
  readonly digest: string;
  readonly provenance: BoardProvenance;
}

export interface IssueBoardMaterializerOptions {
  readonly streams: StreamAdapter;
  readonly cacheDir?: string;
}

export interface MaterializationActivity {
  readonly coldRebuilds: number;
  readonly incrementalUpdates: number;
}

interface MaterializedRepoState {
  readonly labels: LabelState;
  readonly issues: ReadonlyMap<string, IssueState>;
  readonly declarations: ReadonlyMap<string, Offset>;
  readonly heads: ReadonlyMap<string, Offset>;
  readonly body: BoardEndpointBody;
}

function cleanRecord(value: unknown): InputRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("issue-board/corrupt-record");
  const record = value as Record<string, unknown>;
  if (
    typeof record.type !== "string" ||
    typeof record.ts !== "number" ||
    !Number.isFinite(record.ts)
  )
    throw new TypeError("issue-board/corrupt-record");
  return {
    type: record.type,
    payload: record.payload,
    ts: record.ts,
    ...(typeof record.offset === "string" ? { offset: record.offset as Offset } : {}),
  };
}

function head(records: readonly InputRecord[]): Offset {
  const last = records.at(-1);
  return last === undefined
    ? OFFSET_BEFORE_FIRST
    : (last.offset ?? offsetForOrdinal(records.length - 1));
}

function acceptedIssueEvent(record: InputRecord): Event {
  const payload =
    record.payload !== null && typeof record.payload === "object" && !Array.isArray(record.payload)
      ? Object.fromEntries(
          Object.entries(record.payload).filter(([key]) => key !== "actor" && key !== "writer"),
        )
      : record.payload;
  return { type: record.type, payload, ts: record.ts };
}

function isSingleAdvance(previous: Offset, next: Offset): boolean {
  try {
    return nextAllocatedOffset(previous) === next;
  } catch {
    return false;
  }
}

function mapMatchesRecord(
  map: ReadonlyMap<string, Offset>,
  record: Readonly<Record<string, Offset>>,
): boolean {
  const entries = Object.entries(record);
  return (
    entries.length === map.size &&
    entries.every(([streamId, offset]) => map.get(streamId) === offset)
  );
}

export function boardCachePath(cacheDir: string, org: string, repo: string): string {
  return join(cacheDir, `${encodeURIComponent(`${org}/${repo}`)}.json`);
}

export class IssueBoardMaterializer {
  private readonly streams: StreamAdapter;
  private readonly cacheDir: string | undefined;
  private serial: Promise<unknown> = Promise.resolve();
  private readonly memory = new Map<string, MaterializedRepoState>();
  private readonly activities = new Map<string, MaterializationActivity>();
  private readonly snapshotErrors = new Map<string, Error>();

  constructor(options: IssueBoardMaterializerOptions) {
    this.streams = options.streams;
    this.cacheDir = options.cacheDir;
  }

  async labelsForRepo(org: string, repo: string): Promise<LabelState> {
    const records = await this.readOptional(repoLabelsStreamId(org, repo));
    return records
      .map(cleanRecord)
      .reduce<LabelState>(
        (state, event) => reduceLabelApplicationEvent(state, event),
        labelInitialState,
      );
  }

  async assertIssueDeclared(
    org: string,
    repo: string,
    issueStreamId: string,
    sourceOffset: Offset,
  ): Promise<void> {
    const catalogStream = repoIssuesStreamId(org, repo);
    const records = (await this.readOptional(catalogStream)).map(cleanRecord);
    const catalog = replayIssueCatalog(catalogStream, records);
    const declared = catalog.issues[issueStreamId];
    if (declared === undefined) throw new TypeError("repo-issues/migration-required");
    if (declared !== sourceOffset) throw new TypeError("repo-issues/source-offset-mismatch");
  }

  discoverIssue(
    org: string,
    repo: string,
    issueStreamId: string,
    sourceOffset: Offset,
    ts: number,
  ): Promise<Offset> {
    const run = this.serial.then(() =>
      this.discoverIssueNow(org, repo, issueStreamId, sourceOffset, ts),
    );
    this.serial = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  applyCommittedEvent(
    streamId: string,
    event: Event,
    offset: Offset,
    catalogOffset?: Offset,
  ): Promise<BoardEndpointBody> {
    const run = this.serial.then(() =>
      this.applyCommittedEventNow(streamId, event, offset, catalogOffset),
    );
    this.serial = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  materialize(org: string, repo: string): Promise<BoardEndpointBody> {
    const run = this.serial.then(() => this.materializeNow(org, repo));
    this.serial = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  materializedCopy(org: string, repo: string): BoardEndpointBody | undefined {
    return this.memory.get(`${org}/${repo}`)?.body;
  }

  materializationActivity(org: string, repo: string): MaterializationActivity {
    return this.activities.get(`${org}/${repo}`) ?? { coldRebuilds: 0, incrementalUpdates: 0 };
  }

  dropMaterializedCopy(org: string, repo: string): void {
    this.memory.delete(`${org}/${repo}`);
  }

  snapshotError(org: string, repo: string): Error | undefined {
    return this.snapshotErrors.get(`${org}/${repo}`);
  }

  private async materializeNow(org: string, repo: string): Promise<BoardEndpointBody> {
    const current = this.memory.get(`${org}/${repo}`);
    if (
      current !== undefined &&
      this.bodyMatchesReducedState(current) &&
      (await this.sourceHeadsMatch(org, repo, current))
    ) {
      return current.body;
    }
    return this.coldRebuild(org, repo);
  }

  private async coldRebuild(org: string, repo: string): Promise<BoardEndpointBody> {
    const catalogStream = repoIssuesStreamId(org, repo);
    const labelStream = repoLabelsStreamId(org, repo);
    const catalogRecords = (await this.readOptional(catalogStream)).map(cleanRecord);
    const catalog = replayIssueCatalog(catalogStream, catalogRecords);
    const labelRecords = (await this.readOptional(labelStream)).map(cleanRecord);
    const labels = labelRecords.reduce<LabelState>(
      (state, event) => reduceLabelApplicationEvent(state, event),
      labelInitialState,
    );
    const issues = new Map<string, IssueState>();
    const heads = new Map<string, Offset>([
      [catalogStream, head(catalogRecords)],
      [labelStream, head(labelRecords)],
    ]);
    for (const streamId of Object.keys(catalog.issues).sort(compareUtf8)) {
      const events = (await this.readOptional(streamId)).map(cleanRecord);
      this.validateOpenedSource(events, catalog.issues[streamId]!);
      const log = { streamId, events } satisfies IssueLog;
      issues.set(streamId, reduceIssueLog(log));
      heads.set(streamId, head(events));
    }
    return (
      await this.publish(
        org,
        repo,
        labels,
        issues,
        new Map(Object.entries(catalog.issues)),
        heads,
        "cold",
      )
    ).body;
  }

  private async applyCommittedEventNow(
    streamId: string,
    event: Event,
    offset: Offset,
    catalogOffset?: Offset,
  ): Promise<BoardEndpointBody> {
    const labelIdentity = repoIdentityFromLabelStream(streamId);
    const issueIdentity = /^issue:([^/]+)\/([^/]+)\/[^/]+$/.exec(streamId);
    const org = labelIdentity?.org ?? issueIdentity?.[1];
    const repo = labelIdentity?.repo ?? issueIdentity?.[2];
    if (org === undefined || repo === undefined)
      throw new TypeError("issue-board/unsupported-source");
    const current = this.memory.get(`${org}/${repo}`);
    if (current === undefined) return this.coldRebuild(org, repo);

    const currentHead = current.heads.get(streamId) ?? OFFSET_BEFORE_FIRST;
    if (currentHead === offset) {
      return this.bodyMatchesReducedState(current) &&
        (await this.sourceHeadsMatch(org, repo, current))
        ? current.body
        : this.coldRebuild(org, repo);
    }
    if (!isSingleAdvance(currentHead, offset)) return this.coldRebuild(org, repo);

    let labels = current.labels;
    const issues = new Map(current.issues);
    const declarations = new Map(current.declarations);
    const heads = new Map(current.heads);
    if (labelIdentity !== undefined) {
      labels = reduceLabelApplicationEvent(labels, event);
      heads.set(streamId, offset);
    } else {
      const clean = acceptedIssueEvent(cleanRecord(event));
      if (!isIssueEventShape(clean)) return this.coldRebuild(org, repo);
      const declaredOffset = declarations.get(streamId);
      if (clean.type === "issue.opened") {
        if (declaredOffset !== undefined && declaredOffset !== offset)
          return this.coldRebuild(org, repo);
        if (declaredOffset === undefined) {
          if (catalogOffset === undefined) return this.coldRebuild(org, repo);
          declarations.set(streamId, offset);
          heads.set(streamId, OFFSET_BEFORE_FIRST);
        }
        if (catalogOffset !== undefined) {
          const catalogStream = repoIssuesStreamId(org, repo);
          const previousCatalogHead = heads.get(catalogStream) ?? OFFSET_BEFORE_FIRST;
          if (
            catalogOffset !== previousCatalogHead &&
            !isSingleAdvance(previousCatalogHead, catalogOffset)
          )
            return this.coldRebuild(org, repo);
          heads.set(catalogStream, catalogOffset);
        }
      } else if (declaredOffset === undefined) {
        return this.coldRebuild(org, repo);
      }
      const previous = issues.get(streamId) ?? issueInitialStateForStream(streamId);
      const next = reduceIssueApplicationEvent(previous, clean);
      if (next === previous) return this.coldRebuild(org, repo);
      issues.set(streamId, next);
      heads.set(streamId, offset);
    }

    const nextState: MaterializedRepoState = {
      labels,
      issues,
      declarations,
      heads,
      body: this.bodyFromReducedState(labels, issues, heads),
    };
    if (!(await this.sourceHeadsMatch(org, repo, nextState))) {
      return this.coldRebuild(org, repo);
    }
    return (await this.publish(org, repo, labels, issues, declarations, heads, "incremental")).body;
  }

  private async sourceHeadsMatch(
    org: string,
    repo: string,
    current: MaterializedRepoState,
  ): Promise<boolean> {
    const catalogStream = repoIssuesStreamId(org, repo);
    const labelStream = repoLabelsStreamId(org, repo);
    const catalogRecords = (await this.readOptional(catalogStream)).map(cleanRecord);
    const catalog = replayIssueCatalog(catalogStream, catalogRecords);
    if (
      head(catalogRecords) !== current.heads.get(catalogStream) ||
      !mapMatchesRecord(current.declarations, catalog.issues)
    )
      return false;
    const labelRecords = (await this.readOptional(labelStream)).map(cleanRecord);
    if (head(labelRecords) !== current.heads.get(labelStream)) return false;
    for (const streamId of Object.keys(catalog.issues).sort(compareUtf8)) {
      const records = (await this.readOptional(streamId)).map(cleanRecord);
      if (head(records) !== current.heads.get(streamId)) return false;
    }
    return true;
  }

  private async publish(
    org: string,
    repo: string,
    labels: LabelState,
    issues: ReadonlyMap<string, IssueState>,
    declarations: ReadonlyMap<string, Offset>,
    heads: ReadonlyMap<string, Offset>,
    path: "cold" | "incremental",
  ): Promise<MaterializedRepoState> {
    const body = this.bodyFromReducedState(labels, issues, heads);
    const state: MaterializedRepoState = { labels, issues, declarations, heads, body };
    const key = `${org}/${repo}`;
    this.memory.set(key, state);
    const activity = this.materializationActivity(org, repo);
    this.activities.set(key, {
      coldRebuilds: activity.coldRebuilds + (path === "cold" ? 1 : 0),
      incrementalUpdates: activity.incrementalUpdates + (path === "incremental" ? 1 : 0),
    });
    try {
      await this.persist(body, org, repo);
      this.snapshotErrors.delete(key);
    } catch (error) {
      this.snapshotErrors.set(key, error instanceof Error ? error : new Error(String(error)));
    }
    return state;
  }

  private bodyMatchesReducedState(state: MaterializedRepoState): boolean {
    return (
      canonicalJson(state.body) ===
      canonicalJson(this.bodyFromReducedState(state.labels, state.issues, state.heads))
    );
  }

  private bodyFromReducedState(
    labels: LabelState,
    issues: ReadonlyMap<string, IssueState>,
    heads: ReadonlyMap<string, Offset>,
  ): BoardEndpointBody {
    const board = deriveBoardFromStates(labels, [...issues.values()]);
    const provenance: BoardProvenance = {
      inputs: [...heads.entries()]
        .map(([streamId, inputOffset]) => ({ streamId, offset: inputOffset }))
        .sort((left, right) => compareUtf8(left.streamId, right.streamId)),
    };
    return { board, digest: boardDigest(board), provenance };
  }

  private async discoverIssueNow(
    org: string,
    repo: string,
    issueStreamId: string,
    sourceOffset: Offset,
    ts: number,
  ): Promise<Offset> {
    if (!issueBelongsToRepo(issueStreamId, org, repo))
      throw new TypeError("repo-issues/cross-repo-source");
    const streamId = repoIssuesStreamId(org, repo);
    await this.ensureStream(streamId);
    let stalled = 0;
    let previousLength = -1;
    for (;;) {
      const records = await this.streams.read(streamId);
      const clean = records.map(cleanRecord);
      const state = replayIssueCatalog(streamId, clean);
      const existing = state.issues[issueStreamId];
      if (existing !== undefined) {
        if (existing !== sourceOffset) throw new TypeError("repo-issues/conflicting-source");
        return head(clean);
      }
      const offset = offsetForOrdinal(records.length);
      const event: Event = {
        type: ISSUE_CATALOG_EVENT,
        payload: { v: 1, issueStreamId, sourceOffset },
        ts,
      };
      try {
        await this.streams.append(streamId, event, {
          sequence: offset,
          applicationOffset: offset,
        });
        return offset;
      } catch (error) {
        if (!isDurableConflict(error)) throw error;
        stalled = records.length > previousLength ? 0 : stalled + 1;
        if (stalled >= 8) throw new Error("repo-issues/contention", { cause: error });
        previousLength = records.length;
      }
    }
  }

  private validateOpenedSource(records: readonly InputRecord[], declaredOffset: Offset): void {
    if (records.length === 0) return;
    const first = records[0]!;
    const opened = acceptedIssueEvent(first);
    if (opened.type !== "issue.opened" || !isIssueEventShape(opened))
      throw new TypeError("repo-issues/target-does-not-open");
    const firstOffset = first.offset ?? offsetForOrdinal(0);
    if (firstOffset !== declaredOffset) throw new TypeError("repo-issues/source-offset-mismatch");
  }

  private async ensureStream(streamId: string): Promise<void> {
    if ((await this.streams.exists?.(streamId)) === true) return;
    try {
      await this.streams.create(streamId);
    } catch (error) {
      if (!isDurableExistsConflict(error)) throw error;
    }
  }

  private async readOptional(streamId: string): Promise<readonly unknown[]> {
    if ((await this.streams.exists?.(streamId)) === false) return [];
    try {
      return await this.streams.read(streamId);
    } catch (error) {
      if (isDurableNotFound(error)) return [];
      throw error;
    }
  }

  private async persist(body: BoardEndpointBody, org: string, repo: string): Promise<void> {
    if (this.cacheDir === undefined) return;
    const path = boardCachePath(this.cacheDir, org, repo);
    await mkdir(dirname(path), { recursive: true });
    // Cache bytes never participate in source discovery or the served body. Reading
    // here only makes malformed/stale disposable snapshots take the same replace path.
    try {
      const cached = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (canonicalJson(cached) !== canonicalJson(body)) {
        // Replaced atomically below.
      }
    } catch {
      // Missing, truncated, and malformed copies are all replaced below.
    }
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${canonicalJson(body)}\n`, "utf8");
    await rename(temporary, path);
  }
}
