import { isEvent, type Event } from "@eforest/protocol";
import {
  ensureWikiBranch,
  wikiBranchStreamId,
  type EnsureWikiBranchResult,
  type WikiDispatchDoor,
} from "@eforest/meadow";
import { postDispatch } from "@eforest/web-hooks";

function eventsPath(org: string, repo: string): string {
  return `/api/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/wiki/events`;
}

function cleanEvents(value: unknown): readonly Event[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("wiki branch inspection response must be an object");
  }
  const events = (value as { readonly events?: unknown }).events;
  if (!Array.isArray(events)) throw new TypeError("wiki branch inspection omitted events");
  return events.map((candidate) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new TypeError("wiki branch inspection returned a malformed event");
    }
    const record = candidate as Readonly<Record<string, unknown>>;
    const event = { type: record.type, payload: record.payload, ts: record.ts };
    if (!isEvent(event)) throw new TypeError("wiki branch inspection returned a malformed event");
    return event;
  });
}

/** Bind Meadow's provisioner to the production session read and dispatch doors. */
export function browserWikiDispatchDoor(
  org: string,
  repo: string,
  fetcher: typeof fetch = fetch,
): WikiDispatchDoor {
  const expectedStreamId = wikiBranchStreamId(org, repo);
  return {
    inspect: async (streamId) => {
      if (streamId !== expectedStreamId) throw new TypeError("wiki inspection stream mismatch");
      const response = await fetcher(eventsPath(org, repo), {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`wiki branch inspection failed with ${String(response.status)}`);
      }
      const events = cleanEvents(await response.json());
      // A valid wiki stream always starts with genesis. The existing read door
      // intentionally projects a missing stream as an empty event list.
      return { events: events.length === 0 ? undefined : events };
    },
    dispatch: (streamId, event) => postDispatch(streamId, event, { fetch: fetcher }),
  };
}

export function ensureWikiBranchThroughBrowser(
  org: string,
  repo: string,
  fetcher: typeof fetch = fetch,
): Promise<EnsureWikiBranchResult> {
  return ensureWikiBranch(org, repo, browserWikiDispatchDoor(org, repo, fetcher));
}

const productionProvisioning = new Map<string, Promise<EnsureWikiBranchResult>>();

/** One successful provision promise per browser realm; failures remain retryable. */
export function ensureProductionWikiBranch(
  org: string,
  repo: string,
): Promise<EnsureWikiBranchResult> {
  const streamId = wikiBranchStreamId(org, repo);
  const current = productionProvisioning.get(streamId);
  if (current !== undefined) return current;
  const pending = ensureWikiBranchThroughBrowser(org, repo);
  productionProvisioning.set(streamId, pending);
  void pending.catch(() => {
    if (productionProvisioning.get(streamId) === pending) productionProvisioning.delete(streamId);
  });
  return pending;
}
