import { canonicalJson, replay, stateDigest, type Event } from "@eforest/protocol";
import { createHttpServer, MemoryStreamStore } from "@eforest/server";
import { describe, expect, it } from "vitest";
import {
  ContentIntegrityError,
  FileExistsError,
  FileNotFoundError,
  RepoExistsError,
  RepoNotFoundError,
  StreamFs,
  createStreamFsServerOptions,
  emptyTree,
  fsReducer,
  treeDigest,
  type FsTree,
} from "../src/index.js";

async function startServer(): Promise<{
  readonly server: ReturnType<typeof createHttpServer>;
  readonly baseUrl: string;
}> {
  const server = createHttpServer(new MemoryStreamStore(), createStreamFsServerOptions());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: ReturnType<typeof createHttpServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function request(baseUrl: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, init);
}

function eventWithoutOffset(record: { readonly offset: string } & Event): Event {
  const event = { ...record } as Record<string, unknown>;
  delete event.offset;
  return event as unknown as Event;
}

describe("stream-fs core", () => {
  it("round-trips binary content, preserves the CRUD contract, and agrees across folds", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const client = new StreamFs({ baseUrl });
      const repo = await client.createRepo("alpha");
      await expect(client.createRepo("alpha")).rejects.toBeInstanceOf(RepoExistsError);
      await expect(client.openRepo("missing")).rejects.toBeInstanceOf(RepoNotFoundError);

      const initial = new Uint8Array([0, 1, 2, 0xff, 0xc3, 0xa9]);
      await repo.createFile("z/nested.bin", initial);
      await repo.createFile("a.txt", new TextEncoder().encode("first"));
      await expect(repo.createFile("a.txt", new Uint8Array([1]))).rejects.toBeInstanceOf(
        FileExistsError,
      );
      expect(Array.from(await repo.readFile("z/nested.bin"))).toEqual(Array.from(initial));

      const replacement = new TextEncoder().encode("✓ second write");
      await repo.writeFile("a.txt", replacement);
      expect(new TextDecoder().decode(await repo.readFile("a.txt"))).toBe("✓ second write");
      await expect(repo.readFile("missing.txt")).rejects.toBeInstanceOf(FileNotFoundError);

      const beforeDelete = await repo.tree();
      expect(Object.keys(beforeDelete.files)).toEqual(["a.txt", "z/nested.bin"]);
      const digestFromClient = await repo.digest();
      expect(digestFromClient).toBe(treeDigest(beforeDelete));

      const records = await repo.dump();
      const folded = replay(records.map(eventWithoutOffset), fsReducer, emptyTree()) as FsTree;
      expect(stateDigest(folded)).toBe(digestFromClient);
      const stateResponse = await request(
        baseUrl,
        `/streams/${encodeURIComponent(repo.metadataStreamId)}/state`,
      );
      expect(stateResponse.status).toBe(200);
      expect(stateDigest((await stateResponse.json()) as FsTree)).toBe(digestFromClient);

      await repo.deleteFile("a.txt");
      await repo.createFile("a.txt", new TextEncoder().encode("re-created"));
      expect(new TextDecoder().decode(await repo.readFile("a.txt"))).toBe("re-created");
    } finally {
      await stopServer(server);
    }
  });

  it("detects content-stream corruption instead of returning unverified bytes", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const repo = await new StreamFs({ baseUrl }).createRepo("integrity");
      await repo.createFile("bin", new Uint8Array([1, 2, 3]));
      const file = (await repo.tree()).files.bin!;
      const response = await request(
        baseUrl,
        `/streams/${encodeURIComponent(file.contentStreamId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "stream-seq": "1" },
          body: canonicalJson({
            events: [
              {
                type: "fs.file.content",
                payload: { v: 1, contentBase64: Buffer.from("tampered").toString("base64") },
                ts: 3,
              },
            ],
          }),
        },
      );
      expect(response.status).toBe(201);
      await expect(repo.readFile("bin")).rejects.toBeInstanceOf(ContentIntegrityError);
    } finally {
      await stopServer(server);
    }
  });

  it("refuses invalid dispatches without moving the head and keeps the door usable", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const client = new StreamFs({ baseUrl });
      const repo = await client.createRepo("refusals");
      const dispatchUrl = `${baseUrl}/streams/${encodeURIComponent(repo.metadataStreamId)}/dispatch`;
      const validCreate = (path: string): Event => ({
        type: "fs.file.create",
        payload: { v: 1, path, contentStreamId: `content-${path}` },
        ts: 1,
      });
      const invalid: readonly Event[] = [
        { type: "fs.file.unknown", payload: { v: 1, path: "x" }, ts: 1 },
        { type: "fs.file.create", payload: { v: 2, path: "x", contentStreamId: "c" }, ts: 1 },
        { type: "fs.file.create", payload: { v: 1, path: "a//b", contentStreamId: "c" }, ts: 1 },
        { type: "fs.file.create", payload: { v: 1, path: "../x", contentStreamId: "c" }, ts: 1 },
        { type: "fs.file.create", payload: { v: 1, path: "e\u0301", contentStreamId: "c" }, ts: 1 },
        {
          type: "fs.file.write",
          payload: { v: 1, path: "missing", contentSha256: "0".repeat(64), size: 0 },
          ts: 1,
        },
        { type: "fs.file.delete", payload: { v: 1, path: "missing" }, ts: 1 },
      ];
      for (const [index, action] of invalid.entries()) {
        const before = await request(
          baseUrl,
          `/streams/${encodeURIComponent(repo.metadataStreamId)}/dump`,
        );
        const beforeBody = await before.text();
        const refused = await fetch(dispatchUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: canonicalJson(action),
        });
        expect(refused.ok).toBe(false);
        const after = await request(
          baseUrl,
          `/streams/${encodeURIComponent(repo.metadataStreamId)}/dump`,
        );
        expect(await after.text()).toBe(beforeBody);

        const valid = await fetch(dispatchUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: canonicalJson(validCreate(`valid-${index}`)),
        });
        expect(valid.status, await valid.clone().text()).toBe(201);
      }
    } finally {
      await stopServer(server);
    }
  });

  it("rejects reducer-level precondition corruption", () => {
    expect(() =>
      fsReducer(emptyTree(), {
        type: "fs.file.write",
        payload: { v: 1, path: "missing", contentSha256: "0".repeat(64), size: 0 },
        ts: 1,
      }),
    ).toThrow(/missing path/);
  });
});
