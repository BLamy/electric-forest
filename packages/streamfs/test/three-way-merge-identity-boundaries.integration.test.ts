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
  unresolvedMergeConflicts,
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

  it("keeps a clean source-created sibling outside a rejected created-file rename", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("created-sibling-isolation");
    await target.mkdir("d");
    const source = await branch(target);
    await target.createFile("d/final.txt", encoder.encode("target identity\n"));
    await source.createFile("d/temporary.txt", encoder.encode("source identity\n"));
    await source.rename("d/temporary.txt", "d/final.txt");
    await source.createFile("d/clean.txt", encoder.encode("clean sibling\n"));

    const targetBefore = canonicalJson(await target.rawDump());
    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect(canonicalJson(await target.rawDump())).toBe(targetBefore);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({ path: "d/final.txt" });
    expect(
      plan.changes.map((change) => [
        change.type,
        "path" in change.payload ? change.payload.path : undefined,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["fs.file.create", "d/clean.txt"],
        ["fs.file.write", "d/clean.txt"],
      ]),
    );

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("d/clean.txt"))).toBe("clean sibling\n");
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });

  it("aligns matching created scaffolds without widening a nested rename conflict", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("created-scaffold-isolation");
    await target.mkdir("d");
    const source = await branch(target);
    await target.mkdir("d/new");
    await target.mkdir("d/new/nested");
    await target.createFile("d/new/nested/final.txt", encoder.encode("target identity\n"));
    await source.mkdir("d/new");
    await source.mkdir("d/new/nested");
    await source.createFile("d/new/nested/temporary.txt", encoder.encode("source identity\n"));
    await source.rename("d/new/nested/temporary.txt", "d/new/nested/final.txt");
    await source.createFile("d/new/nested/clean.txt", encoder.encode("clean sibling\n"));

    const targetBefore = canonicalJson(await target.rawDump());
    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect(canonicalJson(await target.rawDump())).toBe(targetBefore);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({ path: "d/new/nested/final.txt" });
    expect(
      plan.changes.map((change) => [
        change.type,
        "path" in change.payload ? change.payload.path : undefined,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["fs.file.create", "d/new/nested/clean.txt"],
        ["fs.file.write", "d/new/nested/clean.txt"],
      ]),
    );

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("d/new/nested/clean.txt"))).toBe("clean sibling\n");
    expect(decoder.decode(await target.readFile("d/new/nested/final.txt"))).toBe(
      "target identity\n",
    );
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });

  it.each(["temporary", "reused"] as const)(
    "keeps a later created-directory occupant outside a rejected move (%s alias)",
    async (laterAlias) => {
      const baseUrl = await startOfficialServer();
      const target = await new StreamFs({ baseUrl }).createRepo(
        `created-directory-reuse-${laterAlias}`,
      );
      await target.createFile("base.txt", encoder.encode("base\n"));
      const source = await branch(target);
      await target.createFile("final", encoder.encode("target identity\n"));
      await source.mkdir("temporary");
      await source.createFile("temporary/source.txt", encoder.encode("source identity\n"));
      await source.rename("temporary", "final");
      await source.mkdir(laterAlias);
      await source.createFile(`${laterAlias}/clean.txt`, encoder.encode("clean occupant\n"));

      const targetBefore = canonicalJson(await target.rawDump());
      const sourceBefore = canonicalJson(await source.rawDump());
      const plan = await planThreeWayMerge(target, source);
      expect(await planThreeWayMerge(target, source)).toEqual(plan);
      expect(canonicalJson(await target.rawDump())).toBe(targetBefore);
      expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
      expect(plan.conflicts).toHaveLength(1);
      expect(plan.conflicts[0]).toMatchObject({ path: "final" });
      expect(
        plan.changes.map((change) => [
          change.type,
          "path" in change.payload ? change.payload.path : undefined,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ["fs.dir.create", laterAlias],
          ["fs.file.create", `${laterAlias}/clean.txt`],
          ["fs.file.write", `${laterAlias}/clean.txt`],
        ]),
      );

      const receipt = await applyThreeWayMerge(target, source, plan);
      expect(decoder.decode(await target.readFile(`${laterAlias}/clean.txt`))).toBe(
        "clean occupant\n",
      );
      expect(decoder.decode(await target.readFile("final"))).toBe("target identity\n");
      expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
      expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
    },
  );

  it("reports independent sibling collisions beneath one matching created scaffold", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("created-sibling-collisions");
    await target.createFile("base.txt", encoder.encode("base\n"));
    const source = await branch(target);
    await target.mkdir("d");
    await target.createFile("d/final-a.txt", encoder.encode("target A\n"));
    await target.createFile("d/final-b.txt", encoder.encode("target B\n"));
    await source.mkdir("d");
    await source.createFile("d/temp-a.txt", encoder.encode("source A\n"));
    await source.rename("d/temp-a.txt", "d/final-a.txt");
    await source.createFile("d/temp-b.txt", encoder.encode("source B\n"));
    await source.rename("d/temp-b.txt", "d/final-b.txt");
    await source.createFile("d/clean.txt", encoder.encode("clean\n"));

    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect(plan.conflicts.map(({ path }) => path)).toEqual(["d/final-a.txt", "d/final-b.txt"]);
    expect(
      plan.changes.some(({ payload }) => "path" in payload && payload.path === "d/clean.txt"),
    ).toBe(true);

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("d/final-a.txt"))).toBe("target A\n");
    expect(decoder.decode(await target.readFile("d/final-b.txt"))).toBe("target B\n");
    expect(decoder.decode(await target.readFile("d/clean.txt"))).toBe("clean\n");
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });

  it("keeps accepted, rejected, extinct, and recreated alias generations separate", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("mixed-alias-generations");
    await target.createFile("base.txt", encoder.encode("base\n"));
    const source = await branch(target);
    await target.createFile("blocked", encoder.encode("target blocked\n"));
    await source.mkdir("temporary");
    await source.createFile("temporary/accepted.txt", encoder.encode("accepted\n"));
    await source.rename("temporary", "accepted");
    await source.mkdir("temporary");
    await source.createFile("temporary/rejected.txt", encoder.encode("rejected\n"));
    await source.rename("temporary", "blocked");
    await source.mkdir("temporary");
    await source.createFile("temporary/discard.txt", encoder.encode("discard\n"));
    await source.deleteFile("temporary/discard.txt");
    await source.rmdir("temporary");
    await source.mkdir("temporary");
    await source.createFile("temporary/clean.txt", encoder.encode("clean\n"));

    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect(plan.conflicts.map(({ path }) => path)).toEqual(["blocked"]);
    expect(
      plan.changes.map((change) =>
        change.type === "fs.rename"
          ? [change.type, change.payload.from, change.payload.to]
          : [change.type, change.payload.path],
      ),
    ).toEqual([
      ["fs.dir.create", "temporary"],
      ["fs.file.create", "temporary/accepted.txt"],
      ["fs.file.write", "temporary/accepted.txt"],
      ["fs.rename", "temporary", "accepted"],
      ["fs.dir.create", "temporary"],
      ["fs.file.create", "temporary/clean.txt"],
      ["fs.file.write", "temporary/clean.txt"],
    ]);

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("blocked"))).toBe("target blocked\n");
    expect(decoder.decode(await target.readFile("accepted/accepted.txt"))).toBe("accepted\n");
    expect(decoder.decode(await target.readFile("temporary/clean.txt"))).toBe("clean\n");
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });

  it("adopts a replacement occupant below a rejected inherited root", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("rejected-root-replacement");
    await target.mkdir("old");
    await target.createFile("old/base.txt", encoder.encode("base\n"));
    const source = await branch(target);
    await target.writeFile("old/base.txt", encoder.encode("target edit\n"), {
      forceFull: true,
    });
    await source.rename("old", "final");
    await source.mkdir("old");
    await source.createFile("old/clean.txt", encoder.encode("replacement occupant\n"));

    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect(plan.conflicts.map(({ path }) => path)).toEqual(["final", "old"]);
    expect(plan.conflicts.find(({ path }) => path === "final")).toMatchObject({
      path: "final",
      source: { node: { kind: "dir", path: "final" } },
    });
    expect(plan.conflicts.find(({ path }) => path === "old")).toMatchObject({
      source: { node: { kind: "dir", path: "old" } },
    });
    expect(
      plan.changes.some(({ payload }) => "path" in payload && payload.path === "old/clean.txt"),
    ).toBe(true);

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("old/base.txt"))).toBe("target edit\n");
    expect(decoder.decode(await target.readFile("old/clean.txt"))).toBe("replacement occupant\n");
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });

  it("emits one durable current-state conflict after an extinct rejected generation", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("extinct-rejected-generation");
    await target.createFile("base.txt", encoder.encode("base\n"));
    const source = await branch(target);
    await target.createFile("final", encoder.encode("target C\n"));
    await source.createFile("temporary", encoder.encode("extinct A\n"));
    await source.rename("temporary", "final");
    await source.deleteFile("final");
    await source.createFile("final", encoder.encode("current B\n"));
    const sourceIdentity = (await source.tree()).files["final"]!.contentStreamId;

    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      path: "final",
      kind: "add-add",
      source: { node: { kind: "file", path: "final", contentStreamId: sourceIdentity } },
    });

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("final"))).toBe("target C\n");
    expect(unresolvedMergeConflicts(await target.tree())).toEqual(plan.conflicts);
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });

  it("drops a source-created rename generation whose complete effect is extinct", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("fully-extinct-generation");
    await target.createFile("base.txt", encoder.encode("base\n"));
    const source = await branch(target);
    await target.createFile("final", encoder.encode("target\n"));
    await source.createFile("temporary", encoder.encode("transient\n"));
    await source.rename("temporary", "final");
    await source.deleteFile("final");

    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts).toEqual([]);

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("final"))).toBe("target\n");
    expect(unresolvedMergeConflicts(await target.tree())).toEqual([]);
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });

  it("replaces a stale inherited-rename conflict with its recreated current state", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("recreated-inherited-generation");
    await target.createFile("final", encoder.encode("base A\n"));
    const source = await branch(target);
    await target.writeFile("final", encoder.encode("target C\n"), { forceFull: true });
    await source.rename("final", "temporary");
    await source.deleteFile("temporary");
    await source.createFile("final", encoder.encode("current B\n"));
    const sourceIdentity = (await source.tree()).files["final"]!.contentStreamId;

    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      path: "final",
      kind: "edit-edit",
      source: { node: { kind: "file", path: "final", contentStreamId: sourceIdentity } },
    });

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("final"))).toBe("target C\n");
    expect(unresolvedMergeConflicts(await target.tree())).toEqual(plan.conflicts);
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });

  it.each(["file", "directory"] as const)(
    "keeps a source-created identity beyond a colliding transient alias (%s)",
    async (kind) => {
      const baseUrl = await startOfficialServer();
      const target = await new StreamFs({ baseUrl }).createRepo(`transient-collision-${kind}`);
      await target.createFile("base.txt", encoder.encode("base\n"));
      const source = await branch(target);
      await target.createFile("middle", encoder.encode("target middle\n"));
      if (kind === "file") {
        await source.createFile("temporary", encoder.encode("moved A\n"));
      } else {
        await source.mkdir("temporary");
        await source.createFile("temporary/moved.txt", encoder.encode("moved subtree\n"));
      }
      const movedIdentity = (await source.tree()).files[
        kind === "file" ? "temporary" : "temporary/moved.txt"
      ]!.contentStreamId;
      await source.rename("temporary", "middle");
      await source.rename("middle", "final");
      await source.createFile("middle", encoder.encode("current B\n"));
      const currentIdentity = (await source.tree()).files.middle!.contentStreamId;

      const sourceBefore = canonicalJson(await source.rawDump());
      const plan = await planThreeWayMerge(target, source);
      expect(await planThreeWayMerge(target, source)).toEqual(plan);
      expect(plan.conflicts).toHaveLength(1);
      expect(plan.conflicts[0]).toMatchObject({
        path: "middle",
        kind: "add-add",
        source: { node: { kind: "file", path: "middle", contentStreamId: currentIdentity } },
      });
      expect(
        plan.changes.some(({ payload }) =>
          "path" in payload
            ? payload.path === (kind === "file" ? "final" : "final/moved.txt")
            : false,
        ),
      ).toBe(true);

      const receipt = await applyThreeWayMerge(target, source, plan);
      expect(decoder.decode(await target.readFile("middle"))).toBe("target middle\n");
      expect(
        decoder.decode(await target.readFile(kind === "file" ? "final" : "final/moved.txt")),
      ).toBe(kind === "file" ? "moved A\n" : "moved subtree\n");
      expect(
        (await target.tree()).files[kind === "file" ? "final" : "final/moved.txt"]!.contentStreamId,
      ).toBe(movedIdentity);
      expect(unresolvedMergeConflicts(await target.tree())).toEqual(plan.conflicts);
      expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
      expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
    },
  );

  it("names an inherited moved identity and the current replacement generation", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("inherited-current-generation");
    await target.createFile("middle", encoder.encode("base A\n"));
    const inheritedIdentity = (await target.tree()).files.middle!.contentStreamId;
    const source = await branch(target);
    await target.writeFile("middle", encoder.encode("target A edit\n"), { forceFull: true });
    await source.rename("middle", "final");
    await source.createFile("middle", encoder.encode("current B\n"));
    const currentIdentity = (await source.tree()).files.middle!.contentStreamId;

    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts.map(({ path }) => path).sort()).toEqual(["final", "middle"]);
    expect(plan.conflicts.find(({ path }) => path === "final")).toMatchObject({
      base: { node: { kind: "file", path: "middle", contentStreamId: inheritedIdentity } },
      target: { node: { kind: "file", path: "middle", contentStreamId: inheritedIdentity } },
      source: { node: { kind: "file", path: "final", contentStreamId: inheritedIdentity } },
    });
    expect(plan.conflicts.find(({ path }) => path === "middle")).toMatchObject({
      source: { node: { kind: "file", path: "middle", contentStreamId: currentIdentity } },
    });

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("middle"))).toBe("target A edit\n");
    await expect(target.readFile("final")).rejects.toMatchObject({ code: "file_not_found" });
    expect(unresolvedMergeConflicts(await target.tree())).toEqual(plan.conflicts);
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });

  it("plans a moved inherited directory and its file replacement without partial removal", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("directory-current-generation");
    await target.mkdir("old");
    await target.createFile("old/base.txt", encoder.encode("base A\n"));
    const inheritedIdentity = (await target.tree()).files["old/base.txt"]!.contentStreamId;
    const source = await branch(target);
    await target.writeFile("old/base.txt", encoder.encode("target A edit\n"), {
      forceFull: true,
    });
    await source.rename("old", "final");
    await source.createFile("old", encoder.encode("current B\n"));
    const currentIdentity = (await source.tree()).files.old!.contentStreamId;

    const targetHead = (await target.rawDump()).at(-1)!.offset;
    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect((await target.rawDump()).at(-1)!.offset).toBe(targetHead);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts.map(({ path }) => path).sort()).toEqual(["final", "old"]);
    expect(plan.conflicts.find(({ path }) => path === "final")).toMatchObject({
      base: { node: { kind: "dir", path: "old" } },
      target: { node: { kind: "dir", path: "old" } },
      source: { node: { kind: "dir", path: "final" } },
    });
    expect(plan.conflicts.find(({ path }) => path === "old")).toMatchObject({
      source: { node: { kind: "file", path: "old", contentStreamId: currentIdentity } },
    });

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("old/base.txt"))).toBe("target A edit\n");
    expect((await target.tree()).files["old/base.txt"]!.contentStreamId).toBe(inheritedIdentity);
    await expect(target.readFile("final/base.txt")).rejects.toMatchObject({
      code: "file_not_found",
    });
    expect(unresolvedMergeConflicts(await target.tree())).toEqual(plan.conflicts);
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });

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

  it("splits a moved inherited directory from a current same-kind replacement", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("dir-generation-split");
    await target.mkdir("old");
    await target.createFile("old/a.txt", encoder.encode("base A\n"));
    const source = await branch(target);
    await target.writeFile("old/a.txt", encoder.encode("target A edit\n"), {
      forceFull: true,
    });
    await source.rename("old", "final");
    await source.mkdir("old");
    await source.createFile("old/b.txt", encoder.encode("current B\n"));

    const targetBefore = canonicalJson(await target.rawDump());
    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect(canonicalJson(await target.rawDump())).toBe(targetBefore);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
    expect(plan.conflicts.map(({ path }) => path)).toEqual(["final", "old"]);
    expect(plan.conflicts.find(({ path }) => path === "final")).toMatchObject({
      source: { node: { kind: "dir", path: "final" } },
    });
    expect(plan.conflicts.find(({ path }) => path === "old")).toMatchObject({
      source: { node: { kind: "dir", path: "old" } },
    });

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("old/a.txt"))).toBe("target A edit\n");
    expect(decoder.decode(await target.readFile("old/b.txt"))).toBe("current B\n");
    expect(unresolvedMergeConflicts(await target.tree())).toEqual(plan.conflicts);
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });

  it("uses a descendant key when a same-kind directory replacement collides below", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("dir-generation-child-split");
    await target.mkdir("old");
    await target.createFile("old/a.txt", encoder.encode("base A\n"));
    const source = await branch(target);
    await target.writeFile("old/a.txt", encoder.encode("target A edit\n"), {
      forceFull: true,
    });
    await source.rename("old", "final");
    await source.mkdir("old");
    await source.createFile("old/a.txt", encoder.encode("current B\n"));
    const currentIdentity = (await source.tree()).files["old/a.txt"]!.contentStreamId;

    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect(plan.conflicts.map(({ path }) => path)).toEqual(["final", "old/a.txt"]);
    expect(plan.conflicts.find(({ path }) => path === "final")).toMatchObject({
      source: { node: { kind: "dir", path: "final" } },
    });
    expect(plan.conflicts.find(({ path }) => path === "old/a.txt")).toMatchObject({
      source: {
        node: { kind: "file", path: "old/a.txt", contentStreamId: currentIdentity },
      },
    });

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("old/a.txt"))).toBe("target A edit\n");
    expect(unresolvedMergeConflicts(await target.tree())).toEqual(plan.conflicts);
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });

  it("accounts for every live generation in a rejected inherited swap", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("rejected-swap-generations");
    await target.createFile("a", encoder.encode("base A\n"));
    await target.createFile("b", encoder.encode("base B\n"));
    const baseTree = await target.tree();
    const inheritedA = baseTree.files.a!.contentStreamId;
    const inheritedB = baseTree.files.b!.contentStreamId;
    const source = await branch(target);
    await target.writeFile("a", encoder.encode("target A edit\n"), { forceFull: true });
    await target.createFile("tmp", encoder.encode("target T\n"));
    await source.rename("a", "tmp");
    await source.rename("b", "a");
    await source.rename("tmp", "b");
    await source.createFile("tmp", encoder.encode("current C\n"));
    const currentC = (await source.tree()).files.tmp!.contentStreamId;

    const targetBefore = canonicalJson(await target.rawDump());
    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect(canonicalJson(await target.rawDump())).toBe(targetBefore);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts.map(({ path }) => path)).toEqual(["a", "b", "tmp"]);
    expect(plan.conflicts.find(({ path }) => path === "b")).toMatchObject({
      source: { node: { kind: "file", path: "b", contentStreamId: inheritedA } },
    });
    expect(plan.conflicts.find(({ path }) => path === "a")).toMatchObject({
      source: { node: { kind: "file", path: "a", contentStreamId: inheritedB } },
    });
    expect(plan.conflicts.find(({ path }) => path === "tmp")).toMatchObject({
      source: { node: { kind: "file", path: "tmp", contentStreamId: currentC } },
    });

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("a"))).toBe("target A edit\n");
    expect(decoder.decode(await target.readFile("b"))).toBe("base B\n");
    expect(decoder.decode(await target.readFile("tmp"))).toBe("target T\n");
    expect(unresolvedMergeConflicts(await target.tree())).toEqual(plan.conflicts);
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });

  it("cites the current target generation after an inherited alias is vacated", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("target-generation-reference");
    await target.createFile("old", encoder.encode("base A\n"));
    const source = await branch(target);
    await target.rename("old", "final");
    await target.createFile("old", encoder.encode("target current B\n"));
    const currentTargetIdentity = (await target.tree()).files.old!.contentStreamId;
    await source.writeFile("old", encoder.encode("source A edit\n"), { forceFull: true });

    const targetBefore = canonicalJson(await target.rawDump());
    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect(canonicalJson(await target.rawDump())).toBe(targetBefore);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      path: "old",
      target: {
        node: { kind: "file", path: "old", contentStreamId: currentTargetIdentity },
      },
    });

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("old"))).toBe("target current B\n");
    expect(decoder.decode(await target.readFile("final"))).toBe("base A\n");
    expect(unresolvedMergeConflicts(await target.tree())).toEqual(plan.conflicts);
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });

  it("does not re-emit a common-aligned directory when only its child diverges", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("common-parent-child-divergence");
    await target.mkdir("old");
    await target.createFile("old/a.txt", encoder.encode("base A\n"));
    const source = await branch(target);
    await target.rename("old", "final");
    await source.rename("old", "final");
    await target.writeFile("final/a.txt", encoder.encode("target A edit\n"), {
      forceFull: true,
    });
    await source.rename("final/a.txt", "elsewhere.txt");
    const inheritedIdentity = (await source.tree()).files["elsewhere.txt"]!.contentStreamId;

    const targetBefore = canonicalJson(await target.rawDump());
    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect(canonicalJson(await target.rawDump())).toBe(targetBefore);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      base: { node: { kind: "file", path: "old/a.txt", contentStreamId: inheritedIdentity } },
      target: {
        node: { kind: "file", path: "final/a.txt", contentStreamId: inheritedIdentity },
      },
      source: {
        node: { kind: "file", path: "elsewhere.txt", contentStreamId: inheritedIdentity },
      },
    });

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("final/a.txt"))).toBe("target A edit\n");
    expect(unresolvedMergeConflicts(await target.tree())).toEqual(plan.conflicts);
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });

  it("keys a moved directory and its escaped inherited child without overlap", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("split-parent-child-generations");
    await target.mkdir("old");
    await target.createFile("old/a.txt", encoder.encode("base A\n"));
    const source = await branch(target);
    await target.writeFile("old/a.txt", encoder.encode("target A edit\n"), {
      forceFull: true,
    });
    await source.rename("old", "final");
    await source.rename("final/a.txt", "elsewhere.txt");
    const inheritedIdentity = (await source.tree()).files["elsewhere.txt"]!.contentStreamId;

    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts.map(({ path }) => path)).toEqual(["elsewhere.txt", "final"]);
    expect(plan.conflicts.find(({ path }) => path === "final")).toMatchObject({
      base: { node: { kind: "dir", path: "old" } },
      target: { node: { kind: "dir", path: "old" } },
      source: { node: { kind: "dir", path: "final" } },
    });
    expect(plan.conflicts.find(({ path }) => path === "elsewhere.txt")).toMatchObject({
      base: { node: { kind: "file", path: "old/a.txt", contentStreamId: inheritedIdentity } },
      target: {
        node: { kind: "file", path: "old/a.txt", contentStreamId: inheritedIdentity },
      },
      source: {
        node: { kind: "file", path: "elsewhere.txt", contentStreamId: inheritedIdentity },
      },
    });

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("old/a.txt"))).toBe("target A edit\n");
    expect(unresolvedMergeConflicts(await target.tree())).toEqual(plan.conflicts);
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });

  it("keeps a target-edited replacement correlated after common alignment", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("aligned-edited-replacement");
    await target.createFile("original", encoder.encode("base A\n"));
    await target.createFile("spare", encoder.encode("base B\n"));
    const baseTree = await target.tree();
    const inheritedA = baseTree.files.original!.contentStreamId;
    const inheritedB = baseTree.files.spare!.contentStreamId;
    const source = await branch(target);
    await target.rename("original", "live");
    await source.rename("original", "live");
    await target.writeFile("spare", encoder.encode("target B edit\n"), { forceFull: true });
    await source.deleteFile("live");
    await source.rename("spare", "live");

    const targetBefore = canonicalJson(await target.rawDump());
    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect(canonicalJson(await target.rawDump())).toBe(targetBefore);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts.map(({ path }) => path)).toEqual(["live", "spare"]);
    expect(plan.conflicts.find(({ path }) => path === "live")).toMatchObject({
      base: { node: { kind: "file", path: "original", contentStreamId: inheritedA } },
      target: { node: { kind: "file", path: "live", contentStreamId: inheritedA } },
      source: { node: { kind: "file", path: "live", contentStreamId: inheritedB } },
    });
    expect(plan.conflicts.find(({ path }) => path === "spare")).toMatchObject({
      base: { node: { kind: "file", path: "spare", contentStreamId: inheritedB } },
      target: { node: { kind: "file", path: "spare", contentStreamId: inheritedB } },
      source: { node: { kind: "file", path: "live", contentStreamId: inheritedB } },
    });

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("live"))).toBe("base A\n");
    expect(decoder.decode(await target.readFile("spare"))).toBe("target B edit\n");
    expect(unresolvedMergeConflicts(await target.tree())).toEqual(plan.conflicts);
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });

  it("dependency-closes a created replacement below a conflicted moved root", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("moved-root-created-replacement");
    await target.mkdir("old");
    await target.createFile("old/a", encoder.encode("A\n"));
    const source = await branch(target);
    await target.writeFile("old/a", encoder.encode("target A\n"), { forceFull: true });
    await source.rename("old", "final");
    await source.rename("final/a", "escaped-a");
    await source.createFile("final/a", encoder.encode("replacement B\n"));

    const targetBefore = canonicalJson(await target.rawDump());
    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect(canonicalJson(await target.rawDump())).toBe(targetBefore);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts.map(({ path }) => path)).toEqual(["escaped-a", "final"]);
    expect(plan.conflicts.find(({ path }) => path === "final")).toMatchObject({
      base: { node: { kind: "dir", path: "old" } },
      target: { node: { kind: "dir", path: "old" } },
      source: { node: { kind: "dir", path: "final" } },
    });
    expect(plan.conflicts.find(({ path }) => path === "escaped-a")).toMatchObject({
      base: { node: { kind: "file", path: "old/a" } },
      target: { node: { kind: "file", path: "old/a" } },
      source: { node: { kind: "file", path: "escaped-a" } },
    });

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("old/a"))).toBe("target A\n");
    await expect(target.readFile("final/a")).rejects.toMatchObject({ code: "file_not_found" });
    expect(unresolvedMergeConflicts(await target.tree())).toEqual(plan.conflicts);
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });

  it("preserves an unchanged aligned replacement while its destination conflicts", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("aligned-subtree-replacement");
    await target.mkdir("old");
    await target.createFile("old/a.txt", encoder.encode("base A\n"));
    await target.createFile("old/b.txt", encoder.encode("base B\n"));
    await target.createFile("old/c.txt", encoder.encode("base C\n"));
    const source = await branch(target);
    await target.rename("old", "final");
    await source.rename("old", "final");
    await target.writeFile("final/a.txt", encoder.encode("target A edit\n"), {
      forceFull: true,
    });
    await target.writeFile("final/c.txt", encoder.encode("target C edit\n"), {
      forceFull: true,
    });
    await source.deleteFile("final/a.txt");
    await source.rename("final/b.txt", "final/a.txt");

    const targetBefore = canonicalJson(await target.rawDump());
    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect(canonicalJson(await target.rawDump())).toBe(targetBefore);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts.map(({ path }) => path)).toEqual(["final/a.txt"]);

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("final/a.txt"))).toBe("target A edit\n");
    expect(decoder.decode(await target.readFile("final/b.txt"))).toBe("base B\n");
    expect(decoder.decode(await target.readFile("final/c.txt"))).toBe("target C edit\n");
    expect(unresolvedMergeConflicts(await target.tree())).toEqual(plan.conflicts);
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });

  it("preserves a target-moved edited replacement after common alignment", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("aligned-moved-replacement");
    await target.createFile("original", encoder.encode("A\n"));
    await target.createFile("spare", encoder.encode("B\n"));
    const source = await branch(target);
    await target.rename("original", "live");
    await source.rename("original", "live");
    await target.rename("spare", "target-b");
    await target.writeFile("target-b", encoder.encode("target B edit\n"), { forceFull: true });
    await source.deleteFile("live");
    await source.rename("spare", "live");

    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts.map(({ path }) => path)).toEqual(["live", "spare"]);
    expect(plan.conflicts.find(({ path }) => path === "spare")).toMatchObject({
      target: { node: { kind: "file", path: "target-b" } },
      source: { node: { kind: "file", path: "live" } },
    });

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("live"))).toBe("A\n");
    expect(decoder.decode(await target.readFile("target-b"))).toBe("target B edit\n");
    expect(unresolvedMergeConflicts(await target.tree())).toEqual(plan.conflicts);
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });

  it("dependency-closes a populated target directory against source removal", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("dependency-populated-parent");
    await target.mkdir("dir");
    const source = await branch(target);
    await target.createFile("dir/target.txt", encoder.encode("target child\n"));
    await source.createFile("clean.txt", encoder.encode("independent source sibling\n"));
    await source.rmdir("dir");

    const targetBefore = canonicalJson(await target.rawDump());
    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect(canonicalJson(await target.rawDump())).toBe(targetBefore);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
    expect(
      plan.changes.map((change) => [
        change.type,
        change.type === "fs.rename" ? change.payload.to : change.payload.path,
      ]),
    ).toEqual([
      ["fs.file.create", "clean.txt"],
      ["fs.file.write", "clean.txt"],
    ]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      path: "dir",
      kind: "delete-edit",
      base: { node: { kind: "dir", path: "dir" } },
      target: { node: { kind: "dir", path: "dir" } },
      source: { node: { kind: "missing", path: "dir" } },
    });

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("dir/target.txt"))).toBe("target child\n");
    expect(decoder.decode(await target.readFile("clean.txt"))).toBe("independent source sibling\n");
    expect(unresolvedMergeConflicts(await target.tree())).toEqual(plan.conflicts);
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });

  it("dependency-closes a source grandchild below a target-renamed parent", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("dependency-renamed-parent");
    await target.mkdir("root");
    await target.mkdir("root/nested");
    const source = await branch(target);
    await target.rename("root", "target-root");
    await source.createFile("root/nested/new.txt", encoder.encode("source grandchild\n"));

    const targetBefore = canonicalJson(await target.rawDump());
    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect(canonicalJson(await target.rawDump())).toBe(targetBefore);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      path: "root",
      kind: "edit-edit",
      base: { node: { kind: "dir", path: "root" } },
      target: { node: { kind: "dir", path: "target-root" } },
      source: { node: { kind: "dir", path: "root" } },
    });

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect((await target.tree()).dirs["target-root/nested"]).toEqual({});
    await expect(target.readFile("root/nested/new.txt")).rejects.toMatchObject({
      code: "file_not_found",
    });
    expect(unresolvedMergeConflicts(await target.tree())).toEqual(plan.conflicts);
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });

  it("dependency-closes a source child below a target-removed parent", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("dependency-removed-parent");
    await target.mkdir("dir");
    const source = await branch(target);
    await target.rmdir("dir");
    await source.createFile("dir/new.txt", encoder.encode("source child\n"));
    await source.createFile("clean.txt", encoder.encode("independent source sibling\n"));

    const targetBefore = canonicalJson(await target.rawDump());
    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect(canonicalJson(await target.rawDump())).toBe(targetBefore);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
    expect(
      plan.changes.map((change) => [
        change.type,
        change.type === "fs.rename" ? change.payload.to : change.payload.path,
      ]),
    ).toEqual([
      ["fs.file.create", "clean.txt"],
      ["fs.file.write", "clean.txt"],
    ]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      path: "dir",
      kind: "delete-edit",
      base: { node: { kind: "dir", path: "dir" } },
      target: { node: { kind: "missing", path: "dir" } },
      source: { node: { kind: "dir", path: "dir" } },
    });

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("clean.txt"))).toBe("independent source sibling\n");
    await expect(target.readFile("dir/new.txt")).rejects.toMatchObject({
      code: "file_not_found",
    });
    expect(unresolvedMergeConflicts(await target.tree())).toEqual(plan.conflicts);
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });

  it("accounts for a moved directory and the generation recreating its vacated source", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("generation-dir-move-recreate");
    await target.mkdir("old");
    await target.createFile("old/a.txt", encoder.encode("A\n"));
    await target.mkdir("dest");
    await target.createFile("dest/b.txt", encoder.encode("B\n"));
    const source = await branch(target);
    await target.createFile("target-only.txt", encoder.encode("target\n"));
    await source.deleteFile("dest/b.txt");
    await source.rmdir("dest");
    await source.rename("old", "dest");
    await source.mkdir("old");
    await source.createFile("old/new.txt", encoder.encode("new generation\n"));

    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect(plan.conflicts).toEqual([]);
    expect(
      plan.changes.map((change) => [
        change.type,
        change.type === "fs.rename"
          ? `${change.payload.from}->${change.payload.to}`
          : change.payload.path,
      ]),
    ).toEqual([
      ["fs.file.delete", "dest/b.txt"],
      ["fs.dir.remove", "dest"],
      ["fs.rename", "old->dest"],
      ["fs.dir.create", "old"],
      ["fs.file.create", "old/new.txt"],
      ["fs.file.write", "old/new.txt"],
    ]);

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("dest/a.txt"))).toBe("A\n");
    expect(decoder.decode(await target.readFile("old/new.txt"))).toBe("new generation\n");
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });

  it("accounts for both live file generations after a move and source-path recreation", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("generation-file-move-recreate");
    await target.createFile("a.txt", encoder.encode("A\n"));
    await target.createFile("b.txt", encoder.encode("B\n"));
    const source = await branch(target);
    await target.createFile("target-only.txt", encoder.encode("target\n"));
    await source.deleteFile("b.txt");
    await source.rename("a.txt", "b.txt");
    await source.createFile("a.txt", encoder.encode("replacement A\n"));

    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect(plan.conflicts).toEqual([]);
    expect(
      plan.changes.map((change) => [
        change.type,
        change.type === "fs.rename"
          ? `${change.payload.from}->${change.payload.to}`
          : change.payload.path,
      ]),
    ).toEqual([
      ["fs.file.delete", "b.txt"],
      ["fs.rename", "a.txt->b.txt"],
      ["fs.file.create", "a.txt"],
      ["fs.file.write", "a.txt"],
    ]);

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("b.txt"))).toBe("A\n");
    expect(decoder.decode(await target.readFile("a.txt"))).toBe("replacement A\n");
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });

  it("keeps a recreated parent ahead of the inherited generation nested below it", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("generation-parent-provider-chain");
    await target.mkdir("old");
    await target.createFile("old/a.txt", encoder.encode("A\n"));
    const source = await branch(target);
    await target.createFile("target-only.txt", encoder.encode("target\n"));
    await source.rename("old", "temporary");
    await source.mkdir("old");
    await source.rename("temporary", "old/archive");
    await source.createFile("old/new.txt", encoder.encode("new\n"));

    const sourceBefore = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(await planThreeWayMerge(target, source)).toEqual(plan);
    expect(plan.conflicts).toEqual([]);
    expect(
      plan.changes.map((change) => [
        change.type,
        change.type === "fs.rename"
          ? `${change.payload.from}->${change.payload.to}`
          : change.payload.path,
      ]),
    ).toEqual([
      ["fs.rename", "old->temporary"],
      ["fs.dir.create", "old"],
      ["fs.rename", "temporary->old/archive"],
      ["fs.file.create", "old/new.txt"],
      ["fs.file.write", "old/new.txt"],
    ]);

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("old/archive/a.txt"))).toBe("A\n");
    expect(decoder.decode(await target.readFile("old/new.txt"))).toBe("new\n");
    expect(await replayDigest(target)).toBe(receipt.resultTreeDigest);
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
  });
});
