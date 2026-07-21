import type { Event } from "@eforest/protocol";

export type NamespaceVisibility = "public" | "private";
export type NamespaceEventType = "ns.org.create" | "ns.project.create" | "ns.repo.create";

export interface NamespaceActor {
  readonly sub: string;
}

export interface NamespaceOrgCreatedEvent extends Event {
  readonly type: "ns.org.create";
  readonly payload: {
    readonly v: 1;
    readonly name: string;
    readonly actor: NamespaceActor;
  };
}

export interface NamespaceProjectCreatedEvent extends Event {
  readonly type: "ns.project.create";
  readonly payload: {
    readonly v: 1;
    readonly name: string;
    readonly actor: NamespaceActor;
  };
}

export interface NamespaceRepoCreatedEvent extends Event {
  readonly type: "ns.repo.create";
  readonly payload: {
    readonly v: 1;
    readonly name: string;
    readonly project: string;
    readonly visibility: NamespaceVisibility;
    readonly actor: NamespaceActor;
  };
}

export type NamespaceEvent =
  NamespaceOrgCreatedEvent | NamespaceProjectCreatedEvent | NamespaceRepoCreatedEvent;

export function isNamespaceName(value: string): boolean {
  return /^(?=[a-z0-9-]{1,40}$)[a-z0-9](?:-?[a-z0-9])*$/.test(value);
}

export function isNamespaceEventType(type: string): type is NamespaceEventType {
  return type === "ns.org.create" || type === "ns.project.create" || type === "ns.repo.create";
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol")) return false;
  const actual = (ownKeys as string[]).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function eventEnvelope(value: unknown): value is Event {
  return (
    exactObject(value, ["payload", "ts", "type"]) &&
    typeof value.type === "string" &&
    typeof value.ts === "number" &&
    Number.isFinite(value.ts)
  );
}

function actor(value: unknown): value is NamespaceActor {
  return exactObject(value, ["sub"]) && typeof value.sub === "string" && value.sub.length > 0;
}

export function isNamespaceDispatchEvent(value: Event): boolean {
  if (!isNamespaceEventType(value.type)) return false;
  if (value.type === "ns.repo.create") {
    return (
      exactObject(value.payload, ["v", "name", "project", "visibility"]) &&
      value.payload.v === 1 &&
      typeof value.payload.name === "string" &&
      typeof value.payload.project === "string" &&
      (value.payload.visibility === "public" || value.payload.visibility === "private")
    );
  }
  return (
    exactObject(value.payload, ["v", "name"]) &&
    value.payload.v === 1 &&
    typeof value.payload.name === "string"
  );
}

export function isNamespaceEvent(value: unknown): value is NamespaceEvent {
  if (!eventEnvelope(value) || !isNamespaceEventType(value.type)) return false;
  if (value.type === "ns.repo.create") {
    return (
      exactObject(value.payload, ["v", "name", "project", "visibility", "actor"]) &&
      value.payload.v === 1 &&
      typeof value.payload.name === "string" &&
      typeof value.payload.project === "string" &&
      (value.payload.visibility === "public" || value.payload.visibility === "private") &&
      actor(value.payload.actor)
    );
  }
  return (
    exactObject(value.payload, ["v", "name", "actor"]) &&
    value.payload.v === 1 &&
    typeof value.payload.name === "string" &&
    actor(value.payload.actor)
  );
}

export function stampNamespaceEvent(event: Event, sub: string): NamespaceEvent {
  if (!isNamespaceDispatchEvent(event)) throw new TypeError("namespace schema violation");
  return { ...event, payload: { ...(event.payload as object), actor: { sub } } } as NamespaceEvent;
}
