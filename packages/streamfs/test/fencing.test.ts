import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, stateDigest, type Event } from "@eforest/protocol";
import { createHttpServer, MemoryStreamStore } from "@eforest/server";
import { describe, expect, it } from "vitest";
import {
  BASE_NONE,
  createStreamFsServerOptions,
  diffText,
  FS_EVENT_VERSION,
  StreamFs,
  treeDigest,
  type FsTree,
} from "../src/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface FsRecord {
  readonly offset: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly ts?: number;
}

interface DispatchBody {
  readonly error?: {
    readonly class?: string;
    readonly reason?: string;
    readonly field?: string;
    readonly conflict?: {
      readonly path: string;
      readonly expectedBase: string;
      readonly actualBase: string;
    };
  };
  readonly event?: { readonly offset: string };
}

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function event(type: string, payload: unknown, ts = 1): Event {
  return { type, payload, ts } as Event;
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
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: ReturnType<typeof createHttpServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function dispatch(
  baseUrl: string,
  streamId: string,
  action: Event,
): Promise<{ readonly status: number; readonly body: DispatchBody | undefined }> {
  const response = await fetch(`${baseUrl}/streams/${encodeURIComponent(streamId)}/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: canonicalJson(action),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? undefined : (JSON.parse(text) as DispatchBody),
  };
}

async function snapshot(baseUrl: string, streamId: string) {
  const dumpResponse = await fetch(`${baseUrl}/streams/${encodeURIComponent(streamId)}/dump`);
  const dump = await dumpResponse.text();
  const stateResponse = await fetch(`${baseUrl}/streams/${encodeURIComponent(streamId)}/state`);
  const stateText = await stateResponse.text();
  const state = JSON.parse(stateText) as FsTree;
  return {
    dump,
    stateText,
    head: dumpResponse.headers.get("stream-next-offset"),
    count: dump.length === 0 ? 0 : dump.trimEnd().split("\n").length,
    digest: stateDigest(state),
  };
}

function revisionFromLog(records: readonly FsRecord[], path: string): string {
  const revisions = new Map<string, string>();
  for (const record of records) {
    const pathValue = record.payload.path as string;
    if (record.type === "fs.file.create") revisions.set(pathValue, BASE_NONE);
    else if (record.type === "fs.file.write" || record.type === "fs.file.patch") {
      revisions.set(pathValue, record.offset);
    } else if (record.type === "fs.file.delete") {
      revisions.delete(pathValue);
    } else if (record.type === "fs.rename") {
      const from = record.payload.from as string;
      const to = record.payload.to as string;
      const revision = revisions.get(from);
      revisions.delete(from);
      if (revision !== undefined) revisions.set(to, revision);
    }
  }
  return revisions.get(path) ?? BASE_NONE;
}

function patchAction(
  path: string,
  base: string,
  previous: Uint8Array,
  target: Uint8Array,
  ts: number,
): Event {
  return event(
    "fs.file.patch",
    {
      v: FS_EVENT_VERSION,
      path,
      base,
      baseDigest: digest(previous),
      ops: diffText(decoder.decode(previous), decoder.decode(target)),
      resultDigest: digest(target),
    },
    ts,
  );
}

function fullAction(path: string, base: string, target: Uint8Array, ts: number): Event {
  return event(
    "fs.file.write",
    {
      v: FS_EVENT_VERSION,
      path,
      base,
      contentSha256: digest(target),
      size: target.byteLength,
    },
    ts,
  );
}

function assertStale(
  result: { readonly status: number; readonly body: DispatchBody | undefined },
  path: string,
  expectedBase: string,
  actualBase: string,
): void {
  expect(result.status).toBe(409);
  expect(result.body?.error?.class).toBe("validator-rejected");
  expect(result.body?.error?.reason).toBe("stale-base");
  expect(result.body?.error?.conflict).toEqual({ path, expectedBase, actualBase });
  expect(Object.keys(result.body?.error?.conflict ?? {}).sort()).toEqual([
    "actualBase",
    "expectedBase",
    "path",
  ]);
}

describe("stale-write fencing", () => {
  it("refuses stale writes and patches without changing any metadata surface", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const repo = await new StreamFs({ baseUrl }).createRepo("fencing-neutrality");
      await repo.createFile("note.txt", bytes("seed content"));
      await repo.createFile("other.txt", bytes("other content"));
      const records = (await repo.dump()) as readonly FsRecord[];
      const expectedBase = revisionFromLog(records, "note.txt");
      const otherBase = revisionFromLog(records, "other.txt");
      const previous = await repo.readFile("note.txt");
      const before = await snapshot(baseUrl, repo.metadataStreamId);

      const staleWrite = await dispatch(
        baseUrl,
        repo.metadataStreamId,
        fullAction("note.txt", BASE_NONE, bytes("never lands"), 100),
      );
      assertStale(staleWrite, "note.txt", expectedBase, BASE_NONE);
      expect(await snapshot(baseUrl, repo.metadataStreamId)).toEqual(before);

      const stalePatch = await dispatch(
        baseUrl,
        repo.metadataStreamId,
        patchAction("note.txt", BASE_NONE, previous, bytes("stale patch"), 101),
      );
      assertStale(stalePatch, "note.txt", expectedBase, BASE_NONE);
      expect(await snapshot(baseUrl, repo.metadataStreamId)).toEqual(before);

      const foreignBase = await dispatch(
        baseUrl,
        repo.metadataStreamId,
        patchAction("note.txt", otherBase, previous, bytes("foreign"), 102),
      );
      assertStale(foreignBase, "note.txt", expectedBase, otherBase);
      expect(await snapshot(baseUrl, repo.metadataStreamId)).toEqual(before);

      const futureBase = await dispatch(
        baseUrl,
        repo.metadataStreamId,
        fullAction("note.txt", "future-offset", bytes("future"), 103),
      );
      assertStale(futureBase, "note.txt", expectedBase, "future-offset");
      expect(await snapshot(baseUrl, repo.metadataStreamId)).toEqual(before);

      const missingBase = await dispatch(
        baseUrl,
        repo.metadataStreamId,
        event(
          "fs.file.write",
          {
            v: FS_EVENT_VERSION,
            path: "note.txt",
            contentSha256: digest(bytes("missing")),
            size: 7,
          },
          104,
        ),
      );
      expect(missingBase.status).toBe(422);
      expect(missingBase.body?.error?.class).toBe("schema-violation");
      expect(missingBase.body?.error?.field).toBe("base");

      const mistypedBase = await dispatch(
        baseUrl,
        repo.metadataStreamId,
        event(
          "fs.file.patch",
          {
            v: FS_EVENT_VERSION,
            path: "note.txt",
            base: 123,
            baseDigest: digest(previous),
            ops: [["=", previous.byteLength]],
            resultDigest: digest(previous),
          },
          105,
        ),
      );
      expect(mistypedBase.status).toBe(422);
      expect(mistypedBase.body?.error?.class).toBe("schema-violation");
      expect(mistypedBase.body?.error?.field).toBe("base");

      const burstBefore = await snapshot(baseUrl, repo.metadataStreamId);
      const burst = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          dispatch(
            baseUrl,
            repo.metadataStreamId,
            index % 2 === 0
              ? fullAction("note.txt", BASE_NONE, bytes(`burst-${index}`), 200 + index)
              : patchAction("note.txt", BASE_NONE, previous, bytes(`burst-${index}`), 200 + index),
          ),
        ),
      );
      expect(burst.every((result) => result.status === 409)).toBe(true);
      expect(burst.every((result) => result.body?.error?.reason === "stale-base")).toBe(true);
      expect(await snapshot(baseUrl, repo.metadataStreamId)).toEqual(burstBefore);
      expect(before.head).toBe(burstBefore.head);
      expect(before.count).toBe(burstBefore.count);
      expect(before.digest).toBe(burstBefore.digest);
    } finally {
      await stopServer(server);
    }
  });

  it("pins sentinel, rename, tombstone, ABA, and correct-base chain rules", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const repo = await new StreamFs({ baseUrl }).createRepo("fencing-edges");
      const createOnly = await dispatch(
        baseUrl,
        repo.metadataStreamId,
        event("fs.file.create", {
          v: FS_EVENT_VERSION,
          path: "first.txt",
          contentStreamId: "manual:first",
        }),
      );
      expect(createOnly.status).toBe(201);
      const firstWrite = await dispatch(
        baseUrl,
        repo.metadataStreamId,
        fullAction("first.txt", BASE_NONE, bytes("first"), 2),
      );
      expect(firstWrite.status).toBe(201);
      const firstRevision = firstWrite.body!.event!.offset;
      const firstFile = (await repo.tree()).files["first.txt"]!;
      expect(firstFile.lastContentOffset).toBe(firstRevision);

      const patchNone = await dispatch(
        baseUrl,
        repo.metadataStreamId,
        patchAction("first.txt", BASE_NONE, bytes("first"), bytes("patch"), 3),
      );
      assertStale(patchNone, "first.txt", firstRevision, BASE_NONE);

      await repo.createFile("tombstone.txt", bytes("old"));
      await repo.deleteFile("tombstone.txt");
      const recreated = await dispatch(
        baseUrl,
        repo.metadataStreamId,
        event(
          "fs.file.create",
          {
            v: FS_EVENT_VERSION,
            path: "tombstone.txt",
            contentStreamId: "manual:recreated",
          },
          4,
        ),
      );
      expect(recreated.status).toBe(201);
      const recreatedWrite = await dispatch(
        baseUrl,
        repo.metadataStreamId,
        fullAction("tombstone.txt", BASE_NONE, bytes("new"), 5),
      );
      expect(recreatedWrite.status).toBe(201);

      await repo.createFile("rename-source.txt", bytes("source"));
      const renamedBefore = (await repo.tree()).files["rename-source.txt"]!;
      const renamedBytes = await repo.readFile("rename-source.txt");
      await repo.rename("rename-source.txt", "rename-target.txt");
      const renamePatch = await dispatch(
        baseUrl,
        repo.metadataStreamId,
        patchAction(
          "rename-target.txt",
          renamedBefore.lastContentOffset,
          renamedBytes,
          bytes("renamed target"),
          6,
        ),
      );
      expect(renamePatch.status).toBe(201);

      await repo.createFile("aba.txt", bytes("X"));
      const abaFirst = (await repo.tree()).files["aba.txt"]!.lastContentOffset;
      let abaBytes = bytes("X");
      for (const target of ["Y", "X"]) {
        const current = (await repo.tree()).files["aba.txt"]!;
        const result = await dispatch(
          baseUrl,
          repo.metadataStreamId,
          patchAction("aba.txt", current.lastContentOffset, abaBytes, bytes(target), 10),
        );
        expect(result.status).toBe(201);
        abaBytes = bytes(target);
      }
      const abaCurrent = (await repo.tree()).files["aba.txt"]!;
      expect(abaCurrent.lastContentOffset).not.toBe(abaFirst);
      const abaRefusal = await dispatch(
        baseUrl,
        repo.metadataStreamId,
        patchAction("aba.txt", abaFirst, abaBytes, bytes("Z"), 11),
      );
      assertStale(abaRefusal, "aba.txt", abaCurrent.lastContentOffset, abaFirst);

      const chainRoot = mkdtempSync(join(tmpdir(), "eforest-fencing-chain-"));
      try {
        const chainPath = join(chainRoot, "chain.txt");
        let expected = "seed";
        writeFileSync(chainPath, expected);
        const chainRepo = await new StreamFs({ baseUrl }).createRepo("fencing-chain");
        await chainRepo.createFile("chain.txt", bytes(expected));
        for (let index = 0; index < 60; index += 1) {
          expected = `${expected}:${index}:🌲`;
          writeFileSync(chainPath, expected);
          await chainRepo.writeFile("chain.txt", bytes(expected));
        }
        const independentBytes = readFileSync(chainPath);
        const chainRecords = (await chainRepo.dump()) as readonly FsRecord[];
        const chainFile = (await chainRepo.tree()).files["chain.txt"]!;
        const independentState = {
          files: {
            "chain.txt": {
              contentStreamId: chainFile.contentStreamId,
              contentSha256: digest(independentBytes),
              size: independentBytes.byteLength,
              lastContentOffset: revisionFromLog(chainRecords, "chain.txt"),
            },
          },
          dirs: {},
          tombstones: {},
        };
        const independentDigest = createHash("sha256")
          .update(canonicalJson(independentState))
          .digest("hex");
        expect(treeDigest(await chainRepo.tree())).toBe(independentDigest);
        expect(new TextDecoder().decode(independentBytes)).toBe(expected);
      } finally {
        rmSync(chainRoot, { recursive: true, force: true });
      }
    } finally {
      await stopServer(server);
    }
  });
});
