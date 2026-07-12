import { canonicalJson, compareOffsets, type Offset } from "@eforest/protocol";

interface CacheEntry {
  readonly streamId: string;
  readonly reducerVersion: string;
  readonly offset: Offset;
  readonly state: unknown;
}

export interface StateCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly bypasses: number;
  readonly incrementalReplays: number;
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

export class StateCache {
  private readonly entries = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private bypasses = 0;
  private incrementalReplays = 0;

  get(streamId: string, reducerVersion: string, offset: Offset): unknown | undefined {
    const entry = this.entries.get(this.key(streamId, reducerVersion, offset));
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return clone(entry.state);
  }

  nearestAncestor(
    streamId: string,
    reducerVersion: string,
    offset: Offset,
  ): { readonly offset: Offset; readonly state: unknown } | undefined {
    let best: CacheEntry | undefined;
    for (const entry of this.entries.values()) {
      if (
        entry.streamId !== streamId ||
        entry.reducerVersion !== reducerVersion ||
        compareOffsets(entry.offset, offset) >= 0
      )
        continue;
      if (!best || compareOffsets(entry.offset, best.offset) > 0) best = entry;
    }
    return best ? { offset: best.offset, state: clone(best.state) } : undefined;
  }

  put(streamId: string, reducerVersion: string, offset: Offset, state: unknown): void {
    this.entries.set(this.key(streamId, reducerVersion, offset), {
      streamId,
      reducerVersion,
      offset,
      state: clone(state),
    });
  }

  recordBypass(): void {
    this.bypasses += 1;
  }

  recordIncrementalReplay(): void {
    this.incrementalReplays += 1;
  }

  invalidateStream(streamId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.streamId === streamId) this.entries.delete(key);
    }
  }

  stats(): StateCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      bypasses: this.bypasses,
      incrementalReplays: this.incrementalReplays,
    };
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.bypasses = 0;
    this.incrementalReplays = 0;
  }

  private key(streamId: string, reducerVersion: string, offset: Offset): string {
    return `${streamId}\u0000${reducerVersion}\u0000${offset}`;
  }
}
