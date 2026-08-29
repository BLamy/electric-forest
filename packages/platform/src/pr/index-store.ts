import { isDurableConflict, isDurableExistsConflict, isDurableNotFound } from "@eforest/client";
import {
  derivePrIndex,
  parsePrStreamId,
  prIndexInitialState,
  prIndexReducer,
  prIndexReplacementEvent,
  repoPrIndexStreamId,
  type PrIndexInput,
  type PrIndexState,
} from "@eforest/pr";
import { canonicalJson, OFFSET_BEFORE_FIRST, type Event, type Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import type { StreamAdapter } from "../official.js";

const PR_CATALOG_EVENT = "pr-catalog.registered";

interface PrCatalogRecord {
  readonly prStream: string;
  readonly sourceOffset: Offset;
}

interface IndexedEvent extends Event {
  readonly offset: Offset;
}

function repoPrCatalogStreamId(org: string, repo: string): string {
  return `pr-catalog:${org}/${repo}`;
}

function indexedEvent(value: unknown, ordinal: number): IndexedEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("pr-index/corrupt-record");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string" || typeof record.ts !== "number") {
    throw new TypeError("pr-index/corrupt-record");
  }
  return {
    type: record.type,
    payload: record.payload,
    ts: record.ts,
    offset:
      typeof record.offset === "string" ? (record.offset as Offset) : offsetForOrdinal(ordinal),
  };
}

function catalog(records: readonly unknown[]): readonly PrCatalogRecord[] {
  const result = new Map<string, Offset>();
  for (const [ordinal, value] of records.entries()) {
    const event = indexedEvent(value, ordinal);
    if (
      event.type !== PR_CATALOG_EVENT ||
      event.payload === null ||
      typeof event.payload !== "object" ||
      Array.isArray(event.payload)
    ) {
      throw new TypeError("pr-index/corrupt-catalog");
    }
    const payload = event.payload as Record<string, unknown>;
    if (
      payload.v !== 1 ||
      typeof payload.prStream !== "string" ||
      typeof payload.sourceOffset !== "string"
    ) {
      throw new TypeError("pr-index/corrupt-catalog");
    }
    const existing = result.get(payload.prStream);
    if (existing !== undefined && existing !== payload.sourceOffset) {
      throw new TypeError("pr-index/conflicting-source");
    }
    result.set(payload.prStream, payload.sourceOffset as Offset);
  }
  return [...result].map(([prStream, sourceOffset]) => ({ prStream, sourceOffset }));
}

export class PrIndexMaterializer {
  private serial: Promise<unknown> = Promise.resolve();

  constructor(private readonly streams: StreamAdapter) {}

  async applyCommittedPr(prStream: string): Promise<PrIndexState> {
    const run = this.serial.then(() => this.applyCommittedPrNow(prStream));
    this.serial = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async materialize(org: string, repo: string): Promise<PrIndexState> {
    const run = this.serial.then(() => this.materializeNow(org, repo));
    this.serial = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async applyCommittedPrNow(prStream: string): Promise<PrIndexState> {
    const identity = parsePrStreamId(prStream);
    if (identity === undefined) throw new TypeError("pr-index/cross-repo-source");
    const source = await this.readOptional(prStream);
    if (source.length === 0) throw new TypeError("pr-index/source-empty");
    const openedOffset = indexedEvent(source[0], 0).offset;
    await this.register(identity.org, identity.repo, prStream, openedOffset);
    return this.materializeNow(identity.org, identity.repo);
  }

  private async materializeNow(org: string, repo: string): Promise<PrIndexState> {
    const catalogStream = repoPrCatalogStreamId(org, repo);
    const indexStream = repoPrIndexStreamId(org, repo);
    await this.ensureStream(catalogStream);
    await this.ensureStream(indexStream);
    const registrations = catalog(await this.readOptional(catalogStream));
    const logs: PrIndexInput[] = [];
    for (const registration of registrations) {
      const identity = parsePrStreamId(registration.prStream);
      if (identity?.org !== org || identity.repo !== repo) {
        throw new TypeError("pr-index/cross-repo-source");
      }
      const records = await this.readOptional(registration.prStream);
      if (records.length === 0) continue;
      const first = indexedEvent(records[0], 0);
      if (first.offset !== registration.sourceOffset || first.type !== "pr.opened") {
        throw new TypeError("pr-index/source-offset-mismatch");
      }
      logs.push({
        prStream: registration.prStream,
        events: records.map((value, ordinal) => indexedEvent(value, ordinal)),
      });
    }
    const next = derivePrIndex(logs);
    const projection = (await this.readOptional(indexStream)).map(indexedEvent);
    const current = projection.reduce(prIndexReducer, prIndexInitialState);
    if (canonicalJson(current) === canonicalJson(next)) return next;

    let stalled = 0;
    let priorLength = projection.length;
    for (;;) {
      const records = await this.readOptional(indexStream);
      const observed = records.map(indexedEvent).reduce(prIndexReducer, prIndexInitialState);
      if (canonicalJson(observed) === canonicalJson(next)) return next;
      const offset = offsetForOrdinal(records.length);
      try {
        await this.streams.append(indexStream, prIndexReplacementEvent(next), {
          sequence: offset,
          applicationOffset: offset,
        });
        return next;
      } catch (error) {
        if (!isDurableConflict(error)) throw error;
        stalled = records.length > priorLength ? 0 : stalled + 1;
        if (stalled >= 8) throw new Error("pr-index/contention", { cause: error });
        priorLength = records.length;
      }
    }
  }

  private async register(
    org: string,
    repo: string,
    prStream: string,
    sourceOffset: Offset,
  ): Promise<void> {
    const streamId = repoPrCatalogStreamId(org, repo);
    await this.ensureStream(streamId);
    let stalled = 0;
    let priorLength = -1;
    for (;;) {
      const records = await this.readOptional(streamId);
      const existing = catalog(records).find((entry) => entry.prStream === prStream);
      if (existing !== undefined) {
        if (existing.sourceOffset !== sourceOffset)
          throw new TypeError("pr-index/conflicting-source");
        return;
      }
      const offset = offsetForOrdinal(records.length);
      const event: Event = {
        type: PR_CATALOG_EVENT,
        payload: { v: 1, prStream, sourceOffset },
        ts: Date.now(),
      };
      try {
        await this.streams.append(streamId, event, {
          sequence: offset,
          applicationOffset: offset,
        });
        return;
      } catch (error) {
        if (!isDurableConflict(error)) throw error;
        stalled = records.length > priorLength ? 0 : stalled + 1;
        if (stalled >= 8) throw new Error("pr-index/catalog-contention", { cause: error });
        priorLength = records.length;
      }
    }
  }

  private async ensureStream(streamId: string): Promise<void> {
    if ((await this.streams.exists?.(streamId)) === true) return;
    try {
      await this.streams.create(streamId);
    } catch (error) {
      if (!isDurableExistsConflict(error)) throw error;
    }
  }

  private async readOptional(streamId: string): Promise<readonly unknown[]> {
    try {
      return await (this.streams.readResolved?.(streamId) ?? this.streams.read(streamId));
    } catch (error) {
      if (isDurableNotFound(error)) return [];
      throw error;
    }
  }
}
