import type { Event } from "@eforest/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  reduceWriterLanes,
  WriterLaneCorruptionError,
  WriterLaneDispatcher,
} from "../src/index.js";
import { namespaceHttpFixture, type NamespaceHttpFixture } from "./ns.helpers.js";

const event = (value: number): Event => ({ type: "repo.write", payload: { value }, ts: value });

async function post(
  baseUrl: string,
  token: string,
  writerSeq: number,
  value: number,
): Promise<Response> {
  return fetch(`${baseUrl}/api/dispatch`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ streamId: "writer-lanes", writerSeq, event: event(value) }),
  });
}

describe("writer lane pure reducer", () => {
  it("folds independent versioned lanes and rejects gaps or malformed metadata", () => {
    expect(
      reduceWriterLanes([
        {
          ...event(1),
          payload: { value: 1, actor: "alice", writer: { v: 1, sub: "alice", seq: 1 } },
        },
        { ...event(2), payload: { value: 2, actor: "bob", writer: { v: 1, sub: "bob", seq: 1 } } },
        {
          ...event(3),
          payload: { value: 3, actor: "alice", writer: { v: 1, sub: "alice", seq: 2 } },
        },
        { ...event(4), payload: { value: 4, actor: "bob", writer: { v: 1, sub: "bob", seq: 2 } } },
      ]),
    ).toEqual({ alice: 2, bob: 2 });
    expect(() =>
      reduceWriterLanes([
        { ...event(1), payload: { actor: "alice", writer: { v: 1, sub: "alice", seq: 2 } } },
      ]),
    ).toThrow(WriterLaneCorruptionError);
    expect(() =>
      reduceWriterLanes([
        { ...event(1), payload: { actor: "alice", writer: { v: 2, sub: "alice", seq: 1 } } },
      ]),
    ).toThrow(WriterLaneCorruptionError);
    for (const actor of [undefined, 42, "mallory"]) {
      expect(() =>
        reduceWriterLanes([
          { ...event(1), payload: { actor, writer: { v: 1, sub: "alice", seq: 1 } } },
        ]),
      ).toThrow(WriterLaneCorruptionError);
    }
    const prototypeSubject = reduceWriterLanes([
      {
        ...event(1),
        payload: { actor: "__proto__", writer: { v: 1, sub: "__proto__", seq: 1 } },
      },
    ]);
    expect(Object.keys(prototypeSubject)).toEqual(["__proto__"]);
    expect(prototypeSubject["__proto__"]).toBe(1);
  });

  it("re-runs application preconditions after every observed global head", async () => {
    const records: Event[] = [];
    const adapter = {
      async create() {},
      async append(_streamId: string, value: Event) {
        records.push(value);
      },
      async read() {
        return [...records];
      },
      async *follow() {},
    };
    const dispatcher = new WriterLaneDispatcher(adapter);
    await dispatcher.dispatch("s", event(1), "alice", {
      requestedSequence: 1,
      validate: (current) => {
        expect(current).toHaveLength(0);
      },
    });
    await expect(
      dispatcher.dispatch("s", event(2), "alice", {
        requestedSequence: 2,
        validate: (current) => {
          if (current.length !== 0) throw new Error("application-precondition-stale");
        },
      }),
    ).rejects.toThrow("application-precondition-stale");
    expect(records).toHaveLength(1);
  });

  it("recovers only an exact operation-stamped event and rejects operation collisions", async () => {
    const records: Event[] = [];
    const adapter = {
      async create() {},
      async append(_streamId: string, value: Event) {
        records.push(value);
      },
      async read() {
        return [...records];
      },
      async *follow() {},
    };
    const dispatcher = new WriterLaneDispatcher(adapter);
    const planned = {
      ...event(1),
      payload: { value: 1, actor: "alice" },
    };
    await dispatcher.dispatch("s", event(1), "alice", { operationId: "operation-1" });
    const recovered = await dispatcher.recover("operation-1", "s", planned);
    expect(recovered.globalSequence).toBe("0000000000000000_0000000000000000");
    expect(records).toEqual([recovered.event]);

    await expect(
      dispatcher.recover("operation-1", "s", {
        ...event(2),
        payload: { value: 2, actor: "alice" },
      }),
    ).rejects.toThrow(WriterLaneCorruptionError);
    await expect(
      dispatcher.recover("operation-1", "s", {
        ...event(1),
        payload: { value: 1, actor: "bob" },
      }),
    ).rejects.toThrow(WriterLaneCorruptionError);
    records.push({
      ...event(3),
      payload: {
        value: 3,
        actor: "bob",
        writer: { v: 1, sub: "bob", seq: 1, op: "operation-1" },
      },
    });
    await expect(dispatcher.recover("operation-1", "s", planned)).rejects.toThrow(
      WriterLaneCorruptionError,
    );
    expect(records).toHaveLength(2);
  });
});

describe("writer lane official-stream coordination", () => {
  let fixture: NamespaceHttpFixture | undefined;

  afterEach(async () => {
    await fixture?.stop();
    fixture = undefined;
  });

  it("interleaves 1,1,2,2 in one global order and refuses stale writes log-neutrally", async () => {
    fixture = await namespaceHttpFixture();
    await fixture.streams.create("writer-lanes");
    const alice = fixture.token("auth0|alice");
    const bob = fixture.token("auth0|bob");
    for (const [token, sequence, value] of [
      [alice, 1, 1],
      [bob, 1, 2],
      [alice, 2, 3],
      [bob, 2, 4],
    ] as const) {
      expect((await post(fixture.baseUrl, token, sequence, value)).status).toBe(202);
    }
    const before = await fixture.streams.read("writer-lanes");
    expect(
      before.map((record) => (record as { payload: { writer: unknown } }).payload.writer),
    ).toEqual([
      { v: 1, sub: "auth0|alice", seq: 1 },
      { v: 1, sub: "auth0|bob", seq: 1 },
      { v: 1, sub: "auth0|alice", seq: 2 },
      { v: 1, sub: "auth0|bob", seq: 2 },
    ]);
    const stale = await post(fixture.baseUrl, alice, 2, 5);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: {
        class: "validator-rejected",
        reason: "writer/stale-sequence",
        expected: 3,
        provided: 2,
      },
    });
    expect(await fixture.streams.read("writer-lanes")).toEqual(before);
  });

  it("resolves same-head races by global append fence without fencing another writer", async () => {
    fixture = await namespaceHttpFixture();
    await fixture.streams.create("writer-lanes");
    const second = await fixture.attachGateway();
    const alice = fixture.token("auth0|alice");
    const bob = fixture.token("auth0|bob");

    const different = await Promise.all([
      post(fixture.baseUrl, alice, 1, 1),
      post(second.baseUrl, bob, 1, 2),
    ]);
    expect(different.map((response) => response.status).sort()).toEqual([202, 202]);

    const same = await Promise.all([
      post(fixture.baseUrl, alice, 2, 3),
      post(second.baseUrl, alice, 2, 4),
    ]);
    expect(same.map((response) => response.status).sort()).toEqual([202, 409]);
    const records = await fixture.streams.read("writer-lanes");
    expect(records).toHaveLength(3);
    expect(reduceWriterLanes(records)).toEqual({ "auth0|alice": 2, "auth0|bob": 1 });
  });

  it("replays and rechecks an application precondition after a real transport conflict", async () => {
    fixture = await namespaceHttpFixture();
    await fixture.streams.create("writer-lanes");
    const stalled = new WriterLaneDispatcher(fixture.streams);
    const winner = new WriterLaneDispatcher(fixture.streams);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstValidation!: () => void;
    const validated = new Promise<void>((resolve) => {
      firstValidation = resolve;
    });
    let checks = 0;
    const loser = stalled.dispatch("writer-lanes", event(1), "auth0|alice", {
      requestedSequence: 1,
      validate: async (records) => {
        checks += 1;
        if (checks === 1) {
          expect(records).toHaveLength(0);
          firstValidation();
          await held;
          return;
        }
        throw new Error("streamfs-precondition-stale-after-replay");
      },
    });
    await validated;
    await winner.dispatch("writer-lanes", event(2), "auth0|bob", { requestedSequence: 1 });
    release();
    await expect(loser).rejects.toThrow("streamfs-precondition-stale-after-replay");
    expect(checks).toBe(2);
    expect(reduceWriterLanes(await fixture.streams.read("writer-lanes"))).toEqual({
      "auth0|bob": 1,
    });
  });

  it("forbids forged actor and writer metadata before any stream read", async () => {
    fixture = await namespaceHttpFixture();
    await fixture.streams.create("writer-lanes");
    const authorization = `Bearer ${fixture.token("auth0|alice")}`;
    for (const [key, reason] of [
      ["actor", "client_actor_forbidden"],
      ["writer", "client_writer_forbidden"],
    ] as const) {
      const response = await fetch(`${fixture.baseUrl}/api/dispatch`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          streamId: "writer-lanes",
          writerSeq: 1,
          event: {
            ...event(1),
            payload: { [key]: key === "actor" ? "mallory" : { v: 1, sub: "mallory", seq: 1 } },
          },
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "invalid_request", reason } });
      expect(await fixture.streams.read("writer-lanes")).toEqual([]);
    }
  });
});
