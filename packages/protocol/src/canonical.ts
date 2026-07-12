export class CanonicalJsonError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

function encode(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError("numbers must be finite");
      return Object.is(value, -0) ? "0" : value.toString();
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      throw new CanonicalJsonError(`unsupported value type: ${typeof value}`);
    case "object": {
      if (ancestors.has(value)) throw new CanonicalJsonError("circular reference");
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${Array.from({ length: value.length }, (_, index) =>
            encode(value[index], ancestors),
          ).join(",")}]`;
        }
        const ownKeys = Reflect.ownKeys(value);
        if (ownKeys.some((key) => typeof key === "symbol")) {
          throw new CanonicalJsonError("symbol object keys are unsupported");
        }
        const keys = Object.keys(value).sort();
        return `{${keys
          .map(
            (key) =>
              `${JSON.stringify(key)}:${encode((value as Record<string, unknown>)[key], ancestors)}`,
          )
          .join(",")}}`;
      } finally {
        ancestors.delete(value);
      }
    }
  }
  throw new CanonicalJsonError("unsupported value");
}

export function canonicalJson(value: unknown): string {
  return encode(value, new Set());
}
