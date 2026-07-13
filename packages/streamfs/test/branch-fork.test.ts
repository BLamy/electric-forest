import { createHttpServer, MemoryStreamStore } from "@eforest/server";
import { describe, expect, it } from "vitest";
import {
  FsHttpError,
  StreamFs,
  createStreamFsServerOptions,
  isBranchContentStreamId,
  resolveBranchLog,
} from "../src/index.js";

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

describe("stream-fs branch streams", () => {
  it("forks in O(1), resolves frozen history, and keeps copy-on-write edits independent", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const repo = await new StreamFs({ baseUrl }).createRepo("branch-tests");
      await repo.mkdir("src");
      await repo.createFile("src/shared.txt", new TextEncoder().encode("parent"));
      await repo.createFile("src/other.txt", new TextEncoder().encode("other"));
      const patchBase = `header-${"A".repeat(320)}-footer`;
      await repo.createFile("src/patched.txt", new TextEncoder().encode(patchBase));
      await repo.rename("src/other.txt", "src/renamed.txt");
      const parentBefore = await repo.dump();
      const parentDigest = await repo.digest();
      const parentContentId = (await repo.tree()).files["src/patched.txt"]!.contentStreamId;
      const parentContentBefore = await fetch(
        `${baseUrl}/streams/${encodeURIComponent(parentContentId)}?offset=-1`,
      ).then(async (response) => response.json());
      const fork = await repo.createBranch("feature");
      expect(fork.forkOffset).toBe(parentBefore.at(-1)?.offset);

      const branch = await repo.openBranch("feature");
      expect(await branch.dump()).toHaveLength(1);
      expect(await branch.digest()).toBe(parentDigest);
      expect(new TextDecoder().decode(await branch.readFile("src/renamed.txt"))).toBe("other");

      await branch.writeFile("src/shared.txt", new TextEncoder().encode("branch"), {
        forceFull: true,
      });
      const branchTree = await branch.tree();
      const parentTree = await repo.tree();
      expect(isBranchContentStreamId(branchTree.files["src/shared.txt"]?.contentStreamId)).toBe(
        true,
      );
      expect(parentTree.files["src/shared.txt"]?.contentStreamId).not.toBe(
        branchTree.files["src/shared.txt"]?.contentStreamId,
      );
      expect(new TextDecoder().decode(await branch.readFile("src/shared.txt"))).toBe("branch");
      expect(new TextDecoder().decode(await repo.readFile("src/shared.txt"))).toBe("parent");
      expect(await repo.dump()).toEqual(parentBefore);

      const patchedTarget = `header-B${"A".repeat(319)}-footer`;
      await branch.writeFile("src/patched.txt", new TextEncoder().encode(patchedTarget));
      const branchDump = await branch.dump();
      expect(branchDump.some((record) => record.type === "fs.file.patch")).toBe(true);
      const patchedTree = await branch.tree();
      expect(isBranchContentStreamId(patchedTree.files["src/patched.txt"]?.contentStreamId)).toBe(
        true,
      );
      expect(new TextDecoder().decode(await branch.readFile("src/patched.txt"))).toBe(
        patchedTarget,
      );
      expect(await repo.dump()).toEqual(parentBefore);
      expect(
        await fetch(`${baseUrl}/streams/${encodeURIComponent(parentContentId)}?offset=-1`).then(
          async (response) => response.json(),
        ),
      ).toEqual(parentContentBefore);

      await repo.writeFile("src/shared.txt", new TextEncoder().encode("parent-2"), {
        forceFull: true,
      });
      expect(new TextDecoder().decode(await branch.readFile("src/shared.txt"))).toBe("branch");
      expect(new TextDecoder().decode(await repo.readFile("src/shared.txt"))).toBe("parent-2");
      expect(new TextDecoder().decode(await branch.readFile("src/renamed.txt"))).toBe("other");
    } finally {
      await stopServer(server);
    }
  });

  it("resolves a two-deep fork chain and refuses invalid offsets", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const repo = await new StreamFs({ baseUrl }).createRepo("chain-tests");
      await repo.createFile("a.txt", new TextEncoder().encode("a"));
      const feature = await repo.createBranch("feature");
      const featureRepo = await repo.openBranch("feature");
      await featureRepo.writeFile("a.txt", new TextEncoder().encode("b"), { forceFull: true });
      const nested = await featureRepo.createBranch("nested");
      const nestedRepo = await featureRepo.openBranch("nested");
      expect(nested.forkOffset).toBe((await featureRepo.dump()).at(-1)?.offset);
      expect(await nestedRepo.digest()).toBe(await featureRepo.digest());

      const featureDump = await featureRepo.dump();
      const mainDump = await repo.dump();
      expect(
        resolveBranchLog([
          { streamId: nestedRepo.metadataStreamId, records: await nestedRepo.dump() },
          { streamId: featureRepo.metadataStreamId, records: featureDump },
          { streamId: repo.metadataStreamId, records: mainDump },
        ]),
      ).toHaveLength(mainDump.length + featureDump.length - 1 + 0);

      const invalid = await fetch(
        `${baseUrl}/streams/${encodeURIComponent(nestedRepo.metadataStreamId)}/dispatch`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "fs.branch.fork",
            payload: {
              v: 1,
              parentStreamId: repo.metadataStreamId,
              forkOffset: feature.forkOffset,
            },
            ts: 1,
          }),
        },
      );
      expect(invalid.status).toBe(409);
      expect((await invalid.json()).error.reason).toBe("fs/branch-exists");
      await expect(repo.createBranch("main")).rejects.toBeInstanceOf(TypeError);
      await expect(repo.createBranch("meta")).rejects.toBeInstanceOf(TypeError);
      await expect(repo.createBranch("file")).rejects.toBeInstanceOf(TypeError);
      await expect(repo.createBranch(":bad")).rejects.toBeInstanceOf(TypeError);
    } finally {
      await stopServer(server);
    }
  });

  it("keeps branch-side create, delete, rename, and directory events branch-owned", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const repo = await new StreamFs({ baseUrl }).createRepo("branch-metadata-tests");
      await repo.mkdir("src");
      await repo.createFile("src/inherited-delete.txt", new TextEncoder().encode("parent"));
      const parentBefore = await repo.dump();
      const branch = await repo.createBranch("feature");
      const feature = await repo.openBranch("feature");

      await feature.deleteFile("src/inherited-delete.txt");
      await feature.mkdir("src/new-dir");
      await feature.createFile("src/new-dir/new.txt", new TextEncoder().encode("branch"));
      await feature.rename("src/new-dir", "src/renamed-dir");
      await feature.deleteFile("src/renamed-dir/new.txt");
      await feature.rmdir("src/renamed-dir");

      const types = new Set((await feature.dump()).map((record) => record.type));
      for (const type of [
        "fs.dir.create",
        "fs.file.create",
        "fs.file.delete",
        "fs.rename",
        "fs.dir.remove",
      ]) {
        expect(types.has(type)).toBe(true);
      }
      expect(await repo.dump()).toEqual(parentBefore);
      expect((await repo.tree()).files["src/inherited-delete.txt"]).toBeDefined();
      expect((await feature.tree()).files["src/inherited-delete.txt"]).toBeUndefined();
      expect((await feature.tree()).dirs["src/renamed-dir"]).toBeUndefined();
    } finally {
      await stopServer(server);
    }
  });

  it("exposes typed HTTP errors for a future fork offset", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const repo = await new StreamFs({ baseUrl }).createRepo("invalid-offset");
      await repo.createFile("a.txt", new TextEncoder().encode("a"));
      const response = await fetch(
        `${baseUrl}/streams/${encodeURIComponent("fs:invalid-offset:feature:meta")}/dispatch`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "fs.branch.fork",
            payload: {
              v: 1,
              parentStreamId: repo.metadataStreamId,
              forkOffset: "0000000000000000_9999",
            },
            ts: 1,
          }),
        },
      );
      expect(response.status).toBe(404);
      await expect(
        repo.createBranch("feature", { at: "-1" as import("@eforest/protocol").Offset }),
      ).rejects.toBeInstanceOf(FsHttpError);
    } finally {
      await stopServer(server);
    }
  });
});
