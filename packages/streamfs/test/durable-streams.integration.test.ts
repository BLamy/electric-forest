import { headDurableJsonStream, readDurableJson, type StreamRecord } from "@eforest/client";
import { createDurableStreamTestServer } from "@eforest/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  RepoExistsError,
  RepoNotFoundError,
  StreamFs,
  FsHttpError,
  mergeFastForward,
  treeDigest,
} from "../src/index.js";

const servers: Array<ReturnType<typeof createDurableStreamTestServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function startOfficialServer(): Promise<string> {
  const server = createDurableStreamTestServer({ port: 0, host: "127.0.0.1" });
  servers.push(server);
  return server.start();
}

describe("StreamFS on the published Durable Streams protocol", () => {
  it("runs CRUD, deterministic reduction, snapshots, and native branches", async () => {
    const baseUrl = await startOfficialServer();
    const client = new StreamFs({ baseUrl });
    const repo = await client.createRepo("cloud-compatible");

    await expect(client.createRepo("cloud-compatible")).rejects.toBeInstanceOf(RepoExistsError);
    await expect(client.openRepo("missing")).rejects.toBeInstanceOf(RepoNotFoundError);

    await repo.mkdir("docs");
    await repo.createFile("docs/readme.md", new TextEncoder().encode("first"));
    await repo.writeFile("docs/readme.md", new TextEncoder().encode("second"));
    expect(new TextDecoder().decode(await repo.readFile("docs/readme.md"))).toBe("second");

    const tree = await repo.tree();
    expect(await repo.digest()).toBe(treeDigest(tree));
    expect(tree.files["docs/readme.md"]?.size).toBe(6);

    const streamUrl = `${baseUrl}/streams/${encodeURIComponent(repo.metadataStreamId)}`;
    const officialHead = await headDurableJsonStream({ url: streamUrl });
    const officialItems = await readDurableJson<StreamRecord>({ url: streamUrl });
    expect(officialHead.exists).toBe(true);
    expect(officialItems).toEqual(await repo.dump());
    expect(new Set(officialItems.map((record) => record.offset)).size).toBe(officialItems.length);

    const watchFrom = officialItems.at(-1)!.offset;
    const watcher = repo.watch(".", { from: watchFrom, mode: "sse" });
    const watched = new Promise<{ event: string; path: string }>((resolve) => {
      watcher.onAll((event, path) => resolve({ event, path }));
    });
    await watcher.ready;
    await repo.createFile("watched.txt", new TextEncoder().encode("live"));
    await expect(watched).resolves.toEqual({ event: "add", path: "watched.txt" });
    await watcher.close();

    const snapshot = await repo.createSnapshot();
    const bootstrapped = await repo.bootstrapRead();
    expect(bootstrapped.snapshotEventOffset).toBe(snapshot.snapshotEventOffset);
    expect(treeDigest(bootstrapped.state)).toBe(await repo.digest());
    expect((await repo.compact()).snapshotOffset).toBe(snapshot.snapshotOffset);

    const branchReceipt = await repo.createBranch("feature");
    const branch = await repo.openBranch("feature");
    expect(branchReceipt.forkOffset).toBe((await repo.dump()).at(-1)?.offset);
    expect(new TextDecoder().decode(await branch.readFile("docs/readme.md"))).toBe("second");

    await branch.writeFile("docs/readme.md", new TextEncoder().encode("branch"));
    expect(new TextDecoder().decode(await branch.readFile("docs/readme.md"))).toBe("branch");
    expect(new TextDecoder().decode(await repo.readFile("docs/readme.md"))).toBe("second");

    const merge = await mergeFastForward(repo, branch);
    expect(merge.treeDigest).toBe(await branch.digest());
    expect(new TextDecoder().decode(await repo.readFile("docs/readme.md"))).toBe("branch");

    await branch.writeFile("docs/readme.md", new TextEncoder().encode("after-merge"));
    expect(new TextDecoder().decode(await repo.readFile("docs/readme.md"))).toBe("branch");

    await repo.createBranch("will-conflict");
    const conflictingBranch = await repo.openBranch("will-conflict");
    await conflictingBranch.writeFile("docs/readme.md", new TextEncoder().encode("source"));
    await repo.createFile("target-only.txt", new TextEncoder().encode("target"));
    await expect(mergeFastForward(repo, conflictingBranch)).rejects.toMatchObject({
      status: 409,
      body: {
        error: { class: "validator-rejected", reason: "fs/merge-not-fast-forward" },
      },
    } satisfies Partial<FsHttpError>);
  });

  it("fences concurrent same-base writers through official Stream-Seq coordination", async () => {
    const baseUrl = await startOfficialServer();
    const first = await new StreamFs({ baseUrl }).createRepo("concurrent-writers");
    const second = await new StreamFs({ baseUrl }).openRepo("concurrent-writers");
    await first.createFile("race.txt", new TextEncoder().encode("base"));

    const results = await Promise.allSettled([
      first.writeFile("race.txt", new TextEncoder().encode("first"), { forceFull: true }),
      second.writeFile("race.txt", new TextEncoder().encode("second"), { forceFull: true }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: {
        status: 409,
        body: {
          error: { class: "validator-rejected", reason: "stale-base" },
        },
      },
    });
    const value = new TextDecoder().decode(await first.readFile("race.txt"));
    expect(["first", "second"]).toContain(value);
  });
});
