import type { Event, Offset } from "@eforest/protocol";
import type { NamespaceVisibility } from "../ns/events.js";

/**
 * E2-T08: the five frozen `registry.*` derived event schemas.
 *
 * Every derived event is appended by the server's projector to the
 * server-minted, client-unwritable `__registry__` stream, exactly one per
 * accepted `ns.*` source event, and is a pure function of that source event
 * alone: `ts` is copied from the source event, `source` names the exact
 * namespace record it derives from, and no wall clock, randomness, or
 * projector state participates. Changing any shape invalidates the goldens
 * committed with this task.
 */

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
    readonly visibility: NamespaceVisibility;
    readonly owner: string;
    /** Minted here, at creation, and immutable for the repo's lifetime. */
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
    readonly visibility: NamespaceVisibility;
    readonly source: RegistrySource;
  };
}

export type RegistryEvent =
  | RegistryOrgAddedEvent
  | RegistryProjectAddedEvent
  | RegistryRepoAddedEvent
  | RegistryRepoRenamedEvent
  | RegistryRepoVisibilityChangedEvent;

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

function source(value: unknown): value is RegistrySource {
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

function visibility(value: unknown): value is NamespaceVisibility {
  return value === "public" || value === "private";
}

function name(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Exact-shape runtime guard: mandatory `source`, no extra fields. */
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
        source(payload.source)
      );
    case "registry.project-added":
      return (
        exactObject(payload, ["v", "org", "project", "owner", "source"]) &&
        payload.v === 1 &&
        name(payload.org) &&
        name(payload.project) &&
        name(payload.owner) &&
        source(payload.source)
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
        source(payload.source)
      );
    case "registry.repo-renamed":
      return (
        exactObject(payload, ["v", "org", "repo", "newRepo", "source"]) &&
        payload.v === 1 &&
        name(payload.org) &&
        name(payload.repo) &&
        name(payload.newRepo) &&
        source(payload.source)
      );
    case "registry.repo-visibility-changed":
      return (
        exactObject(payload, ["v", "org", "repo", "visibility", "source"]) &&
        payload.v === 1 &&
        name(payload.org) &&
        name(payload.repo) &&
        visibility(payload.visibility) &&
        source(payload.source)
      );
  }
}
