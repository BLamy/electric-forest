import { stateDigest, type Event } from "@eforest/protocol";
import { FS_EVENT_VERSION, fsInitialState, fsReducer, treeDigest } from "@eforest/streamfs";
import { fileContentReducerDefinition } from "./file-content.js";
import { historyInitialState, historyReducer, historyStateDigest } from "./history.js";
import { registryInitialState, registryReducer, registryStateDigest } from "./registry.js";
import {
  repositoryBranchesInitialState,
  repositoryBranchesReducer,
  repositoryHomeDigest,
  repositoryNamespaceInitialState,
  repositoryNamespaceReducer,
  repositoryStatusInitialState,
  repositoryStatusReducer,
} from "./repo-home.js";

export * from "./registry.js";
export * from "./repo-home.js";
export * from "./file-content.js";
export * from "./history.js";

export interface ReducerDefinition {
  readonly id: string;
  readonly version: number;
  readonly initialState: unknown;
  readonly reduce: (state: unknown, event: Event) => unknown;
  readonly digest: (state: unknown) => string;
  readonly matchesStream: (streamId: string) => boolean;
}

const STREAMFS_META_PATTERN =
  /^fs:[a-z0-9](?:-?[a-z0-9])*\/[a-z0-9](?:-?[a-z0-9])*:[a-z0-9][a-z0-9-]{0,63}:meta$/;

function reduceStreamFsApplicationEvent(state: unknown, event: Event): unknown {
  const payload =
    event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? Object.fromEntries(
          Object.entries(event.payload).filter(([key]) => key !== "actor" && key !== "writer"),
        )
      : event.payload;
  return fsReducer(state as Parameters<typeof fsReducer>[0], { ...event, payload });
}

export const streamFsReducerDefinition: ReducerDefinition = Object.freeze({
  id: "streamfs",
  version: FS_EVENT_VERSION,
  initialState: fsInitialState,
  reduce: reduceStreamFsApplicationEvent,
  digest: treeDigest as (state: unknown) => string,
  matchesStream: (streamId: string) => STREAMFS_META_PATTERN.test(streamId),
});

export const registryReducerDefinition: ReducerDefinition = Object.freeze({
  id: "registry",
  version: 1,
  initialState: registryInitialState,
  reduce: registryReducer as (state: unknown, event: Event) => unknown,
  digest: registryStateDigest as (state: unknown) => string,
  matchesStream: (streamId: string) => streamId === "__registry__",
});

const REPO_HOME_NAMESPACE =
  /^repo-home:[a-z0-9](?:-?[a-z0-9])*\/[a-z0-9](?:-?[a-z0-9])*:namespace$/;
const REPO_HOME_BRANCHES = /^repo-home:[a-z0-9](?:-?[a-z0-9])*\/[a-z0-9](?:-?[a-z0-9])*:branches$/;
const REPO_HOME_STATUS = /^repo-home:[a-z0-9](?:-?[a-z0-9])*\/[a-z0-9](?:-?[a-z0-9])*:status$/;

export const historyReducerDefinition: ReducerDefinition = Object.freeze({
  id: "history",
  version: 1,
  initialState: historyInitialState,
  reduce: historyReducer as (state: unknown, event: Event) => unknown,
  digest: historyStateDigest,
  matchesStream: (streamId: string) => STREAMFS_META_PATTERN.test(streamId),
});

export const repositoryNamespaceReducerDefinition: ReducerDefinition = Object.freeze({
  id: "repo-namespace",
  version: 1,
  initialState: repositoryNamespaceInitialState,
  reduce: repositoryNamespaceReducer as (state: unknown, event: Event) => unknown,
  digest: repositoryHomeDigest,
  matchesStream: (streamId: string) => REPO_HOME_NAMESPACE.test(streamId),
});

export const repositoryBranchesReducerDefinition: ReducerDefinition = Object.freeze({
  id: "repo-branches",
  version: 1,
  initialState: repositoryBranchesInitialState,
  reduce: repositoryBranchesReducer as (state: unknown, event: Event) => unknown,
  digest: repositoryHomeDigest,
  matchesStream: (streamId: string) => REPO_HOME_BRANCHES.test(streamId),
});

export const repositoryStatusReducerDefinition: ReducerDefinition = Object.freeze({
  id: "repo-status",
  version: 1,
  initialState: repositoryStatusInitialState,
  reduce: repositoryStatusReducer as (state: unknown, event: Event) => unknown,
  digest: repositoryHomeDigest,
  matchesStream: (streamId: string) => REPO_HOME_STATUS.test(streamId),
});

const definitions: readonly ReducerDefinition[] = [
  streamFsReducerDefinition,
  registryReducerDefinition,
  repositoryNamespaceReducerDefinition,
  repositoryBranchesReducerDefinition,
  repositoryStatusReducerDefinition,
  fileContentReducerDefinition,
  historyReducerDefinition,
];

export function reducerById(id: string): ReducerDefinition | undefined {
  return definitions.find((definition) => definition.id === id);
}

export function reducerForStream(streamId: string): ReducerDefinition | undefined {
  return definitions.find((definition) => definition.matchesStream(streamId));
}

export function requireReducer(id: string, streamId: string): ReducerDefinition {
  const definition = reducerById(id);
  if (definition === undefined || !definition.matchesStream(streamId)) {
    throw new TypeError(`reducer ${id} does not match stream ${streamId}`);
  }
  return definition;
}

export function replayWithReducer(
  definition: ReducerDefinition,
  events: readonly Event[],
): { readonly state: unknown; readonly digest: string } {
  const state = events.reduce<unknown>(
    (current, event) => definition.reduce(current, event),
    definition.initialState,
  );
  return { state, digest: definition.digest(state) };
}

/** Sensitivity oracle: registry digests are canonical state digests, never event-list hashes. */
export function digestReducerState(state: unknown): string {
  return stateDigest(state);
}
