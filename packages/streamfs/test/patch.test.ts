import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHttpServer, MemoryStreamStore } from "@eforest/server";
import { canonicalJson } from "@eforest/protocol";
import { describe, expect, it } from "vitest";
import {
  applyPatch,
  chooseWriteEvent,
  createStreamFsServerOptions,
  diffText,
  FS_EVENT_VERSION,
  isPatchOps,
  PatchError,
  StreamFs,
} from "../src/index.js";

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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

describe("text patch operations", () => {
  it("round-trips deterministic unicode edits byte-for-byte", () => {
    const base = "zero 🌲 café\r\nlast\n";
    const target = "zero brave 🌲 café\nlast line\n";
    const first = diffText(base, target);
    const second = diffText(base, target);
    expect(first).toEqual(second);
    expect(Array.from(applyPatch(bytes(base), first))).toEqual(Array.from(bytes(target)));
  });

  it("enforces the canonical grammar and exact byte consumption", () => {
    expect(isPatchOps([])).toBe(true);
    expect(
      isPatchOps([
        ["=", 1],
        ["=", 1],
      ]),
    ).toBe(false);
    expect(isPatchOps([["=", 0]])).toBe(false);
    expect(isPatchOps([["-", -1]])).toBe(false);
    expect(isPatchOps([["+", "\ud800"]])).toBe(false);
    expect(isPatchOps([["+", "🌲"]])).toBe(true);
    expect(() => applyPatch(bytes("abc"), [["=", 2]])).toThrowError(PatchError);
    expect(() =>
      applyPatch(bytes("🌲"), [
        ["=", 1],
        ["+", "x"],
        ["=", 3],
      ]),
    ).toThrow("patch/target-not-a-text-file");
    expect(() =>
      applyPatch(bytes("abc"), [
        ["=", 3],
        ["-", 1],
      ]),
    ).toThrow("patch/malformed-ops");
  });

  it("chooses patches only when the strict wire-byte rule wins", () => {
    const base = bytes("a".repeat(240));
    const target = bytes(`${"a".repeat(239)}b`);
    const choice = chooseWriteEvent(base, target, "notes.txt");
    expect(choice.type).toBe("fs.file.patch");
    if (choice.type === "fs.file.patch") {
      expect(applyPatch(base, choice.payload.ops)).toEqual(target);
      expect(choice.payload.baseDigest).toBe(digest(base));
      expect(choice.payload.resultDigest).toBe(digest(target));
    }
    expect(chooseWriteEvent(new Uint8Array([0, 1]), new Uint8Array([0, 2]), "bin").type).toBe(
      "fs.file.write",
    );
    expect(chooseWriteEvent(bytes("same"), bytes("same"), "same").type).toBe("fs.file.write");
  });
});

describe("live patch dispatch", () => {
  it("records compact patches, reconstructs them, and keeps refusals head-neutral", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const repo = await new StreamFs({ baseUrl }).createRepo("patches");
      const initial = `${"The quick brown fox jumps over the lazy dog.\n".repeat(8)}`;
      await repo.createFile("note.txt", bytes(initial));
      const target = initial.replace("brown", "green").replace("lazy", "quiet");
      await repo.writeFile("note.txt", bytes(target));
      expect(new TextDecoder().decode(await repo.readFile("note.txt"))).toBe(target);

      const consecutiveTarget = `${target}🌲 consecutive patch\n`;
      await repo.writeFile("note.txt", bytes(consecutiveTarget));
      expect(new TextDecoder().decode(await repo.readFile("note.txt"))).toBe(consecutiveTarget);

      const metadata = await repo.dump();
      expect(metadata.filter((event) => event.type === "fs.file.patch")).toHaveLength(2);

      const forced = "forced full content\n";
      await repo.writeFile("note.txt", bytes(forced), { forceFull: true });
      expect(new TextDecoder().decode(await repo.readFile("note.txt"))).toBe(forced);
      const afterFull = await repo.dump();
      expect(afterFull.some((event) => event.type === "fs.file.write")).toBe(true);

      const file = (await repo.tree()).files["note.txt"]!;
      const dispatchUrl = `${baseUrl}/streams/${encodeURIComponent(repo.metadataStreamId)}/dispatch`;
      const before = await repo.dump();
      const refusalCases = [
        {
          reason: "patch/malformed-ops",
          payload: {
            v: FS_EVENT_VERSION,
            path: "note.txt",
            base: file.lastContentOffset,
            baseDigest: file.contentSha256,
            ops: [["=", 1]],
            resultDigest: file.contentSha256,
          },
        },
        {
          reason: "patch/base-mismatch",
          payload: {
            v: FS_EVENT_VERSION,
            path: "note.txt",
            base: file.lastContentOffset,
            baseDigest: "0".repeat(64),
            ops: [["=", file.size]],
            resultDigest: file.contentSha256,
          },
        },
        {
          reason: "patch/result-mismatch",
          payload: {
            v: FS_EVENT_VERSION,
            path: "note.txt",
            base: file.lastContentOffset,
            baseDigest: file.contentSha256,
            ops: [["=", file.size]],
            resultDigest: "0".repeat(64),
          },
        },
      ] as const;
      for (const [index, refusal] of refusalCases.entries()) {
        const response = await fetch(dispatchUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: canonicalJson({
            type: "fs.file.patch",
            payload: refusal.payload,
            ts: index + 1,
          }),
        });
        expect(response.status, await response.clone().text()).toBe(409);
        expect(await response.json()).toMatchObject({ error: { reason: refusal.reason } });
        expect(await repo.dump()).toEqual(before);
      }

      await repo.createFile("binary", new Uint8Array([0, 1, 2]));
      const binary = (await repo.tree()).files.binary!;
      const binaryResponse = await fetch(dispatchUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: canonicalJson({
          type: "fs.file.patch",
          payload: {
            v: FS_EVENT_VERSION,
            path: "binary",
            base: binary.lastContentOffset,
            baseDigest: binary.contentSha256,
            ops: [["=", binary.size]],
            resultDigest: binary.contentSha256,
          },
          ts: 99,
        }),
      });
      expect(binaryResponse.status).toBe(409);
      expect(await binaryResponse.json()).toMatchObject({
        error: { reason: "patch/target-not-a-text-file" },
      });
    } finally {
      await stopServer(server);
    }
  });

  it("runs every committed refusal corpus case without moving the head", async () => {
    const corpus = resolve("packages/streamfs/fixtures/fuzz/patch-refusals");
    const cases = readdirSync(corpus)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map(
        (name) =>
          JSON.parse(readFileSync(resolve(corpus, name), "utf8")) as {
            readonly name: string;
            readonly reason: string;
            readonly action: Record<string, unknown>;
          },
      );
    expect(cases.length).toBeGreaterThanOrEqual(8);
    for (const reason of [
      "patch/malformed-ops",
      "patch/base-mismatch",
      "patch/result-mismatch",
      "patch/target-not-a-text-file",
    ]) {
      expect(cases.some((testCase) => testCase.reason === reason)).toBe(true);
    }

    const { server, baseUrl } = await startServer();
    try {
      for (const [index, testCase] of cases.entries()) {
        const repo = await new StreamFs({ baseUrl }).createRepo(`corpus-${index}`);
        await repo.createFile("note.txt", bytes("0123456789"));
        await repo.createFile("binary.bin", new Uint8Array([0, 1, 2]));
        const tree = await repo.tree();
        const note = tree.files["note.txt"]!;
        const binary = tree.files["binary.bin"]!;
        const replace = (value: unknown): unknown => {
          if (typeof value === "string") {
            if (value === "__BASE__") return note.contentSha256;
            if (value === "__BINARY_BASE__") return binary.contentSha256;
            if (value === "__REVISION__") return note.lastContentOffset;
            if (value === "__BINARY_REVISION__") return binary.lastContentOffset;
            return value;
          }
          if (Array.isArray(value)) return value.map(replace);
          if (value !== null && typeof value === "object") {
            return Object.fromEntries(
              Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
                key,
                replace(entry),
              ]),
            );
          }
          return value;
        };
        const action = replace(testCase.action) as {
          readonly type: string;
          readonly payload: unknown;
          readonly ts: number;
        };
        const before = await repo.dump();
        const response = await fetch(
          `${baseUrl}/streams/${encodeURIComponent(repo.metadataStreamId)}/dispatch`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: canonicalJson(action),
          },
        );
        expect(response.status, `${testCase.name}: ${await response.clone().text()}`).toBe(409);
        expect(await response.json()).toMatchObject({ error: { reason: testCase.reason } });
        expect(await repo.dump()).toEqual(before);
      }
    } finally {
      await stopServer(server);
    }
  });
});
