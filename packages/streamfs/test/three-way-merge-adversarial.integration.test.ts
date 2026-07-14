import { canonicalJson, SNAPSHOT_FORMAT_VERSION, type Event, type Offset } from "@eforest/protocol";
import { createDurableStreamTestServer } from "@eforest/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCompleteMergeStage,
  applyThreeWayMerge,
  fsReducer,
  isFsMergeConflictEvent,
  isFsThreeWayMergeEvent,
  planThreeWayMerge,
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
