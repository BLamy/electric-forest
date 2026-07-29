import type { Event } from "@eforest/protocol";
import { isNamespaceEvent, type NamespaceEvent, type NamespaceVisibility } from "./events.js";

export interface NamespaceOrgSeed {
  readonly owner: string;
}

export interface NamespaceProjectSeed {
  readonly owner: string;
}

export interface NamespaceRepoSeed {
  readonly owner: string;
  readonly project: string;
  readonly visibility: NamespaceVisibility;
}

export interface NamespaceStreamState {
  readonly kind: "empty" | "root" | "org";
  readonly orgs: Readonly<Record<string, NamespaceOrgSeed>>;
  readonly projects: Readonly<Record<string, NamespaceProjectSeed>>;
  readonly repos: Readonly<Record<string, NamespaceRepoSeed>>;
}

export interface NamespaceOrgView {
  readonly owner: string;
  readonly projects: Readonly<Record<string, NamespaceProjectSeed>>;
  readonly repos: Readonly<Record<string, NamespaceRepoSeed>>;
}

export interface NamespaceView {
  readonly orgs: Readonly<Record<string, NamespaceOrgView>>;
}

export function createNamespaceInitialState(): NamespaceStreamState {
  return Object.freeze({
    kind: "empty",
    orgs: Object.freeze({}),
    projects: Object.freeze({}),
    repos: Object.freeze({}),
  });
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function reject(message: string): never {
  throw new TypeError(`ns/reducer-invalid: ${message}`);
}

export function namespaceReducer(
  state: NamespaceStreamState,
  rawEvent: Event,
): NamespaceStreamState {
  if (!isNamespaceEvent(rawEvent)) reject("invalid event");
  const event = rawEvent as NamespaceEvent;
  if (event.type === "ns.org.create") {
    if (state.kind === "org") reject("org event in per-org stream");
    if (own(state.orgs, event.payload.name) !== undefined) reject("duplicate org");
    return {
      ...state,
      kind: "root",
      orgs: { ...state.orgs, [event.payload.name]: { owner: event.payload.actor.sub } },
    };
  }
  if (state.kind === "root") reject("per-org event in root stream");
  if (event.type === "ns.project.create") {
    if (own(state.projects, event.payload.name) !== undefined) reject("duplicate project");
    return {
      ...state,
      kind: "org",
      projects: { ...state.projects, [event.payload.name]: { owner: event.payload.actor.sub } },
    };
  }
  if (own(state.projects, event.payload.project) === undefined) reject("unknown project");
  if (own(state.repos, event.payload.name) !== undefined) reject("duplicate repo");
  return {
    ...state,
    kind: "org",
    repos: {
      ...state.repos,
      [event.payload.name]: {
        owner: event.payload.actor.sub,
        project: event.payload.project,
        visibility: event.payload.visibility,
      },
    },
  };
}

function envelope(record: unknown): Event {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    reject("record is not an object");
  }
  const value = record as Record<string, unknown>;
  return { type: value.type, payload: value.payload, ts: value.ts } as Event;
}

export function replayNamespaceStream(events: readonly unknown[]): NamespaceStreamState {
  return events.reduce<NamespaceStreamState>(
    (state, record) => namespaceReducer(state, envelope(record)),
    createNamespaceInitialState(),
  );
}

export function composeNamespaceView(
  rootEvents: readonly unknown[],
  orgStreams: Readonly<Record<string, readonly unknown[]>>,
): NamespaceView {
  const root = replayNamespaceStream(rootEvents);
  if (root.kind !== "root" && rootEvents.length > 0) reject("root stream has no org events");
  const orgs: Record<string, NamespaceOrgView> = {};
  for (const name of Object.keys(root.orgs).sort()) {
    const streamId = `ns:org:${name}`;
    const local = replayNamespaceStream(orgStreams[streamId] ?? []);
    orgs[name] = {
      owner: root.orgs[name]!.owner,
      projects: local.projects,
      repos: local.repos,
    };
  }
  return { orgs };
}
