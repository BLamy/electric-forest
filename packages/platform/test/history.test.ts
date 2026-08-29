import { emptyView } from "@eforest/identity";
import type { Event } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { historyReducerDefinition, replayWithReducer } from "@eforest/reducers";
import { describe, expect, it } from "vitest";
import { PlatformGateway, type AuthorizationVerifier, type StreamAdapter } from "../src/index.js";
import type { AuthzInput } from "../src/authz/decide.js";

const mainStream = "fs:maple/reading-room:main:meta";
const featureStream = "fs:maple/reading-room:feature:meta";

function record(ordinal: number, event: Event) {
  return { ...event, offset: offsetForOrdinal(ordinal) };
}

function stamped(event: Event, actor: string, sequence: number): Event {
  const payload = event.payload as Record<string, unknown>;
  return {
    ...event,
    payload: { ...payload, actor, writer: { v: 1, sub: actor, seq: sequence } },
  };
}

class MemoryAdapter implements StreamAdapter {
  constructor(readonly values: Map<string, readonly unknown[]>) {}

  async create(): Promise<void> {}
  async append(): Promise<void> {}
  async read(streamId: string): Promise<readonly unknown[]> {
    return this.values.get(streamId) ?? [];
  }
  async *follow(): AsyncIterable<unknown> {
    yield* [];
  }
}

const verifier: AuthorizationVerifier = {
  verifyAuthorization: async () => ({ sub: "history-test" }),
  authorizationContext: async () => ({
    principal: { kind: "anonymous" },
    identity: emptyView(),
    identityOffset: "-1",
  }),
};

function allow(input: AuthzInput) {
  return {
    allowed: true as const,
    operation: input.operation,
    identityOffset: input.identityOffset,
    basis: "public" as const,
    streamId: input.target.kind === "repo" ? input.target.streamId : mainStream,
  };
}

function gateway(
  mainRecords: readonly unknown[] = [
    record(
      0,
      stamped({ type: "fs.dir.create", payload: { v: 2, path: "docs" }, ts: 1 }, "alice", 1),
    ),
    record(
      1,
      stamped({ type: "future.event", payload: { v: 99, path: "unknown.txt" }, ts: 2 }, "bob", 1),
    ),
    record(2, {
      type: "future.spoof",
      payload: { v: 99, actor: "mallory" },
      ts: 3,
    }),
  ],
  featureRecords: readonly unknown[] = [
    record(0, {
      type: "fs.branch.fork",
      payload: { v: 1, parentStreamId: mainStream, forkOffset: offsetForOrdinal(0) },
      ts: 3,
    }),
    record(
      1,
      stamped(
        {
          type: "fs.file.create",
          payload: { v: 2, path: "docs/feature.md", contentStreamId: "fs:feature:file" },
          ts: 4,
        },
        "carol",
        1,
      ),
    ),
  ],
): PlatformGateway {
  return new PlatformGateway({
    verifier,
    streams: new MemoryAdapter(
      new Map([
        [mainStream, mainRecords],
        [featureStream, featureRecords],
      ]),
    ),
    decideAuthorization: allow,
    namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
  });
}

describe("canonical history projection", () => {
  it("keeps stamped actors, unknown raw events, and source streams", async () => {
    const response = await gateway().handle(
      new Request(
        "https://platform.test/api/repos/maple/reading-room/main/events?projection=1&reducer=history",
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly events: readonly {
        readonly offset: string;
        readonly type: string;
        readonly ts: number;
        readonly actor: string;
        readonly sourceStreamId: string;
        readonly payload: unknown;
      }[];
      readonly checkpoint: string;
    };
    expect(body.events).toHaveLength(3);
    expect(body.events.map((event) => event.offset)).toEqual([
      offsetForOrdinal(0),
      offsetForOrdinal(1),
      offsetForOrdinal(2),
    ]);
    expect(body.events.map((event) => event.actor)).toEqual(["alice", "bob", "unknown-actor"]);
    expect(body.events.every((event) => event.sourceStreamId === mainStream)).toBe(true);
    expect(body.events[1]!.type).toBe("future.event");
    expect(body.events[1]!.payload).toMatchObject({ v: 99, path: "unknown.txt" });
    expect(body.checkpoint).toBe(offsetForOrdinal(2));
    const replay = replayWithReducer(historyReducerDefinition, body.events);
    expect(replay.state).toMatchObject({
      records: [{ actor: "alice" }, { actor: "bob" }, { actor: "unknown-actor" }],
    });
  });

  it("orders inherited branch history before the fork and branch-local events", async () => {
    const response = await gateway().handle(
      new Request(
        "https://platform.test/api/repos/maple/reading-room/feature/events?projection=1&reducer=history",
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly events: readonly {
        readonly offset: string;
        readonly type: string;
        readonly sourceStreamId: string;
      }[];
      readonly branch: { readonly parentStreamId: string; readonly forkCheckpoint: string };
    };
    expect(body.events.map((event) => event.type)).toEqual([
      "fs.dir.create",
      "fs.branch.fork",
      "fs.file.create",
    ]);
    expect(body.events.map((event) => event.sourceStreamId)).toEqual([
      mainStream,
      featureStream,
      featureStream,
    ]);
    expect(body.events.map((event) => event.offset)).toEqual([
      offsetForOrdinal(0),
      offsetForOrdinal(1),
      offsetForOrdinal(2),
    ]);
    expect(body.branch).toMatchObject({
      parentStreamId: mainStream,
      forkCheckpoint: offsetForOrdinal(0),
    });
  });

  it("normalizes an official inherited prefix before projecting branch history", async () => {
    const response = await gateway(undefined, [
      record(
        0,
        stamped({ type: "fs.dir.create", payload: { v: 2, path: "docs" }, ts: 1 }, "alice", 1),
      ),
      record(1, {
        type: "fs.branch.fork",
        payload: { v: 1, parentStreamId: mainStream, forkOffset: offsetForOrdinal(0) },
        ts: 3,
      }),
      record(
        2,
        stamped(
          {
            type: "fs.file.create",
            payload: { v: 2, path: "docs/feature.md", contentStreamId: "fs:feature:file" },
            ts: 4,
          },
          "carol",
          1,
        ),
      ),
    ]).handle(
      new Request(
        "https://platform.test/api/repos/maple/reading-room/feature/events?projection=1&reducer=history",
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly events: readonly { readonly type: string; readonly sourceStreamId: string }[];
    };
    expect(body.events.map((event) => event.type)).toEqual([
      "fs.dir.create",
      "fs.branch.fork",
      "fs.file.create",
    ]);
    expect(body.events.map((event) => event.sourceStreamId)).toEqual([
      mainStream,
      featureStream,
      featureStream,
    ]);
  });

  it.each([
    ["native offset", [{ offset: "garbage", type: "future.event", payload: { v: 99 }, ts: 1 }]],
    ["event type", [{ offset: offsetForOrdinal(0), type: 42, payload: { v: 99 }, ts: 1 }]],
    [
      "event timestamp",
      [{ offset: offsetForOrdinal(0), type: "future.event", payload: { v: 99 } }],
    ],
    ["event payload", [{ offset: offsetForOrdinal(0), type: "future.event", ts: 1 }]],
    [
      "supported StreamFS payload",
      [
        {
          offset: offsetForOrdinal(0),
          type: "fs.file.create",
          payload: { v: 2, path: "x" },
          ts: 1,
        },
      ],
    ],
    [
      "native offset gap",
      [
        { offset: offsetForOrdinal(0), type: "future.event", payload: { v: 99 }, ts: 1 },
        { offset: offsetForOrdinal(2), type: "future.event", payload: { v: 99 }, ts: 2 },
      ],
    ],
    [
      "writer lane gap",
      [
        {
          offset: offsetForOrdinal(0),
          type: "future.event",
          payload: { v: 99, actor: "alice", writer: { v: 1, sub: "alice", seq: 2 } },
          ts: 1,
        },
      ],
    ],
    [
      "writer lane extra field",
      [
        {
          offset: offsetForOrdinal(0),
          type: "future.event",
          payload: {
            v: 99,
            actor: "alice",
            writer: { v: 1, sub: "alice", seq: 1, unexpected: true },
          },
          ts: 1,
        },
      ],
    ],
  ])("rejects malformed canonical history records: %s", async (_label, records) => {
    const response = await gateway(records).handle(
      new Request(
        "https://platform.test/api/repos/maple/reading-room/main/events?projection=1&reducer=history",
      ),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { class: "malformed_application_event" },
    });
  });

  it("rejects a repeated native fork directive", async () => {
    const response = await gateway(undefined, [
      record(0, {
        type: "fs.branch.fork",
        payload: { v: 1, parentStreamId: mainStream, forkOffset: offsetForOrdinal(0) },
        ts: 3,
      }),
      record(1, {
        type: "fs.branch.fork",
        payload: { v: 1, parentStreamId: mainStream, forkOffset: offsetForOrdinal(0) },
        ts: 4,
      }),
    ]).handle(
      new Request(
        "https://platform.test/api/repos/maple/reading-room/feature/events?projection=1&reducer=history",
      ),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { class: "malformed_application_event" },
    });
  });
});
