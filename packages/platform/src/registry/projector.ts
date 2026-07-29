import { isDurableConflict, isDurableExistsConflict, isDurableNotFound } from "@eforest/client";
import { compareOffsets, type Event, type Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { isNamespaceEvent, type NamespaceEvent } from "../ns/events.js";
import type { StreamAdapter } from "../official.js";
import { isRegistryEvent, type RegistryEvent } from "./events.js";

export const REGISTRY_STREAM = "__registry__";

/**
 * Raised when a source log carries a record the projection is not total over
 * — an unrecognized event type on a namespace stream is a LOUD projector
 * error, never a silent drop. Every accepted `ns.*` event projects to exactly
 * one derived event; there is no null/skip return.
 */
export class RegistryProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryProjectionError";
  }
}

function projectionError(message: string): never {
  throw new RegistryProjectionError(message);
}

/**
 * The pure projection: one accepted source event → exactly one derived
 * registry event. A pure function of (event, offset, stream) alone — the
 * derived `ts` is the source event's `ts`, `source` cites the exact namespace
 * record, and nothing else (no clock, no randomness, no projector state)
 * participates.
 */
export function projectSourceEvent(event: Event, offset: Offset, stream: string): RegistryEvent {
  if (!isNamespaceEvent(event)) {
    projectionError(
      `unrecognized source event ${JSON.stringify(event.type)} at ${stream}@${offset}`,
    );
  }
  const source = { stream, offset };
  const namespaceEvent = event as NamespaceEvent;
  if (namespaceEvent.type === "ns.org.create") {
    if (stream !== "ns:root")
      projectionError(`ns.org.create outside ns:root at ${stream}@${offset}`);
    return {
      type: "registry.org-added",
      payload: {
        v: 1,
        org: namespaceEvent.payload.name,
        owner: namespaceEvent.payload.actor.sub,
        source,
      },
      ts: namespaceEvent.ts,
    };
  }
  if (!stream.startsWith("ns:org:")) {
    projectionError(`per-org source event on ${stream}@${offset}`);
  }
  const org = stream.slice("ns:org:".length);
  if (namespaceEvent.type === "ns.project.create") {
    return {
      type: "registry.project-added",
      payload: {
        v: 1,
        org,
        project: namespaceEvent.payload.name,
        owner: namespaceEvent.payload.actor.sub,
        source,
      },
      ts: namespaceEvent.ts,
    };
  }
  if (namespaceEvent.type === "ns.repo.create") {
    return {
      type: "registry.repo-added",
      payload: {
        v: 1,
        org,
        project: namespaceEvent.payload.project,
        repo: namespaceEvent.payload.name,
        visibility: namespaceEvent.payload.visibility,
        owner: namespaceEvent.payload.actor.sub,
        repoStreamPrefix: `fs:${org}/${namespaceEvent.payload.name}`,
        source,
      },
      ts: namespaceEvent.ts,
    };
  }
  if (namespaceEvent.type === "ns.repo.rename") {
    return {
      type: "registry.repo-renamed",
      payload: {
        v: 1,
        org,
        repo: namespaceEvent.payload.name,
        newRepo: namespaceEvent.payload.newName,
        source,
      },
      ts: namespaceEvent.ts,
    };
  }
  return {
    type: "registry.repo-visibility-changed",
    payload: {
      v: 1,
      org,
      repo: namespaceEvent.payload.name,
      visibility: namespaceEvent.payload.visibility,
      source,
    },
    ts: namespaceEvent.ts,
  };
}

interface SourceRecord {
  readonly event: Event;
  readonly offset: Offset;
}

function parseSourceRecord(raw: unknown, stream: string, index: number): SourceRecord {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    projectionError(`${stream} record ${index} is not an object`);
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.offset !== "string" || record.offset.length === 0) {
    projectionError(`${stream} record ${index} has no application offset`);
  }
  return {
    event: { type: record.type, payload: record.payload, ts: record.ts } as Event,
    offset: record.offset as Offset,
  };
}

export interface RegistryProjectorOptions {
  /** Fallback poll interval for cross-process source appends. */
  readonly pollMs?: number;
}

/**
 * The follower half of the projection: tails `ns:root` and every
 * `ns:org:<org>` (per-org streams discovered from projected
 * `registry.org-added` state, bootstrap from `ns:root`), appends derived
 * events to `__registry__` through the server's internal append path, and
 * resumes from the checkpoint READ BACK FROM `__registry__` ITSELF — the last
 * derived event's `source` pointer per source stream. There is no side file,
 * no counter, no map that outlives a process and carries state not
 * recoverable from the streams: every pass rebuilds its checkpoints from the
 * durable `__registry__` log, so a crash and restart at any point never
 * duplicates or drops a derived event (duplicates are additionally fenced by
 * `sequence` on the internal append — two racing projectors cannot land the
 * same ordinal twice).
 */
export class RegistryProjector {
  private readonly streams: StreamAdapter;
  private readonly pollMs: number;
  private running = false;
  private stopped = false;
  private wake: (() => void) | undefined;
  private poked = false;
  private loopDone: Promise<void> = Promise.resolve();

  constructor(streams: StreamAdapter, options: RegistryProjectorOptions = {}) {
    this.streams = streams;
    this.pollMs = options.pollMs ?? 250;
  }

  /**
   * One reconciliation pass over every source stream. Returns the number of
   * derived events appended. A sequence conflict (a concurrent projector won
   * an ordinal) aborts the pass; the caller's loop re-reads and retries.
   */
  async syncOnce(): Promise<number> {
    try {
      return await this.pass();
    } catch (error) {
      if (isDurableConflict(error)) return 0;
      throw error;
    }
  }

  private async pass(): Promise<number> {
    await this.ensureRegistryStream();
    const registryRecords = await this.readOrEmpty(REGISTRY_STREAM);
    const seen = new Set<string>();
    const checkpoints = new Map<string, Offset>();
    for (const [index, raw] of registryRecords.entries()) {
      const record = parseSourceRecord(raw, REGISTRY_STREAM, index);
      if (!isRegistryEvent(record.event)) {
        projectionError(`__registry__ record ${index} is not a registry event`);
      }
      const source = (record.event as RegistryEvent).payload.source;
      seen.add(`${source.stream}\n${source.offset}`);
      const existing = checkpoints.get(source.stream);
      if (existing === undefined || compareOffsets(source.offset, existing) > 0) {
        checkpoints.set(source.stream, source.offset);
      }
    }
    let ordinal = registryRecords.length;
    let appended = 0;
    const projectStream = async (stream: string, rawRecords: readonly unknown[]) => {
      const checkpoint = checkpoints.get(stream);
      for (const [index, raw] of rawRecords.entries()) {
        const record = parseSourceRecord(raw, stream, index);
        if (checkpoint !== undefined && compareOffsets(record.offset, checkpoint) <= 0) continue;
        if (seen.has(`${stream}\n${record.offset}`)) continue;
        const derived = projectSourceEvent(record.event, record.offset, stream);
        const offset = offsetForOrdinal(ordinal);
        const derivedRecord = { ...derived, offset };
        await this.streams.append(REGISTRY_STREAM, derivedRecord, { sequence: offset });
        ordinal += 1;
        appended += 1;
      }
    };
    const rootRecords = await this.readOrEmpty("ns:root");
    await projectStream("ns:root", rootRecords);
    const orgs = rootRecords
      .map((raw, index) => parseSourceRecord(raw, "ns:root", index).event)
      .filter((event) => event.type === "ns.org.create")
      .map((event) => (event.payload as { readonly name: string }).name)
      .sort();
    for (const org of orgs) {
      await projectStream(`ns:org:${org}`, await this.readOrEmpty(`ns:org:${org}`));
    }
    return appended;
  }

  /** Nudge the follower: a namespace dispatch just appended a source event. */
  poke(): void {
    this.poked = true;
    this.wake?.();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.loopDone = this.loop();
  }

  /**
   * Stop the follower and wait for any in-flight sync cycle to settle. The
   * wait is load-bearing for clean shutdown: a source read still in flight
   * when the owner tears down the stream store enters the durable client's
   * unbounded reconnect backoff — a timer chain that keeps the event loop
   * alive forever with no child process and no open socket (run-4 verdict:
   * the refusals harness printed OK, then hung on exactly that residual
   * handle). Owners stop the projector — and await it — BEFORE closing the
   * store.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.loopDone;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      this.poked = false;
      try {
        await this.syncOnce();
      } catch {
        // The store may be briefly unavailable (restart windows). The next
        // cycle re-reads everything from the streams; no state is lost
        // because none is held.
      }
      if (this.stopped) break;
      if (this.poked) continue;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        const timer = setTimeout(resolve, this.pollMs);
        timer.unref?.();
      });
      this.wake = undefined;
    }
    this.running = false;
  }

  private async ensureRegistryStream(): Promise<void> {
    try {
      await this.streams.create(REGISTRY_STREAM);
    } catch (error) {
      if (!isDurableExistsConflict(error)) throw error;
    }
  }

  private async readOrEmpty(streamId: string): Promise<readonly unknown[]> {
    try {
      return await this.streams.read(streamId);
    } catch (error) {
      if (isDurableNotFound(error)) return [];
      throw error;
    }
  }
}
