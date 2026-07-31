import { emptyView } from "@eforest/identity";
import { OFFSET_BEFORE_FIRST, type Event } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { describe, expect, it } from "vitest";
import {
  PlatformGateway,
  RepositoryHomeCorruptError,
  RepositoryHomeNativeForkError,
  RepositoryHomeStore,
  type AuthorizationVerifier,
  type NamespaceView,
  type StreamAdapter,
} from "../src/index.js";

class MemoryAdapter implements StreamAdapter {
  readonly values = new Map<string, unknown[]>();
  readonly operations: Array<{ readonly op: string; readonly streamId: string }> = [];

  async create(streamId: string): Promise<void> {
    this.operations.push({ op: "create", streamId });
    if (!this.values.has(streamId)) this.values.set(streamId, []);
  }

  async append(
    streamId: string,
    event: Event,
    options?: Parameters<StreamAdapter["append"]>[2],
  ): Promise<void> {
    this.operations.push({ op: "append", streamId });
    const records = this.values.get(streamId) ?? [];
    const expected = offsetForOrdinal(records.length);
    if (options?.sequence !== expected || options.applicationOffset !== expected) {
      throw new Error("test append fence mismatch");
    }
    records.push({ ...event, offset: options.applicationOffset });
    this.values.set(streamId, records);
  }

  async read(streamId: string): Promise<readonly unknown[]> {
    this.operations.push({ op: "read", streamId });
    return this.values.get(streamId) ?? [];
  }

  async *follow(): AsyncIterable<unknown> {
    yield* [];
  }
}

const VIEW: NamespaceView = {
  orgs: {
    acme: {
      owner: "auth0|owner",
      projects: { canopy: { owner: "auth0|project-owner" } },
      repos: {
        forest: {
          owner: "auth0|repo-owner",
          project: "canopy",
          visibility: "public",
        },
        secret: {
          owner: "auth0|repo-owner",
          project: "canopy",
          visibility: "private",
        },
      },
    },
  },
};

function namespaceCreate(name: string, visibility: "public" | "private"): Event {
  return {
    type: "ns.repo.create",
    ts: 1,
    payload: {
      v: 1,
      name,
      project: "canopy",
      visibility,
      actor: { v: 1, sub: "auth0|repo-owner" },
    },
  };
}

describe("repository home canonical projections", () => {
  it("initializes namespace, main branch, and building status as independent projections", async () => {
    const streams = new MemoryAdapter();
    streams.values.set("ns:org:acme", [namespaceCreate("forest", "public")]);
    const homes = new RepositoryHomeStore(streams);

    await homes.ensureRepository("acme", "forest", "canopy");
    const namespace = await homes.projection(VIEW, "acme", "forest", "namespace");
    const branches = await homes.projection(VIEW, "acme", "forest", "branches");
    const status = await homes.projection(VIEW, "acme", "forest", "status");

    expect(namespace.streamId).toBe("repo-home:acme/forest:namespace");
    expect(namespace.events).toMatchObject([
      {
        offset: offsetForOrdinal(0),
        type: "repo.namespace.loaded",
        payload: { org: "acme", repo: "forest", project: "canopy", visibility: "public" },
      },
    ]);
    expect(branches.events).toMatchObject([
      {
        offset: offsetForOrdinal(0),
        payload: {
          name: "main",
          streamId: "fs:acme/forest:main:meta",
          parentStreamId: null,
          forkOffset: OFFSET_BEFORE_FIRST,
        },
      },
    ]);
    expect(status.events).toMatchObject([
      { offset: offsetForOrdinal(0), payload: { status: "building" } },
    ]);

    await homes.setProjectStatus("acme", "canopy", "paused");
    expect((await homes.projection(VIEW, "acme", "forest", "status")).events).toMatchObject([
      { payload: { status: "building" } },
      { offset: offsetForOrdinal(1), payload: { status: "paused" } },
    ]);
  });

  it("registers only a native fork and exposes its parent stream and application checkpoint", async () => {
    const streams = new MemoryAdapter();
    const homes = new RepositoryHomeStore(streams);
    await homes.ensureRepository("acme", "forest", "canopy");
    streams.values.set(
      "fs:acme/forest:main:meta",
      Array.from({ length: 5 }, (_, ordinal) => ({
        offset: offsetForOrdinal(ordinal),
        type: "fs.file.created",
        ts: ordinal,
        payload: { v: 1 },
      })),
    );
    streams.values.set("fs:acme/forest:feature:meta", [
      {
        offset: offsetForOrdinal(0),
        type: "fs.branch.fork",
        ts: 2,
        payload: {
          v: 1,
          parentStreamId: "fs:acme/forest:main:meta",
          forkOffset: offsetForOrdinal(4),
        },
      },
    ]);

    await homes.registerNativeBranch("acme", "forest", "feature");
    expect(
      (await homes.projection(VIEW, "acme", "forest", "branches")).events.at(-1),
    ).toMatchObject({
      offset: offsetForOrdinal(1),
      payload: {
        name: "feature",
        parentStreamId: "fs:acme/forest:main:meta",
        forkOffset: offsetForOrdinal(4),
      },
    });

    streams.values.set("fs:acme/forest:fake:meta", [
      { offset: offsetForOrdinal(0), type: "fs.file.created", ts: 3, payload: {} },
    ]);
    await expect(homes.registerNativeBranch("acme", "forest", "fake")).rejects.toBeInstanceOf(
      RepositoryHomeNativeForkError,
    );

    streams.values.set("fs:acme/forest:missing-checkpoint:meta", [
      {
        offset: offsetForOrdinal(0),
        type: "fs.branch.fork",
        ts: 4,
        payload: {
          v: 1,
          parentStreamId: "fs:acme/forest:main:meta",
          forkOffset: offsetForOrdinal(9),
        },
      },
    ]);
    await expect(
      homes.registerNativeBranch("acme", "forest", "missing-checkpoint"),
    ).rejects.toThrow("fork checkpoint is absent from parent stream");
  });

  it("refuses malformed and cyclic catalog history visibly", async () => {
    const streams = new MemoryAdapter();
    const homes = new RepositoryHomeStore(streams);
    await homes.ensureRepository("acme", "forest", "canopy");
    streams.values.get("repo-home:acme/forest:branches")!.push({
      offset: offsetForOrdinal(1),
      type: "repo.branch.created",
      ts: 2,
      payload: {
        v: 1,
        name: "cycle",
        streamId: "fs:acme/forest:cycle:meta",
        parentStreamId: "fs:acme/forest:cycle:meta",
        forkOffset: offsetForOrdinal(0),
      },
    });
    await expect(homes.projection(VIEW, "acme", "forest", "branches")).rejects.toBeInstanceOf(
      RepositoryHomeCorruptError,
    );
  });
});

describe("repository home authorization door", () => {
  it("returns byte-identical refusals for an unknown repo and an unknown private repo", async () => {
    const streams = new MemoryAdapter();
    streams.values.set("ns:org:acme", [
      namespaceCreate("forest", "public"),
      namespaceCreate("secret", "private"),
    ]);
    const verifier: AuthorizationVerifier = {
      verifyAuthorization: async () => {
        throw new Error("not used for anonymous projection reads");
      },
      authorizationContext: async () => ({
        principal: { kind: "anonymous" },
        identity: emptyView(),
        identityOffset: "-1",
      }),
    };
    const gateway = new PlatformGateway({
      verifier,
      streams,
      namespaceViewReader: { viewFor: async () => VIEW },
    });

    const unknown = await gateway.handle(
      new Request(
        "https://platform.test/api/repos/acme/ghost/home/namespace?projection=1&reducer=repo-namespace",
      ),
    );
    const privateRepo = await gateway.handle(
      new Request(
        "https://platform.test/api/repos/acme/secret/home/namespace?projection=1&reducer=repo-namespace",
      ),
    );
    expect(unknown.status).toBe(404);
    expect(privateRepo.status).toBe(404);
    expect(await unknown.text()).toBe(await privateRepo.text());
    expect(streams.operations.some(({ streamId }) => streamId.includes("ghost"))).toBe(false);
    expect(streams.operations.some(({ streamId }) => streamId.includes("secret"))).toBe(false);

    const visible = await gateway.handle(
      new Request(
        "https://platform.test/api/repos/acme/forest/home/namespace?projection=1&reducer=repo-namespace",
      ),
    );
    expect(visible.status).toBe(200);
    expect(await visible.json()).toMatchObject({
      checkpoint: offsetForOrdinal(0),
      reducer: { id: "repo-namespace", version: 1 },
    });
  });
});
