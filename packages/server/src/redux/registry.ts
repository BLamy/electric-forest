import type { Event } from "@eforest/protocol";

export type Reducer<S = unknown> = (state: S, event: Event) => S;

export interface ReducerBinding {
  readonly type: string;
  readonly version: string;
  readonly reducer: Reducer<unknown>;
  readonly initialState: unknown;
}

export class UnknownReducerTypeError extends Error {
  readonly type: string | null;

  constructor(type: string | null) {
    super(`no reducer is registered for stream type ${type ?? "<untyped>"}`);
    this.name = "UnknownReducerTypeError";
    this.type = type;
  }
}

export class ReducerRegistry {
  private readonly bindings = new Map<string, ReducerBinding>();

  register<S>(type: string, reducer: Reducer<S>, version: string, initialState?: S): this {
    if (type.length === 0) throw new TypeError("reducer type must not be empty");
    if (version.length === 0) throw new TypeError("reducer version must not be empty");
    this.bindings.set(type, {
      type,
      version,
      reducer: reducer as Reducer<unknown>,
      initialState: initialState === undefined ? {} : initialState,
    });
    return this;
  }

  get(type: unknown): ReducerBinding | undefined {
    return typeof type === "string" ? this.bindings.get(type) : undefined;
  }

  require(type: unknown): ReducerBinding {
    const binding = this.get(type);
    if (!binding) throw new UnknownReducerTypeError(typeof type === "string" ? type : null);
    return binding;
  }
}
