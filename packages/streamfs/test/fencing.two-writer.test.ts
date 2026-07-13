import { createHash } from "node:crypto";
import { canonicalJson, type Event } from "@eforest/protocol";
import { createHttpServer, MemoryStreamStore } from "@eforest/server";
import { describe, expect, it } from "vitest";
import { createStreamFsServerOptions, diffText, FS_EVENT_VERSION, StreamFs } from "../src/index.js";

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

function patchAction(
  path: string,
  base: string,
  previous: Uint8Array,
  target: Uint8Array,
  ts: number,
): Event {
  return {
    type: "fs.file.patch",
    payload: {
      v: FS_EVENT_VERSION,
      path,
      base,
      baseDigest: digest(previous),
      ops: diffText(decoder.decode(previous), decoder.decode(target)),
      resultDigest: digest(target),
    },
    ts,
  };
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

async function dispatch(baseUrl: string, streamId: string, action: Event) {
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

function currentRevision(records: readonly FsRecord[], path: string): string {
  let revision = "BASE_NONE";
  for (const record of records) {
    if (record.type === "fs.file.create" && record.payload.path === path) revision = "BASE_NONE";
    if (
      (record.type === "fs.file.write" || record.type === "fs.file.patch") &&
      record.payload.path === path
    ) {
      revision = record.offset;
    }
  }
  return revision;
}

describe("stream-fs two-writer fencing", () => {
  it("accepts A, refuses B at the old base, then accepts B from the 409 base", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const repo = await new StreamFs({ baseUrl }).createRepo("two-writer-golden");
      await repo.createFile("contested.txt", bytes("baseline"));
      const baseline = await repo.readFile("contested.txt");
      const revision = currentRevision((await repo.dump()) as readonly FsRecord[], "contested.txt");
      const writerA = patchAction("contested.txt", revision, baseline, bytes("writer A"), 2);
      const writerB = patchAction("contested.txt", revision, baseline, bytes("writer B"), 3);
      const accepted = await dispatch(baseUrl, repo.metadataStreamId, writerA);
      expect(accepted.status).toBe(201);
      const refused = await dispatch(baseUrl, repo.metadataStreamId, writerB);
      expect(refused.status).toBe(409);
      expect(refused.body!.error!.class).toBe("validator-rejected");
      expect(refused.body!.error!.reason).toBe("stale-base");
      expect(refused.body!.error!.conflict).toEqual({
        path: "contested.txt",
        expectedBase: accepted.body!.event!.offset,
        actualBase: revision,
      });

      const expectedBase = refused.body!.error!.conflict!.expectedBase;
      const rebased = await dispatch(
        baseUrl,
        repo.metadataStreamId,
        patchAction("contested.txt", expectedBase, bytes("writer A"), bytes("writer B"), 4),
      );
      expect(rebased.status).toBe(201);
      expect(new TextDecoder().decode(await repo.readFile("contested.txt"))).toBe("writer B");

      const records = (await repo.dump()) as readonly FsRecord[];
      expect(
        records.filter(
          (record) =>
            record.payload.path === "contested.txt" &&
            (record.type === "fs.file.write" || record.type === "fs.file.patch"),
        ),
      ).toHaveLength(3);
      expect(records.some((record) => record.payload?.base === revision && record.ts === 3)).toBe(
        false,
      );
    } finally {
      await stopServer(server);
    }
  });

  it("serializes 25 concurrent same-base races with exactly one winner each", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const repo = await new StreamFs({ baseUrl }).createRepo("two-writer-races");
      await repo.createFile("race.txt", bytes("seed"));
      for (let round = 0; round < 25; round += 1) {
        const current = await repo.readFile("race.txt");
        const revision = currentRevision((await repo.dump()) as readonly FsRecord[], "race.txt");
        const targets = [bytes(`A-${round}-${"x".repeat(round % 7)}`), bytes(`B-${round}`)];
        const results = await Promise.all(
          targets.map((target, index) =>
            dispatch(
              baseUrl,
              repo.metadataStreamId,
              patchAction("race.txt", revision, current, target, round * 2 + index),
            ),
          ),
        );
        expect(results.filter((result) => result.status === 201)).toHaveLength(1);
        expect(results.filter((result) => result.status === 409)).toHaveLength(1);
        const winnerIndex = results.findIndex((result) => result.status === 201);
        const loser = results[1 - winnerIndex]!;
        expect(loser.body!.error!.reason).toBe("stale-base");
        expect(loser.body!.error!.conflict!.expectedBase).toBe(
          results[winnerIndex]!.body!.event!.offset,
        );
        expect(loser.body!.error!.conflict!.actualBase).toBe(revision);
        expect(new TextDecoder().decode(await repo.readFile("race.txt"))).toBe(
          decoder.decode(targets[winnerIndex]!),
        );
      }
    } finally {
      await stopServer(server);
    }
  });
});
