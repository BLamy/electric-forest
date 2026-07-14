import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { canonicalJson, type Event } from "@eforest/protocol";
import { createHttpServer, MemoryStreamStore } from "@eforest/server";
import { describe, expect, it } from "vitest";
import {
  FsHttpError,
  StreamFs,
  createStreamFsServerOptions,
  mergeFastForward,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

async function runCliProcess(
  command: string,
  args: readonly string[],
): Promise<{
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  try {
    const result = await execFileAsync(process.execPath, [command, ...args], { encoding: "utf8" });
    return { status: 0, stdout: String(result.stdout), stderr: String(result.stderr) };
  } catch (error) {
    const result = error as {
      readonly code?: number;
      readonly stdout?: string;
      readonly stderr?: string;
    };
    return {
      status: typeof result.code === "number" ? result.code : 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }
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

function writeDump(
  path: string,
  records: readonly {
    readonly offset: string;
    readonly type: string;
    readonly payload: unknown;
    readonly ts: number;
  }[],
): void {
  writeFileSync(path, records.map((record) => canonicalJson(record)).join("\n") + "\n", "utf8");
}

async function dispatchMerge(
  target: Awaited<ReturnType<StreamFs["createRepo"]>>,
  payload: unknown,
) {
  return target.dispatchToStream(target.metadataStreamId, {
    type: "fs.branch.merge",
    payload,
    ts: Date.now(),
  } as Event);
}

describe("stream-fs fast-forward merge", () => {
  it("adopts one source branch event and preserves the source stream", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const repo = await new StreamFs({ baseUrl }).createRepo("merge-green");
      await repo.createFile("a.txt", new TextEncoder().encode("main"));
      const targetBefore = await repo.dump();
      const targetDigestBefore = await repo.digest();
      await repo.createBranch("feature");
      const source = await repo.openBranch("feature");
      await source.writeFile("a.txt", new TextEncoder().encode("feature"), { forceFull: true });
      const sourceBefore = await source.dump();
      const sourceDigest = await source.digest();

      const receipt = await mergeFastForward(repo, source);
      const targetAfter = await repo.dump();
      expect(targetAfter).toHaveLength(targetBefore.length + 1);
      expect(targetAfter.at(-1)).toMatchObject({
        type: "fs.branch.merge",
        payload: {
          v: 1,
          sourceStreamId: source.metadataStreamId,
          forkOffset: targetBefore.at(-1)!.offset,
          mergedThroughOffset: sourceBefore.at(-1)!.offset,
        },
      });
      expect(receipt.mergeOffset).toBe(targetAfter.at(-1)!.offset);
      expect(await source.dump()).toEqual(sourceBefore);
      expect(await repo.readFile("a.txt")).toEqual(new TextEncoder().encode("feature"));
      expect(await repo.digest()).toBe(sourceDigest);
      expect(await repo.digest()).not.toBe(targetDigestBefore);

      const scratch = mkdtempSync(join(tmpdir(), "eforest-e1-t09-replay-"));
      const targetBeforePath = join(scratch, "target-before.jsonl");
      const targetAfterPath = join(scratch, "target-after.jsonl");
      const sourcePath = join(scratch, "source.jsonl");
      writeDump(targetBeforePath, targetBefore);
      writeDump(targetAfterPath, targetAfter);
      writeDump(sourcePath, sourceBefore);
      const cli = join(process.cwd(), "packages/cli/dist/src/bin.js");
      const sourceReplayDigest = execFileSync(
        process.execPath,
        [
          cli,
          "replay",
          sourcePath,
          "--parent",
          targetBeforePath,
          "--parent-stream-id",
          repo.metadataStreamId,
          "--digest",
        ],
        { encoding: "utf8" },
      ).trim();
      const mergedReplayDigest = execFileSync(
        process.execPath,
        [cli, "replay", targetAfterPath, "--merge-source", sourcePath, "--digest"],
        { encoding: "utf8" },
      ).trim();
      expect(mergedReplayDigest).toBe(sourceReplayDigest);
      expect(mergedReplayDigest).toBe(receipt.treeDigest);

      await expect(mergeFastForward(repo, source)).rejects.toMatchObject({
        status: 409,
        body: expect.objectContaining({
          error: expect.objectContaining({ reason: "fs/merge-not-fast-forward" }),
        }),
      } satisfies Partial<FsHttpError>);
    } finally {
      await stopServer(server);
    }
  });

  it("refuses an advanced target without changing either dump", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const repo = await new StreamFs({ baseUrl }).createRepo("merge-refusal");
      await repo.createFile("a.txt", new TextEncoder().encode("main"));
      await repo.createBranch("feature");
      const source = await repo.openBranch("feature");
      await source.writeFile("a.txt", new TextEncoder().encode("feature"), { forceFull: true });
      await repo.writeFile("a.txt", new TextEncoder().encode("advanced"), { forceFull: true });
      const targetBefore = await repo.dump();
      const sourceBefore = await source.dump();
      await expect(mergeFastForward(repo, source)).rejects.toMatchObject({
        status: 409,
        body: expect.objectContaining({
          error: expect.objectContaining({ reason: "fs/merge-not-fast-forward" }),
        }),
      } satisfies Partial<FsHttpError>);
      expect(await repo.dump()).toEqual(targetBefore);
      expect(await source.dump()).toEqual(sourceBefore);
    } finally {
      await stopServer(server);
    }
  });

  it("exposes the frozen refusal reasons through the dispatch door", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const repo = await new StreamFs({ baseUrl }).createRepo("merge-reasons");
      await repo.createFile("a.txt", new TextEncoder().encode("main"));
      await repo.createBranch("feature");
      const source = await repo.openBranch("feature");
      const other = await new StreamFs({ baseUrl }).createRepo("merge-other");
      await other.createFile("a.txt", new TextEncoder().encode("other"));
      await other.createBranch("feature");
      const unrelated = await other.openBranch("feature");
      const targetBefore = await repo.dump();
      const sourceBefore = await source.dump();
      const forkOffset = targetBefore.at(-1)!.offset;
      const sourceHead = sourceBefore.at(-1)!.offset;
      const valid = {
        v: 1,
        sourceStreamId: source.metadataStreamId,
        forkOffset,
        mergedThroughOffset: sourceHead,
      };
      const refusals: Array<[string, unknown]> = [
        ["fs/merge-source-not-found", { ...valid, sourceStreamId: "fs:missing:feature:meta" }],
        ["fs/merge-into-self", { ...valid, sourceStreamId: repo.metadataStreamId }],
        ["fs/merge-unrelated-source", { ...valid, sourceStreamId: unrelated.metadataStreamId }],
        [
          "fs/merge-bad-range",
          { ...valid, mergedThroughOffset: "0000000000000000_0000000000000099" },
        ],
      ];
      for (const [reason, payload] of refusals) {
        await expect(dispatchMerge(repo, payload)).rejects.toMatchObject({
          status: 409,
          body: expect.objectContaining({
            error: expect.objectContaining({ reason }),
          }),
        } satisfies Partial<FsHttpError>);
        expect(await repo.dump()).toEqual(targetBefore);
        expect(await source.dump()).toEqual(sourceBefore);
      }
    } finally {
      await stopServer(server);
    }
  });

  it("merges an empty source and leaves the target digest unchanged", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const repo = await new StreamFs({ baseUrl }).createRepo("merge-empty");
      await repo.createFile("a.txt", new TextEncoder().encode("main"));
      const before = await repo.digest();
      await repo.createBranch("empty");
      const empty = await repo.openBranch("empty");
      const sourceFork = (await empty.dump()).at(0)!;
      const receipt = await mergeFastForward(repo, empty);
      expect(receipt.mergedThroughOffset).toBe(
        (sourceFork.payload as { readonly forkOffset: string }).forkOffset,
      );
      expect(await repo.digest()).toBe(before);
      expect((await repo.dump()).at(-1)).toMatchObject({ type: "fs.branch.merge" });
    } finally {
      await stopServer(server);
    }
  });

  it("resolves the adopted range for a live watcher and keeps later source edits invisible", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const repo = await new StreamFs({ baseUrl }).createRepo("merge-watch");
      await repo.createFile("a.txt", new TextEncoder().encode("main"));
      await repo.createBranch("feature");
      const source = await repo.openBranch("feature");
      await source.writeFile("a.txt", new TextEncoder().encode("feature"), { forceFull: true });

      const changes: Array<{ event: string; path: string }> = [];
      const watcher = repo.watch();
      watcher.onAll((event, path) => changes.push({ event, path }));
      await watcher.ready;
      await mergeFastForward(repo, source);
      for (
        let index = 0;
        index < 100 && !changes.some((change) => change.event === "change");
        index += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(changes).toContainEqual({ event: "change", path: "a.txt" });

      const changeCount = changes.length;
      await source.writeFile("a.txt", new TextEncoder().encode("source-after-merge"), {
        forceFull: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(changes.length).toBe(changeCount);
      await watcher.close();
    } finally {
      await stopServer(server);
    }
  });

  it("keeps ef merge stdout pinned and emits typed refusal JSON", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const cli = join(process.cwd(), "packages/cli/dist/src/bin.js");
      const repo = await new StreamFs({ baseUrl }).createRepo("merge-cli");
      await repo.createFile("a.txt", new TextEncoder().encode("main"));
      await repo.createBranch("feature");
      const source = await repo.openBranch("feature");
      await source.writeFile("a.txt", new TextEncoder().encode("feature"), { forceFull: true });
      const targetUrl = `${baseUrl}/streams/${encodeURIComponent(repo.metadataStreamId)}`;
      const sourceUrl = `${baseUrl}/streams/${encodeURIComponent(source.metadataStreamId)}`;
      const success = await runCliProcess(cli, ["merge", targetUrl, sourceUrl, "--ff-only"]);
      expect(success.status).toBe(0);
      expect(success.stderr).toBe("");
      expect(success.stdout).toMatch(/^[0-9]+(?:_[0-9]+)?\n[0-9a-f]{64}\n$/);
      const successLines = success.stdout.trim().split("\n");
      const targetAfter = await repo.dump();
      expect(successLines[0]).toBe(targetAfter.at(-1)!.offset);
      expect(successLines[1]).toBe(await repo.digest());

      const refusalRepo = await new StreamFs({ baseUrl }).createRepo("merge-cli-refusal");
      await refusalRepo.createFile("a.txt", new TextEncoder().encode("main"));
      await refusalRepo.createBranch("feature");
      const refusalSource = await refusalRepo.openBranch("feature");
      await refusalSource.writeFile("a.txt", new TextEncoder().encode("feature"), {
        forceFull: true,
      });
      await refusalRepo.writeFile("a.txt", new TextEncoder().encode("advanced"), {
        forceFull: true,
      });
      const refusal = await runCliProcess(cli, [
        "merge",
        `${baseUrl}/streams/${encodeURIComponent(refusalRepo.metadataStreamId)}`,
        `${baseUrl}/streams/${encodeURIComponent(refusalSource.metadataStreamId)}`,
        "--ff-only",
      ]);
      expect(refusal.status).not.toBe(0);
      expect(refusal.stdout).toBe("");
      expect(JSON.parse(refusal.stderr)).toMatchObject({
        error: { class: "validator-rejected", reason: "fs/merge-not-fast-forward" },
      });
    } finally {
      await stopServer(server);
    }
  });
});
