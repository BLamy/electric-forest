import { emptyView } from "@eforest/identity";
import type { Event } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { digestBytes, treeDigest, type FsTree } from "@eforest/streamfs";
import { replayWithReducer, streamFsReducerDefinition } from "@eforest/reducers";
import { describe, expect, it } from "vitest";
import { PlatformGateway, type AuthorizationVerifier, type StreamAdapter } from "../src/index.js";
import type { AuthzInput } from "../src/authz/decide.js";

const mainStream = "fs:maple/reading-room:main:meta";
const branchStream = "fs:maple/reading-room:feature:meta";
const mainContent = "fs:maple/reading-room:main:file:readme";
const branchContent = "fs:maple/reading-room:feature:file:1-feature";
const initial = new TextEncoder().encode("main\n");
const feature = new TextEncoder().encode("feature\n");

function record(ordinal: number, event: Event) {
  return { ...event, offset: offsetForOrdinal(ordinal) };
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
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
  verifyAuthorization: async () => ({ sub: "branch-test" }),
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

function request(branch: string, suffix: string): Request {
  return new Request(
    `https://platform.test/api/repos/maple/reading-room/${branch}/${suffix}&projection=1&reducer=streamfs`,
  );
}

function fixture(): MemoryAdapter {
  return new MemoryAdapter(
    new Map([
      [
        mainStream,
        [
          record(0, { type: "fs.dir.create", payload: { v: 2, path: "docs" }, ts: 1 }),
          record(1, {
            type: "fs.file.create",
            payload: { v: 2, path: "docs/readme.md", contentStreamId: mainContent },
            ts: 2,
          }),
          record(2, {
            type: "fs.file.write",
            payload: {
              v: 2,
              path: "docs/readme.md",
              base: "BASE_NONE",
              contentSha256: digestBytes(initial),
              size: initial.byteLength,
            },
            ts: 3,
          }),
        ],
      ],
      [
        branchStream,
        [
          record(0, {
            type: "fs.branch.fork",
            payload: { v: 1, parentStreamId: mainStream, forkOffset: offsetForOrdinal(1) },
            ts: 4,
          }),
          record(1, {
            type: "fs.file.create",
            payload: { v: 2, path: "docs/feature.md", contentStreamId: branchContent },
            ts: 5,
          }),
          record(2, {
            type: "fs.file.write",
            payload: {
              v: 2,
              path: "docs/feature.md",
              base: "BASE_NONE",
              contentSha256: digestBytes(feature),
              size: feature.byteLength,
            },
            ts: 6,
          }),
        ],
      ],
      [
        mainContent,
        [
          record(0, {
            type: "fs.file.content",
            payload: { v: 2, contentStreamId: mainContent, contentBase64: base64(initial) },
            ts: 3,
          }),
        ],
      ],
      [
        branchContent,
        [
          record(0, {
            type: "fs.file.content",
            payload: { v: 2, contentStreamId: branchContent, contentBase64: base64(feature) },
            ts: 6,
          }),
        ],
      ],
    ]),
  );
}

function inheritedPrefixFixture(): MemoryAdapter {
  const base = fixture();
  return new MemoryAdapter(
    new Map([
      ...base.values,
      [
        branchStream,
        [
          record(0, { type: "fs.dir.create", payload: { v: 2, path: "docs" }, ts: 1 }),
          record(1, {
            type: "fs.file.create",
            payload: { v: 2, path: "docs/readme.md", contentStreamId: mainContent },
            ts: 2,
          }),
          record(2, {
            type: "fs.branch.fork",
            payload: { v: 1, parentStreamId: mainStream, forkOffset: offsetForOrdinal(1) },
            ts: 4,
          }),
          record(3, {
            type: "fs.file.create",
            payload: { v: 2, path: "docs/feature.md", contentStreamId: branchContent },
            ts: 5,
          }),
          record(4, {
            type: "fs.file.write",
            payload: {
              v: 2,
              path: "docs/feature.md",
              base: "BASE_NONE",
              contentSha256: digestBytes(feature),
              size: feature.byteLength,
            },
            ts: 6,
          }),
        ],
      ],
    ]),
  );
}

describe("native fork branch projections", () => {
  it("resolves ancestry into an isolated contiguous tree projection", async () => {
    const adapter = fixture();
    const gateway = new PlatformGateway({
      verifier,
      streams: adapter,
      decideAuthorization: allow,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
    });

    const response = await gateway.handle(request("feature", "events?"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly events: readonly Event[];
      readonly checkpoint: string;
      readonly branch: {
        readonly parentStreamId: string | null;
        readonly forkCheckpoint: string;
        readonly headCheckpoint: string;
      };
    };
    expect(body.events.map((event) => event.type)).toEqual([
      "fs.dir.create",
      "fs.file.create",
      "fs.file.create",
      "fs.file.write",
    ]);
    expect(
      body.events.every(
        (event, index) => (event as Event & { offset: string }).offset === offsetForOrdinal(index),
      ),
    ).toBe(true);
    expect(body.branch).toMatchObject({
      parentStreamId: mainStream,
      forkCheckpoint: offsetForOrdinal(1),
      headCheckpoint: offsetForOrdinal(3),
    });
    expect(body.checkpoint).toBe(body.branch.headCheckpoint);
    const replay = replayWithReducer(streamFsReducerDefinition, body.events);
    expect(replay.digest).toBe(treeDigest(replay.state as FsTree));
    expect(replay.state).toMatchObject({
      files: {
        "docs/readme.md": expect.anything(),
        "docs/feature.md": expect.anything(),
      },
    });

    const main = await gateway.handle(request("main", "events?"));
    const mainBody = (await main.json()) as { readonly events: readonly Event[] };
    expect(
      mainBody.events.some(
        (event) => event.payload && (event.payload as { path?: string }).path === "docs/feature.md",
      ),
    ).toBe(false);
  });

  it("normalizes an official inherited prefix before resolving the branch", async () => {
    const gateway = new PlatformGateway({
      verifier,
      streams: inheritedPrefixFixture(),
      decideAuthorization: allow,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
    });
    const response = await gateway.handle(request("feature", "events?"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly events: readonly Event[];
      readonly branch: {
        readonly parentStreamId: string | null;
        readonly forkCheckpoint: string;
      };
    };
    expect(body.events.map((event) => event.type)).toEqual([
      "fs.dir.create",
      "fs.file.create",
      "fs.file.create",
      "fs.file.write",
    ]);
    expect(body.branch).toMatchObject({
      parentStreamId: mainStream,
      forkCheckpoint: offsetForOrdinal(1),
    });
  });

  it("joins branch-owned sidecar bytes for a blob without leaking parent content", async () => {
    const adapter = fixture();
    const gateway = new PlatformGateway({
      verifier,
      streams: adapter,
      decideAuthorization: allow,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
    });
    const response = await gateway.handle(
      new Request(
        "https://platform.test/api/repos/maple/reading-room/feature/blob/docs/feature.md?projection=1&reducer=file-content",
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly events: readonly { readonly type: string; readonly payload: unknown }[];
      readonly branch: { readonly headCheckpoint: string };
    };
    expect(body.events.at(-1)?.type).toBe("fs.file.write");
    expect(body.events.at(-1)?.payload).toMatchObject({
      contentBase64: base64(feature),
      contentSha256: digestBytes(feature),
    });
    expect(body.branch.headCheckpoint).toBe(offsetForOrdinal(4));
  });
});
