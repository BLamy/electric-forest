/**
 * Long-poll hold for every live projection in the web app.
 *
 * Browsers open at most six HTTP/1.1 connections per host per browsing context, shared by
 * every tab. A projection holds one for up to this long while it waits for the next event
 * (an event ends the wait immediately). With multi-second holds a page that follows more
 * than six streams — a pull request's Changes tab follows eleven — or two tabs of one
 * session queue their dispatches and other projections behind held sockets. A short hold
 * keeps every socket turning over within this bound; at ~40 follows/minute per projection it
 * stays inside the platform's 1000/minute follow budget for a heavily open session.
 */
export const FOLLOW_WAIT_MS = 1_500;

/** True for a checkpointed long-poll follow (`live=1`), as built by `projectionUrl`. */
export function isFollowRequest(input: RequestInfo | URL): boolean {
  return /[?&]live=1(?:&|$)/.test(requestHref(input));
}

function requestHref(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** A follow response one tab fetched, as every other tab of the session may reuse it. */
interface SharedFollowResult {
  readonly key: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

const SHARE_WINDOW_MS = 2_000;
const heard = new Map<string, { readonly result: SharedFollowResult; readonly at: number }>();
const waiters = new Map<string, Set<(result: SharedFollowResult) => void>>();
const channel =
  typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel("ef-live-follow");

function remember(result: SharedFollowResult): void {
  const now = Date.now();
  for (const [key, entry] of heard) if (now - entry.at > SHARE_WINDOW_MS) heard.delete(key);
  heard.set(result.key, { result, at: now });
  for (const resolve of waiters.get(result.key) ?? []) resolve(result);
  waiters.delete(result.key);
}

channel?.addEventListener("message", (event: MessageEvent<SharedFollowResult>) => {
  const data = event.data;
  if (
    typeof data?.key === "string" &&
    typeof data.status === "number" &&
    typeof data.contentType === "string" &&
    typeof data.body === "string"
  ) {
    remember(data);
  }
});

/**
 * A result for `key` that arrived at or after `since` — i.e. while the asking request was
 * already waiting. An older result is never reused: after an empty long-poll a tab asks the
 * same URL again, and answering it from memory would spin without ever reaching the network.
 */
function heardSince(key: string, since: number): SharedFollowResult | undefined {
  const entry = heard.get(key);
  return entry !== undefined && entry.at >= since && Date.now() - entry.at <= SHARE_WINDOW_MS
    ? entry.result
    : undefined;
}

function toResponse(result: SharedFollowResult): Response {
  return new Response(result.body, {
    status: result.status,
    headers: { "content-type": result.contentType },
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The follow was aborted.", "AbortError");
}

/** How long a tab granted the lock after waiting gives the fetcher's broadcast to arrive. */
const BROADCAST_GRACE_MS = 100;

/**
 * One follow request on the wire per identical follow URL across every tab of the session.
 *
 * Every tab of a session follows the same frame streams (registry, workspace chat catalog)
 * and often the same page streams (a branch catalog, a tree) — each a held request against
 * the six-socket budget. Two follows with the same URL (same stream, reducer, checkpoint and
 * hold) are answered by the same bytes: the events after that checkpoint. So the first tab
 * to ask takes a Web Lock named for the URL and fetches at once; a tab that finds the lock
 * held waits for it without a socket, and the fetcher broadcasts the response before
 * releasing it. A waiter that hears the broadcast returns those bytes; one that does not
 * (the fetcher failed or was aborted) fetches for itself once the lock is free. Nothing is
 * skipped: the reducer still validates every batch's offsets against its own checkpoint.
 */
async function sharedFollow(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<Response> {
  const key = requestHref(input);
  const lockName = `ef-live-follow:${key}`;
  const startedAt = Date.now();
  const fetchAndShare = async (): Promise<Response> => {
    const response = await fetch(input, { ...init, priority: "low" });
    const result: SharedFollowResult = {
      key,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/json",
      body: await response.text(),
    };
    remember(result);
    channel?.postMessage(result);
    return toResponse(result);
  };
  // Nobody is fetching this follow: fetch it now, holding the lock for the other tabs.
  const led = await navigator.locks.request(lockName, { ifAvailable: true }, (lock) =>
    lock === null ? undefined : fetchAndShare(),
  );
  if (led !== undefined) return led;

  // Another tab is fetching it: wait for its broadcast, or for the lock if it fails.
  const signal = init?.signal ?? undefined;
  const stopWaiting = new AbortController();
  const heardFirst = new Promise<SharedFollowResult>((resolve) => {
    const set = waiters.get(key) ?? new Set();
    set.add(resolve);
    waiters.set(key, set);
    stopWaiting.signal.addEventListener("abort", () => set.delete(resolve), { once: true });
  });
  // The caller's abort also cancels the pending lock request. (Built by hand: the Replay
  // Chromium the browser evidence runs in predates AbortSignal.any.)
  if (signal !== undefined) {
    if (signal.aborted) stopWaiting.abort();
    else signal.addEventListener("abort", () => stopWaiting.abort(), { once: true });
  }
  const viaLock = navigator.locks.request(
    lockName,
    { signal: stopWaiting.signal },
    async (): Promise<Response> => {
      // The fetcher posts before it releases, but the grant can outrun the message.
      const shared =
        heardSince(key, startedAt) ??
        (await Promise.race([
          heardFirst,
          new Promise<undefined>((resolve) => setTimeout(resolve, BROADCAST_GRACE_MS)),
        ]));
      return shared === undefined ? fetchAndShare() : toResponse(shared);
    },
  );
  try {
    return await Promise.race([
      viaLock,
      heardFirst.then((result) => {
        if (signal?.aborted === true) throw abortReason(signal);
        return toResponse(result);
      }),
    ]);
  } finally {
    stopWaiting.abort();
    // A lock request cancelled after the race was decided rejects with AbortError.
    viaLock.catch(() => undefined);
  }
}

/**
 * The fetch every live projection uses. A follow is issued at `low` fetch priority: when
 * every socket to the host is taken, the browser hands the next free one to a snapshot read
 * or a dispatch (default priority) before another follow. Identical follows across the
 * session's tabs share one request (see `sharedFollow`). Bootstrap snapshots and every
 * non-follow request pass through untouched.
 */
export const followFetch: typeof fetch = (input, init) => {
  if (!isFollowRequest(input)) return fetch(input, init);
  if (typeof navigator === "undefined" || !("locks" in navigator) || channel === undefined)
    return fetch(input, { ...init, priority: "low" });
  return sharedFollow(input, init);
};

/** Spread into every following `useStreamReducer` call: the bounded hold + shared follows. */
export const LIVE_FOLLOW = { followWaitMs: FOLLOW_WAIT_MS, fetch: followFetch } as const;
