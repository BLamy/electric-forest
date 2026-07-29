import { isDurableNotFound } from "@eforest/client";
import type { AuthorizationView } from "@eforest/identity";
import { canonicalJson, compareOffsets, type Event, type Offset } from "@eforest/protocol";
import type { StreamAdapter } from "../official.js";
import { isRegistryEvent, type RegistryEvent } from "./events.js";
import { filterForIdentity, registryEntries, restrictToOwnRelations } from "./filter.js";
import { REGISTRY_STREAM } from "./projector.js";
import { registryInitialState, registryReducer, type RegistryState } from "./reducer.js";

/**
 * E2-T08: the three registry read doors' shared machinery — snapshot,
 * long-poll, and SSE over `__registry__`, every answer filtered per
 * requesting identity through the single `filterForIdentity`.
 *
 * Frozen offset semantics: `asOf`, live-frame ids, and the `after` resume
 * cursor are raw `__registry__` offsets. The head offset advances on every
 * derived event, including events the requesting identity may not see, so
 * `asOf` jumps and offset gaps between visible frames are contract-conformant
 * — offset metadata reveals at most hidden event COUNTS, never entry
 * contents, and resume-by-offset stays one plain raw-offset cursor identical
 * for every identity. The visibility filter governs entry contents and frame
 * payloads only.
 */

export interface RegistryScope {
  /** Restrict listings/frames to one org (`/registry/org/:org`). */
  readonly org?: string;
  /** `/registry/me`: restrict to owned/member-org relations of this subject. */
  readonly restrictOwn?: string;
}

export interface RegistryRecord extends Event {
  readonly offset: Offset;
}

export class RegistryStreamCorruptError extends Error {
  constructor(detail: string) {
    super(`__registry__ stream corrupt: ${detail}`);
    this.name = "RegistryStreamCorruptError";
  }
}

export function parseRegistryRecord(raw: unknown, index: number): RegistryRecord {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RegistryStreamCorruptError(`record ${String(index)} is not an object`);
  }
  const record = raw as Record<string, unknown>;
  const event = { type: record.type, payload: record.payload, ts: record.ts };
  if (typeof record.offset !== "string" || record.offset.length === 0 || !isRegistryEvent(event)) {
    throw new RegistryStreamCorruptError(`record ${String(index)} is not a derived registry event`);
  }
  return { ...event, offset: record.offset as Offset } as RegistryRecord;
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function scopedFilter(
  state: RegistryState,
  authView: AuthorizationView,
  subject: string | null,
  scope: RegistryScope,
): RegistryState {
  let filtered = filterForIdentity(state, authView, subject);
  if (scope.restrictOwn !== undefined) {
    filtered = restrictToOwnRelations(filtered, authView, scope.restrictOwn);
  }
  if (scope.org !== undefined) {
    const org = own(filtered.orgs, scope.org);
    filtered = org === undefined ? { orgs: {} } : { orgs: { [scope.org]: org } };
  }
  return filtered;
}

/**
 * A live frame's visibility judged against the entry's POST-event state:
 * apply the derived event, filter the resulting state for the identity, and
 * the frame is visible iff the affected entity exists in the filtered view.
 * Visibility-loss transitions are therefore suppression by construction —
 * a flip that makes an entry invisible to this identity produces exactly
 * zero frames for it (no removal/tombstone frame in v1).
 */
export function frameVisible(
  record: RegistryRecord,
  postState: RegistryState,
  authView: AuthorizationView,
  subject: string | null,
  scope: RegistryScope,
): boolean {
  const event = record as unknown as RegistryEvent;
  const payload = event.payload;
  if (scope.org !== undefined && payload.org !== scope.org) return false;
  const filtered = scopedFilter(postState, authView, subject, scope);
  const org = own(filtered.orgs, payload.org);
  if (org === undefined) return false;
  switch (event.type) {
    case "registry.org-added":
      return true;
    case "registry.project-added":
      return own(org.projects, event.payload.project) !== undefined;
    case "registry.repo-added":
      return own(org.repos, event.payload.repo) !== undefined;
    case "registry.repo-renamed":
      return own(org.repos, event.payload.newRepo) !== undefined;
    case "registry.repo-visibility-changed":
      return own(org.repos, event.payload.repo) !== undefined;
  }
}

function canonicalResponse(status: number, body: unknown): Response {
  return new Response(canonicalJson(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readOrEmpty(streams: StreamAdapter, streamId: string): Promise<readonly unknown[]> {
  try {
    return await streams.read(streamId);
  } catch (error) {
    if (isDurableNotFound(error)) return [];
    throw error;
  }
}

function frameBody(record: RegistryRecord): Record<string, unknown> {
  return { offset: record.offset, payload: record.payload, ts: record.ts, type: record.type };
}

/** `{ asOf, entries }` — canonical JSON, entries sorted by (org, repo). */
export async function registrySnapshotResponse(
  streams: StreamAdapter,
  authView: AuthorizationView,
  subject: string | null,
  scope: RegistryScope,
): Promise<Response> {
  const raw = await readOrEmpty(streams, REGISTRY_STREAM);
  const records = raw.map((item, index) => parseRegistryRecord(item, index));
  let state = registryInitialState;
  for (const record of records) {
    state = registryReducer(state, record);
  }
  const filtered = scopedFilter(state, authView, subject, scope);
  return canonicalResponse(200, {
    asOf: records.length === 0 ? "-1" : records.at(-1)!.offset,
    entries: registryEntries(filtered),
  });
}

function past(offset: Offset, after: Offset | "-1"): boolean {
  return after === "-1" || compareOffsets(offset, after) > 0;
}

/**
 * Long-poll: all currently visible frames past `after`, or wait up to
 * `waitMs` for the first visible new frame. The returned `after` cursor is
 * the raw head offset processed — it advances over hidden events too.
 */
export async function registryLongPollResponse(
  streams: StreamAdapter,
  authView: AuthorizationView,
  subject: string | null,
  scope: RegistryScope,
  after: Offset | "-1",
  waitMs: number,
): Promise<Response> {
  const raw = await readOrEmpty(streams, REGISTRY_STREAM);
  let state = registryInitialState;
  let cursor: Offset | "-1" = after;
  const frames: Record<string, unknown>[] = [];
  for (const [index, item] of raw.entries()) {
    const record = parseRegistryRecord(item, index);
    state = registryReducer(state, record);
    if (!past(record.offset, after)) continue;
    cursor = record.offset;
    if (frameVisible(record, state, authView, subject, scope)) frames.push(frameBody(record));
  }
  if (frames.length > 0 || waitMs === 0) {
    return canonicalResponse(200, { after: cursor, frames });
  }
  const signal = AbortSignal.timeout(waitMs);
  try {
    let followState = registryInitialState;
    let index = 0;
    for await (const item of streams.follow(REGISTRY_STREAM, signal)) {
      const record = parseRegistryRecord(item, index);
      index += 1;
      followState = registryReducer(followState, record);
      if (!past(record.offset, cursor)) continue;
      cursor = record.offset;
      if (frameVisible(record, followState, authView, subject, scope)) {
        frames.push(frameBody(record));
        break;
      }
    }
  } catch (error) {
    if (
      !isDurableNotFound(error) &&
      !(error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
    ) {
      throw error;
    }
  }
  return canonicalResponse(200, { after: cursor, frames });
}

/**
 * SSE per E0-T06 semantics: `text/event-stream`, each data frame's `id:`
 * carrying its `__registry__` offset (the resume cursor), keep-alive comment
 * heartbeats while quiescent, and only frames the requesting identity may
 * see ever written — hidden events advance the internal cursor silently.
 */
export function registrySseResponse(
  streams: StreamAdapter,
  authView: AuthorizationView,
  subject: string | null,
  scope: RegistryScope,
  after: Offset | "-1",
  heartbeatMs = 1000,
): Response {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string): void => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          abort.abort();
        }
      };
      heartbeat = setInterval(() => {
        send(": keep-alive\n\n");
      }, heartbeatMs);
      heartbeat.unref?.();
      const run = async (): Promise<void> => {
        while (!abort.signal.aborted) {
          let state = registryInitialState;
          let cursor: Offset | "-1" = after;
          let index = 0;
          try {
            for await (const item of streams.follow(REGISTRY_STREAM, abort.signal)) {
              const record = parseRegistryRecord(item, index);
              index += 1;
              state = registryReducer(state, record);
              if (!past(record.offset, cursor)) continue;
              cursor = record.offset;
              if (frameVisible(record, state, authView, subject, scope)) {
                send(`id: ${record.offset}\ndata: ${canonicalJson(frameBody(record))}\n\n`);
              }
            }
          } catch (error) {
            if (isDurableNotFound(error)) {
              // The projector mints __registry__ on startup; wait for it.
              await new Promise((resolve) => setTimeout(resolve, 100));
              continue;
            }
            if (!(
              error instanceof Error &&
              (error.name === "AbortError" || error.name === "TimeoutError")
            )) {
              abort.abort();
              throw error;
            }
          }
          break;
        }
      };
      void run()
        .catch(() => undefined)
        .finally(() => {
          if (heartbeat !== undefined) clearInterval(heartbeat);
          try {
            controller.close();
          } catch {
            // already errored/cancelled
          }
        });
    },
    cancel() {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      abort.abort();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
