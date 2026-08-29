import { stateDigest, type Event, type Offset } from "@eforest/protocol";

export type RegistryVisibility = "public" | "private";

export interface RegistrySource {
  readonly stream: string;
  readonly offset: Offset;
}

export type RegistryEventType =
  | "registry.org-added"
  | "registry.project-added"
  | "registry.repo-added"
  | "registry.repo-renamed"
  | "registry.repo-visibility-changed";

export interface RegistryOrgAddedEvent extends Event {
  readonly type: "registry.org-added";
  readonly payload: {
    readonly v: 1;
    readonly org: string;
    readonly owner: string;
    readonly source: RegistrySource;
  };
}

export interface RegistryProjectAddedEvent extends Event {
  readonly type: "registry.project-added";
  readonly payload: {
    readonly v: 1;
    readonly org: string;
    readonly project: string;
    readonly owner: string;
    readonly source: RegistrySource;
  };
}

export interface RegistryRepoAddedEvent extends Event {
  readonly type: "registry.repo-added";
  readonly payload: {
    readonly v: 1;
    readonly org: string;
    readonly project: string;
    readonly repo: string;
    readonly visibility: RegistryVisibility;
    readonly owner: string;
    readonly repoStreamPrefix: string;
    readonly source: RegistrySource;
  };
}

export interface RegistryRepoRenamedEvent extends Event {
  readonly type: "registry.repo-renamed";
  readonly payload: {
    readonly v: 1;
    readonly org: string;
    readonly repo: string;
    readonly newRepo: string;
    readonly source: RegistrySource;
  };
}

export interface RegistryRepoVisibilityChangedEvent extends Event {
  readonly type: "registry.repo-visibility-changed";
  readonly payload: {
    readonly v: 1;
    readonly org: string;
    readonly repo: string;
    readonly visibility: RegistryVisibility;
    readonly source: RegistrySource;
  };
}

export type RegistryEvent =
  | RegistryOrgAddedEvent
  | RegistryProjectAddedEvent
  | RegistryRepoAddedEvent
  | RegistryRepoRenamedEvent
  | RegistryRepoVisibilityChangedEvent;

export interface RegistryRepoState {
  readonly owner: string;
  readonly project: string;
  readonly visibility: RegistryVisibility;
  readonly repoStreamPrefix: string;
}

export interface RegistryProjectState {
  readonly owner: string;
}

export interface RegistryOrgState {
  readonly owner: string;
  readonly projects: Readonly<Record<string, RegistryProjectState>>;
  readonly repos: Readonly<Record<string, RegistryRepoState>>;
}

export interface RegistryState {
  readonly orgs: Readonly<Record<string, RegistryOrgState>>;
}

export const registryInitialState: RegistryState = Object.freeze({ orgs: Object.freeze({}) });

export function isRegistryEventType(type: string): type is RegistryEventType {
  return (
    type === "registry.org-added" ||
    type === "registry.project-added" ||
    type === "registry.repo-added" ||
    type === "registry.repo-renamed" ||
    type === "registry.repo-visibility-changed"
  );
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol")) return false;
  const actual = (ownKeys as string[]).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validSource(value: unknown): value is RegistrySource {
  return (
    exactObject(value, ["stream", "offset"]) &&
    typeof value.stream === "string" &&
    value.stream.length > 0 &&
    typeof value.offset === "string" &&
    value.offset.length > 0
  );
}

function eventEnvelope(value: unknown): value is Event {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).type === "string" &&
    typeof (value as Record<string, unknown>).ts === "number" &&
    Number.isFinite((value as Record<string, unknown>).ts)
  );
}

function name(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function visibility(value: unknown): value is RegistryVisibility {
  return value === "public" || value === "private";
}

export function isRegistryEvent(value: unknown): value is RegistryEvent {
  if (!eventEnvelope(value) || !isRegistryEventType(value.type)) return false;
  const payload = (value as { readonly payload: unknown }).payload;
  switch (value.type) {
    case "registry.org-added":
      return (
        exactObject(payload, ["v", "org", "owner", "source"]) &&
        payload.v === 1 &&
        name(payload.org) &&
        name(payload.owner) &&
        validSource(payload.source)
      );
    case "registry.project-added":
      return (
        exactObject(payload, ["v", "org", "project", "owner", "source"]) &&
        payload.v === 1 &&
        name(payload.org) &&
        name(payload.project) &&
        name(payload.owner) &&
        validSource(payload.source)
      );
    case "registry.repo-added":
      return (
        exactObject(payload, [
          "v",
          "org",
          "project",
          "repo",
          "visibility",
          "owner",
          "repoStreamPrefix",
          "source",
        ]) &&
        payload.v === 1 &&
        name(payload.org) &&
        name(payload.project) &&
        name(payload.repo) &&
        visibility(payload.visibility) &&
        name(payload.owner) &&
        name(payload.repoStreamPrefix) &&
        validSource(payload.source)
      );
    case "registry.repo-renamed":
      return (
        exactObject(payload, ["v", "org", "repo", "newRepo", "source"]) &&
        payload.v === 1 &&
        name(payload.org) &&
        name(payload.repo) &&
        name(payload.newRepo) &&
        validSource(payload.source)
      );
    case "registry.repo-visibility-changed":
      return (
        exactObject(payload, ["v", "org", "repo", "visibility", "source"]) &&
        payload.v === 1 &&
        name(payload.org) &&
        name(payload.repo) &&
        visibility(payload.visibility) &&
        validSource(payload.source)
      );
  }
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function reject(message: string): never {
  throw new TypeError(`registry/reducer-invalid: ${message}`);
}

function withOrg(state: RegistryState, org: string, next: RegistryOrgState): RegistryState {
  return { orgs: { ...state.orgs, [org]: next } };
}

export function registryReducer(state: RegistryState, rawEvent: Event): RegistryState {
  if (!isRegistryEvent(rawEvent)) reject("invalid event");
  const event = rawEvent as RegistryEvent;
  if (event.type === "registry.org-added") {
    if (own(state.orgs, event.payload.org) !== undefined) reject("duplicate org");
    return withOrg(state, event.payload.org, {
      owner: event.payload.owner,
      projects: {},
      repos: {},
    });
  }
  const org = own(state.orgs, event.payload.org);
  if (org === undefined) reject("unknown org");
  if (event.type === "registry.project-added") {
    if (own(org.projects, event.payload.project) !== undefined) reject("duplicate project");
    return withOrg(state, event.payload.org, {
      ...org,
      projects: { ...org.projects, [event.payload.project]: { owner: event.payload.owner } },
    });
  }
  if (event.type === "registry.repo-added") {
    if (own(org.projects, event.payload.project) === undefined) reject("unknown project");
    if (own(org.repos, event.payload.repo) !== undefined) reject("duplicate repo");
    return withOrg(state, event.payload.org, {
      ...org,
      repos: {
        ...org.repos,
        [event.payload.repo]: {
          owner: event.payload.owner,
          project: event.payload.project,
          visibility: event.payload.visibility,
          repoStreamPrefix: event.payload.repoStreamPrefix,
        },
      },
    });
  }
  const repo = own(org.repos, event.payload.repo);
  if (repo === undefined) reject("unknown repo");
  if (event.type === "registry.repo-renamed") {
    if (own(org.repos, event.payload.newRepo) !== undefined) reject("rename onto taken name");
    const rest = Object.fromEntries(
      Object.entries(org.repos).filter(([name]) => name !== event.payload.repo),
    );
    return withOrg(state, event.payload.org, {
      ...org,
      repos: { ...rest, [event.payload.newRepo]: repo },
    });
  }
  return withOrg(state, event.payload.org, {
    ...org,
    repos: {
      ...org.repos,
      [event.payload.repo]: { ...repo, visibility: event.payload.visibility },
    },
  });
}

function envelope(record: unknown): Event {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    reject("record is not an object");
  }
  const value = record as Record<string, unknown>;
  return { type: value.type, payload: value.payload, ts: value.ts } as Event;
}

export function replayRegistryStream(events: readonly unknown[]): RegistryState {
  return events.reduce<RegistryState>(
    (state, record) => registryReducer(state, envelope(record)),
    registryInitialState,
  );
}

export function registryStateDigest(state: RegistryState): string {
  return stateDigest(state);
}
