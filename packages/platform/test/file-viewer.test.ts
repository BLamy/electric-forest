import { emptyView } from "@eforest/identity";
import type { Event } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { digestBytes } from "@eforest/streamfs";
import { describe, expect, it } from "vitest";
import { PlatformGateway, type AuthorizationVerifier, type StreamAdapter } from "../src/index.js";
import type { AuthzInput } from "../src/authz/decide.js";

const metadataStream = "fs:maple/reading-room:main:meta";
const contentStream = "fs:maple/reading-room:main:file:viewer";
const encoder = new TextEncoder();

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function record(ordinal: number, event: Event) {
  return { ...event, offset: offsetForOrdinal(ordinal) };
}

class MemoryAdapter implements StreamAdapter {
  constructor(readonly streams: ReadonlyMap<string, readonly unknown[]>) {}

  async create(): Promise<void> {}

  async append(): Promise<void> {}

  async read(streamId: string): Promise<readonly unknown[]> {
    return this.streams.get(streamId) ?? [];
  }

  async *follow(): AsyncIterable<unknown> {
    yield* [];
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
    streamId: metadataStream,
  };
}

function projectionRequest(path = "docs/readme.md", query = "projection=1&reducer=file-content") {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return new Request(
    `https://platform.test/api/repos/maple/reading-room/main/blob/${encodedPath}?${query}`,
  );
}

function fixture(patchBase = "hello world\n") {
  const initial = encoder.encode("hello world\n");
  const result = encoder.encode("hello durable streams\n");
  const metadata = [
    record(0, { type: "fs.dir.create", payload: { v: 2, path: "docs" }, ts: 1 }),
    record(1, {
      type: "fs.file.create",
      payload: { v: 2, path: "docs/readme.md", contentStreamId: contentStream },
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
    record(3, {
      type: "fs.file.patch",
      payload: {
        v: 2,
        path: "docs/readme.md",
        base: "BASE_NONE",
        baseDigest: digestBytes(encoder.encode(patchBase)),
        ops: [
          ["=", 6],
          ["+", "durable streams"],
          ["-", 5],
          ["=", 1],
        ],
        resultDigest: digestBytes(result),
      },
      ts: 4,
    }),
  ];
  const content = [
    record(0, {
      type: "fs.file.content",
      payload: { v: 2, contentStreamId: contentStream, contentBase64: base64(initial) },
      ts: 1,
    }),
  ];
  return { metadata, content, initial, result };
}

function gateway(fixtureValue = fixture()): PlatformGateway {
  return new PlatformGateway({
    verifier,
    streams: new MemoryAdapter(
      new Map([
        [metadataStream, fixtureValue.metadata],
        [contentStream, fixtureValue.content],
      ]),
    ),
    decideAuthorization: allow,
    namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
  });
}

describe("live patch-aware file projection", () => {
  it("joins the sidecar generation and replays bytes through one reducer contract", async () => {
    const fixtureValue = fixture();
    const response = await gateway(fixtureValue).handle(projectionRequest());

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly events: readonly { readonly type: string; readonly payload: unknown }[];
      readonly checkpoint: string;
      readonly reducer: { readonly id: string; readonly version: number };
    };
    expect(body.reducer).toEqual({ id: "file-content", version: 1 });
    expect(body.events).toHaveLength(5);
    expect(body.events.map((event) => event.type)).toEqual([
      "file.view.target",
      "fs.dir.create",
      "fs.file.create",
      "fs.file.write",
      "fs.file.patch",
    ]);
    expect(body.checkpoint).toBe(offsetForOrdinal(4));
    expect(body.events[3]?.payload).toMatchObject({
      contentBase64: base64(fixtureValue.initial),
      contentSha256: digestBytes(fixtureValue.initial),
      size: fixtureValue.initial.byteLength,
    });
  });

  it("refuses a corrupt patch base before exposing a partially reduced file", async () => {
    const response = await gateway(fixture("different base\n")).handle(projectionRequest());

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: {
        class: "malformed_application_event",
        offset: offsetForOrdinal(3),
        reason: expect.stringContaining("patch base digest mismatch"),
      },
    });
  });

  it("rejects missing projection and malformed encoded paths without reading content", async () => {
    const platform = gateway();
    const missingProjection = await platform.handle(
      projectionRequest("docs/readme.md", "reducer=file-content"),
    );
    expect(missingProjection.status).toBe(400);
    expect(await missingProjection.json()).toMatchObject({
      error: { reason: "projection_required" },
    });

    const encodedSeparator = await platform.handle(
      new Request(
        "https://platform.test/api/repos/maple/reading-room/main/blob/docs%2Freadme.md?projection=1&reducer=file-content",
      ),
    );
    expect(encodedSeparator.status).toBe(404);

    const invalidPath = await platform.handle(
      new Request(
        "https://platform.test/api/repos/maple/reading-room/main/blob/docs/%00/readme.md?projection=1&reducer=file-content",
      ),
    );
    expect(invalidPath.status).toBe(404);
  });
});
