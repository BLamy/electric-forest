import { checkpoint, type StreamBatch, type StreamCheckpoint } from "@eforest/client";
import { emptyView } from "@eforest/identity";
import { OFFSET_BEFORE_FIRST } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { createDurableStreamTestServer } from "@eforest/server";
import { describe, expect, it } from "vitest";
import {
  OfficialStreamAdapter,
  PlatformGateway,
  WriterLaneDispatcher,
  type AuthorizationVerifier,
  type StreamAdapter,
} from "../src/index.js";
import type { AuthzInput } from "../src/authz/decide.js";

const streamId = "fs:maple/reading-room:main:meta";
const event = (ordinal: number, path: string) => ({
  type: "fs.dir.create",
  payload: { v: 2, path },
  ts: ordinal + 1,
  offset: offsetForOrdinal(ordinal),
});

class ProjectionAdapter implements StreamAdapter {
  readonly followedFrom: StreamCheckpoint[] = [];

  constructor(
    readonly bootstrap: StreamBatch,
    readonly follows: readonly StreamBatch[] = [],
  ) {}

  async create(): Promise<void> {}

  async append(): Promise<void> {}

  async read(): Promise<readonly unknown[]> {
    return [];
  }

  follow(): AsyncIterable<unknown> {
    return (async function* (): AsyncGenerator<unknown> {
      yield* [];
    })();
  }

  async applicationBootstrap(): Promise<StreamBatch> {
    return this.bootstrap;
  }

  applicationFollow(_streamId: string, from: StreamCheckpoint): AsyncIterable<StreamBatch> {
    this.followedFrom.push(from);
    const follows = this.follows;
    return (async function* (): AsyncGenerator<StreamBatch> {
      yield* follows;
    })();
  }
}

const verifier: AuthorizationVerifier = {
  verifyAuthorization: async () => ({ sub: "anonymous-test" }),
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
    streamId:
      input.target.kind === "repo" ||
      input.target.kind === "control" ||
      input.target.kind === "sandbox" ||
      input.target.kind === "internal"
        ? input.target.streamId
        : streamId,
  };
}

function gateway(adapter: StreamAdapter): PlatformGateway {
  return new PlatformGateway({
    verifier,
    streams: adapter,
    decideAuthorization: allow,
    namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
  });
}

function request(query = "projection=1&reducer=streamfs"): Request {
  return new Request(`https://platform.test/api/repos/maple/reading-room/main/events?${query}`);
}

describe("application checkpoint projection", () => {
  it("persists product checkpoints inside official Durable Streams events", async () => {
    const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
    const baseUrl = await server.start();
    const controller = new AbortController();
    try {
      const adapter = new OfficialStreamAdapter({ baseUrl });
      await adapter.create(streamId);
      const writers = new WriterLaneDispatcher(adapter);
      await writers.dispatch(
        streamId,
        { type: "fs.dir.create", payload: { v: 2, path: "docs" }, ts: 1 },
        "alice",
      );

      const bootstrap = await adapter.applicationBootstrap(streamId);
      expect(bootstrap).toMatchObject({
        events: [{ offset: offsetForOrdinal(0), type: "fs.dir.create" }],
        checkpoint: checkpoint(offsetForOrdinal(0)),
      });

      const following = adapter.applicationFollow(
        streamId,
        bootstrap.checkpoint,
        controller.signal,
      );
      const iterator = following[Symbol.asyncIterator]();
      const next = iterator.next();
      await writers.dispatch(
        streamId,
        { type: "fs.dir.create", payload: { v: 2, path: "src" }, ts: 2 },
        "alice",
      );
      expect(await next).toMatchObject({
        done: false,
        value: {
          events: [{ offset: offsetForOrdinal(1), type: "fs.dir.create" }],
          checkpoint: checkpoint(offsetForOrdinal(1)),
        },
      });

      const alreadyAborted = new AbortController();
      alreadyAborted.abort();
      const timedOutFollow = adapter.applicationFollow(
        streamId,
        checkpoint(offsetForOrdinal(1)),
        alreadyAborted.signal,
      );
      const timedOut = timedOutFollow[Symbol.asyncIterator]();
      await expect(timedOut.next()).resolves.toEqual({ done: true, value: undefined });
    } finally {
      controller.abort();
      await server.stop();
    }
  });

  it("bootstraps the complete canonical range and follows exactly after its checkpoint", async () => {
    const first = event(0, "docs");
    const boundary = event(1, "src");
    const adapter = new ProjectionAdapter(
      { events: [first], checkpoint: checkpoint(first.offset) },
      [{ events: [boundary], checkpoint: checkpoint(boundary.offset) }],
    );
    const platform = gateway(adapter);

    const bootstrap = await platform.handle(request());
    expect(bootstrap.status).toBe(200);
    expect(await bootstrap.json()).toMatchObject({
      events: [first],
      checkpoint: first.offset,
      reducer: { id: "streamfs", version: 2 },
    });

    const follow = await platform.handle(
      request(
        `projection=1&reducer=streamfs&live=1&checkpoint=${encodeURIComponent(first.offset)}&waitMs=1`,
      ),
    );
    expect(follow.status).toBe(200);
    expect(await follow.json()).toMatchObject({
      events: [boundary],
      checkpoint: boundary.offset,
    });
    expect(adapter.followedFrom).toEqual([checkpoint(first.offset)]);
  });

  it.each([
    ["duplicate", [event(0, "docs"), event(0, "src")], offsetForOrdinal(0)],
    ["out of order", [event(0, "docs"), event(1, "src"), event(0, "old")], offsetForOrdinal(0)],
  ])("refuses a %s application batch at the offending offset", async (_name, events, offset) => {
    const response = await gateway(
      new ProjectionAdapter({
        events,
        checkpoint: checkpoint(events.at(-1)!.offset),
      }),
    ).handle(request());
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { class: "malformed_application_event", offset },
    });
  });

  it("refuses an interior bootstrap gap at the exact missing offset", async () => {
    const response = await gateway(
      new ProjectionAdapter({
        events: [event(0, "docs"), event(2, "src")],
        checkpoint: checkpoint(offsetForOrdinal(2)),
      }),
    ).handle(request());
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: {
        class: "malformed_application_event",
        offset: offsetForOrdinal(1),
        reason: expect.stringContaining(`observed offset ${offsetForOrdinal(2)}`),
      },
    });
  });

  it("refuses an interior follow gap at the exact missing offset", async () => {
    const first = event(0, "docs");
    const skipped = event(2, "src");
    const platform = gateway(
      new ProjectionAdapter({ events: [first], checkpoint: checkpoint(first.offset) }, [
        { events: [skipped], checkpoint: checkpoint(skipped.offset) },
      ]),
    );
    const response = await platform.handle(
      request(
        `projection=1&reducer=streamfs&live=1&checkpoint=${encodeURIComponent(first.offset)}&waitMs=1`,
      ),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: {
        class: "malformed_application_event",
        offset: offsetForOrdinal(1),
        reason: expect.stringContaining(`observed offset ${offsetForOrdinal(2)}`),
      },
    });
  });

  it("refuses a reducer-invalid event loudly at its exact offset", async () => {
    const malformed = {
      type: "fs.dir.create",
      payload: { v: 2, path: "../escape" },
      ts: 1,
      offset: offsetForOrdinal(0),
    };
    const response = await gateway(
      new ProjectionAdapter({
        events: [malformed],
        checkpoint: checkpoint(malformed.offset),
      }),
    ).handle(request());
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: {
        class: "malformed_application_event",
        offset: malformed.offset,
      },
    });
  });

  it("refuses reducer/stream mismatches before application stream access", async () => {
    const adapter = new ProjectionAdapter({
      events: [],
      checkpoint: checkpoint(OFFSET_BEFORE_FIRST),
    });
    const response = await gateway(adapter).handle(request("projection=1&reducer=unknown"));
    expect(response.status).toBe(400);
    expect(adapter.followedFrom).toEqual([]);
  });
});
