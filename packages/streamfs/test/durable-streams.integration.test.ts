import { headDurableJsonStream, readDurableJson, type StreamRecord } from "@eforest/client";
import { createDurableStreamTestServer } from "@eforest/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  RepoExistsError,
  RepoNotFoundError,
  StreamFs,
  FsHttpError,
  contentMap,
  createSnapshot,
  digestBytes,
  isFsEvent,
  mergeFastForward,
  treeDigest,
  type FsFileWriteEvent,
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

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

function requestMethod(input: URL | RequestInfo, init?: RequestInit): string {
  if (init?.method !== undefined) return init.method.toUpperCase();
  return input instanceof Request ? input.method.toUpperCase() : "GET";
}

function requestUrl(input: URL | RequestInfo): string {
  return input instanceof Request ? input.url : String(input);
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
    await repo.rename("docs/readme.md", "docs/renamed.md");
    expect(new TextDecoder().decode(await repo.readFile("docs/renamed.md"))).toBe("second");
    await repo.rename("docs/renamed.md", "docs/readme.md");

    const patchBase = new TextEncoder().encode("patch-seed\n".repeat(80));
    const patchResult = new TextEncoder().encode(`${"patch-seed\n".repeat(79)}patch-final\n`);
    await repo.createFile("patch.txt", patchBase);
    await repo.writeFile("patch.txt", patchResult);
    expect((await repo.rawDump()).at(-1)?.type).toBe("fs.file.patch");
    expect(await repo.readFile("patch.txt")).toEqual(patchResult);

    await repo.createFile("recreated.txt", new TextEncoder().encode("deleted"));
    await repo.deleteFile("recreated.txt");
    await repo.createFile("recreated.txt", new TextEncoder().encode("reborn"));
    expect(new TextDecoder().decode(await repo.readFile("recreated.txt"))).toBe("reborn");

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
    const targetDumpBeforeRefusal = JSON.stringify(await repo.rawDump());
    const sourceDumpBeforeRefusal = JSON.stringify(await conflictingBranch.rawDump());
    const targetDigestBeforeRefusal = await repo.digest();
    const sourceDigestBeforeRefusal = await conflictingBranch.digest();
    await expect(mergeFastForward(repo, conflictingBranch)).rejects.toMatchObject({
      status: 409,
      body: {
        error: { class: "validator-rejected", reason: "fs/merge-not-fast-forward" },
      },
    } satisfies Partial<FsHttpError>);
    expect(JSON.stringify(await repo.rawDump())).toBe(targetDumpBeforeRefusal);
    expect(JSON.stringify(await conflictingBranch.rawDump())).toBe(sourceDumpBeforeRefusal);
    expect(await repo.digest()).toBe(targetDigestBeforeRefusal);
    expect(await conflictingBranch.digest()).toBe(sourceDigestBeforeRefusal);
  });

  it("ignores loser-first orphan content when the other same-base writer commits", async () => {
    const baseUrl = await startOfficialServer();
    const setup = await new StreamFs({ baseUrl }).createRepo("concurrent-writers");
    await setup.createFile("race.txt", new TextEncoder().encode("base"));
    const contentStreamId = (await setup.tree()).files["race.txt"]!.contentStreamId;
    const metadataUrl = `${baseUrl}/streams/${encodeURIComponent(setup.metadataStreamId)}`;
    const loserMetadataAppendStarted = deferred();
    const releaseLoserMetadataAppend = deferred();
    const loserFetch: typeof fetch = async (input, init) => {
      if (requestMethod(input, init) === "POST" && requestUrl(input) === metadataUrl) {
        loserMetadataAppendStarted.resolve();
        await releaseLoserMetadataAppend.promise;
      }
      return fetch(input, init);
    };
    const loser = await new StreamFs({ baseUrl, fetch: loserFetch }).openRepo("concurrent-writers");
    const winner = await new StreamFs({ baseUrl }).openRepo("concurrent-writers");

    const loserWrite = loser.writeFile("race.txt", new TextEncoder().encode("A"), {
      forceFull: true,
    });
    await loserMetadataAppendStarted.promise;
    await winner.writeFile("race.txt", new TextEncoder().encode("B"), { forceFull: true });
    releaseLoserMetadataAppend.resolve();

    await expect(loserWrite).rejects.toMatchObject({
      status: 409,
      body: {
        error: { class: "validator-rejected", reason: "stale-base" },
      },
    });

    const contentUrl = `${baseUrl}/streams/${encodeURIComponent(contentStreamId)}`;
    const content = await readDurableJson<{
      readonly payload: { readonly contentBase64: string };
    }>({ url: contentUrl });
    expect(
      content.map((record) => Buffer.from(record.payload.contentBase64, "base64").toString("utf8")),
    ).toEqual(["base", "A", "B"]);

    const metadata = await setup.rawDump();
    const writes = metadata
      .map((record) => ({ type: record.type, payload: record.payload, ts: record.ts }))
      .filter(
        (event): event is FsFileWriteEvent =>
          isFsEvent(event) && event.type === "fs.file.write" && event.payload.path === "race.txt",
      );
    expect(writes).toHaveLength(2);
    expect(writes.at(-1)?.payload).toMatchObject({
      contentSha256: digestBytes(new TextEncoder().encode("B")),
      size: 1,
    });
    const fresh = await new StreamFs({ baseUrl }).openRepo("concurrent-writers");
    expect(new TextDecoder().decode(await fresh.readFile("race.txt"))).toBe("B");

    await createSnapshot({
      baseUrl: setup.baseUrl,
      metadataStreamId: setup.metadataStreamId,
      fetcher: setup.fetcher,
      now: () => 0,
      writeContent: (streamId, bytes) => setup.writeContent(streamId, bytes),
      dispatchSnapshot: (event) => setup.dispatchSnapshot(event),
    });
    const bootstrapped = await setup.bootstrapRead();
    const snapshotBytes = contentMap(bootstrapped.state).get(contentStreamId);
    expect(new TextDecoder().decode(snapshotBytes)).toBe("B");
  });

  it("materializes patch, rename, delete/recreate, and COW handoff without live readers", async () => {
    const baseUrl = await startOfficialServer();
    const main = await new StreamFs({ baseUrl }).createRepo("snapshot-fallback-paths");
    await main.mkdir("docs");
    const inheritedBase = new TextEncoder().encode("seed-line\n".repeat(96));
    const inheritedResult = new TextEncoder().encode(
      `${"seed-line\n".repeat(95)}inherited-result\n`,
    );
    const ownedResult = new TextEncoder().encode(
      `${"seed-line\n".repeat(94)}owned-result-one\nowned-result-two\n`,
    );
    await main.createFile("docs/patch.txt", inheritedBase);
    await main.createFile("recreated.txt", new TextEncoder().encode("old-value"));

    await main.createBranch("fallback");
    const branch = await main.openBranch("fallback");
    await branch.writeFile("docs/patch.txt", inheritedResult);
    await branch.rename("docs/patch.txt", "docs/renamed.txt");
    await branch.writeFile("docs/renamed.txt", ownedResult);
    await branch.deleteFile("recreated.txt");
    await branch.createFile("recreated.txt", new TextEncoder().encode("reborn-value"));

    const before = await branch.tree();
    const renamedStreamId = before.files["docs/renamed.txt"]!.contentStreamId;
    const recreatedStreamId = before.files["recreated.txt"]!.contentStreamId;
    expect(
      (await branch.resolvedDump()).filter((record) => record.type === "fs.file.patch"),
    ).toHaveLength(2);

    const receipt = await createSnapshot({
      baseUrl: branch.baseUrl,
      metadataStreamId: branch.metadataStreamId,
      fetcher: branch.fetcher,
      now: () => 4242,
      writeContent: (streamId, content) => branch.writeContent(streamId, content),
      dispatchSnapshot: (event) => branch.dispatchSnapshot(event),
    });
    const bootstrapped = await branch.bootstrapRead();
    const materialized = contentMap(bootstrapped.state);

    expect(receipt.snapshotOffset).not.toBe("-1");
    expect(bootstrapped.snapshotEventOffset).toBe(receipt.snapshotEventOffset);
    expect(treeDigest(bootstrapped.state)).toBe(await branch.digest());
    expect(materialized.get(renamedStreamId)).toEqual(ownedResult);
    expect(materialized.get(recreatedStreamId)).toEqual(new TextEncoder().encode("reborn-value"));
  });
});
