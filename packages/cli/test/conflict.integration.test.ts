import { appendDurableJson, createDurableJsonStream, readDurableJson } from "@eforest/client";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { createDurableStreamTestServer } from "@eforest/server";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { conflictFileName, surfaceConflict } from "../src/sync/conflict.js";

const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
let baseUrl: string;

describe("conflict surfacing integration", () => {
  beforeAll(async () => {
    baseUrl = await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it("persists the byte-exact loser before announcing the conflict event", async () => {
    const root = await mkdtemp(join(tmpdir(), "eforest-conflict-integration-"));
    const streamId = "fs:e4-t11/conflict-integration:main:meta";
    try {
      await createDurableJsonStream({ url: `${baseUrl}/streams/${encodeURIComponent(streamId)}` });
      const loser = Uint8Array.from([0, 1, 2, 255]);
      const winningOffset = offsetForOrdinal(0);
      const surfaced = surfaceConflict({
        workspaceRoot: root,
        path: "docs/data.bin",
        winningOffset,
        loserBytes: loser,
      });
      expect(await readFile(join(root, surfaced.conflictFile))).toEqual(Buffer.from(loser));
      await appendDurableJson(
        { url: `${baseUrl}/streams/${encodeURIComponent(streamId)}` },
        {
          offset: offsetForOrdinal(0),
          type: "sync/conflict",
          payload: {
            v: 1,
            path: "docs/data.bin",
            conflictFile: conflictFileName("docs/data.bin", winningOffset),
            winningOffset,
            loserSha256: surfaced.loserSha256,
          },
          ts: 1,
        },
        offsetForOrdinal(0),
      );
      const records = await readDurableJson({
        url: `${baseUrl}/streams/${encodeURIComponent(streamId)}`,
      });
      expect(records).toHaveLength(1);
      expect(records[0]!.type).toBe("sync/conflict");
      expect(records[0]!.payload).toMatchObject({ loserSha256: surfaced.loserSha256 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
