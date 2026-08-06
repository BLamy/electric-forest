import { isDurableConflict, isDurableExistsConflict, isDurableNotFound } from "@eforest/client";
import { OFFSET_BEFORE_FIRST, type Event, type Offset } from "@eforest/protocol";
import { isWellFormedOffset, offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import {
  repositoryBranchesReducer,
  repositoryBranchesInitialState,
  repositoryHomeStreamId,
  repositoryStatusReducer,
  repositoryStatusInitialState,
  type ProjectStatus,
} from "@eforest/reducers";
import type { NamespaceView } from "./ns/reducer.js";
import type { StreamAdapter } from "./official.js";

export type RepositoryHomeRegion = "namespace" | "branches" | "status";

export interface RepositoryHomeBatch {
  readonly streamId: string;
  readonly events: readonly Event[];
}

export class RepositoryHomeCorruptError extends Error {
  constructor(
    readonly region: RepositoryHomeRegion,
    message: string,
  ) {
    super(`repo-home/${region}-corrupt: ${message}`);
    this.name = "RepositoryHomeCorruptError";
  }
}

export class RepositoryHomeNativeForkError extends Error {
  constructor(message: string) {
    super(`repo-home/native-fork-refused: ${message}`);
    this.name = "RepositoryHomeNativeForkError";
  }
}

function envelope(value: unknown): Event {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("record is not an object");
  }
  const record = value as Record<string, unknown>;
  return { type: record.type, payload: record.payload, ts: record.ts } as Event;
}

function withOffset(event: Event, ordinal: number): Event {
  return { ...event, offset: offsetForOrdinal(ordinal) } as Event;
}

async function readOrEmpty(streams: StreamAdapter, streamId: string): Promise<readonly unknown[]> {
  try {
    return await streams.read(streamId);
  } catch (error) {
    if (isDurableNotFound(error)) return [];
    throw error;
  }
}

async function ensureStream(streams: StreamAdapter, streamId: string): Promise<void> {
  try {
    await streams.create(streamId);
  } catch (error) {
    if (!isDurableExistsConflict(error)) throw error;
  }
}

function namespaceProjection(
  view: NamespaceView,
  org: string,
  repo: string,
  orgRecords: readonly unknown[],
): readonly Event[] {
  const metadata = view.orgs[org]?.repos[repo];
  const project = metadata === undefined ? undefined : view.orgs[org]?.projects[metadata.project];
  if (metadata === undefined || project === undefined) return [];

  // Find the creation-time identity of the current listing by replaying only
  // repo names. This keeps visibility transitions for this repository while
  // excluding unrelated namespace traffic, so virtual offsets stay contiguous.
  interface Lineage {
    readonly visibility: Array<"public" | "private">;
  }
  const lineages = new Map<string, Lineage>();
  for (const raw of orgRecords) {
    const event = envelope(raw);
    const payload = event.payload as Record<string, unknown>;
    if (event.type === "ns.repo.create" && typeof payload.name === "string") {
      const lineage: Lineage = { visibility: [] };
      if (payload.visibility === "public" || payload.visibility === "private") {
        lineage.visibility.push(payload.visibility);
      }
      lineages.set(payload.name, lineage);
    } else if (
      event.type === "ns.repo.rename" &&
      typeof payload.name === "string" &&
      typeof payload.newName === "string"
    ) {
      const lineage = lineages.get(payload.name);
      if (lineage !== undefined) {
        lineages.delete(payload.name);
        lineages.set(payload.newName, lineage);
      }
    } else if (
      event.type === "ns.repo.set-visibility" &&
      typeof payload.name === "string" &&
      (payload.visibility === "public" || payload.visibility === "private")
    ) {
      lineages.get(payload.name)?.visibility.push(payload.visibility);
    }
  }
  const lineage = lineages.get(repo);
  if (lineage === undefined) {
    // The namespace reducer says the repo exists but the source history cannot
    // establish its lineage. Refuse visibly instead of fabricating metadata.
    throw new RepositoryHomeCorruptError("namespace", "current repo has no source lineage");
  }
  const loaded: Event = {
    type: "repo.namespace.loaded",
    ts: 0,
    payload: {
      v: 1,
      org,
      repo,
      project: metadata.project,
      projectOwner: project.owner,
      repoOwner: metadata.owner,
      visibility: lineage.visibility[0] ?? metadata.visibility,
    },
  };
  return [
    withOffset(loaded, 0),
    ...lineage.visibility.slice(1).map((next, index) =>
      withOffset(
        {
          type: "repo.namespace.visibility-set",
          ts: index + 1,
          payload: { v: 1, visibility: next },
        },
        index + 1,
      ),
    ),
  ];
}

function validateBranchProjection(records: readonly unknown[]): readonly Event[] {
  let state = repositoryBranchesInitialState;
  return records.map((raw, ordinal) => {
    const event = envelope(raw);
    try {
      state = repositoryBranchesReducer(state, event);
    } catch (error) {
      throw new RepositoryHomeCorruptError(
        "branches",
        error instanceof Error ? error.message : String(error),
      );
    }
    return withOffset(event, ordinal);
  });
}

function validateStatusProjection(records: readonly unknown[]): readonly Event[] {
  let state = repositoryStatusInitialState;
  return records.map((raw, ordinal) => {
    const event = envelope(raw);
    try {
      state = repositoryStatusReducer(state, event);
    } catch (error) {
      throw new RepositoryHomeCorruptError(
        "status",
        error instanceof Error ? error.message : String(error),
      );
    }
    return withOffset(event, ordinal);
  });
}

export class RepositoryHomeStore {
  private serial: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly streams: StreamAdapter,
    private readonly now: () => number = Date.now,
  ) {}

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.serial.then(work);
    this.serial = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async projection(
    view: NamespaceView,
    org: string,
    repo: string,
    region: RepositoryHomeRegion,
  ): Promise<RepositoryHomeBatch> {
    const streamId = repositoryHomeStreamId(org, repo, region);
    if (region === "namespace") {
      return {
        streamId,
        events: namespaceProjection(
          view,
          org,
          repo,
          await readOrEmpty(this.streams, `ns:org:${org}`),
        ),
      };
    }
    if (region === "branches") {
      return {
        streamId,
        events: validateBranchProjection(await readOrEmpty(this.streams, streamId)),
      };
    }
    const project = view.orgs[org]?.repos[repo]?.project;
    if (project === undefined) return { streamId, events: [] };
    return {
      streamId,
      events: validateStatusProjection(
        await readOrEmpty(this.streams, `project-status:${org}/${project}`),
      ),
    };
  }

  ensureRepository(org: string, repo: string, project: string): Promise<void> {
    return this.enqueue(async () => {
      const branchStream = repositoryHomeStreamId(org, repo, "branches");
      await ensureStream(this.streams, branchStream);
      await this.appendValidated(
        branchStream,
        {
          type: "repo.branch.created",
          ts: this.now(),
          payload: {
            v: 1,
            name: "main",
            streamId: `fs:${org}/${repo}:main:meta`,
            parentStreamId: null,
            forkOffset: OFFSET_BEFORE_FIRST,
          },
        },
        "branches",
        true,
      );
      const statusStream = `project-status:${org}/${project}`;
      await ensureStream(this.streams, statusStream);
      await this.appendValidated(
        statusStream,
        { type: "project.status.set", ts: this.now(), payload: { v: 1, status: "building" } },
        "status",
        true,
      );
    });
  }

  setProjectStatus(org: string, project: string, status: ProjectStatus): Promise<void> {
    return this.enqueue(async () => {
      const streamId = `project-status:${org}/${project}`;
      await ensureStream(this.streams, streamId);
      await this.appendValidated(
        streamId,
        { type: "project.status.set", ts: this.now(), payload: { v: 1, status } },
        "status",
      );
    });
  }

  registerNativeBranch(org: string, repo: string, name: string): Promise<void> {
    return this.enqueue(async () => {
      const nativeStreamId = `fs:${org}/${repo}:${name}:meta`;
      const native = await readOrEmpty(this.streams, nativeStreamId);
      // The official Durable Streams fork surface exposes the inherited parent
      // prefix when a child is read. The child-owned fork directive is therefore
      // the last fork event in the raw stream, not necessarily record zero. A
      // memory emulator that returns only child-owned records still takes the
      // same path with its sole fork event.
      const forkRecord = [...native]
        .reverse()
        .find((record) => envelope(record).type === "fs.branch.fork");
      if (forkRecord === undefined) {
        throw new RepositoryHomeNativeForkError(
          native.length === 0
            ? "branch stream is empty"
            : "first event is not a valid fs.branch.fork",
        );
      }
      const event = envelope(forkRecord);
      const rawPayload = event.payload;
      if (
        event.type !== "fs.branch.fork" ||
        rawPayload === null ||
        typeof rawPayload !== "object" ||
        Array.isArray(rawPayload) ||
        Reflect.ownKeys(rawPayload).length !== 3
      ) {
        throw new RepositoryHomeNativeForkError("first event is not a valid fs.branch.fork");
      }
      const payload = rawPayload as Record<string, unknown>;
      if (
        payload.v !== 1 ||
        typeof payload.parentStreamId !== "string" ||
        typeof payload.forkOffset !== "string" ||
        !isWellFormedOffset(payload.forkOffset)
      ) {
        throw new RepositoryHomeNativeForkError("first event is not a valid fs.branch.fork");
      }
      const parentStreamId = payload.parentStreamId;
      if (!parentStreamId.startsWith(`fs:${org}/${repo}:`) || !parentStreamId.endsWith(":meta")) {
        throw new RepositoryHomeNativeForkError("parent stream belongs to another repository");
      }
      if (this.streams.exists !== undefined && !(await this.streams.exists(parentStreamId))) {
        throw new RepositoryHomeNativeForkError("parent stream does not exist");
      }
      let parent: readonly unknown[];
      try {
        parent = await this.streams.read(parentStreamId);
      } catch (error) {
        if (isDurableNotFound(error)) {
          throw new RepositoryHomeNativeForkError("parent stream does not exist");
        }
        throw error;
      }
      if (
        payload.forkOffset !== OFFSET_BEFORE_FIRST &&
        !parent.some(
          (record) =>
            record !== null &&
            typeof record === "object" &&
            !Array.isArray(record) &&
            (record as { readonly offset?: unknown }).offset === payload.forkOffset,
        )
      ) {
        throw new RepositoryHomeNativeForkError("fork checkpoint is absent from parent stream");
      }
      const branchStream = repositoryHomeStreamId(org, repo, "branches");
      await ensureStream(this.streams, branchStream);
      await this.appendValidated(
        branchStream,
        {
          type: "repo.branch.created",
          ts: this.now(),
          payload: {
            v: 1,
            name,
            streamId: nativeStreamId,
            parentStreamId: payload.parentStreamId,
            forkOffset: payload.forkOffset as Offset,
          },
        },
        "branches",
      );
    });
  }

  private async appendValidated(
    streamId: string,
    event: Event,
    region: "branches" | "status",
    idempotent = false,
  ): Promise<void> {
    let previousLength = -1;
    for (;;) {
      const records = await readOrEmpty(this.streams, streamId);
      if (idempotent && records.length > 0) return;
      if (region === "branches") validateBranchProjection([...records, event]);
      else validateStatusProjection([...records, event]);
      const offset = offsetForOrdinal(records.length);
      try {
        await this.streams.append(streamId, event, {
          sequence: offset,
          applicationOffset: offset,
        });
        return;
      } catch (error) {
        if (!isDurableConflict(error) || records.length === previousLength) throw error;
        previousLength = records.length;
      }
    }
  }
}
