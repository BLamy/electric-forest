import { stateDigest, type Event } from "@eforest/protocol";
import type { NamespaceVisibility } from "../ns/events.js";
import { isRegistryEvent, type RegistryEvent } from "./events.js";

/**
 * E2-T08: the registry reducer over `__registry__`.
 *
 * The materialized project index is `replay(__registry__)` and nothing else:
 * canonical-JSON state (orgs → projects → repos), digestible with
 * `ef replay --digest --reducer packages/platform/registry-reducer.mjs` (the
 * repo's E0-T10 reducer-registration convention) and by
 * `registryStateDigest`. The reducer is strict — an event that contradicts
 * the state it arrives at is a loud rejection, never a silent skip — and
 * commutative across entities: events for distinct entities touch disjoint
 * state, so any interleaving of distinct source streams reduces to one
 * canonical state, while events for one entity are totally ordered by their
 * single source stream's offsets.
 */

export interface RegistryRepoState {
  readonly owner: string;
  readonly project: string;
  readonly visibility: NamespaceVisibility;
  /** Minted at repo creation; immutable — a rename never changes it. */
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
    // The listing key moves; the creation-time repoStreamPrefix does not.
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

/** SHA-256 over the canonically encoded materialized index. */
export function registryStateDigest(state: RegistryState): string {
  return stateDigest(state);
}
