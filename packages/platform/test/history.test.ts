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

function gateway(): PlatformGateway {
  const main = [
    record(
      0,
      stamped({ type: "fs.dir.create", payload: { v: 2, path: "docs" }, ts: 1 }, "alice", 1),
    ),
    record(
      1,
      stamped({ type: "future.event", payload: { v: 99, path: "unknown.txt" }, ts: 2 }, "bob", 1),
    ),
  ];
  const feature = [
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
  ];
  return new PlatformGateway({
    verifier,
    streams: new MemoryAdapter(
      new Map([
        [mainStream, main],
        [featureStream, feature],
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
    expect(body.events).toHaveLength(2);
    expect(body.events.map((event) => event.offset)).toEqual([
      offsetForOrdinal(0),
      offsetForOrdinal(1),
    ]);
    expect(body.events.map((event) => event.actor)).toEqual(["alice", "bob"]);
    expect(body.events.every((event) => event.sourceStreamId === mainStream)).toBe(true);
    expect(body.events[1]!.type).toBe("future.event");
    expect(body.events[1]!.payload).toMatchObject({ v: 99, path: "unknown.txt" });
    expect(body.checkpoint).toBe(offsetForOrdinal(1));
    const replay = replayWithReducer(historyReducerDefinition, body.events);
    expect(replay.state).toMatchObject({ records: [{ actor: "alice" }, { actor: "bob" }] });
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
});
