import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, replay, stateDigest, type Event, type Offset } from "@eforest/protocol";
import { fixtureInitialState, fixtureReducer } from "@eforest/protocol/fixtures/reducer";
import { describe, expect, it } from "vitest";
import { createHttpServer } from "./http.js";
import { createDefaultReducerRegistry } from "./redux/reducers.js";
import { ReducerRegistry } from "./redux/registry.js";
import { StateCache } from "./redux/state-cache.js";
import { FileStreamStore } from "./store/file.js";
import { MemoryStreamStore } from "./store/memory.js";

interface TestResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

async function startServer(
  store: MemoryStreamStore | FileStreamStore,
  registry = createDefaultReducerRegistry(),
  cache = new StateCache(),
): Promise<{ server: ReturnType<typeof createHttpServer>; base: string }> {
  const server = createHttpServer(store, { reducerRegistry: registry, stateCache: cache });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: ReturnType<typeof createHttpServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function request(base: string, path: string, init: RequestInit = {}): Promise<TestResponse> {
  const response = await fetch(`${base}${path}`, init);
  return { status: response.status, headers: response.headers, body: await response.text() };
}

function event(type: string, payload: unknown, ts: number): Event {
  return { type, payload, ts };
}

function json<T>(body: string): T {
  return JSON.parse(body) as T;
}

function stateFor(
  records: readonly { offset: Offset; type: string; payload: unknown; ts: number }[],
  offset: Offset,
) {
  const through = records.filter((record) => record.offset <= offset);
  return replay(through, fixtureReducer, fixtureInitialState);
}

describe("server redux read path", () => {
  it("keeps /events, /state, cache paths, and registry versions evidence-backed", async () => {
    const store = new MemoryStreamStore();
    const cache = new StateCache();
    const registry = createDefaultReducerRegistry();
    const { server, base } = await startServer(store, registry, cache);
    try {
      expect(
        (
          await request(base, "/streams/typed", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "fixture" }),
          })
        ).status,
      ).toBe(201);
      const events = [
        event("set", 4, 1),
        event("push", { unicode: "✓", nested: [1, { key: "value" }] }, 2),
        event("increment", 3, 3),
        event("meta", { z: 1, a: "canonical" }, 4),
      ];
      for (const [sequence, action] of events.entries()) {
        expect(
          (
            await request(base, "/streams/typed", {
              method: "POST",
              headers: { "content-type": "application/json", "stream-seq": String(sequence) },
              body: JSON.stringify({ events: [action] }),
            })
          ).status,
        ).toBe(201);
      }

      const raw = await request(base, "/streams/typed?offset=-1");
      const throughEvents = await request(base, "/streams/typed/events?offset=-1");
      expect(throughEvents.status).toBe(200);
      expect(throughEvents.body).toBe(raw.body);
      expect(throughEvents.headers.get("stream-next-offset")).toBe(
        raw.headers.get("stream-next-offset"),
      );

      const records = json<Array<{ offset: Offset; type: string; payload: unknown; ts: number }>>(
        raw.body,
      );
      for (const record of records) {
        const state = await request(
          base,
          `/streams/typed/state?offset=${encodeURIComponent(record.offset)}`,
        );
        expect(state.status).toBe(200);
        expect(state.headers.get("stream-offset")).toBe(record.offset);
        expect(state.body).toBe(canonicalJson(stateFor(records, record.offset)));
      }
      const warm = await request(base, `/streams/typed/state?offset=${records[1]!.offset}`);
      const head = await request(base, "/streams/typed/state");
      const bypass = await request(base, "/streams/typed/state?cache=bypass");
      expect(warm.body).toBe(canonicalJson(stateFor(records, records[1]!.offset)));
      expect(head.headers.get("stream-offset")).toBe(records.at(-1)!.offset);
      expect(bypass.body).toBe(head.body);
      expect(stateDigest(json(head.body))).toBe(stateDigest(json(bypass.body)));
      expect(
        (
          await request(base, "/streams/alternate", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "alternate" }),
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await request(base, "/streams/alternate", {
            method: "POST",
            headers: { "content-type": "application/json", "stream-seq": "0" },
            body: JSON.stringify({ events }),
          })
        ).status,
      ).toBe(201);
      const alternate = await request(base, "/streams/alternate/state");
      expect(alternate.status).toBe(200);
      expect(stateDigest(json(alternate.body))).not.toBe(stateDigest(json(head.body)));
      const stats = cache.stats();
      expect(stats.hits).toBeGreaterThan(0);
      expect(stats.misses).toBeGreaterThan(0);
      expect(stats.bypasses).toBe(1);
      expect(stats.incrementalReplays).toBeGreaterThan(0);

      cache.resetStats();
      expect(
        (
          await request(base, "/streams/typed", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "fixture" }),
          })
        ).status,
      ).toBe(200);
      expect((await request(base, "/streams/typed/state")).status).toBe(200);
      expect(cache.stats()).toMatchObject({ hits: 0, misses: 1 });

      registry.register(
        "fixture",
        (state, current: Event) => ({
          ...fixtureReducer(state, current),
          version: "v2",
        }),
        "fixture-v2",
        fixtureInitialState,
      );
      cache.resetStats();
      const versionBump = await request(base, "/streams/typed/state");
      expect(versionBump.status).toBe(200);
      expect(json<{ version: string }>(versionBump.body).version).toBe("v2");
      expect(cache.stats()).toMatchObject({ hits: 0, misses: 1 });
    } finally {
      await stopServer(server);
    }
  });

  it("keeps registry errors and offset errors neutral", async () => {
    const store = new MemoryStreamStore();
    const cache = new StateCache();
    const { server, base } = await startServer(store, new ReducerRegistry(), cache);
    try {
      await request(base, "/streams/unknown", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "not-registered" }),
      });
      await request(base, "/streams/unknown", {
        method: "POST",
        headers: { "content-type": "application/json", "stream-seq": "0" },
        body: JSON.stringify({ events: [event("set", 1, 1)] }),
      });
      const before = await request(base, "/streams/unknown/dump");
      const beforeStats = cache.stats();
      const unknown = await request(base, "/streams/unknown/state");
      expect(unknown.status).toBe(422);
      expect(json<{ error: string; type: string }>(unknown.body)).toEqual({
        error: "unknown_reducer_type",
        type: "not-registered",
      });
      expect((await request(base, "/streams/unknown/dump")).body).toBe(before.body);
      expect(cache.stats()).toEqual(beforeStats);

      await request(base, "/streams/untyped", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const untyped = await request(base, "/streams/untyped/state");
      expect(untyped.status).toBe(422);
      expect(json<{ error: string; type: null }>(untyped.body)).toEqual({
        error: "unknown_reducer_type",
        type: null,
      });

      for (const suffix of [
        "?offset=",
        "?offset=-2",
        "?offset=9999999999999999_9999999999999999",
      ]) {
        expect((await request(base, `/streams/unknown/state${suffix}`)).status).toBe(400);
      }
      expect((await request(base, "/streams/missing/state")).status).toBe(404);
    } finally {
      await stopServer(server);
    }
  });

  it("persists the stream type across file-store restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "eforest-redux-file-"));
    const store = new FileStreamStore(dataDir);
    const first = await startServer(store);
    let expected: string;
    try {
      await request(first.base, "/streams/persisted", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "fixture" }),
      });
      await request(first.base, "/streams/persisted", {
        method: "POST",
        headers: { "content-type": "application/json", "stream-seq": "0" },
        body: JSON.stringify({ events: [event("set", 7, 1), event("push", "after-restart", 2)] }),
      });
      expected = (await request(first.base, "/streams/persisted/state")).body;
    } finally {
      await stopServer(first.server);
    }

    const second = await startServer(new FileStreamStore(dataDir));
    try {
      const state = await request(second.base, "/streams/persisted/state");
      expect(state.status).toBe(200);
      expect(state.body).toBe(expected);
    } finally {
      await stopServer(second.server);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("returns offset-consistent state across twenty append races", async () => {
    const store = new MemoryStreamStore();
    const { server, base } = await startServer(store);
    try {
      await request(base, "/streams/racing", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "fixture" }),
      });
      for (let sequence = 0; sequence < 20; sequence += 1) {
        const actions = [0, 1].map((writer) => event("increment", writer + 1, sequence));
        const responses = await Promise.all(
          actions.map((action) =>
            request(base, "/streams/racing", {
              method: "POST",
              headers: { "content-type": "application/json", "stream-seq": String(sequence) },
              body: JSON.stringify({ events: [action] }),
            }),
          ),
        );
        expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
        expect(responses.filter((response) => response.status === 409)).toHaveLength(1);
        const dump = json<Array<{ offset: Offset; type: string; payload: unknown; ts: number }>>(
          (await request(base, "/streams/racing/events?offset=-1")).body,
        );
        const state = await request(base, "/streams/racing/state");
        const offset = state.headers.get("stream-offset") as Offset;
        expect(offset).toBe(dump.at(-1)!.offset);
        expect(state.body).toBe(canonicalJson(stateFor(dump, offset)));
      }
    } finally {
      await stopServer(server);
    }
  }, 60_000);
});
