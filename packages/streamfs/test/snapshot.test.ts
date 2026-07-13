import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJson, compareOffsets, replay, stateDigest, type Offset } from "@eforest/protocol";
import { StreamGoneError, StreamReader } from "@eforest/client";
import { createHttpServer, FileStreamStore, MemoryStreamStore } from "@eforest/server";
import { describe, expect, it } from "vitest";
import {
  createStreamFsServerOptions,
  emptyTree,
  fsReducer,
  SnapshotIntegrityError,
  StreamFs,
  bootstrapRead,
  contentMap,
  type SnapshotRoot,
  type FsTree,
} from "../src/index.js";

interface RunningServer {
  readonly server: ReturnType<typeof createHttpServer>;
  readonly baseUrl: string;
  readonly dataDir: string | undefined;
}

async function startServer(
  kind: "memory" | "file",
  existingDataDir?: string,
): Promise<RunningServer> {
  const dataDir =
    kind === "file"
      ? (existingDataDir ?? mkdtempSync(join(tmpdir(), "eforest-snapshot-")))
      : undefined;
  const store = kind === "file" ? new FileStreamStore(dataDir!) : new MemoryStreamStore();
  const server = createHttpServer(store, createStreamFsServerOptions());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("snapshot server did not bind");
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, dataDir };
}

async function stopServer(running: RunningServer, removeDataDir = true): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    running.server.close((error) => (error ? reject(error) : resolve()));
  });
  if (removeDataDir && running.dataDir !== undefined) {
    rmSync(running.dataDir, { recursive: true, force: true });
  }
}

async function scenario(repo: Awaited<ReturnType<StreamFs["createRepo"]>>) {
  await repo.mkdir("src");
  await repo.mkdir("src/nested");
  const patchBase = "A".repeat(400);
  await repo.createFile("src/a.txt", new TextEncoder().encode(patchBase));
  await repo.createFile("src/nested/b.txt", new TextEncoder().encode("bravo\n"));
  for (const value of [
    `B${patchBase.slice(1)}`,
    `BC${patchBase.slice(2)}`,
    `BCD${patchBase.slice(3)}`,
  ]) {
    await repo.writeFile("src/a.txt", new TextEncoder().encode(value));
  }
  const beforeSnapshot = await repo.dump();
  const snapshot = await repo.createSnapshot();
  await repo.rename("src/nested", "moved");
  await repo.deleteFile("src/a.txt");
  await repo.createFile("src/a.txt", new TextEncoder().encode("re-created\n"));
  const full = await repo.dump();
  return { beforeSnapshot, snapshot, full };
}

describe.each(["memory", "file"] as const)("snapshots and retention: %s", (kind) => {
  it("bootstraps a patch/rename/delete-recreate log and enforces the exact retention boundary", async () => {
    const running = await startServer(kind);
    try {
      const repo = await new StreamFs({ baseUrl: running.baseUrl }).createRepo(`snap-${kind}`);
      const { snapshot, full } = await scenario(repo);
      const patchCount = full.filter((record) => record.type === "fs.file.patch").length;
      expect(patchCount).toBeGreaterThanOrEqual(3);
      expect(full.some((record) => record.type === "fs.rename")).toBe(true);
      expect(full.filter((record) => record.type === "fs.file.delete")).toHaveLength(1);
      expect(full.filter((record) => record.type === "fs.file.create").length).toBeGreaterThan(2);

      const metadataUrl = `${running.baseUrl}/streams/${encodeURIComponent(repo.metadataStreamId)}`;
      const beforeCompact = await fetch(`${metadataUrl}?offset=-1`);
      expect(beforeCompact.status).toBe(200);
      expect(await beforeCompact.json()).toEqual(full);

      const expected = replay(full, fsReducer, emptyTree()) as FsTree;
      const expectedDigest = stateDigest(expected);
      expect(expectedDigest).toBe(await repo.digest());
      await repo.compactSnapshot();

      if (kind === "file") {
        const restarted = await startServer(kind, running.dataDir);
        try {
          const reopened = await new StreamFs({ baseUrl: restarted.baseUrl }).openRepo(
            `snap-${kind}`,
          );
          expect((await reopened.bootstrapRead()).stateDigest).toBe(expectedDigest);
          expect(new TextDecoder().decode(await reopened.readFile("moved/b.txt"))).toBe("bravo\n");
        } finally {
          await stopServer(restarted, false);
        }
      }

      const gone = await fetch(`${metadataUrl}?offset=-1`);
      expect(gone.status).toBe(410);
      expect(gone.headers.get("stream-snapshot-offset")).toBe(snapshot.snapshotOffset);
      expect(await gone.text()).toBe(
        canonicalJson({ error: "gone", snapshotOffset: snapshot.snapshotOffset }),
      );
      const boundary = await fetch(
        `${metadataUrl}?offset=${encodeURIComponent(snapshot.snapshotOffset)}`,
      );
      expect(boundary.status).toBe(200);
      expect((await boundary.json())[0]?.offset).toBe(snapshot.snapshotOffset);

      const staleReader = new StreamReader({
        baseUrl: running.baseUrl,
        streamId: repo.metadataStreamId,
      });
      await expect(staleReader.read("-1" as Offset).next()).rejects.toBeInstanceOf(StreamGoneError);
      const resumedReader = new StreamReader({
        baseUrl: running.baseUrl,
        streamId: repo.metadataStreamId,
      });
      const resumed = resumedReader.tail(snapshot.snapshotOffset, { mode: "long-poll" });
      const resumedBatch = await resumed.next();
      expect(resumedBatch.done).toBe(false);
      expect(resumedBatch.value?.events).toEqual(
        full.filter((record) => compareOffsets(record.offset, snapshot.snapshotOffset) > 0),
      );
      await resumed.return(undefined);

      const bootstrap = await repo.bootstrapRead();
      expect(bootstrap.stateDigest).toBe(expectedDigest);
      expect(stateDigest(bootstrap.state)).toBe(expectedDigest);
      expect([...contentMap(bootstrap.state).keys()]).toHaveLength(2);
      expect((await repo.tree()).files["src/a.txt"]?.contentSha256).toBe(
        expected.files["src/a.txt"]?.contentSha256,
      );
      expect(new TextDecoder().decode(await repo.readFile("moved/b.txt"))).toBe("bravo\n");
      expect(new TextDecoder().decode(await repo.readFile("src/a.txt"))).toBe("re-created\n");

      const artifactResponse = await repo.fetcher(
        `${running.baseUrl}/streams/${encodeURIComponent(snapshot.contentRef)}?offset=-1`,
      );
      const artifactBody = (await artifactResponse.json()) as Array<Record<string, unknown>>;
      const artifactPayload = artifactBody[0]?.payload as Record<string, unknown>;
      const artifactBytes = Buffer.from(String(artifactPayload.contentBase64), "base64");
      const positions = new Set([0, artifactBytes.length - 1]);
      let seed = 0x7e1a07;
      while (positions.size < 18) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        positions.add(1 + (seed % Math.max(1, artifactBytes.length - 2)));
      }
      for (const position of positions) {
        const corruptRoot: SnapshotRoot = {
          ...repo,
          fetcher: async (input, init) => {
            const response = await repo.fetcher(input, init);
            if (
              String(input).includes(`${encodeURIComponent(snapshot.contentRef)}?offset=`) &&
              init?.method === undefined
            ) {
              const body = (await response.json()) as Array<Record<string, unknown>>;
              const payload = body[0]?.payload as Record<string, unknown>;
              const bytes = Buffer.from(String(payload.contentBase64), "base64");
              bytes[position] = (bytes[position] ?? 0) ^ 1;
              payload.contentBase64 = bytes.toString("base64");
              return new Response(JSON.stringify(body), { status: response.status });
            }
            return response;
          },
        };
        try {
          await bootstrapRead(corruptRoot);
          throw new Error(`corruption position ${position} unexpectedly bootstrapped`);
        } catch (error) {
          if (!(error instanceof SnapshotIntegrityError)) {
            throw new Error(
              `corruption position ${position} produced ${error instanceof Error ? error.stack : String(error)}`,
              { cause: error },
            );
          }
        }
      }
      const truncatedRoot: SnapshotRoot = {
        ...repo,
        fetcher: async (input, init) => {
          const response = await repo.fetcher(input, init);
          if (
            String(input).includes(`${encodeURIComponent(snapshot.contentRef)}?offset=`) &&
            init?.method === undefined
          ) {
            const body = (await response.json()) as Array<Record<string, unknown>>;
            const payload = body[0]?.payload as Record<string, unknown>;
            const bytes = Buffer.from(String(payload.contentBase64), "base64");
            payload.contentBase64 = bytes.subarray(0, bytes.length - 1).toString("base64");
            return new Response(JSON.stringify(body), { status: response.status });
          }
          return response;
        },
      };
      await expect(bootstrapRead(truncatedRoot)).rejects.toBeInstanceOf(SnapshotIntegrityError);

      const staleWatcher = repo.watch(".", { from: "-1" as Offset });
      await expect(staleWatcher.ready).rejects.toBeInstanceOf(StreamGoneError);
      await staleWatcher.close();

      const survivingWatcher = repo.watch(".", { from: full.at(-1)!.offset });
      await expect(survivingWatcher.ready).resolves.toBeUndefined();
      await survivingWatcher.close();
    } finally {
      await stopServer(running);
    }
  }, 30_000);

  it("does not compact until explicitly requested and advances to the newest snapshot", async () => {
    const running = await startServer(kind);
    try {
      const repo = await new StreamFs({ baseUrl: running.baseUrl }).createRepo(`cycles-${kind}`);
      await repo.createFile("one.txt", new TextEncoder().encode("one"));
      const first = await repo.createSnapshot();
      await repo.writeFile("one.txt", new TextEncoder().encode("two"), { forceFull: true });
      const before = await repo.dump();
      const second = await repo.createSnapshot();
      const metadataUrl = `${running.baseUrl}/streams/${encodeURIComponent(repo.metadataStreamId)}`;
      expect((await fetch(`${metadataUrl}?offset=-1`)).status).toBe(200);
      await repo.compactSnapshot();
      const oldGone = await fetch(`${metadataUrl}?offset=-1`);
      expect(oldGone.status).toBe(410);
      expect(oldGone.headers.get("stream-snapshot-offset")).toBe(second.snapshotOffset);
      const oldBoundary = await fetch(
        `${metadataUrl}?offset=${encodeURIComponent(first.snapshotOffset)}`,
      );
      expect(oldBoundary.status).toBe(410);
      const after = await repo.dump();
      expect(after.some((record) => record.offset === first.snapshotEventOffset)).toBe(false);
      expect(after.some((record) => record.offset === second.snapshotEventOffset)).toBe(true);
      const expected = replay(before, fsReducer, emptyTree()) as FsTree;
      expect((await repo.bootstrapRead()).stateDigest).toBe(stateDigest(expected));

      await repo.compactSnapshot();
      await repo.writeFile("one.txt", new TextEncoder().encode("three"), { forceFull: true });
      const afterCompaction = await repo.tree();
      const third = await repo.createSnapshot();
      expect(third.snapshotOffset).not.toBe(second.snapshotOffset);
      expect(third.stateDigest).toBe(stateDigest(afterCompaction));
      await repo.compactSnapshot();
      expect((await repo.bootstrapRead()).stateDigest).toBe(stateDigest(afterCompaction));
    } finally {
      await stopServer(running);
    }
  }, 30_000);

  it("creates a snapshot from a single-record NDJSON metadata dump", async () => {
    const running = await startServer(kind);
    try {
      const repo = await new StreamFs({ baseUrl: running.baseUrl }).createRepo(`single-${kind}`);
      await repo.mkdir("only");
      const receipt = await repo.createSnapshot();
      expect((await repo.bootstrapRead()).stateDigest).toBe(receipt.stateDigest);
      await repo.compactSnapshot();
      expect((await repo.tree()).dirs).toEqual({ only: {} });
    } finally {
      await stopServer(running);
    }
  }, 30_000);

  it("refuses a snapshot whose anchor is beyond the stream head on both stores", async () => {
    const running = await startServer(kind);
    try {
      const streamId = `future-${kind}`;
      const streamUrl = `${running.baseUrl}/streams/${encodeURIComponent(streamId)}`;
      expect(
        (
          await fetch(streamUrl, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: canonicalJson({ type: "snapshot-test", version: 1 }),
          })
        ).status,
      ).toBe(201);
      const futureOffset = "0000000000000000_0000000000000010" as Offset;
      const append = await fetch(streamUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "stream-seq": "0" },
        body: canonicalJson({
          events: [
            {
              type: "fs.snapshot",
              payload: {
                contentRef: "future-artifact",
                formatVersion: 1,
                snapshotOffset: futureOffset,
                stateDigest: "b".repeat(64),
              },
              ts: 1,
            },
          ],
        }),
      });
      expect(append.status).toBe(201);
      const before = await (await fetch(`${streamUrl}/dump`)).text();
      const compact = await fetch(`${streamUrl}/compact`, { method: "POST" });
      expect(compact.status).toBe(409);
      expect(await compact.json()).toMatchObject({
        error: "invalid_snapshot",
        snapshotOffset: futureOffset,
      });
      expect(await (await fetch(`${streamUrl}/dump`)).text()).toBe(before);
    } finally {
      await stopServer(running);
    }
  }, 30_000);
});
