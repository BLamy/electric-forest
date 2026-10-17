import { afterEach, describe, expect, it, vi } from "vitest";

/** Two tabs of one session: two independent instances of the module (own channel, own memory). */
async function tab(): Promise<typeof import("./live.js")> {
  vi.resetModules();
  return import("./live.js");
}

function jsonResponse(body: unknown, delayMs = 30, status = 200): Promise<Response> {
  return new Promise((resolve) =>
    setTimeout(
      () =>
        resolve(
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
        ),
      delayMs,
    ),
  );
}

const follow = (checkpoint: string): string =>
  `/api/repos/maple/reading-room/pulls?projection=1&reducer=pr-index&live=1&checkpoint=${checkpoint}&waitMs=1500`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("live follow fetch", () => {
  it("passes snapshot reads through untouched and marks follows low priority", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true }, 0);
    });
    const { followFetch, isFollowRequest } = await tab();
    const snapshot = "/api/repos/maple/reading-room/pulls?projection=1&reducer=pr-index";
    expect(isFollowRequest(snapshot)).toBe(false);
    expect(isFollowRequest(follow("0000000000000000_0000000000000001"))).toBe(true);
    await followFetch(snapshot, { credentials: "same-origin" });
    await followFetch(follow("0000000000000000_0000000000000002"), { credentials: "same-origin" });
    expect(calls[0]).toEqual({ url: snapshot, init: { credentials: "same-origin" } });
    expect(calls[1]?.init).toEqual({ credentials: "same-origin", priority: "low" });
  });

  it("answers identical follows from two tabs with one request and the same bytes", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      urls.push(url);
      return jsonResponse({ events: [{ offset: "x" }], checkpoint: "x" });
    });
    const first = await tab();
    const second = await tab();
    const url = follow("0000000000000000_0000000000000003");
    const [a, b] = await Promise.all([first.followFetch(url), second.followFetch(url)]);
    expect(urls).toEqual([url]);
    expect(a.status).toBe(200);
    expect(await a.text()).toBe(await b.text());
  });

  it("never answers a later identical follow from memory (an empty hold is asked again)", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", () => {
      calls += 1;
      return jsonResponse({ events: [], checkpoint: "same" }, 5);
    });
    const only = await tab();
    const url = follow("0000000000000000_0000000000000008");
    await (await only.followFetch(url)).text();
    await (await only.followFetch(url)).text();
    await (await only.followFetch(url)).text();
    expect(calls).toBe(3);
  });

  it("never shares across different checkpoints", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      urls.push(url);
      return jsonResponse({ events: [], checkpoint: url });
    });
    const first = await tab();
    const second = await tab();
    const one = follow("0000000000000000_0000000000000004");
    const two = follow("0000000000000000_0000000000000005");
    const [a, b] = await Promise.all([first.followFetch(one), second.followFetch(two)]);
    expect(urls.sort()).toEqual([one, two].sort());
    expect(((await a.json()) as { checkpoint: string }).checkpoint).toBe(one);
    expect(((await b.json()) as { checkpoint: string }).checkpoint).toBe(two);
  });

  it("falls back to its own request when the fetching tab fails", async () => {
    let attempt = 0;
    vi.stubGlobal("fetch", () => {
      attempt += 1;
      return attempt === 1
        ? new Promise((_, reject) => setTimeout(() => reject(new TypeError("fetch failed")), 30))
        : jsonResponse({ events: [], checkpoint: "y" });
    });
    const first = await tab();
    const second = await tab();
    const url = follow("0000000000000000_0000000000000006");
    const [a, b] = await Promise.allSettled([first.followFetch(url), second.followFetch(url)]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("fulfilled");
    expect(attempt).toBe(2);
  });

  it("an aborted waiter rejects without fetching", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", () => {
      calls += 1;
      return jsonResponse({ events: [], checkpoint: "z" }, 60);
    });
    const first = await tab();
    const second = await tab();
    const url = follow("0000000000000000_0000000000000007");
    const controller = new AbortController();
    const leader = first.followFetch(url);
    const waiter = second.followFetch(url, { signal: controller.signal });
    controller.abort();
    await expect(waiter).rejects.toThrow();
    await leader;
    expect(calls).toBe(1);
  });
});
