import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson, replay, type Event } from "@eforest/protocol";
import {
  fixtureInitialState,
  fixtureReducer,
  type FixtureState,
} from "@eforest/protocol/fixtures/reducer";
import { describe, expect, it } from "vitest";
import { appendInvocationStats, resetAppendInvocationStats } from "./append-door.js";
import { createHttpServer } from "./http.js";
import { createDefaultReducerRegistry } from "./redux/reducers.js";
import { StateCache } from "./redux/state-cache.js";
import { createDefaultActionValidatorRegistry } from "./validation.js";
import { MemoryStreamStore } from "./store/memory.js";

interface TestResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

interface StartedServer {
  readonly server: ReturnType<typeof createHttpServer>;
  readonly base: string;
  readonly cache: StateCache;
}

function json<T>(body: string): T {
  return JSON.parse(body) as T;
}

async function request(
  base: string,
  path: string,
  init: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  } = {},
): Promise<TestResponse> {
  const response = await fetch(`${base}${path}`, init);
  return { status: response.status, headers: response.headers, body: await response.text() };
}

async function startServer(): Promise<StartedServer> {
  const cache = new StateCache();
  const server = createHttpServer(new MemoryStreamStore(), {
    reducerRegistry: createDefaultReducerRegistry(),
    stateCache: cache,
    actionValidators: createDefaultActionValidatorRegistry(),
  });
  await new Promise<void>((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveStart);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
  return { server, base: `http://127.0.0.1:${address.port}`, cache };
}

async function stopServer(server: ReturnType<typeof createHttpServer>): Promise<void> {
  await new Promise<void>((resolveStop, reject) => {
    server.close((error) => (error ? reject(error) : resolveStop()));
  });
}

async function createStream(base: string, streamId: string, type: string): Promise<void> {
  const response = await request(base, `/streams/${streamId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type }),
  });
  expect(response.status).toBe(201);
}

async function dispatch(base: string, streamId: string, body: string): Promise<TestResponse> {
  return request(base, `/streams/${streamId}/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function logDigest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

async function capture(
  base: string,
  streamId: string,
): Promise<{
  readonly head: string;
  readonly digest: string;
  readonly body: string;
}> {
  const dump = await request(base, `/streams/${streamId}/dump`);
  expect(dump.status).toBe(200);
  return {
    head: dump.headers.get("stream-next-offset") ?? "<missing>",
    digest: logDigest(dump.body),
    body: dump.body,
  };
}

const evidenceDir = resolve(
  process.cwd(),
  ".eforest/tasks/epic-0-the-seed/E0-T11-validated-dispatch/evidence",
);

describe("validated dispatch door", () => {
  it("refuses each taxonomy class without changing head or dump digest", async () => {
    resetAppendInvocationStats();
    const { server, base } = await startServer();
    const evidence: string[] = ["class status head-before head-after digest-before digest-after"];
    try {
      await createStream(base, "neutral-fixture", "fixture");
      await createStream(base, "neutral-counter", "counter");
      expect(
        (
          await dispatch(
            base,
            "neutral-counter",
            JSON.stringify({ type: "counter/increment", payload: 1, ts: 1 }),
          )
        ).status,
      ).toBe(201);

      const cases: ReadonlyArray<{
        readonly name: string;
        readonly streamId: string;
        readonly body: string;
        readonly expectedStatus: number;
        readonly expectedClass: string;
      }> = [
        {
          name: "malformed-body",
          streamId: "neutral-fixture",
          body: "{",
          expectedStatus: 400,
          expectedClass: "malformed-body",
        },
        {
          name: "schema-violation",
          streamId: "neutral-fixture",
          body: JSON.stringify({ type: "set", ts: 2 }),
          expectedStatus: 422,
          expectedClass: "schema-violation",
        },
        {
          name: "unknown-action-type",
          streamId: "neutral-fixture",
          body: JSON.stringify({ type: "not-registered", payload: true, ts: 3 }),
          expectedStatus: 404,
          expectedClass: "unknown-action-type",
        },
        {
          name: "validator-rejected",
          streamId: "neutral-counter",
          body: JSON.stringify({ type: "counter/decrement", payload: 2, ts: 4 }),
          expectedStatus: 409,
          expectedClass: "validator-rejected",
        },
      ];

      for (const testCase of cases) {
        const before = await capture(base, testCase.streamId);
        const refused = await dispatch(base, testCase.streamId, testCase.body);
        const after = await capture(base, testCase.streamId);
        expect(refused.status, testCase.name).toBe(testCase.expectedStatus);
        const body = json<{ error: { class: string; reason: string } }>(refused.body);
        expect(body.error.class, testCase.name).toBe(testCase.expectedClass);
        expect(body.error.reason.length, testCase.name).toBeGreaterThan(0);
        expect(after.head, testCase.name).toBe(before.head);
        expect(after.digest, testCase.name).toBe(before.digest);
        expect(after.body, testCase.name).toBe(before.body);
        evidence.push(
          [
            testCase.name,
            String(refused.status),
            before.head,
            after.head,
            before.digest,
            after.digest,
          ].join(" "),
        );
      }

      const missing = await dispatch(
        base,
        "missing-dispatch-stream",
        JSON.stringify({ type: "set", payload: 1, ts: 5 }),
      );
      expect(missing.status).toBe(404);
      const missingBody = json<{ error: string; message: string }>(missing.body);
      expect(missingBody.error).toBe("stream_not_found");
      expect(missing.body).not.toContain('"class"');

      await createStream(base, "untyped-dispatch-stream", "not-registered");
      const noReducer = await dispatch(
        base,
        "untyped-dispatch-stream",
        JSON.stringify({ type: "set", payload: 1, ts: 6 }),
      );
      expect(noReducer.status).toBe(404);
      expect(json<{ error: { class: string } }>(noReducer.body).error.class).toBe(
        "unknown-action-type",
      );
      expect(appendInvocationStats()).toMatchObject({ raw: 0, dispatch: 1 });
    } finally {
      await stopServer(server);
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(
        resolve(evidenceDir, "e0-t11-refusal-neutrality.txt"),
        `${evidence.join("\n")}\n`,
      );
    }
  });

  it("accepts one action through the reducer and keeps the cache coherent", async () => {
    resetAppendInvocationStats();
    const { server, base, cache } = await startServer();
    try {
      await createStream(base, "valid-dispatch", "fixture");
      const accepted = await dispatch(
        base,
        "valid-dispatch",
        JSON.stringify({ type: "set", payload: 4, ts: 10 }),
      );
      expect(accepted.status).toBe(201);
      const acceptedBody = json<{ event: Event & { offset: string }; offset: string }>(
        accepted.body,
      );
      expect(acceptedBody.event.type).toBe("set");
      expect(acceptedBody.offset).toBe(acceptedBody.event.offset);

      const events = await request(base, "/streams/valid-dispatch/events?offset=-1");
      expect(events.status).toBe(200);
      const records = json<Array<Event & { offset: string }>>(events.body);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ type: "set", payload: 4, ts: 10 });

      const expected = replay(records, fixtureReducer, fixtureInitialState) as FixtureState;
      const firstState = await request(base, "/streams/valid-dispatch/state");
      expect(firstState.status).toBe(200);
      expect(firstState.body).toBe(canonicalJson(expected));
      const statsAfterFirstRead = cache.stats();
      const secondState = await request(base, "/streams/valid-dispatch/state");
      expect(secondState.body).toBe(firstState.body);
      expect(cache.stats().hits).toBeGreaterThan(statsAfterFirstRead.hits);

      const raw = await request(base, "/streams/valid-dispatch", {
        method: "POST",
        headers: { "content-type": "application/json", "stream-seq": "1" },
        body: JSON.stringify({ events: [{ type: "push", payload: "raw", ts: 11 }] }),
      });
      expect(raw.status).toBe(201);
      expect(appendInvocationStats()).toEqual({ raw: 1, dispatch: 1, total: 2 });
    } finally {
      await stopServer(server);
    }
  });

  it("accepts and then refuses the same state-dependent action, and preserves interleaving", async () => {
    const { server, base } = await startServer();
    try {
      await createStream(base, "counter-dispatch", "counter");
      expect(
        (
          await dispatch(
            base,
            "counter-dispatch",
            JSON.stringify({ type: "counter/increment", payload: 1, ts: 20 }),
          )
        ).status,
      ).toBe(201);
      expect(
        (
          await dispatch(
            base,
            "counter-dispatch",
            JSON.stringify({ type: "counter/decrement", payload: 1, ts: 21 }),
          )
        ).status,
      ).toBe(201);
      const beforeRefusal = await capture(base, "counter-dispatch");
      const refused = await dispatch(
        base,
        "counter-dispatch",
        JSON.stringify({ type: "counter/decrement", payload: 1, ts: 22 }),
      );
      expect(refused.status).toBe(409);
      expect((await capture(base, "counter-dispatch")).digest).toBe(beforeRefusal.digest);

      await createStream(base, "interleaved-control", "fixture");
      await createStream(base, "interleaved-test", "fixture");
      for (const [streamId, actions] of [
        [
          "interleaved-control",
          [
            { type: "set", payload: 1, ts: 30 },
            { type: "increment", payload: 2, ts: 31 },
          ],
        ],
        ["interleaved-test", [{ type: "set", payload: 1, ts: 30 }]],
      ] as const) {
        for (const action of actions)
          expect((await dispatch(base, streamId, JSON.stringify(action))).status).toBe(201);
      }
      const invalid = await dispatch(
        base,
        "interleaved-test",
        JSON.stringify({ type: "nope", payload: true, ts: 30 }),
      );
      expect(invalid.status).toBe(404);
      expect(
        (
          await dispatch(
            base,
            "interleaved-test",
            JSON.stringify({ type: "increment", payload: 2, ts: 31 }),
          )
        ).status,
      ).toBe(201);
      const controlDump = await request(base, "/streams/interleaved-control/dump");
      const testDump = await request(base, "/streams/interleaved-test/dump");
      expect(testDump.body).toBe(controlDump.body);
    } finally {
      await stopServer(server);
    }
  });
});
