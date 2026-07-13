import { type Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import type { StreamRecord } from "@eforest/client";
import { createHttpServer, MemoryStreamStore } from "@eforest/server";
import { describe, expect, it } from "vitest";
import {
  diffText,
  FS_EVENT_VERSION,
  fsEventsToWatchEvents,
  createStreamFsServerOptions,
  StreamFs,
  watch,
  type WatchEventRecord,
} from "../src/index.js";

const encoder = new TextEncoder();

function record(type: string, payload: unknown, ordinal: number): StreamRecord {
  return {
    type,
    payload,
    ts: ordinal,
    offset: offsetForOrdinal(ordinal),
  } as StreamRecord;
}

function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("watch test timed out"));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

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
  if (!address || typeof address === "string") throw new Error("watch test server did not bind");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: ReturnType<typeof createHttpServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function expectedPureMapping(): readonly WatchEventRecord[] {
  const previous = encoder.encode("one");
  return fsEventsToWatchEvents([
    record("fs.dir.create", { v: FS_EVENT_VERSION, path: "src" }, 0),
    record("fs.dir.create", { v: FS_EVENT_VERSION, path: "src/lib" }, 1),
    record(
      "fs.file.create",
      { v: FS_EVENT_VERSION, path: "src/lib/a.txt", contentStreamId: "file:a" },
      2,
    ),
    record(
      "fs.file.write",
      {
        v: FS_EVENT_VERSION,
        path: "src/lib/a.txt",
        base: "BASE_NONE",
        contentSha256: "0".repeat(64),
        size: previous.byteLength,
      },
      3,
    ),
    record(
      "fs.file.patch",
      {
        v: FS_EVENT_VERSION,
        path: "src/lib/a.txt",
        base: offsetForOrdinal(3),
        baseDigest: "0".repeat(64),
        ops: diffText("one", "two"),
        resultDigest: "1".repeat(64),
      },
      4,
    ),
    record("fs.rename", { v: FS_EVENT_VERSION, from: "src/lib/a.txt", to: "src/lib/b.txt" }, 5),
    record("fs.rename", { v: FS_EVENT_VERSION, from: "src", to: "archive" }, 6),
    record("fs.file.delete", { v: FS_EVENT_VERSION, path: "archive/lib/b.txt" }, 7),
    record("fs.dir.remove", { v: FS_EVENT_VERSION, path: "archive/lib" }, 8),
    record("fs.dir.remove", { v: FS_EVENT_VERSION, path: "archive" }, 9),
  ]).events;
}

describe("stream-fs watch mapping", () => {
  it("maps patches, file renames, and directory renames in the pinned order", () => {
    const events = expectedPureMapping();
    expect(events.map(({ event, path }) => ({ event, path }))).toEqual([
      { event: "addDir", path: "src" },
      { event: "addDir", path: "src/lib" },
      { event: "add", path: "src/lib/a.txt" },
      { event: "change", path: "src/lib/a.txt" },
      { event: "change", path: "src/lib/a.txt" },
      { event: "unlink", path: "src/lib/a.txt" },
      { event: "add", path: "src/lib/b.txt" },
      { event: "unlink", path: "src/lib/b.txt" },
      { event: "unlinkDir", path: "src/lib" },
      { event: "unlinkDir", path: "src" },
      { event: "addDir", path: "archive" },
      { event: "addDir", path: "archive/lib" },
      { event: "add", path: "archive/lib/b.txt" },
      { event: "unlink", path: "archive/lib/b.txt" },
      { event: "unlinkDir", path: "archive/lib" },
      { event: "unlinkDir", path: "archive" },
    ]);
    expect(events.every((entry) => entry.offset === offsetForOrdinal(6))).toBe(false);
    expect(new Set(events.map((entry) => entry.event))).toEqual(
      new Set(["add", "addDir", "change", "unlink", "unlinkDir"]),
    );
  });

  it.each(["long-poll", "sse"] as const)(
    "tails metadata and matches pure replay in %s mode",
    async (mode) => {
      const { server, baseUrl } = await startServer();
      try {
        const repo = await new StreamFs({ baseUrl }).createRepo(`watch-${mode}`);
        const transcript: WatchEventRecord[] = [];
        const allEvents: WatchEventRecord[] = [];
        const addedFiles: string[] = [];
        const addedDirs: string[] = [];
        const checkpoints: Offset[] = [];
        const watcher = repo.watch(".", { mode, from: { offset: "-1" as Offset } });
        watcher.onBatch((records) => transcript.push(...records));
        watcher.onAll((event, path, offset) => allEvents.push({ event, path, offset }));
        watcher.on("add", (path) => addedFiles.push(path));
        watcher.on("addDir", (path) => addedDirs.push(path));
        watcher.onCheckpoint((value) => checkpoints.push(value.offset));
        await watcher.ready;

        await repo.createFile("root.txt", encoder.encode("one"));
        await repo.mkdir("src");
        await repo.mkdir("src/lib");
        const patchBase = "A".repeat(400);
        await repo.createFile("src/lib/a.txt", encoder.encode(patchBase));
        await repo.writeFile("src/lib/a.txt", encoder.encode(`B${patchBase.slice(1)}`));
        await repo.writeFile("src/lib/a.txt", encoder.encode(`BC${patchBase.slice(2)}`));
        await repo.writeFile("src/lib/a.txt", encoder.encode(`BCD${patchBase.slice(3)}`));
        await repo.rename("src/lib/a.txt", "src/lib/b.txt");
        await repo.rename("src", "archive");
        await repo.deleteFile("archive/lib/b.txt");
        await repo.rmdir("archive/lib");
        await repo.rmdir("archive");

        const metadata = await repo.dump();
        const expected = fsEventsToWatchEvents(metadata).events;
        await waitFor(() => transcript.length === expected.length);
        await watcher.close();
        expect(transcript).toEqual(expected);
        expect(allEvents).toEqual(expected);
        expect(addedFiles).toEqual(
          expected.filter((entry) => entry.event === "add").map((entry) => entry.path),
        );
        expect(addedDirs).toEqual(
          expected.filter((entry) => entry.event === "addDir").map((entry) => entry.path),
        );
        expect(checkpoints).toHaveLength(metadata.length);
        expect(watcher.checkpoint().offset).toBe(metadata.at(-1)!.offset);
        expect(new Set(transcript.map((entry) => entry.event))).toEqual(
          new Set(["add", "addDir", "change", "unlink", "unlinkDir"]),
        );
        expect(transcript.map((entry) => entry.offset)).toEqual(
          [...transcript.map((entry) => entry.offset)].sort(),
        );
        const patchOffsets = metadata
          .filter((entry) => entry.type === "fs.file.patch")
          .map((entry) => entry.offset);
        expect(patchOffsets).not.toHaveLength(0);
        for (const offset of patchOffsets) {
          expect(transcript.filter((entry) => entry.offset === offset)).toEqual([
            { event: "change", path: "src/lib/a.txt", offset },
          ]);
        }
        const directoryRename = metadata.find(
          (entry) =>
            entry.type === "fs.rename" && (entry.payload as { from?: unknown }).from === "src",
        );
        expect(directoryRename).toBeDefined();
        const renameEvents = transcript.filter((entry) => entry.offset === directoryRename!.offset);
        expect(renameEvents.map(({ event, path }) => ({ event, path }))).toEqual([
          { event: "unlink", path: "src/lib/b.txt" },
          { event: "unlinkDir", path: "src/lib" },
          { event: "unlinkDir", path: "src" },
          { event: "addDir", path: "archive" },
          { event: "addDir", path: "archive/lib" },
          { event: "add", path: "archive/lib/b.txt" },
        ]);
      } finally {
        await stopServer(server);
      }
    },
  );

  it("filters a non-dot root while preserving custom transport and checkpoint options", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const repo = await new StreamFs({ baseUrl }).createRepo("watch-root");
      let fetchCalls = 0;
      const visible: WatchEventRecord[] = [];
      const watcher = repo.watch("src", {
        mode: "long-poll",
        from: { offset: "-1" as Offset },
        reconnectDelayMs: 0,
        fetch: async (input, init) => {
          fetchCalls += 1;
          return fetch(input, init);
        },
      });
      watcher.onAll((event, path, offset) => visible.push({ event, path, offset }));
      await watcher.ready;
      await repo.mkdir("src");
      await repo.createFile("src/a.txt", encoder.encode("a"));
      await repo.mkdir("outside");
      await waitFor(() => visible.length === 3);
      await watcher.close();
      expect(visible.map(({ event, path }) => ({ event, path }))).toEqual([
        { event: "addDir", path: "src" },
        { event: "add", path: "src/a.txt" },
        { event: "change", path: "src/a.txt" },
      ]);
      expect(fetchCalls).toBeGreaterThan(0);
    } finally {
      await stopServer(server);
    }
  });

  it("surfaces bootstrap transport errors to the error listener", async () => {
    const errors: unknown[] = [];
    const watcher = watch(".", {
      baseUrl: "http://watch.invalid",
      streamId: "synthetic",
      mode: "long-poll",
      from: { offset: "-1" as Offset },
      fetch: async () => {
        throw new Error("synthetic watch transport failure");
      },
    });
    watcher.on("error", (error) => errors.push(error));
    await expect(watcher.ready).rejects.toThrow("synthetic watch transport failure");
    expect(errors).toHaveLength(1);
  });
});
