import { canonicalJson, SNAPSHOT_FORMAT_VERSION, type Event, type Offset } from "@eforest/protocol";
import { createDurableStreamTestServer } from "@eforest/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCompleteMergeStage,
  applyThreeWayMerge,
  fsInitialState,
  fsReducer,
  isFsMergeConflictEvent,
  isFsThreeWayMergeEvent,
  planThreeWayMerge,
  reduceSnapshotPlusTail,
  treeDigest,
  unresolvedMergeConflicts,
  StreamFs,
  type FsTree,
  type StreamFsRepo,
} from "../src/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const servers: Array<ReturnType<typeof createDurableStreamTestServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function startOfficialServer(): Promise<string> {
  const server = createDurableStreamTestServer({ port: 0, host: "127.0.0.1" });
  servers.push(server);
  return server.start();
}

function document(marker?: { readonly line: number; readonly value: string }): Uint8Array {
  const lines = Array.from({ length: 128 }, (_, index) => `line-${String(index).padStart(3, "0")}`);
  if (marker !== undefined) lines[marker.line] = marker.value;
  return encoder.encode(`${lines.join("\n")}\n`);
}

async function branch(target: StreamFsRepo): Promise<StreamFsRepo> {
  await target.createBranch("feature");
  return target.openBranch("feature");
}

function reducePlan(initial: FsTree, events: readonly Event[], offsets: readonly Offset[]): FsTree {
  return events.reduce(
    (state, event, index) => fsReducer(state, { ...event, offset: offsets[index]! } as Event),
    initial,
  );
}

describe("three-way merge adversarial regressions", () => {
  it("adopts source-only file and directory renames without losing content identity", async () => {
    const baseUrl = await startOfficialServer();

    const fileTarget = await new StreamFs({ baseUrl }).createRepo("source-file-rename");
    await fileTarget.createFile("before.txt", encoder.encode("file rename\n"));
    const fileSource = await branch(fileTarget);
    await fileTarget.createFile("target-only.txt", encoder.encode("target\n"));
    await fileSource.rename("before.txt", "after.txt");
    const fileSourceBefore = canonicalJson(await fileSource.rawDump());
    const filePlan = await planThreeWayMerge(fileTarget, fileSource);
    expect(filePlan.changes).toEqual([
      { type: "fs.rename", payload: { v: 2, from: "before.txt", to: "after.txt" } },
    ]);
    await applyThreeWayMerge(fileTarget, fileSource, filePlan);
    expect(decoder.decode(await fileTarget.readFile("after.txt"))).toBe("file rename\n");
    await expect(fileTarget.readFile("before.txt")).rejects.toMatchObject({
      code: "file_not_found",
    });
    expect(canonicalJson(await fileSource.rawDump())).toBe(fileSourceBefore);

    const dirTarget = await new StreamFs({ baseUrl }).createRepo("source-dir-rename");
    await dirTarget.mkdir("src");
    await dirTarget.mkdir("src/nested");
    await dirTarget.createFile("src/a.txt", encoder.encode("a\n"));
    await dirTarget.createFile("src/nested/b.txt", encoder.encode("b\n"));
    const dirSource = await branch(dirTarget);
    await dirTarget.createFile("target-only.txt", encoder.encode("target\n"));
    await dirSource.rename("src", "lib");
    const dirPlan = await planThreeWayMerge(dirTarget, dirSource);
    expect(dirPlan.changes).toEqual([
      { type: "fs.rename", payload: { v: 2, from: "src", to: "lib" } },
    ]);
    const receipt = await applyThreeWayMerge(dirTarget, dirSource, dirPlan);
    expect(decoder.decode(await dirTarget.readFile("lib/a.txt"))).toBe("a\n");
    expect(decoder.decode(await dirTarget.readFile("lib/nested/b.txt"))).toBe("b\n");
    expect((await dirTarget.list()).filter((entry) => entry.includes("src"))).toEqual([]);
    const snapshot = await dirTarget.createSnapshot();
    const bootstrapped = await dirTarget.bootstrapRead();
    expect(snapshot.stateDigest).toBe(receipt.resultTreeDigest);
    expect(treeDigest(bootstrapped.state)).toBe(receipt.resultTreeDigest);
  });

  it("does not misclassify a full write followed by a patch as patch-only history", async () => {
    const baseUrl = await startOfficialServer();
    for (const fullWriter of ["target", "source"] as const) {
      const target = await new StreamFs({ baseUrl }).createRepo(`full-then-patch-${fullWriter}`);
      await target.createFile("notes.txt", document());
      const source = await branch(target);
      const writer = fullWriter === "target" ? target : source;
      const patcher = fullWriter === "target" ? source : target;
      await writer.writeFile("notes.txt", document({ line: 10, value: `${fullWriter}-full` }), {
        forceFull: true,
      });
      const second = Array.from({ length: 128 }, (_, index) =>
        index === 10
          ? `${fullWriter}-full`
          : index === 11
            ? `${fullWriter}-later-patch`
            : `line-${String(index).padStart(3, "0")}`,
      );
      await writer.writeFile("notes.txt", encoder.encode(`${second.join("\n")}\n`));
      await patcher.writeFile("notes.txt", document({ line: 96, value: "other-patch" }));
      const plan = await planThreeWayMerge(target, source);
      expect(plan.conflicts.map(({ path, kind, reason }) => ({ path, kind, reason }))).toEqual([
        { path: "notes.txt", kind: "edit-edit", reason: "non-patchable" },
      ]);
    }
  });

  it("replays replacement, chained, and swap rename programs with inherited identity", async () => {
    const baseUrl = await startOfficialServer();

    const replacement = await new StreamFs({ baseUrl }).createRepo("rename-replacement");
    await replacement.createFile("a.txt", encoder.encode("A\n"));
    await replacement.createFile("b.txt", encoder.encode("B\n"));
    const replacementSource = await branch(replacement);
    await replacement.createFile("target-only.txt", encoder.encode("target\n"));
    await replacementSource.deleteFile("b.txt");
    await replacementSource.rename("a.txt", "b.txt");
    const replacementSourceBefore = canonicalJson(await replacementSource.rawDump());
    const replacementHead = (await replacement.rawDump()).at(-1)!.offset;
    const watched: Array<{ event: string; path: string; offset: string }> = [];
    const watcher = replacement.watch(".", { from: replacementHead, mode: "sse" });
    const watchComplete = new Promise<void>((resolve) => {
      watcher.onAll((event, path, offset) => {
        watched.push({ event, path, offset });
        if (watched.length === 3) resolve();
      });
    });
    await watcher.ready;
    const replacementPlan = await planThreeWayMerge(replacement, replacementSource);
    expect(replacementPlan.changes).toEqual([
      { type: "fs.file.delete", payload: { v: 2, path: "b.txt" } },
      { type: "fs.rename", payload: { v: 2, from: "a.txt", to: "b.txt" } },
    ]);
    const replacementReceipt = await applyThreeWayMerge(
      replacement,
      replacementSource,
      replacementPlan,
    );
    await watchComplete;
    await watcher.close();
    expect(watched).toEqual([
      { event: "unlink", path: "b.txt", offset: replacementReceipt.mergeOffset },
      { event: "unlink", path: "a.txt", offset: replacementReceipt.mergeOffset },
      { event: "add", path: "b.txt", offset: replacementReceipt.mergeOffset },
    ]);
    expect(decoder.decode(await replacement.readFile("b.txt"))).toBe("A\n");
    await expect(replacement.readFile("a.txt")).rejects.toMatchObject({
      code: "file_not_found",
    });
    expect(canonicalJson(await replacementSource.rawDump())).toBe(replacementSourceBefore);
    const replacementRaw = await replacement.rawDump();
    let replacementReplay = await replacement.treeAt(replacementPlan.target.offset);
    for (const record of replacementRaw.slice(-3)) {
      replacementReplay = fsReducer(replacementReplay, record);
    }
    expect(treeDigest(replacementReplay)).toBe(replacementReceipt.resultTreeDigest);
    const replacementSnapshot = await replacement.createSnapshot();
    expect(replacementSnapshot.stateDigest).toBe(replacementReceipt.resultTreeDigest);
    expect(treeDigest((await replacement.bootstrapRead()).state)).toBe(
      replacementReceipt.resultTreeDigest,
    );

    const directory = await new StreamFs({ baseUrl }).createRepo("rename-directory-replacement");
    await directory.mkdir("old");
    await directory.createFile("old/a.txt", encoder.encode("A\n"));
    await directory.mkdir("dest");
    await directory.createFile("dest/b.txt", encoder.encode("B\n"));
    const directorySource = await branch(directory);
    await directory.createFile("target-only.txt", encoder.encode("target\n"));
    await directorySource.deleteFile("dest/b.txt");
    await directorySource.rmdir("dest");
    await directorySource.rename("old", "dest");
    const directoryPlan = await planThreeWayMerge(directory, directorySource);
    expect(directoryPlan.changes).toEqual([
      { type: "fs.file.delete", payload: { v: 2, path: "dest/b.txt" } },
      { type: "fs.dir.remove", payload: { v: 2, path: "dest" } },
      { type: "fs.rename", payload: { v: 2, from: "old", to: "dest" } },
    ]);
    await applyThreeWayMerge(directory, directorySource, directoryPlan);
    expect(decoder.decode(await directory.readFile("dest/a.txt"))).toBe("A\n");
    expect((await directory.list()).filter((entry) => entry.includes("old"))).toEqual([]);

    const chain = await new StreamFs({ baseUrl }).createRepo("rename-chain");
    await chain.createFile("first.txt", encoder.encode("chain\n"));
    const chainSource = await branch(chain);
    await chain.createFile("target-only.txt", encoder.encode("target\n"));
    await chainSource.rename("first.txt", "middle.txt");
    await chainSource.rename("middle.txt", "final.txt");
    const chainPlan = await planThreeWayMerge(chain, chainSource);
    expect(chainPlan.changes).toEqual([
      { type: "fs.rename", payload: { v: 2, from: "first.txt", to: "middle.txt" } },
      { type: "fs.rename", payload: { v: 2, from: "middle.txt", to: "final.txt" } },
    ]);
    await applyThreeWayMerge(chain, chainSource, chainPlan);
    expect(decoder.decode(await chain.readFile("final.txt"))).toBe("chain\n");

    const swap = await new StreamFs({ baseUrl }).createRepo("rename-swap");
    await swap.createFile("left.txt", encoder.encode("left\n"));
    await swap.createFile("right.txt", encoder.encode("right\n"));
    const swapSource = await branch(swap);
    await swap.createFile("target-only.txt", encoder.encode("target\n"));
    await swapSource.rename("left.txt", "temp.txt");
    await swapSource.rename("right.txt", "left.txt");
    await swapSource.rename("temp.txt", "right.txt");
    const swapPlan = await planThreeWayMerge(swap, swapSource);
    expect(swapPlan.changes.map(({ type }) => type)).toEqual([
      "fs.rename",
      "fs.rename",
      "fs.rename",
    ]);
    await applyThreeWayMerge(swap, swapSource, swapPlan);
    expect(decoder.decode(await swap.readFile("left.txt"))).toBe("right\n");
    expect(decoder.decode(await swap.readFile("right.txt"))).toBe("left\n");

    const conflicted = await new StreamFs({ baseUrl }).createRepo("rename-versus-edit");
    await conflicted.createFile("before.txt", document());
    const conflictedSource = await branch(conflicted);
    await conflicted.writeFile("before.txt", document({ line: 12, value: "target-edit" }));
    await conflictedSource.rename("before.txt", "after.txt");
    const conflictedPlan = await planThreeWayMerge(conflicted, conflictedSource);
    expect(conflictedPlan.changes).toEqual([]);
    expect(
      conflictedPlan.conflicts.map(({ path, kind, reason }) => ({ path, kind, reason })),
    ).toEqual([{ path: "before.txt", kind: "rename-rename", reason: "non-patchable" }]);
    await applyThreeWayMerge(conflicted, conflictedSource, conflictedPlan);
    expect(decoder.decode(await conflicted.readFile("before.txt"))).toContain("target-edit");
  });

  it("treats identical rename programs as already converged", async () => {
    const baseUrl = await startOfficialServer();

    const identical = await new StreamFs({ baseUrl }).createRepo("identical-rename");
    await identical.createFile("before.txt", encoder.encode("same\n"));
    const identicalSource = await branch(identical);
    await identical.rename("before.txt", "after.txt");
    await identicalSource.rename("before.txt", "after.txt");
    const identicalDigest = await identical.digest();
    const identicalPlan = await planThreeWayMerge(identical, identicalSource);
    expect(identicalPlan.changes).toEqual([]);
    expect(identicalPlan.conflicts).toEqual([]);
    const identicalReceipt = await applyThreeWayMerge(identical, identicalSource, identicalPlan);
    expect(identicalReceipt.resultTreeDigest).toBe(identicalDigest);
    expect(await identicalSource.digest()).toBe(identicalDigest);
    expect(unresolvedMergeConflicts(await identical.tree())).toEqual([]);

    const swap = await new StreamFs({ baseUrl }).createRepo("identical-rename-swap");
    await swap.createFile("left.txt", encoder.encode("left\n"));
    await swap.createFile("right.txt", encoder.encode("right\n"));
    const swapSource = await branch(swap);
    for (const repo of [swap, swapSource]) {
      await repo.rename("left.txt", "temporary.txt");
      await repo.rename("right.txt", "left.txt");
      await repo.rename("temporary.txt", "right.txt");
    }
    const swapDigest = await swap.digest();
    const swapPlan = await planThreeWayMerge(swap, swapSource);
    expect(swapPlan.changes).toEqual([]);
    expect(swapPlan.conflicts).toEqual([]);
    const swapReceipt = await applyThreeWayMerge(swap, swapSource, swapPlan);
    expect(swapReceipt.resultTreeDigest).toBe(swapDigest);
    expect(await swapSource.digest()).toBe(swapDigest);
    expect(decoder.decode(await swap.readFile("left.txt"))).toBe("right\n");
    expect(decoder.decode(await swap.readFile("right.txt"))).toBe("left\n");
  });

  it("aligns common rename prefixes before merging one-sided and disjoint content", async () => {
    const baseUrl = await startOfficialServer();

    for (const editedSide of ["source", "target"] as const) {
      const target = await new StreamFs({ baseUrl }).createRepo(`common-rename-${editedSide}`);
      await target.createFile("before.txt", encoder.encode("before\n"));
      const source = await branch(target);
      await target.rename("before.txt", "after.txt");
      await source.rename("before.txt", "after.txt");
      const writer = editedSide === "source" ? source : target;
      await writer.writeFile("after.txt", encoder.encode(`${editedSide} edit\n`), {
        forceFull: true,
      });
      const watched: Array<{ event: string; path: string }> = [];
      const watcher =
        editedSide === "source"
          ? target.watch(".", {
              from: (await target.rawDump()).at(-1)!.offset,
              mode: "sse",
            })
          : undefined;
      const watchComplete =
        watcher === undefined
          ? undefined
          : new Promise<void>((resolve) => {
              watcher.onAll((event, path) => {
                watched.push({ event, path });
                if (watched.length === 2) resolve();
              });
            });
      if (watcher !== undefined) await watcher.ready;
      const sourceBefore = canonicalJson(await source.rawDump());
      const plan = await planThreeWayMerge(target, source);
      expect(plan.conflicts).toEqual([]);
      expect(plan.changes.map(({ type }) => type)).toEqual(
        editedSide === "source" ? ["fs.file.write", "fs.file.create"] : [],
      );
      const receipt = await applyThreeWayMerge(target, source, plan);
      if (watcher !== undefined && watchComplete !== undefined) {
        await watchComplete;
        await watcher.close();
        expect(watched).toEqual([
          { event: "change", path: "after.txt" },
          { event: "add", path: "after.txt" },
        ]);
      }
      expect(decoder.decode(await target.readFile("after.txt"))).toBe(`${editedSide} edit\n`);
      expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
      expect(await target.digest()).toBe(receipt.resultTreeDigest);
      const replay = (await target.rawDump()).reduce(
        (tree, record) => fsReducer(tree, record),
        fsInitialState,
      );
      expect(treeDigest(replay)).toBe(receipt.resultTreeDigest);
      expect((await target.createSnapshot()).stateDigest).toBe(receipt.resultTreeDigest);
      expect(treeDigest((await target.bootstrapRead()).state)).toBe(receipt.resultTreeDigest);
    }

    const composed = await new StreamFs({ baseUrl }).createRepo("common-rename-disjoint-patches");
    await composed.createFile("before.txt", document());
    const composedSource = await branch(composed);
    await composed.rename("before.txt", "after.txt");
    await composedSource.rename("before.txt", "after.txt");
    await composed.writeFile("after.txt", document({ line: 10, value: "target patch" }));
    await composedSource.writeFile("after.txt", document({ line: 90, value: "source patch" }));
    const composedPlan = await planThreeWayMerge(composed, composedSource);
    expect(composedPlan.conflicts).toEqual([]);
    expect(composedPlan.changes.map(({ type }) => type)).toEqual(["fs.file.patch"]);
    await applyThreeWayMerge(composed, composedSource, composedPlan);
    const composedText = decoder.decode(await composed.readFile("after.txt"));
    expect(composedText).toContain("target patch");
    expect(composedText).toContain("source patch");
  });

  it("unions sibling rename components through shared ancestor operations", async () => {
    const baseUrl = await startOfficialServer();
    for (const withContent of [false, true]) {
      const target = await new StreamFs({ baseUrl }).createRepo(
        `sibling-rename-components-${withContent ? "content" : "pure"}`,
      );
      await target.mkdir("src");
      await target.mkdir("dest");
      await target.createFile("src/x.txt", encoder.encode("X\n"));
      await target.createFile("src/y.txt", encoder.encode("Y\n"));
      const source = await branch(target);
      await target.createFile("target-only.txt", encoder.encode("target\n"));
      await source.rename("src/x.txt", "dest/x.txt");
      if (withContent) {
        await source.writeFile("dest/x.txt", encoder.encode("X edited\n"), {
          forceFull: true,
        });
      }
      await source.rename("src/y.txt", "dest/y.txt");
      if (withContent) {
        await source.writeFile("dest/y.txt", encoder.encode("Y edited\n"), {
          forceFull: true,
        });
      }
      await source.rmdir("src");
      const sourceBefore = canonicalJson(await source.rawDump());
      const plan = await planThreeWayMerge(target, source);
      expect(plan.conflicts).toEqual([]);
      expect(plan.changes.map(({ type }) => type)).toEqual(
        withContent
          ? [
              "fs.rename",
              "fs.file.write",
              "fs.file.create",
              "fs.rename",
              "fs.file.write",
              "fs.file.create",
              "fs.dir.remove",
            ]
          : ["fs.rename", "fs.rename", "fs.dir.remove"],
      );
      const receipt = await applyThreeWayMerge(target, source, plan);
      expect(decoder.decode(await target.readFile("dest/x.txt"))).toBe(
        withContent ? "X edited\n" : "X\n",
      );
      expect(decoder.decode(await target.readFile("dest/y.txt"))).toBe(
        withContent ? "Y edited\n" : "Y\n",
      );
      expect((await target.list()).filter((path) => path === "src")).toEqual([]);
      expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
      const replay = (await target.rawDump()).reduce(
        (tree, record) => fsReducer(tree, record),
        fsInitialState,
      );
      expect(treeDigest(replay)).toBe(receipt.resultTreeDigest);
      expect((await target.createSnapshot()).stateDigest).toBe(receipt.resultTreeDigest);
    }
  });

  it("replays connected source directory creation before an ancestor rename", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("created-directory-rename");
    await target.createFile("base.txt", encoder.encode("base\n"));
    const source = await branch(target);
    await target.createFile("target-only.txt", encoder.encode("target\n"));
    await source.mkdir("temporary");
    await source.mkdir("temporary/nested");
    await source.createFile("temporary/nested/file.txt", encoder.encode("created\n"));
    await source.rename("temporary", "final");
    const plan = await planThreeWayMerge(target, source);
    expect(plan.conflicts).toEqual([]);
    expect(plan.changes.map(({ type }) => type)).toEqual([
      "fs.dir.create",
      "fs.dir.create",
      "fs.file.create",
      "fs.file.write",
      "fs.rename",
    ]);
    await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("final/nested/file.txt"))).toBe("created\n");
  });

  it("replays content, creation, and deletion events connected to source renames", async () => {
    const baseUrl = await startOfficialServer();

    for (const order of ["rename-then-write", "write-then-rename"] as const) {
      const target = await new StreamFs({ baseUrl }).createRepo(`rename-content-${order}`);
      await target.createFile("before.txt", encoder.encode("before\n"));
      const source = await branch(target);
      await target.createFile("target-only.txt", encoder.encode("target\n"));
      if (order === "rename-then-write") {
        await source.rename("before.txt", "after.txt");
        await source.writeFile("after.txt", encoder.encode("source edit\n"), {
          forceFull: true,
        });
      } else {
        await source.writeFile("before.txt", encoder.encode("source edit\n"), {
          forceFull: true,
        });
        await source.rename("before.txt", "after.txt");
      }
      const watched: Array<{ event: string; path: string }> = [];
      const watcher = target.watch(".", {
        from: (await target.rawDump()).at(-1)!.offset,
        mode: "sse",
      });
      const watchComplete = new Promise<void>((resolve) => {
        watcher.onAll((event, path) => {
          watched.push({ event, path });
          if (watched.length === 4) resolve();
        });
      });
      await watcher.ready;
      const sourceBefore = canonicalJson(await source.rawDump());
      const plan = await planThreeWayMerge(target, source);
      expect(plan.conflicts).toEqual([]);
      expect(plan.changes.map(({ type }) => type)).toContain("fs.rename");
      expect(plan.changes.map(({ type }) => type)).toContain("fs.file.write");
      const receipt = await applyThreeWayMerge(target, source, plan);
      await watchComplete;
      await watcher.close();
      expect(watched).toEqual(
        order === "rename-then-write"
          ? [
              { event: "unlink", path: "before.txt" },
              { event: "add", path: "after.txt" },
              { event: "change", path: "after.txt" },
              { event: "add", path: "after.txt" },
            ]
          : [
              { event: "change", path: "before.txt" },
              { event: "add", path: "before.txt" },
              { event: "unlink", path: "before.txt" },
              { event: "add", path: "after.txt" },
            ],
      );
      expect(decoder.decode(await target.readFile("after.txt"))).toBe("source edit\n");
      await expect(target.readFile("before.txt")).rejects.toMatchObject({
        code: "file_not_found",
      });
      expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
      expect(await target.digest()).toBe(receipt.resultTreeDigest);
      const replay = (await target.rawDump()).reduce(
        (tree, record) => fsReducer(tree, record),
        fsInitialState,
      );
      expect(treeDigest(replay)).toBe(receipt.resultTreeDigest);
      const snapshot = await target.createSnapshot();
      expect(snapshot.stateDigest).toBe(receipt.resultTreeDigest);
      expect(treeDigest((await target.bootstrapRead()).state)).toBe(receipt.resultTreeDigest);
    }

    const patched = await new StreamFs({ baseUrl }).createRepo("rename-patched-content");
    await patched.createFile("before.txt", document());
    const patchedSource = await branch(patched);
    await patched.createFile("target-only.txt", encoder.encode("target\n"));
    await patchedSource.rename("before.txt", "after.txt");
    await patchedSource.writeFile(
      "after.txt",
      document({ line: 22, value: "source patch after move" }),
    );
    const patchedPlan = await planThreeWayMerge(patched, patchedSource);
    expect(patchedPlan.conflicts).toEqual([]);
    expect(patchedPlan.changes.map(({ type }) => type)).toEqual([
      "fs.rename",
      "fs.file.patch",
      "fs.file.create",
    ]);
    await applyThreeWayMerge(patched, patchedSource, patchedPlan);
    expect(decoder.decode(await patched.readFile("after.txt"))).toContain(
      "source patch after move",
    );

    const directory = await new StreamFs({ baseUrl }).createRepo("rename-directory-content");
    await directory.mkdir("old");
    await directory.mkdir("old/deep");
    await directory.createFile("old/deep/file.txt", encoder.encode("old\n"));
    const directorySource = await branch(directory);
    await directory.createFile("target-only.txt", encoder.encode("target\n"));
    await directorySource.rename("old", "new");
    await directorySource.writeFile("new/deep/file.txt", encoder.encode("new\n"), {
      forceFull: true,
    });
    const directoryPlan = await planThreeWayMerge(directory, directorySource);
    expect(directoryPlan.conflicts).toEqual([]);
    await applyThreeWayMerge(directory, directorySource, directoryPlan);
    expect(decoder.decode(await directory.readFile("new/deep/file.txt"))).toBe("new\n");

    const created = await new StreamFs({ baseUrl }).createRepo("rename-created-content");
    await created.createFile("base.txt", encoder.encode("base\n"));
    const createdSource = await branch(created);
    await created.createFile("target-only.txt", encoder.encode("target\n"));
    await createdSource.createFile("temporary.txt", encoder.encode("created\n"));
    await createdSource.rename("temporary.txt", "final.txt");
    const createdPlan = await planThreeWayMerge(created, createdSource);
    expect(createdPlan.conflicts).toEqual([]);
    await applyThreeWayMerge(created, createdSource, createdPlan);
    expect(decoder.decode(await created.readFile("final.txt"))).toBe("created\n");

    const deleted = await new StreamFs({ baseUrl }).createRepo("rename-deleted-content");
    await deleted.createFile("before.txt", encoder.encode("delete me\n"));
    const deletedSource = await branch(deleted);
    await deleted.createFile("target-only.txt", encoder.encode("target\n"));
    await deletedSource.rename("before.txt", "temporary.txt");
    await deletedSource.deleteFile("temporary.txt");
    const deletedPlan = await planThreeWayMerge(deleted, deletedSource);
    expect(deletedPlan.conflicts).toEqual([]);
    await applyThreeWayMerge(deleted, deletedSource, deletedPlan);
    await expect(deleted.readFile("before.txt")).rejects.toMatchObject({
      code: "file_not_found",
    });
    await expect(deleted.readFile("temporary.txt")).rejects.toMatchObject({
      code: "file_not_found",
    });
  });

  it("anchors rejected replacement renames to the target-touched destination", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("rename-destination-collision");
    await target.createFile("a.txt", encoder.encode("A\n"));
    await target.createFile("b.txt", encoder.encode("B\n"));
    const source = await branch(target);
    await target.writeFile("b.txt", encoder.encode("target B\n"), { forceFull: true });
    await source.deleteFile("b.txt");
    await source.rename("a.txt", "b.txt");
    const targetTree = await target.tree();
    const plan = await planThreeWayMerge(target, source);
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      path: "b.txt",
      kind: "rename-rename",
      reason: "non-patchable",
      target: {
        node: {
          kind: "file",
          path: "b.txt",
          contentSha256: targetTree.files["b.txt"]!.contentSha256,
        },
      },
    });

    const directory = await new StreamFs({ baseUrl }).createRepo("rename-directory-collision");
    await directory.mkdir("old");
    await directory.mkdir("old/deep");
    await directory.createFile("old/deep/file.txt", document());
    const directorySource = await branch(directory);
    await directory.writeFile(
      "old/deep/file.txt",
      document({ line: 4, value: "target nested edit" }),
    );
    await directorySource.rename("old", "new");
    const directoryPlan = await planThreeWayMerge(directory, directorySource);
    expect(directoryPlan.changes).toEqual([]);
    expect(directoryPlan.conflicts).toHaveLength(1);
    expect(directoryPlan.conflicts[0]).toMatchObject({
      path: "old",
      kind: "rename-rename",
      reason: "non-patchable",
      target: { node: { kind: "dir", path: "old" } },
    });
  });

  it("rejects truncated merge groups at repository and snapshot-tail boundaries", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("truncated-boundaries");
    await target.createFile("conflict.txt", document());
    const source = await branch(target);
    await target.writeFile("conflict.txt", document({ line: 20, value: "target" }));
    await source.writeFile("conflict.txt", document({ line: 20, value: "source" }));
    const plan = await planThreeWayMerge(target, source);
    const artifact = await source.treeAt(plan.forkOffset);
    await target.dispatchToStream(target.metadataStreamId, plan.events[0]);
    await expect(target.tree()).rejects.toThrow("merge/incomplete-batch");
    await expect(target.createSnapshot()).rejects.toThrow("merge/incomplete-batch");
    expect(() =>
      reduceSnapshotPlusTail(artifact, [{ ...plan.events[0], offset: plan.firstOffset }]),
    ).toThrow("merge/incomplete-batch");
  });

  it("turns nested source deletion versus target edit into one explicit conflict", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("nested-delete-edit");
    await target.mkdir("dir");
    await target.createFile("dir/file.txt", document());
    const source = await branch(target);
    await target.writeFile("dir/file.txt", document({ line: 20, value: "target-edit" }));
    await source.deleteFile("dir/file.txt");
    await source.rmdir("dir");
    const plan = await planThreeWayMerge(target, source);
    expect(plan.conflicts.map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: "dir/file.txt", kind: "delete-edit" },
    ]);
    expect(plan.changes).toEqual([]);
    await applyThreeWayMerge(target, source, plan);
    expect(decoder.decode(await target.readFile("dir/file.txt"))).toContain("target-edit");
    expect(unresolvedMergeConflicts(await target.tree())).toHaveLength(1);
  });

  it("surfaces independent same-byte add/add identities instead of selecting target", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("same-byte-add-add");
    await target.createFile("base.txt", encoder.encode("base\n"));
    const source = await branch(target);
    await target.createFile("same.txt", encoder.encode("identical\n"));
    await source.createFile("same.txt", encoder.encode("identical\n"));
    const targetFile = (await target.tree()).files["same.txt"]!;
    const sourceFile = (await source.tree()).files["same.txt"]!;
    expect(targetFile.contentStreamId).not.toBe(sourceFile.contentStreamId);
    const plan = await planThreeWayMerge(target, source);
    expect(plan.conflicts.map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: "same.txt", kind: "add-add" },
    ]);
  });

  it("rejects correlated reference tampering, interleaving, and truncated batches", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("merge-integrity-attacks");
    await target.createFile("conflict.txt", document());
    const source = await branch(target);
    await target.writeFile("conflict.txt", document({ line: 30, value: "target" }));
    await source.writeFile("conflict.txt", document({ line: 30, value: "source" }));
    const plan = await planThreeWayMerge(target, source);
    const initial = await target.tree();
    const offsets = plan.events.map((_, index) =>
      index === 0 ? plan.firstOffset : plan.terminalOffset,
    );

    const corrupted = structuredClone(plan.events);
    const stagedConflict = corrupted.find(isFsMergeConflictEvent);
    const terminal = corrupted.find(isFsThreeWayMergeEvent);
    if (stagedConflict === undefined || terminal === undefined) throw new Error("bad fixture");
    Object.assign(stagedConflict.payload.base, { treeDigest: "e".repeat(64) });
    Object.assign(terminal.payload.conflicts[0]!.base, { treeDigest: "e".repeat(64) });
    expect(() => reducePlan(initial, corrupted, offsets)).toThrow("merge/reference-mismatch");

    const staged = fsReducer(initial, { ...plan.events[0], offset: plan.firstOffset } as Event);
    expect(() =>
      fsReducer(staged, {
        type: "fs.snapshot",
        payload: {
          snapshotOffset: plan.target.offset,
          stateDigest: plan.target.treeDigest,
          contentRef: "snapshot:interleaved",
          formatVersion: SNAPSHOT_FORMAT_VERSION,
        },
        ts: 1,
        offset: plan.terminalOffset,
      } as Event),
    ).toThrow("merge/interleaved-batch");
    expect(() => assertCompleteMergeStage(staged)).toThrow("merge/incomplete-batch");

    const conflicted = reducePlan(initial, plan.events, offsets);
    const portable = JSON.parse(canonicalJson(conflicted)) as FsTree;
    expect(unresolvedMergeConflicts(portable)).toEqual(plan.conflicts);
    const resolved = fsReducer(portable, {
      type: "fs/merge-resolve",
      payload: {
        v: 1,
        mergeId: plan.mergeId,
        path: plan.conflicts[0]!.path,
        resolutionDigest: treeDigest(portable),
      },
      ts: 2,
      offset: plan.terminalOffset,
    } as Event);
    expect(unresolvedMergeConflicts(resolved)).toEqual([]);
  });
});
