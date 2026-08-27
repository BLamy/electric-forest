export const ENTITY_KINDS = ["issue"] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

export interface EntityRef {
  readonly entity: "issue";
  readonly stream: string;
}

export class EntityRefError extends TypeError {
  constructor(readonly value: unknown) {
    super("invalid entity reference");
    this.name = "EntityRefError";
  }
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key === "symbol")) return false;
  const sorted = (actual as string[]).sort();
  const expected = [...keys].sort();
  return sorted.length === expected.length && sorted.every((key, index) => key === expected[index]);
}

export function isEntityRef(value: unknown): value is EntityRef {
  return (
    exactObject(value, ["entity", "stream"]) &&
    value.entity === "issue" &&
    typeof value.stream === "string" &&
    value.stream.length > 0
  );
}

export function parseEntityRef(value: unknown): EntityRef {
  if (!isEntityRef(value)) throw new EntityRefError(value);
  return { entity: value.entity, stream: value.stream };
}

export function sameEntityRef(left: EntityRef, right: EntityRef): boolean {
  return left.entity === right.entity && left.stream === right.stream;
}

/** Stable first-occurrence collapse; entity stream ids remain opaque. */
export function uniqueEntityRefs(refs: readonly EntityRef[]): readonly EntityRef[] {
  const seen = new Set<string>();
  const result: EntityRef[] = [];
  for (const ref of refs) {
    const key = `${ref.entity}\u0000${ref.stream}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}
