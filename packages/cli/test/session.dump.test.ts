import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendDurableJson, createDurableJsonStream } from "@eforest/client";
import { createDurableStreamTestServer } from "@eforest/server";
import { captureSession, replaySessionDirectory } from "../src/session/dump.js";
import {
  parseSessionManifest,
  sessionDumpFileName,
  type SessionManifest,
  type SessionRecord,
} from "../src/session/manifest.js";

const repo = resolve(import.meta.dirname, "../../..");
const fixture = join(repo, "packages/cli/fixtures/sessions/issue-to-merge");
const expected = JSON.parse(await readFile(join(fixture, "expected.json"), "utf8")) as {
  readonly composite: string;
  readonly links: { readonly resolved: number };
  readonly streams: readonly {
    readonly stream: string;
    readonly dumpDigest: string;
    readonly digest: string;
  }[];
};
const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
const scratch = await mkdtemp(join(tmpdir(), "eforest-session-dump-"));
let baseUrl = "";

function streamUrl(stream: string): string {
  return `${baseUrl}/streams/${encodeURIComponent(stream)}`;
}

async function seedStream(stream: string, records: readonly SessionRecord[]): Promise<void> {
  await createDurableJsonStream({ url: streamUrl(stream) });
  for (const record of records) {
    await appendDurableJson({ url: streamUrl(stream) }, record, record.offset);
  }
}

beforeAll(async () => {
  baseUrl = await server.start();
  const manifest = parseSessionManifest(await readFile(join(fixture, "session.json"), "utf8"));
  for (const entry of manifest.streams) {
    const records = (await readFile(join(fixture, sessionDumpFileName(entry.stream)), "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as SessionRecord);
    await seedStream(entry.stream, records);
  }
  await seedStream("issue:maple/reading-room/unrelated", [
    {
      offset: "0000000000000000_0000000000000000",
      type: "issue.opened",
      payload: { v: 1, title: "Unrelated", body: "Must not be swept into the closure" },
      ts: 99,
    },
  ]);
});

afterAll(async () => {
  await server.stop();
  await rm(scratch, { recursive: true, force: true });
});

describe("session dump capture", () => {
  it("captures exactly the seven-member closure and is born replay-verified", async () => {
    const out = join(scratch, "captured");
    const captured = await captureSession({
      server: baseUrl,
      root: "pr:maple/reading-room/negotiation",
      out,
    });

    expect(captured.manifest.streams).toHaveLength(7);
    expect(captured.manifest.streams.map(({ stream }) => stream)).not.toContain(
      "issue:maple/reading-room/unrelated",
    );
    expect(captured.replay.digest).toBe(expected.composite);
    expect(captured.replay.links.resolved).toBe(expected.links.resolved);
    expect(captured.replay.streams).toEqual(
      expected.streams.map((stream) => expect.objectContaining(stream)),
    );

    const replayed = await replaySessionDirectory(out);
    expect(replayed).toEqual(captured.replay);
    const manifestText = await readFile(join(out, "session.json"), "utf8");
    const parsed = parseSessionManifest(manifestText) as SessionManifest;
    expect(parsed.streams).toHaveLength(7);
  });

  it("never overwrites a previously captured session", async () => {
    const out = join(scratch, "captured");
    await expect(
      captureSession({
        server: baseUrl,
        root: "pr:maple/reading-room/negotiation",
        out,
      }),
    ).rejects.toMatchObject({ code: "session/out-exists" });
  });
});
