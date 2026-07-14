import { createDurableStreamTestServer } from "@eforest/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyThreeWayMerge,
  fsInitialState,
  fsReducer,
  planThreeWayMerge,
  StreamFs,
  treeDigest,
  type StreamFsRepo,
} from "../src/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const servers: Array<ReturnType<typeof createDurableStreamTestServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function startOfficialServer(): Promise<string> {
  const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  return server.start();
}

async function branch(target: StreamFsRepo): Promise<StreamFsRepo> {
  await target.createBranch("feature");
  return target.openBranch("feature");
}

function document(markers: Readonly<Record<number, string>> = {}): Uint8Array {
  const lines = Array.from(
    { length: 128 },
    (_, index) => markers[index] ?? `line-${String(index).padStart(3, "0")}`,
  );
  return encoder.encode(`${lines.join("\n")}\n`);
}

async function replayDigest(repo: StreamFsRepo): Promise<string> {
  const replay = (await repo.rawDump()).reduce(
    (state, record) => fsReducer(state, record),
    fsInitialState,
  );
  return treeDigest(replay);
}

describe("three-way merge identity boundaries", () => {
  it("surfaces a same-byte delete and recreation as an identity conflict", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("same-byte-recreation-boundary");
    const bytes = document();
    await target.createFile("doc.txt", bytes);
    const baseIdentity = (await target.tree()).files["doc.txt"]!.contentStreamId;
    const source = await branch(target);

    await target.writeFile("doc.txt", document({ 10: "target edit" }));
    await source.deleteFile("doc.txt");
    await source.createFile("doc.txt", bytes);
    const sourceIdentity = (await source.tree()).files["doc.txt"]!.contentStreamId;
    expect(sourceIdentity).not.toBe(baseIdentity);

    const plan = await planThreeWayMerge(target, source);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      path: "doc.txt",
      kind: "edit-edit",
      reason: "non-patchable",
      base: { node: { kind: "file", path: "doc.txt", contentStreamId: baseIdentity } },
      target: { node: { kind: "file", path: "doc.txt", contentStreamId: baseIdentity } },
      source: { node: { kind: "file", path: "doc.txt", contentStreamId: sourceIdentity } },
    });
    const receipt = await applyThreeWayMerge(target, source, plan);
    expect((await target.tree()).files["doc.txt"]!.contentStreamId).toBe(baseIdentity);
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
  });

  it("isolates an equivalent two-hop identity from reuse of its vacated alias", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("two-hop-alias-reuse-boundary");
    await target.createFile("a.txt", document());
    await target.createFile("other.txt", encoder.encode("other base\n"));
    const source = await branch(target);

    await target.writeFile("a.txt", document({ 10: "target identity patch" }));
    await target.rename("a.txt", "target-temp-1.txt");
    await target.rename("target-temp-1.txt", "target-temp-2.txt");
    await target.rename("target-temp-2.txt", "c.txt");
    await target.writeFile("other.txt", encoder.encode("unrelated target occupant\n"), {
      forceFull: true,
    });
    await target.rename("other.txt", "a.txt");
    await source.rename("a.txt", "source-temp.txt");
    await source.writeFile("source-temp.txt", document({ 96: "source identity patch" }));
    await source.rename("source-temp.txt", "c.txt");

    const plan = await planThreeWayMerge(target, source);
    expect(plan.conflicts).toEqual([]);
    expect(plan.changes.map(({ type }) => type)).toEqual(["fs.file.patch"]);
    const receipt = await applyThreeWayMerge(target, source, plan);
    const merged = decoder.decode(await target.readFile("c.txt"));
    expect(merged).toContain("target identity patch");
    expect(merged).toContain("source identity patch");
    expect(decoder.decode(await target.readFile("a.txt"))).toBe("unrelated target occupant\n");
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
  });

  it.each(["rename", "delete", "dir-create", "dir-remove"] as const)(
    "adopts a disjoint %s suffix below a shared parent rename",
    async (operation) => {
      const baseUrl = await startOfficialServer();
      const target = await new StreamFs({ baseUrl }).createRepo(`parent-suffix-${operation}`);
      await target.mkdir("old");
      await target.mkdir("old/source-dir");
      await target.createFile("old/source.txt", encoder.encode("source base\n"));
      await target.createFile("old/target.txt", document());
      const source = await branch(target);

      await target.rename("old", "new");
      await source.rename("old", "new");
      await target.writeFile("new/target.txt", document({ 12: "target sibling edit" }));
      if (operation === "rename") {
        await source.rename("new/source.txt", "new/renamed.txt");
      } else if (operation === "delete") {
        await source.deleteFile("new/source.txt");
      } else if (operation === "dir-create") {
        await source.mkdir("new/source-dir-2");
      } else {
        await source.rmdir("new/source-dir");
      }

      const plan = await planThreeWayMerge(target, source);
      expect(plan.conflicts).toEqual([]);
      expect(plan.changes).toHaveLength(1);
      const receipt = await applyThreeWayMerge(target, source, plan);
      expect(decoder.decode(await target.readFile("new/target.txt"))).toContain(
        "target sibling edit",
      );
      expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    },
  );

  it("cites a moved target file and source file at their live paths", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("moved-file-reference-boundary");
    await target.createFile("a.txt", document());
    const source = await branch(target);
    await target.rename("a.txt", "b.txt");
    await source.rename("a.txt", "b.txt");
    await target.rename("b.txt", "c.txt");
    await source.writeFile("b.txt", document({ 96: "source patch" }));

    const plan = await planThreeWayMerge(target, source);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      base: { node: { kind: "file", path: "a.txt" } },
      target: { node: { kind: "file", path: "c.txt" } },
      source: { node: { kind: "file", path: "b.txt" } },
    });
  });

  it("cites a moved target descendant at its live directory alias", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("moved-descendant-reference");
    await target.mkdir("src");
    await target.createFile("src/notes.txt", document());
    const source = await branch(target);
    await target.rename("src", "lib");
    await source.writeFile("src/notes.txt", document({ 96: "source nested patch" }));

    const plan = await planThreeWayMerge(target, source);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      base: { node: { kind: "file", path: "src/notes.txt" } },
      target: { node: { kind: "file", path: "lib/notes.txt" } },
      source: { node: { kind: "file", path: "src/notes.txt" } },
    });
  });

  it.each(["file", "directory"] as const)(
    "cites the actual source %s replacement after a shared rename",
    async (kind) => {
      const baseUrl = await startOfficialServer();
      const target = await new StreamFs({ baseUrl }).createRepo(`source-${kind}-replacement-ref`);
      if (kind === "file") {
        await target.createFile("original", document());
        await target.createFile("spare", encoder.encode("replacement\n"));
      } else {
        await target.mkdir("original");
        await target.mkdir("spare");
      }
      const source = await branch(target);
      await target.rename("original", "live");
      await source.rename("original", "live");
      if (kind === "file") {
        await target.writeFile("live", document({ 12: "target edit" }));
        await source.deleteFile("live");
      } else {
        await target.mkdir("live/target-child");
        await source.rmdir("live");
      }
      await source.rename("spare", "live");
      const sourceTree = await source.tree();

      const plan = await planThreeWayMerge(target, source);
      expect(plan.changes).toEqual([]);
      expect(plan.conflicts).toHaveLength(1);
      const nodeKind = kind === "file" ? "file" : "dir";
      expect(plan.conflicts[0]).toMatchObject({
        base: { node: { kind: nodeKind, path: "original" } },
        target: { node: { kind: nodeKind, path: "live" } },
        source: {
          node:
            kind === "file"
              ? {
                  kind: "file",
                  path: "live",
                  contentStreamId: sourceTree.files.live!.contentStreamId,
                }
              : { kind: "dir", path: "live" },
        },
      });
    },
  );

  it("terminates patch identity after file deletion and terminal-path reuse", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("delete-path-reuse-boundary");
    await target.createFile("a.txt", document());
    await target.createFile("other.txt", document());
    const source = await branch(target);
    await target.writeFile("a.txt", document({ 10: "discarded inherited patch" }));
    await target.deleteFile("a.txt");
    await target.rename("other.txt", "a.txt");
    await target.writeFile("a.txt", document({ 20: "target replacement patch" }));
    await source.writeFile("a.txt", document({ 96: "source inherited patch" }));

    const plan = await planThreeWayMerge(target, source);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({ path: "a.txt", reason: "non-patchable" });
  });
});
