import { createDurableStreamTestServer } from "@eforest/server";
import { canonicalJson } from "@eforest/protocol";
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
  const raw = await repo.rawDump();
  const replay = raw.reduce((state, record) => fsReducer(state, record), fsInitialState);
  const repeated = raw.reduce((state, record) => fsReducer(state, record), fsInitialState);
  expect(treeDigest(repeated)).toBe(treeDigest(replay));
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

  it.each(["file", "directory"] as const)(
    "isolates a source %s identity from a later occupant of its transient alias",
    async (kind) => {
      const baseUrl = await startOfficialServer();
      const target = await new StreamFs({ baseUrl }).createRepo(`source-transient-${kind}`);
      if (kind === "file") {
        await target.createFile("original", encoder.encode("A\n"));
        await target.createFile("other", encoder.encode("B\n"));
      } else {
        await target.mkdir("original");
        await target.createFile("original/a.txt", encoder.encode("A\n"));
        await target.mkdir("other");
        await target.createFile("other/b.txt", encoder.encode("B\n"));
      }
      const source = await branch(target);
      await target.rename("original", "final");
      await source.rename("original", "temporary");
      await source.rename("temporary", "final");
      await source.rename("other", "temporary");

      const targetHead = (await target.rawDump()).at(-1)!.offset;
      const sourceHead = (await source.rawDump()).at(-1)!.offset;
      const plan = await planThreeWayMerge(target, source);
      const repeated = await planThreeWayMerge(target, source);
      expect(repeated).toEqual(plan);
      expect((await target.rawDump()).at(-1)!.offset).toBe(targetHead);
      expect((await source.rawDump()).at(-1)!.offset).toBe(sourceHead);
      expect(plan.conflicts).toEqual([]);
      expect(plan.changes).toEqual([
        { type: "fs.rename", payload: { v: 2, from: "other", to: "temporary" } },
      ]);
      const receipt = await applyThreeWayMerge(target, source, plan);
      expect(decoder.decode(await target.readFile(kind === "file" ? "final" : "final/a.txt"))).toBe(
        "A\n",
      );
      expect(
        decoder.decode(await target.readFile(kind === "file" ? "temporary" : "temporary/b.txt")),
      ).toBe("B\n");
      expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    },
  );

  it.each([1, 2] as const)(
    "keeps source transient aliases separate from later occupants (%s aliases)",
    async (aliases) => {
      const baseUrl = await startOfficialServer();
      const target = await new StreamFs({ baseUrl }).createRepo(`source-transient-${aliases}`);
      await target.createFile("a.txt", document());
      await target.createFile("other-one.txt", encoder.encode("other one\n"));
      if (aliases === 2) {
        await target.createFile("other-two.txt", encoder.encode("other two\n"));
      }
      const source = await branch(target);
      await target.writeFile("a.txt", document({ 10: "target identity patch" }));
      await target.rename("a.txt", "final.txt");
      await source.rename("a.txt", "source-one.txt");
      await source.writeFile("source-one.txt", document({ 96: "source identity patch" }));
      if (aliases === 2) {
        await source.rename("source-one.txt", "source-two.txt");
        await source.rename("source-two.txt", "final.txt");
      } else {
        await source.rename("source-one.txt", "final.txt");
      }
      await source.rename("other-one.txt", "source-one.txt");
      if (aliases === 2) await source.rename("other-two.txt", "source-two.txt");

      const plan = await planThreeWayMerge(target, source);
      expect(plan.conflicts).toEqual([]);
      expect(plan.changes.some(({ type }) => type === "fs.file.patch")).toBe(true);
      const receipt = await applyThreeWayMerge(target, source, plan);
      const merged = decoder.decode(await target.readFile("final.txt"));
      expect(merged).toContain("target identity patch");
      expect(merged).toContain("source identity patch");
      expect(decoder.decode(await target.readFile("source-one.txt"))).toBe("other one\n");
      if (aliases === 2) {
        expect(decoder.decode(await target.readFile("source-two.txt"))).toBe("other two\n");
      }
      expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    },
  );

  it.each(["target-long", "source-long"] as const)(
    "aligns equivalent file moves through different directory scaffolds (%s)",
    async (longSide) => {
      const baseUrl = await startOfficialServer();
      const target = await new StreamFs({ baseUrl }).createRepo(`scaffold-${longSide}`);
      await target.createFile("a.txt", document());
      const source = await branch(target);
      const long = async (repo: StreamFsRepo, temporary: string, marker: number) => {
        await repo.writeFile("a.txt", document({ [marker]: `${temporary} edit` }));
        await repo.mkdir(temporary);
        await repo.rename("a.txt", `${temporary}/a.txt`);
        await repo.rename(temporary, "final");
      };
      const short = async (repo: StreamFsRepo, marker: number) => {
        await repo.writeFile("a.txt", document({ [marker]: "short edit" }));
        await repo.rename("a.txt", "final/a.txt");
      };
      if (longSide === "target-long") {
        await long(target, "target-tmp", 10);
        await source.mkdir("final");
        await short(source, 96);
      } else {
        await target.mkdir("final");
        await short(target, 10);
        await long(source, "source-tmp", 96);
      }

      const sourceBefore = canonicalJson(await source.rawDump());
      const plan = await planThreeWayMerge(target, source);
      expect(plan.conflicts).toEqual([]);
      const receipt = await applyThreeWayMerge(target, source, plan);
      const merged = decoder.decode(await target.readFile("final/a.txt"));
      expect(merged).toContain(longSide === "target-long" ? "target-tmp edit" : "short edit");
      expect(merged).toContain(longSide === "target-long" ? "short edit" : "source-tmp edit");
      expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
      expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
    },
  );

  it.each(["target-atomic", "source-atomic"] as const)(
    "aligns an atomic directory rename with a decomposed child move (%s)",
    async (atomicSide) => {
      const baseUrl = await startOfficialServer();
      const target = await new StreamFs({ baseUrl }).createRepo(`decomposed-${atomicSide}`);
      await target.mkdir("old");
      await target.createFile("old/a.txt", document());
      const source = await branch(target);
      const atomic = async (repo: StreamFsRepo, marker: number) => {
        await repo.writeFile("old/a.txt", document({ [marker]: "atomic edit" }));
        await repo.rename("old", "new");
      };
      const decomposed = async (repo: StreamFsRepo, marker: number) => {
        await repo.writeFile("old/a.txt", document({ [marker]: "decomposed edit" }));
        await repo.mkdir("new");
        await repo.rename("old/a.txt", "new/a.txt");
        await repo.rmdir("old");
      };
      if (atomicSide === "target-atomic") {
        await atomic(target, 10);
        await decomposed(source, 96);
      } else {
        await decomposed(target, 10);
        await atomic(source, 96);
      }

      const plan = await planThreeWayMerge(target, source);
      expect(plan.conflicts).toEqual([]);
      const receipt = await applyThreeWayMerge(target, source, plan);
      const merged = decoder.decode(await target.readFile("new/a.txt"));
      expect(merged).toContain(atomicSide === "target-atomic" ? "atomic edit" : "decomposed edit");
      expect(merged).toContain(atomicSide === "target-atomic" ? "decomposed edit" : "atomic edit");
      expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    },
  );

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
