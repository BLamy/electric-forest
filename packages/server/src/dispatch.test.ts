import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { canonicalJson, replay, stateDigest, type Event } from "@eforest/protocol";
import {
  fixtureInitialState,
  fixtureReducer,
  type FixtureState,
} from "@eforest/protocol/fixtures/reducer";
import { describe, expect, it } from "vitest";
import { appendInvocationStats, resetAppendInvocationStats } from "./append-door.js";
import { createHttpServer, handleRequest } from "./http.js";
import {
  counterInitialState,
  counterReducer,
  createDefaultReducerRegistry,
} from "./redux/reducers.js";
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

async function rawHttp(port: number, requestText: string): Promise<string> {
  return new Promise<string>((resolveRaw, rejectRaw) => {
    const socket = connect(port, "127.0.0.1");
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      rejectRaw(new Error("raw HTTP request did not receive a response"));
    }, 2_000);
    socket.on("connect", () => socket.end(requestText));
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
    });
    socket.on("end", () => {
      clearTimeout(timeout);
      resolveRaw(response);
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      rejectRaw(error);
    });
  });
}

function rawStatus(response: string): number {
  const status = Number(response.split("\r\n", 1)[0]?.split(" ")[1]);
  return status;
}

class CapturedResponse {
  statusCode = 0;
  body = "";
  readonly headers = new Map<string, string | number>();

  setHeader(name: string, value: string | number): this {
    this.headers.set(name, value);
    return this;
  }

  writeHead(status: number, headers: Record<string, string | number>): this {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers)) this.headers.set(name, value);
    return this;
  }

  end(body?: string | Uint8Array): this {
    this.body = body === undefined ? "" : Buffer.from(body).toString("utf8");
    return this;
  }
}

async function invokeTruncatedRequest(
  contentLength: string | undefined,
  signal: "end" | "aborted" | "close",
): Promise<CapturedResponse> {
  const store = new MemoryStreamStore();
  store.create("in-memory-truncated", { type: "fixture" });
  const request = new EventEmitter() as IncomingMessage;
  Object.assign(request, {
    method: "POST",
    url: "/streams/in-memory-truncated/dispatch",
    headers: {
      "content-type": "application/json",
      ...(contentLength === undefined ? {} : { "content-length": contentLength }),
    },
    resume: () => request,
  });
  const response = new CapturedResponse();
  const pending = handleRequest(request, response as unknown as ServerResponse, store, undefined, {
    registry: createDefaultReducerRegistry(),
    cache: new StateCache(),
    actionValidators: createDefaultActionValidatorRegistry(),
  });
  request.emit("data", Buffer.from('{"type":"set"}'));
  request.emit(signal);
  await pending;
  return response;
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

interface ReductionSpec<S> {
  readonly reducer: (state: S, event: Event) => S;
  readonly initialState: S;
}

const fixtureReduction: ReductionSpec<FixtureState> = {
  reducer: fixtureReducer,
  initialState: fixtureInitialState,
};

const counterReduction: ReductionSpec<{ readonly count: number }> = {
  reducer: counterReducer,
  initialState: counterInitialState,
};

async function capture<S>(
  base: string,
  streamId: string,
  reduction: ReductionSpec<S>,
): Promise<{
  readonly head: string;
  readonly digest: string;
  readonly replayDigest: string;
  readonly body: string;
}> {
  const dump = await request(base, `/streams/${streamId}/dump`);
  expect(dump.status).toBe(200);
  const records = dump.body.trim().length
    ? (dump.body
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)) as Event[])
    : [];
  return {
    head: dump.headers.get("stream-next-offset") ?? "<missing>",
    digest: logDigest(dump.body),
    replayDigest: stateDigest(replay(records, reduction.reducer, reduction.initialState)),
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
    const evidence: string[] = [
      "class status head-before head-after raw-before raw-after replay-before replay-after",
    ];
    const snapshots: Array<{
      readonly name: string;
      readonly before: string;
      readonly after: string;
    }> = [];
    try {
      await createStream(base, "neutral-fixture", "fixture");
      await createStream(base, "neutral-counter", "counter");
      expect(
        (
          await dispatch(
            base,
            "neutral-fixture",
            JSON.stringify({ type: "set", payload: 0, ts: 0 }),
          )
        ).status,
      ).toBe(201);
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
        const before = await capture(base, testCase.streamId, fixtureReduction);
        const refused = await dispatch(base, testCase.streamId, testCase.body);
        const after = await capture(base, testCase.streamId, fixtureReduction);
        expect(refused.status, testCase.name).toBe(testCase.expectedStatus);
        const body = json<{ error: { class: string; reason: string } }>(refused.body);
        expect(body.error.class, testCase.name).toBe(testCase.expectedClass);
        expect(body.error.reason.length, testCase.name).toBeGreaterThan(0);
        expect(after.head, testCase.name).toBe(before.head);
        expect(after.digest, testCase.name).toBe(before.digest);
        expect(after.replayDigest, testCase.name).toBe(before.replayDigest);
        expect(after.body, testCase.name).toBe(before.body);
        snapshots.push({ name: testCase.name, before: before.body, after: after.body });
        evidence.push(
          [
            testCase.name,
            String(refused.status),
            before.head,
            after.head,
            before.digest,
            after.digest,
            before.replayDigest,
            after.replayDigest,
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
      expect(appendInvocationStats()).toMatchObject({ raw: 0, dispatch: 2 });
    } finally {
      await stopServer(server);
      mkdirSync(evidenceDir, { recursive: true });
      for (const snapshot of snapshots) {
        writeFileSync(
          resolve(evidenceDir, `e0-t11-refusal-neutrality-${snapshot.name}-before.jsonl`),
          snapshot.before,
        );
        writeFileSync(
          resolve(evidenceDir, `e0-t11-refusal-neutrality-${snapshot.name}-after.jsonl`),
          snapshot.after,
        );
      }
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

  it("turns truncated content-length and chunked bodies into typed malformed refusals", async () => {
    const { server, base } = await startServer();
    try {
      await createStream(base, "truncated-dispatch", "fixture");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server has no TCP port");
      const contentLengthBody = JSON.stringify({ type: "set", payload: 1, ts: 40 });
      const contentLengthResponse = await rawHttp(
        address.port,
        [
          "POST /streams/truncated-dispatch/dispatch HTTP/1.1",
          "Host: 127.0.0.1",
          "Content-Type: application/json",
          `Content-Length: ${Buffer.byteLength(contentLengthBody) + 5}`,
          "Connection: close",
          "",
          contentLengthBody,
        ].join("\r\n"),
      );
      expect(rawStatus(contentLengthResponse)).toBe(400);

      const chunkedBody = JSON.stringify({ type: "set", payload: 1, ts: 41 });
      const chunk = chunkedBody.slice(0, 4);
      const chunkedResponse = await rawHttp(
        address.port,
        [
          "POST /streams/truncated-dispatch/dispatch HTTP/1.1",
          "Host: 127.0.0.1",
          "Content-Type: application/json",
          "Transfer-Encoding: chunked",
          "Connection: close",
          "",
          `${chunk.length.toString(16)}\r\n${chunk}\r\n`,
        ].join("\r\n"),
      );
      expect(rawStatus(chunkedResponse)).toBe(400);
      expect((await capture(base, "truncated-dispatch", fixtureReduction)).head).toBe("-1");

      const shortLength = await invokeTruncatedRequest("100", "end");
      expect(shortLength.statusCode).toBe(400);
      expect(shortLength.body).toContain('"class":"malformed-body"');
      const abortedChunk = await invokeTruncatedRequest(undefined, "aborted");
      expect(abortedChunk.statusCode).toBe(400);
      expect(abortedChunk.body).toContain('"class":"malformed-body"');
      const closedChunk = await invokeTruncatedRequest(undefined, "close");
      expect(closedChunk.statusCode).toBe(400);
      expect(closedChunk.body).toContain('"class":"malformed-body"');
    } finally {
      await stopServer(server);
    }
  });

  it("rejects reducer-breaking numeric payloads before they can poison state", async () => {
    const { server, base } = await startServer();
    try {
      await createStream(base, "semantic-dispatch", "fixture");
      expect(
        (
          await dispatch(
            base,
            "semantic-dispatch",
            JSON.stringify({ type: "set", payload: 4, ts: 50 }),
          )
        ).status,
      ).toBe(201);
      const before = await capture(base, "semantic-dispatch", fixtureReduction);
      const refused = await dispatch(
        base,
        "semantic-dispatch",
        JSON.stringify({ type: "set", payload: { nested: ["not", "a", "number"] }, ts: 51 }),
      );
      expect(refused.status).toBe(409);
      expect(json<{ error: { class: string } }>(refused.body).error.class).toBe(
        "validator-rejected",
      );
      const after = await capture(base, "semantic-dispatch", fixtureReduction);
      expect(after.body).toBe(before.body);
      expect(after.replayDigest).toBe(before.replayDigest);
      const state = await request(base, "/streams/semantic-dispatch/state");
      expect(state.status).toBe(200);
      expect(state.body).toBe(canonicalJson({ count: 4, values: [], meta: {} }));
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
      const beforeRefusal = await capture(base, "counter-dispatch", counterReduction);
      const refused = await dispatch(
        base,
        "counter-dispatch",
        JSON.stringify({ type: "counter/decrement", payload: 1, ts: 22 }),
      );
      expect(refused.status).toBe(409);
      const afterRefusal = await capture(base, "counter-dispatch", counterReduction);
      expect(afterRefusal.digest).toBe(beforeRefusal.digest);
      expect(afterRefusal.replayDigest).toBe(beforeRefusal.replayDigest);

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
