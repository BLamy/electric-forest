export interface Event {
  readonly type: string;
  readonly payload: unknown;
  readonly ts: number;
}

export function isEvent(value: unknown): value is Event {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const ownKeys = Reflect.ownKeys(record);
  if (ownKeys.some((key) => typeof key === "symbol")) return false;
  const keys = (ownKeys as string[]).sort();
  return (
    keys.length === 3 &&
    keys[0] === "payload" &&
    keys[1] === "ts" &&
    keys[2] === "type" &&
    typeof record.type === "string" &&
    typeof record.ts === "number" &&
    Number.isFinite(record.ts)
  );
}
