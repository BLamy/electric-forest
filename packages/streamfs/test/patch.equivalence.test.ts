import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "@eforest/protocol";
import { createHttpServer, MemoryStreamStore } from "@eforest/server";
import { describe, expect, it } from "vitest";
import { createStreamFsServerOptions, StreamFs, treeDigest, type FsTree } from "../src/index.js";

interface FixtureEdit {
  readonly newContent?: string;
  readonly newBytesBase64?: string;
}

interface FixtureDefinition {
  readonly name: string;
  readonly initialContent: string;
  readonly edits: readonly FixtureEdit[];
}

interface FixtureEvent {
  readonly payload: Record<string, unknown>;
  readonly type: string;
}

interface RunResult {
  readonly digest: string;
  readonly metadata: readonly FixtureEvent[];
  readonly content: readonly FixtureEvent[];
  readonly wireBytes: number;
  readonly finalBytes: Uint8Array;
}

const encoder = new TextEncoder();

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

function contentFor(edit: FixtureEdit): Uint8Array {
  if (edit.newBytesBase64 !== undefined)
    return new Uint8Array(Buffer.from(edit.newBytesBase64, "base64"));
  if (edit.newContent !== undefined) return encoder.encode(edit.newContent);
  throw new Error("fixture edit has no content");
}

function wireBytes(metadata: readonly FixtureEvent[], content: readonly FixtureEvent[]): number {
  const metadataBytes = metadata.reduce(
    (total, event) => total + Buffer.byteLength(canonicalJson(event.payload)),
    0,
  );
  const contentBytes = content.reduce(
    (total, event) => total + Buffer.from(String(event.payload.contentBase64), "base64").byteLength,
    0,
  );
  return metadataBytes + contentBytes;
}

async function runFixture(definition: FixtureDefinition, forceFull: boolean): Promise<RunResult> {
  const { server, baseUrl } = await startServer();
  try {
    const repo = await new StreamFs({ baseUrl }).createRepo(definition.name);
    await repo.createFile("note.txt", encoder.encode(definition.initialContent));
    for (const edit of definition.edits) {
      await repo.writeFile("note.txt", contentFor(edit), forceFull ? { forceFull: true } : {});
    }
    const tree = (await repo.tree()) as FsTree;
    const file = tree.files["note.txt"]!;
    const contentResponse = await fetch(
      `${baseUrl}/streams/${encodeURIComponent(file.contentStreamId)}?offset=-1`,
    );
    if (!contentResponse.ok) throw new Error(`content dump failed: ${contentResponse.status}`);
    const content = (await contentResponse.json()) as readonly FixtureEvent[];
    const metadata = (await repo.dump()) as readonly FixtureEvent[];
    const finalBytes = await repo.readFile("note.txt");
    return {
      digest: treeDigest(tree),
      metadata,
      content,
      wireBytes: wireBytes(metadata, content),
      finalBytes,
    };
  } finally {
    await stopServer(server);
  }
}

describe("real stream-server patch/full-write equivalence", () => {
  it("drives every committed edit sequence through separate server instances", async () => {
    const root = resolve("packages/streamfs/fixtures/patches");
    for (const name of readdirSync(root).sort()) {
      const fixture = resolve(root, name);
      const definition = JSON.parse(
        readFileSync(resolve(fixture, `${name}.edits.json`), "utf8"),
      ) as FixtureDefinition;
      const expected = JSON.parse(readFileSync(resolve(fixture, "expected.json"), "utf8")) as {
        readonly treeDigest: string;
        readonly patchedWireBytes: number;
        readonly fullwriteWireBytes: number;
      };
      const patched = await runFixture(definition, false);
      const fullwrite = await runFixture(definition, true);
      expect(patched.digest).toBe(expected.treeDigest);
      expect(fullwrite.digest).toBe(expected.treeDigest);
      expect(patched.finalBytes).toEqual(fullwrite.finalBytes);
      expect(patched.wireBytes).toBe(expected.patchedWireBytes);
      expect(fullwrite.wireBytes).toBe(expected.fullwriteWireBytes);
      expect(patched.wireBytes).toBeLessThan(fullwrite.wireBytes);
      expect(patched.metadata.some((event) => event.type === "fs.file.patch")).toBe(true);
      if (name === "mixed-fallback") {
        expect(patched.metadata.some((event) => event.type === "fs.file.write")).toBe(true);
      }
      expect(fullwrite.metadata.some((event) => event.type === "fs.file.patch")).toBe(false);
    }
  });
});
