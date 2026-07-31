import { stateDigest, type Event, type Offset } from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";

export type RepositoryVisibility = "public" | "private";
export type ProjectStatus = "building" | "complete" | "paused" | "invalid_loop";

export interface RepositoryNamespaceState {
  readonly metadata: null | {
    readonly org: string;
    readonly repo: string;
    readonly project: string;
    readonly projectOwner: string;
    readonly repoOwner: string;
    readonly visibility: RepositoryVisibility;
  };
}

export interface RepositoryBranch {
  readonly name: string;
  readonly streamId: string;
  readonly parentStreamId: string | null;
  readonly forkOffset: Offset;
}

export interface RepositoryBranchesState {
  readonly branches: Readonly<Record<string, RepositoryBranch>>;
}

export interface RepositoryStatusState {
  readonly status: ProjectStatus | null;
}

export const repositoryNamespaceInitialState: RepositoryNamespaceState = Object.freeze({
  metadata: null,
});

export const repositoryBranchesInitialState: RepositoryBranchesState = Object.freeze({
  branches: Object.freeze({}),
});

export const repositoryStatusInitialState: RepositoryStatusState = Object.freeze({
  status: null,
});

const NAME = /^(?=[a-z0-9-]{1,40}$)[a-z0-9](?:-?[a-z0-9])*$/;
const BRANCH = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESERVED_BRANCHES = new Set(["meta", "file"]);
const STREAM =
  /^fs:([a-z0-9](?:-?[a-z0-9])*)\/([a-z0-9](?:-?[a-z0-9])*):([a-z0-9][a-z0-9-]{0,63}):meta$/;

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string")) return false;
  const sorted = (actual as string[]).sort();
  const expected = [...keys].sort();
  return sorted.length === expected.length && sorted.every((key, index) => key === expected[index]);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function reject(region: string, message: string): never {
  throw new TypeError(`repo-home/${region}-invalid: ${message}`);
}

export function repositoryNamespaceReducer(
  state: RepositoryNamespaceState,
  event: Event,
): RepositoryNamespaceState {
  if (event.type === "repo.namespace.loaded") {
    if (
      state.metadata !== null ||
      !exactObject(event.payload, [
        "v",
        "org",
        "repo",
        "project",
        "projectOwner",
        "repoOwner",
        "visibility",
      ]) ||
      event.payload.v !== 1 ||
      typeof event.payload.org !== "string" ||
      !NAME.test(event.payload.org) ||
      typeof event.payload.repo !== "string" ||
      !NAME.test(event.payload.repo) ||
      typeof event.payload.project !== "string" ||
      !NAME.test(event.payload.project) ||
      !nonempty(event.payload.projectOwner) ||
      !nonempty(event.payload.repoOwner) ||
      (event.payload.visibility !== "public" && event.payload.visibility !== "private")
    ) {
      reject("namespace", "malformed or duplicate metadata");
    }
    return {
      metadata: {
        org: event.payload.org,
        repo: event.payload.repo,
        project: event.payload.project,
        projectOwner: event.payload.projectOwner,
        repoOwner: event.payload.repoOwner,
        visibility: event.payload.visibility,
      },
    };
  }
  if (event.type === "repo.namespace.visibility-set") {
    if (
      state.metadata === null ||
      !exactObject(event.payload, ["v", "visibility"]) ||
      event.payload.v !== 1 ||
      (event.payload.visibility !== "public" && event.payload.visibility !== "private")
    ) {
      reject("namespace", "malformed visibility transition");
    }
    return { metadata: { ...state.metadata, visibility: event.payload.visibility } };
  }
  reject("namespace", `unknown event ${event.type}`);
}

export function repositoryBranchesReducer(
  state: RepositoryBranchesState,
  event: Event,
): RepositoryBranchesState {
  if (
    event.type !== "repo.branch.created" ||
    !exactObject(event.payload, ["v", "name", "streamId", "parentStreamId", "forkOffset"]) ||
    event.payload.v !== 1 ||
    typeof event.payload.name !== "string" ||
    !BRANCH.test(event.payload.name) ||
    RESERVED_BRANCHES.has(event.payload.name) ||
    typeof event.payload.streamId !== "string" ||
    (event.payload.parentStreamId !== null && typeof event.payload.parentStreamId !== "string") ||
    typeof event.payload.forkOffset !== "string" ||
    !isWellFormedOffset(event.payload.forkOffset)
  ) {
    reject("branches", "malformed branch event");
  }
  const payload = event.payload as {
    readonly v: 1;
    readonly name: string;
    readonly streamId: string;
    readonly parentStreamId: string | null;
    readonly forkOffset: Offset;
  };
  const streamMatch = STREAM.exec(payload.streamId);
  if (streamMatch === null || streamMatch[3] !== payload.name) {
    reject("branches", "branch name and stream id disagree");
  }
  if (own(state.branches, payload.name) !== undefined) {
    reject("branches", "duplicate branch name");
  }
  if (Object.values(state.branches).some((branch) => branch.streamId === payload.streamId)) {
    reject("branches", "duplicate branch stream");
  }
  if (payload.parentStreamId === null) {
    if (payload.name !== "main" || payload.forkOffset !== "-1") {
      reject("branches", "only main may be a root branch");
    }
  } else {
    if (payload.parentStreamId === payload.streamId) {
      reject("branches", "cyclic branch ancestry");
    }
    const parent = Object.values(state.branches).find(
      (branch) => branch.streamId === payload.parentStreamId,
    );
    if (parent === undefined) reject("branches", "unknown parent stream");
    const parentMatch = STREAM.exec(parent.streamId);
    if (
      parentMatch === null ||
      parentMatch[1] !== streamMatch[1] ||
      parentMatch[2] !== streamMatch[2]
    ) {
      reject("branches", "cross-repository parent stream");
    }
  }
  const branch: RepositoryBranch = {
    name: payload.name,
    streamId: payload.streamId,
    parentStreamId: payload.parentStreamId,
    forkOffset: payload.forkOffset,
  };
  return { branches: { ...state.branches, [branch.name]: branch } };
}

export function repositoryStatusReducer(
  state: RepositoryStatusState,
  event: Event,
): RepositoryStatusState {
  if (
    event.type !== "project.status.set" ||
    !exactObject(event.payload, ["v", "status"]) ||
    event.payload.v !== 1 ||
    (event.payload.status !== "building" &&
      event.payload.status !== "complete" &&
      event.payload.status !== "paused" &&
      event.payload.status !== "invalid_loop")
  ) {
    reject("status", "malformed status transition");
  }
  return { status: event.payload.status };
}

export function repositoryHomeDigest(state: unknown): string {
  return stateDigest(state);
}

export function repositoryHomeStreamId(
  org: string,
  repo: string,
  region: "namespace" | "branches" | "status",
): string {
  return `repo-home:${org}/${repo}:${region}`;
}
