import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendDurableJson,
  createDurableJsonStream,
  readDurableJson,
  type StreamRecord,
} from "@eforest/client";
import { sha256Hex } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { createDurableStreamTestServer } from "@eforest/server";
import { StreamFsRepo, worktreeDigest } from "@eforest/streamfs";
import { load as loadWorkspace } from "@eforest/workspace";
import { runClone, runWorkspaceCheck } from "./clone-command.js";

const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
let baseUrl: string;

function streamUrl(streamId: string): string {
  return `${baseUrl}/streams/${encodeURIComponent(streamId)}`;
}

function metadataId(repo: string, branch = "main"): string {
  return `fs:acme/${repo}:${branch}:meta`;
}

function contentId(repo: string, branch = "main"): string {
  return `fs:acme/${repo}:${branch}:file:1`;
}

async function appendRecord(
  streamId: string,
  type: string,
  payload: Record<string, unknown>,
  ordinal: number,
): Promise<StreamRecord> {
  const offset = offsetForOrdinal(ordinal);
  const record = { offset, type, payload, ts: ordinal } as StreamRecord;
  await appendDurableJson({ url: streamUrl(streamId) }, record, offset);
  return record;
}

async function createMetadata(repo: string, branch = "main"): Promise<string> {
  const streamId = metadataId(repo, branch);
  await createDurableJsonStream({ url: streamUrl(streamId) });
  return streamId;
}

async function seedFile(
  repo: string,
  branch = "main",
): Promise<{
  readonly metadata: string;
  readonly content: string;
  readonly oldBytes: Buffer;
  readonly oldOffset: string;
}> {
  const metadata = await createMetadata(repo, branch);
  const content = contentId(repo, branch);
  await createDurableJsonStream({ url: streamUrl(content) });
  await appendRecord(metadata, "fs.branch.genesis", { v: 1, branch }, 0);
  await appendRecord(
    metadata,
    "fs.file.create",
    { v: 2, path: "hello.txt", contentStreamId: content },
    1,
  );
  const oldBytes = Buffer.from("hello from the old checkpoint\n");
  const oldOffset = offsetForOrdinal(2);
  await appendRecord(
    metadata,
    "fs.file.write",
    {
      v: 2,
      path: "hello.txt",
      base: "BASE_NONE",
      contentSha256: sha256Hex(oldBytes),
      size: oldBytes.byteLength,
    },
    2,
  );
  await appendRecord(
    content,
    "fs.file.content",
    { v: 2, contentStreamId: content, contentBase64: oldBytes.toString("base64") },
    0,
  );
  return { metadata, content, oldBytes, oldOffset };
}

function environment(root: string): NodeJS.ProcessEnv {
  return { EF_SERVER: baseUrl, EF_HOME: join(root, "home") };
}

async function clone(
  args: readonly string[],
  root: string,
  dependencies: { readonly fetcher?: typeof fetch } = {},
): Promise<{ readonly status: number; readonly stdout: string; readonly stderr: string }> {
  let stdout = "";
  let stderr = "";
  const status = await runClone(
    args,
    {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
    { environment: environment(root), ...(dependencies.fetcher ? dependencies : {}) },
  );
  return { status, stdout, stderr };
}

describe("ef clone", () => {
  beforeAll(async () => {
    baseUrl = await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it("materializes exact bytes, writes a canonical workspace, and is deterministic", async () => {
    const root = await mkdtemp(join(tmpdir(), "eforest-clone-"));
    const fixture = await seedFile("clone-basic");
    const first = join(root, "first");
    const second = join(root, "second");
    try {
      const result = await clone(["acme/clone-basic", "main", first], root);
      const digest = worktreeDigest({
        files: {
          "hello.txt": {
            contentSha256: sha256Hex(fixture.oldBytes),
            size: fixture.oldBytes.length,
          },
        },
      });
      expect(result).toEqual({
        status: 0,
        stdout: `checkpoint ${fixture.oldOffset}\n${digest}\n`,
        stderr: "",
      });
      expect(await readFile(join(first, "hello.txt"))).toEqual(fixture.oldBytes);
      expect(readFileSync(join(first, ".ef", "complete"), "utf8")).toBe('{"v":1}\n');
      expect(
        runWorkspaceCheck(["check", first], { stdout: () => undefined, stderr: () => undefined }),
      ).toBe(0);
      expect(loadWorkspace(first)).toMatchObject({
        headOffset: fixture.oldOffset,
        identity: {
          server: "http://127.0.0.1",
          project: "clone-basic",
          repo: "clone-basic",
          branch: "main",
          metadataStreamId: fixture.metadata,
        },
        files: {
          "hello.txt": {
            base: fixture.oldOffset,
            contentSha256: sha256Hex(fixture.oldBytes),
            size: fixture.oldBytes.length,
          },
        },
      });

      await mkdir(second, { recursive: true });
      const repeat = await clone(["acme/clone-basic", "main", second], root);
      expect(repeat.stdout).toBe(result.stdout);
      expect(await readFile(join(second, "hello.txt"))).toEqual(fixture.oldBytes);
      expect(readFileSync(join(second, ".ef", "workspace.json"))).toEqual(
        readFileSync(join(first, ".ef", "workspace.json")),
      );
      expect(await readdir(first)).toEqual([".ef", "hello.txt"]);
      expect(await readdir(second)).toEqual([".ef", "hello.txt"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses one privacy-neutral refusal for unknown and private repositories", async () => {
    const root = await mkdtemp(join(tmpdir(), "eforest-clone-privacy-"));
    const unknownTarget = join(root, "unknown");
    const privateTarget = join(root, "private");
    const privateFetcher: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/api/namespaces/")) {
        return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
      }
      if (url.includes("/api/repos/")) {
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      }
      return fetch(input, init);
    };
    try {
      const unknown = await clone(["acme/does-not-exist", "main", unknownTarget], root);
      const privateRepo = await clone(["acme/secret", "main", privateTarget], root, {
        fetcher: privateFetcher,
      });
      expect(unknown).toEqual({
        status: 1,
        stdout: "",
        stderr: "EREFUSED: repository is not readable\n",
      });
      expect(privateRepo).toEqual(unknown);
      expect(existsSync(join(unknownTarget, ".ef", "complete"))).toBe(false);
      expect(existsSync(join(privateTarget, ".ef", "complete"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds a dead transport and preserves an existing empty target", async () => {
    const root = await mkdtemp(join(tmpdir(), "eforest-clone-transport-"));
    const deadTarget = join(root, "dead");
    const existingTarget = join(root, "existing");
    await mkdir(existingTarget);
    let calls = 0;
    const deadFetcher: typeof fetch = async () => {
      calls += 1;
      throw new Error("ECONNREFUSED");
    };
    try {
      const started = Date.now();
      const dead = await clone(["acme/dead", "main", deadTarget], root, {
        fetcher: deadFetcher,
      });
      expect(dead.status).toBe(1);
      expect(dead.stdout).toBe("");
      expect(dead.stderr).toMatch(/^EINTERRUPTED:/);
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(calls).toBeGreaterThan(0);
      expect(existsSync(deadTarget)).toBe(false);

      const refused = await clone(["acme/does-not-exist", "main", existingTarget], root);
      expect(refused.stderr).toMatch(/^EREFUSED:/);
      expect(existsSync(existingTarget)).toBe(true);
      expect(await readdir(existingTarget)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 12_000);

  it("samples a checkpoint once and ignores a concurrent append", async () => {
    const root = await mkdtemp(join(tmpdir(), "eforest-clone-race-"));
    const fixture = await seedFile("clone-race");
    const target = join(root, "race");
    const nextBytes = Buffer.from("appended after the sampled head\n");
    let metadataReads = 0;
    let appended = false;
    const fetcher: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const url = String(input instanceof Request ? input.url : input);
      const metadataUrl = streamUrl(fixture.metadata);
      if (
        (url.startsWith(`${metadataUrl}?`) || url.startsWith(`${metadataUrl}/dump`)) &&
        metadataReads++ === 0 &&
        !appended
      ) {
        appended = true;
        await appendRecord(
          fixture.content,
          "fs.file.content",
          {
            v: 2,
            contentStreamId: fixture.content,
            contentBase64: nextBytes.toString("base64"),
          },
          1,
        );
        await appendRecord(
          fixture.metadata,
          "fs.file.write",
          {
            v: 2,
            path: "hello.txt",
            base: fixture.oldOffset,
            contentSha256: sha256Hex(nextBytes),
            size: nextBytes.byteLength,
          },
          3,
        );
      }
      return response;
    };
    try {
      const result = await clone(["acme/clone-race", "main", target], root, { fetcher });
      expect(result.status).toBe(0);
      expect(result.stdout.startsWith(`checkpoint ${fixture.oldOffset}\n`)).toBe(true);
      expect(await readFile(join(target, "hello.txt"))).toEqual(fixture.oldBytes);
      const records = await readDurableJson<StreamRecord>({ url: streamUrl(fixture.metadata) });
      expect(records.at(-1)?.offset).toBe(offsetForOrdinal(3));
      expect(loadWorkspace(target).headOffset).toBe(fixture.oldOffset);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports historical and empty clones and refuses a non-empty target before network access", async () => {
    const root = await mkdtemp(join(tmpdir(), "eforest-clone-boundaries-"));
    const fixture = await seedFile("clone-history");
    const newerBytes = Buffer.from("the later checkpoint\n");
    await appendRecord(
      fixture.content,
      "fs.file.content",
      {
        v: 2,
        contentStreamId: fixture.content,
        contentBase64: newerBytes.toString("base64"),
      },
      1,
    );
    await appendRecord(
      fixture.metadata,
      "fs.file.write",
      {
        v: 2,
        path: "hello.txt",
        base: fixture.oldOffset,
        contentSha256: sha256Hex(newerBytes),
        size: newerBytes.byteLength,
      },
      3,
    );
    const emptyMetadata = await createMetadata("clone-empty");
    const historical = join(root, "historical");
    const empty = join(root, "empty");
    const nonEmpty = join(root, "non-empty");
    await writeFile(nonEmpty, "not a directory");
    let requests = 0;
    const countingFetch: typeof fetch = async (input, init) => {
      requests += 1;
      return fetch(input, init);
    };
    try {
      const atHead = await clone(
        ["acme/clone-history", "main", historical, "--at", fixture.oldOffset],
        root,
      );
      expect(atHead.status).toBe(0);
      expect(atHead.stdout.startsWith(`checkpoint ${fixture.oldOffset}\n`)).toBe(true);
      expect(await readFile(join(historical, "hello.txt"))).toEqual(fixture.oldBytes);

      const emptyResult = await clone(["acme/clone-empty", "main", empty], root);
      const emptyDigest = worktreeDigest({ files: {} });
      expect(emptyResult).toEqual({
        status: 0,
        stdout: `checkpoint -1\n${emptyDigest}\n`,
        stderr: "",
      });
      expect(loadWorkspace(empty).headOffset).toBe("-1");
      expect(await readdir(empty)).toEqual([".ef"]);
      expect(emptyMetadata).toBe(metadataId("clone-empty"));

      const refused = await clone(["acme/clone-history", "main", nonEmpty], root, {
        fetcher: countingFetch,
      });
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toMatch(/^ETARGET_NOT_EMPTY:/);
      expect(requests).toBe(0);
      expect(readFileSync(nonEmpty, "utf8")).toBe("not a directory");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps missing branches, bad offsets, and corrupted content to typed failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "eforest-clone-errors-"));
    const fixture = await seedFile("clone-errors");
    const missing = await clone(["acme/clone-errors", "missing", join(root, "missing")], root);
    const badOffset = await clone(
      ["acme/clone-errors", "main", join(root, "bad-offset"), "--at", offsetForOrdinal(99)],
      root,
    );
    const gone = await clone(
      ["acme/clone-errors", "main", join(root, "gone"), "--at", fixture.oldOffset],
      root,
      {
        fetcher: async (input, init) => {
          const url = String(input instanceof Request ? input.url : input);
          return url.includes("/streams/")
            ? new Response("gone", { status: 410 })
            : fetch(input, init);
        },
      },
    );
    const corruptMetadata = await createMetadata("clone-corrupt");
    const corruptContent = contentId("clone-corrupt");
    await createDurableJsonStream({ url: streamUrl(corruptContent) });
    const corruptBytes = Buffer.from("the wire is wrong\n");
    await appendRecord(corruptMetadata, "fs.branch.genesis", { v: 1, branch: "main" }, 0);
    await appendRecord(
      corruptMetadata,
      "fs.file.create",
      { v: 2, path: "bad.txt", contentStreamId: corruptContent },
      1,
    );
    await appendRecord(
      corruptMetadata,
      "fs.file.write",
      {
        v: 2,
        path: "bad.txt",
        base: "BASE_NONE",
        contentSha256: "0".repeat(64),
        size: corruptBytes.length,
      },
      2,
    );
    await appendRecord(
      corruptContent,
      "fs.file.content",
      {
        v: 2,
        contentStreamId: corruptContent,
        contentBase64: corruptBytes.toString("base64"),
      },
      0,
    );
    const corrupt = await clone(["acme/clone-corrupt", "main", join(root, "corrupt")], root);
    try {
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toMatch(/^ENOT_FOUND:/);
      expect(badOffset.status).not.toBe(0);
      expect(badOffset.stderr).toMatch(/^EBAD_OFFSET:/);
      expect(gone.status).not.toBe(0);
      expect(gone.stderr).toMatch(/^EBAD_OFFSET:/);
      expect(corrupt.status).not.toBe(0);
      expect(corrupt.stderr).toMatch(/^ECORRUPT_EVENT:/);
      expect(existsSync(join(root, "missing", ".ef", "complete"))).toBe(false);
      expect(existsSync(join(root, "bad-offset", ".ef", "complete"))).toBe(false);
      expect(existsSync(join(root, "gone", ".ef", "complete"))).toBe(false);
      expect(existsSync(join(root, "corrupt", ".ef", "complete"))).toBe(false);
      expect(fixture.oldOffset).toBe(offsetForOrdinal(2));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("verifies snapshot integrity and materializes a post-snapshot generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "eforest-clone-snapshot-"));
    await seedFile("clone-snapshot");
    const repo = new StreamFsRepo(baseUrl, fetch, "acme/clone-snapshot");
    const fullReplayTarget = join(root, "full-replay");
    const fullReplay = await clone(["acme/clone-snapshot", "main", fullReplayTarget], root);
    expect(fullReplay.status).toBe(0);
    const receipt = await repo.createSnapshot();
    const snapshotTarget = join(root, "snapshot-bootstrap");
    const snapshotBootstrap = await clone(["acme/clone-snapshot", "main", snapshotTarget], root);
    expect(snapshotBootstrap.status).toBe(0);
    expect(snapshotBootstrap.stdout).toMatch(/^checkpoint [0-9]+_[0-9]+\n[0-9a-f]{64}\n$/);
    expect(await readFile(join(snapshotTarget, "hello.txt"))).toEqual(
      await readFile(join(fullReplayTarget, "hello.txt")),
    );
    expect(loadWorkspace(snapshotTarget).files).toEqual(loadWorkspace(fullReplayTarget).files);
    const newerBytes = Buffer.from("the snapshot tail is current\n");
    await repo.writeFile("hello.txt", newerBytes, { forceFull: true });
    const target = join(root, "post-snapshot");
    try {
      const result = await clone(["acme/clone-snapshot", "main", target], root);
      expect(result.status).toBe(0);
      expect(await readFile(join(target, "hello.txt"))).toEqual(newerBytes);
      expect(result.stdout).toMatch(/^checkpoint [0-9]+_[0-9]+\n[0-9a-f]{64}\n$/);

      const corruptTarget = join(root, "corrupt-snapshot");
      const corruptFetcher: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes(encodeURIComponent(receipt.contentRef))) {
          const body = (await response.json()) as Array<Record<string, unknown>>;
          const first = body[0] as Record<string, unknown>;
          const payload = first.payload as Record<string, unknown>;
          const encoded = String(payload.contentBase64);
          payload.contentBase64 = `${encoded.slice(0, -2)}AA`;
          return Response.json(body);
        }
        return response;
      };
      const corrupt = await clone(["acme/clone-snapshot", "main", corruptTarget], root, {
        fetcher: corruptFetcher,
      });
      expect(corrupt.status).not.toBe(0);
      expect(corrupt.stderr).toMatch(/^ESNAPSHOT_INTEGRITY:/);
      expect(existsSync(join(corruptTarget, ".ef", "complete"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("boots from a provider-retained dump without rereading discarded history", async () => {
    const root = await mkdtemp(join(tmpdir(), "eforest-clone-retained-"));
    const fixture = await seedFile("clone-retained");
    const repo = new StreamFsRepo(baseUrl, fetch, "acme/clone-retained");
    const receipt = await repo.createSnapshot();
    const records = await readDurableJson<StreamRecord>({ url: streamUrl(fixture.metadata) });
    const snapshotIndex = records.findIndex(
      (record) => record.offset === receipt.snapshotEventOffset,
    );
    expect(snapshotIndex).toBeGreaterThanOrEqual(0);
    const retained = records.slice(snapshotIndex);
    const metadataPath = `/streams/${encodeURIComponent(fixture.metadata)}`;
    let discardedPrefixReads = 0;
    const compactedFetcher: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(`${baseUrl}${metadataPath}/dump`)) return Response.json(retained);
      if (url.startsWith(`${baseUrl}${metadataPath}?`)) {
        discardedPrefixReads += 1;
        return new Response(JSON.stringify({ error: "gone" }), { status: 410 });
      }
      return fetch(input, init);
    };
    const target = join(root, "retained");
    const belowCompaction = join(root, "below-compaction");
    try {
      const result = await clone(["acme/clone-retained", "main", target], root, {
        fetcher: compactedFetcher,
      });
      expect(result.status).toBe(0);
      expect(await readFile(join(target, "hello.txt"))).toEqual(fixture.oldBytes);
      expect(discardedPrefixReads).toBe(0);

      const refused = await clone(
        ["acme/clone-retained", "main", belowCompaction, "--at", fixture.oldOffset],
        root,
        { fetcher: compactedFetcher },
      );
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toMatch(/^EBAD_OFFSET:/);
      expect(existsSync(join(belowCompaction, ".ef", "complete"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
