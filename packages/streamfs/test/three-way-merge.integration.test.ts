import { canonicalJson, type Event } from "@eforest/protocol";
import { createDurableStreamTestServer } from "@eforest/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  StreamFs,
  ThreeWayMergeError,
  applyThreeWayMerge,
  fsInitialState,
  fsReducer,
  isFsMergeConflictEvent,
  isFsThreeWayMergeEvent,
  mergeThreeWay,
  planThreeWayMerge,
  resolveMergeConflict,
  treeDigest,
  unresolvedMergeConflicts,
  type StreamFsRepo,
  type ThreeWayMergePlan,
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

function text(lines = 128): string[] {
  return Array.from({ length: lines }, (_, index) => `line-${String(index).padStart(3, "0")}`);
}

function bytes(lines: readonly string[]): Uint8Array {
  return encoder.encode(`${lines.join("\n")}\n`);
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

function requestHeader(
  input: URL | RequestInfo,
  init: RequestInit | undefined,
  name: string,
): string | null {
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get(
    name,
  );
}

async function cleanMergeFixture(
  baseUrl: string,
  name: string,
): Promise<{
  readonly target: StreamFsRepo;
  readonly source: StreamFsRepo;
  readonly expected: Uint8Array;
}> {
  const target = await new StreamFs({ baseUrl }).createRepo(name);
  const base = text();
  await target.createFile("notes.txt", bytes(base));
  await target.createBranch("feature");
  const source = await target.openBranch("feature");
  const targetLines = [...base];
  targetLines[12] = "target-line-012";
  const sourceLines = [...base];
  sourceLines[96] = "source-line-096";
  const expected = [...targetLines];
  expected[96] = sourceLines[96]!;
  await target.writeFile("notes.txt", bytes(targetLines));
  await source.writeFile("notes.txt", bytes(sourceLines));
  expect((await target.rawDump()).at(-1)?.type).toBe("fs.file.patch");
  expect((await source.rawDump()).at(-2)?.type).toBe("fs.file.patch");
  return { target, source, expected: bytes(expected) };
}

describe("deterministic three-way merge on the published Durable Streams protocol", () => {
  it("composes disjoint patches atomically across replay, watch, and snapshot materialization", async () => {
    const baseUrl = await startOfficialServer();
    const { target, source, expected } = await cleanMergeFixture(baseUrl, "clean-compose");
    const targetHead = (await target.rawDump()).at(-1)!.offset;
    const sourceBefore = canonicalJson(await source.rawDump());
    const firstPlan = await planThreeWayMerge(target, source);
    const secondPlan = await planThreeWayMerge(target, source);

    expect(canonicalJson(firstPlan)).toBe(canonicalJson(secondPlan));
    expect(firstPlan.conflicts).toEqual([]);
    expect(firstPlan.events.map(({ type }) => type)).toEqual([
      "fs/merge-change",
      "fs.branch.merge",
    ]);
    expect(firstPlan.firstOffset).not.toBe(firstPlan.terminalOffset);

    const watcher = target.watch(".", { from: targetHead, mode: "sse" });
    const watched = new Promise<{ event: string; path: string; offset: string }>((resolve) => {
      watcher.onAll((event, path, offset) => resolve({ event, path, offset }));
    });
    await watcher.ready;
    const receipt = await applyThreeWayMerge(target, source, firstPlan);
    await expect(watched).resolves.toEqual({
      event: "change",
      path: "notes.txt",
      offset: receipt.mergeOffset,
    });
    await watcher.close();

    expect(await target.readFile("notes.txt")).toEqual(expected);
    expect(receipt.resultTreeDigest).toBe(await target.digest());
    expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
    const raw = await target.rawDump();
    expect(raw.slice(-2).map(({ type }) => type)).toEqual(["fs/merge-change", "fs.branch.merge"]);
    const terminal = raw.at(-1)!;
    expect(
      isFsThreeWayMergeEvent({
        type: terminal.type,
        payload: terminal.payload,
        ts: terminal.ts,
      } as Event),
    ).toBe(true);

    const replay = (): string => {
      let state = fsInitialState;
      for (const record of raw) state = fsReducer(state, record);
      return treeDigest(state);
    };
    expect(replay()).toBe(receipt.resultTreeDigest);
    expect(replay()).toBe(receipt.resultTreeDigest);

    const snapshot = await target.createSnapshot();
    const bootstrapped = await target.bootstrapRead();
    expect(snapshot.stateDigest).toBe(receipt.resultTreeDigest);
    expect(treeDigest(bootstrapped.state)).toBe(receipt.resultTreeDigest);
    expect(await target.readFile("notes.txt")).toEqual(expected);
  }, 15_000);

  it("surfaces stable overlap, binary, delete-edit, rename-rename, and add-add conflicts", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("conflict-taxonomy");
    const overlapBase = text();
    await target.createFile("a-overlap.txt", bytes(overlapBase));
    await target.createFile("b-binary.bin", new Uint8Array([0, 1, 2, 3]));
    await target.createFile("c-delete.txt", encoder.encode("base\n".repeat(80)));
    await target.createFile("d-rename.txt", encoder.encode("rename\n".repeat(80)));
    await target.createBranch("feature");
    const source = await target.openBranch("feature");

    const targetOverlap = [...overlapBase];
    targetOverlap[40] = "target-overlap";
    const sourceOverlap = [...overlapBase];
    sourceOverlap[40] = "source-overlap";
    await target.writeFile("a-overlap.txt", bytes(targetOverlap));
    await source.writeFile("a-overlap.txt", bytes(sourceOverlap));
    await target.writeFile("b-binary.bin", new Uint8Array([0, 1, 9, 3]), { forceFull: true });
    await source.writeFile("b-binary.bin", new Uint8Array([0, 1, 8, 3]), { forceFull: true });
    await target.deleteFile("c-delete.txt");
    await source.writeFile("c-delete.txt", encoder.encode("source\n".repeat(80)));
    await target.rename("d-rename.txt", "d-target.txt");
    await source.rename("d-rename.txt", "d-source.txt");
    await target.createFile("e-added.txt", encoder.encode("target"));
    await source.createFile("e-added.txt", encoder.encode("source"));

    const beforeTarget = canonicalJson(await target.rawDump());
    const beforeSource = canonicalJson(await source.rawDump());
    const plan = await planThreeWayMerge(target, source);
    expect(canonicalJson(await planThreeWayMerge(target, source))).toBe(canonicalJson(plan));
    expect(plan.conflicts.map(({ path, kind, reason }) => ({ path, kind, reason }))).toEqual([
      { path: "a-overlap.txt", kind: "edit-edit", reason: "overlap" },
      { path: "b-binary.bin", kind: "edit-edit", reason: "binary" },
      { path: "c-delete.txt", kind: "delete-edit", reason: "non-patchable" },
      { path: "d-rename.txt", kind: "rename-rename", reason: "non-patchable" },
      { path: "e-added.txt", kind: "add-add", reason: "non-patchable" },
    ]);
    expect(canonicalJson(await target.rawDump())).toBe(beforeTarget);
    expect(canonicalJson(await source.rawDump())).toBe(beforeSource);

    const receipt = await applyThreeWayMerge(target, source, plan);
    expect(receipt.conflicts).toEqual(
      plan.conflicts.map(({ path, kind, reason }) => ({ path, kind, reason })),
    );
    expect(decoder.decode(await target.readFile("a-overlap.txt"))).toContain("target-overlap");
    expect(unresolvedMergeConflicts(await target.tree())).toEqual(plan.conflicts);
  });

  it("persists, blocks on, and resolves an explicit conflict", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("conflict-lifecycle");
    const base = text();
    await target.createFile("conflict.txt", bytes(base));
    await target.createBranch("feature");
    const source = await target.openBranch("feature");
    const targetLines = [...base];
    targetLines[40] = "target-overlap";
    const sourceLines = [...base];
    sourceLines[40] = "source-overlap";
    await target.writeFile("conflict.txt", bytes(targetLines));
    await source.writeFile("conflict.txt", bytes(sourceLines));
    const plan = await planThreeWayMerge(target, source);
    expect(plan.conflicts).toHaveLength(1);
    await applyThreeWayMerge(target, source, plan);

    await target.createSnapshot();
    const bootstrapped = await target.bootstrapRead();
    expect(unresolvedMergeConflicts(bootstrapped.state)).toEqual(plan.conflicts);
    await expect(mergeThreeWay(target, source)).rejects.toMatchObject({
      code: "merge/target-conflicted",
    } satisfies Partial<ThreeWayMergeError>);
    const conflict = plan.conflicts[0]!;
    const resolution = await resolveMergeConflict(target, conflict.mergeId, conflict.path);
    expect(resolution.resultTreeDigest).toBe(plan.resultTreeDigest);
    expect(unresolvedMergeConflicts(await target.tree())).toEqual([]);
  });

  it("rejects a corrupted conflict reference deterministically without moving either head", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("corrupt-reference");
    const base = text();
    await target.createFile("conflict.txt", bytes(base));
    await target.createBranch("feature");
    const source = await target.openBranch("feature");
    const targetLines = [...base];
    targetLines[30] = "target";
    const sourceLines = [...base];
    sourceLines[30] = "source";
    await target.writeFile("conflict.txt", bytes(targetLines));
    await source.writeFile("conflict.txt", bytes(sourceLines));
    const plan = await planThreeWayMerge(target, source);
    const corrupted = structuredClone(plan);
    const conflict = corrupted.events.find((event) => isFsMergeConflictEvent(event));
    expect(conflict).toBeDefined();
    Object.assign(conflict!.payload.base, { treeDigest: "0".repeat(64) });
    const targetBefore = canonicalJson(await target.rawDump());
    const sourceBefore = canonicalJson(await source.rawDump());

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        applyThreeWayMerge(target, source, corrupted as ThreeWayMergePlan),
      ).rejects.toMatchObject({
        code: "merge/reference-mismatch",
      } satisfies Partial<ThreeWayMergeError>);
      expect(canonicalJson(await target.rawDump())).toBe(targetBefore);
      expect(canonicalJson(await source.rawDump())).toBe(sourceBefore);
    }

    let replayState = await target.tree();
    const staged = structuredClone(plan.events[0]);
    expect(isFsMergeConflictEvent(staged)).toBe(true);
    if (!isFsMergeConflictEvent(staged)) throw new Error("expected staged conflict");
    Object.assign(staged.payload.base, { treeDigest: "1".repeat(64) });
    const stagedRecord = { ...staged, offset: plan.firstOffset } as Event;
    const terminalRecord = {
      ...plan.events.at(-1)!,
      offset: plan.terminalOffset,
    } as Event;
    replayState = fsReducer(replayState, stagedRecord);
    expect(() => fsReducer(replayState, terminalRecord)).toThrow("merge/staged-record-mismatch");

    const targetBeforeSourceAdvance = canonicalJson(await target.rawDump());
    await source.createFile("source-advanced.txt", encoder.encode("advanced"));
    const sourceAfterAdvance = canonicalJson(await source.rawDump());
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(applyThreeWayMerge(target, source, plan)).rejects.toMatchObject({
        code: "merge/source-advanced",
      } satisfies Partial<ThreeWayMergeError>);
      expect(canonicalJson(await target.rawDump())).toBe(targetBeforeSourceAdvance);
      expect(canonicalJson(await source.rawDump())).toBe(sourceAfterAdvance);
    }
    await expect(planThreeWayMerge(source, target)).rejects.toMatchObject({
      code: "merge/unrelated-source",
    } satisfies Partial<ThreeWayMergeError>);
  });

  it("lets an ordinary writer win before the merge batch without exposing a partial merge", async () => {
    const baseUrl = await startOfficialServer();
    const target = await new StreamFs({ baseUrl }).createRepo("writer-wins");
    await target.createFile("base.txt", encoder.encode("base"));
    await target.createBranch("feature");
    const source = await target.openBranch("feature");
    await source.createFile("source.txt", encoder.encode("source"));
    const plan = await planThreeWayMerge(target, source);
    const metadataUrl = `${baseUrl}/streams/${encodeURIComponent(target.metadataStreamId)}`;
    const appendStarted = deferred();
    const releaseAppend = deferred();
    let mergeSequence: string | null = null;
    const pausedFetch: typeof fetch = async (input, init) => {
      if (requestMethod(input, init) === "POST" && requestUrl(input) === metadataUrl) {
        mergeSequence = requestHeader(input, init, "stream-seq");
        appendStarted.resolve();
        await releaseAppend.promise;
      }
      return fetch(input, init);
    };
    const mergingTarget = await new StreamFs({ baseUrl, fetch: pausedFetch }).openRepo(
      "writer-wins",
    );
    const merge = applyThreeWayMerge(mergingTarget, source, plan);
    await appendStarted.promise;
    expect(mergeSequence).toBe(plan.firstOffset);
    await target.createFile("winner.txt", encoder.encode("ordinary writer"));
    releaseAppend.resolve();

    await expect(merge).rejects.toMatchObject({
      code: "merge/target-advanced",
    } satisfies Partial<ThreeWayMergeError>);
    const types = (await target.rawDump()).map(({ type }) => type);
    expect(types).not.toContain("fs/merge-change");
    expect(types).not.toContain("fs/merge-conflict");
    expect(types.filter((type) => type === "fs.branch.merge")).toHaveLength(0);
    expect(decoder.decode(await target.readFile("winner.txt"))).toBe("ordinary writer");
  });

  it("lets the merge batch win before an ordinary writer and rejects the stale writer", async () => {
    const baseUrl = await startOfficialServer();
    const fixture = await cleanMergeFixture(baseUrl, "merge-wins");
    const metadataUrl = `${baseUrl}/streams/${encodeURIComponent(fixture.target.metadataStreamId)}`;
    const appendStarted = deferred();
    const releaseAppend = deferred();
    const pausedFetch: typeof fetch = async (input, init) => {
      if (requestMethod(input, init) === "POST" && requestUrl(input) === metadataUrl) {
        appendStarted.resolve();
        await releaseAppend.promise;
      }
      return fetch(input, init);
    };
    const writer = await new StreamFs({ baseUrl, fetch: pausedFetch }).openRepo("merge-wins");
    const ordinaryWrite = writer.writeFile("notes.txt", encoder.encode("stale writer"), {
      forceFull: true,
    });
    await appendStarted.promise;
    const receipt = await mergeThreeWay(fixture.target, fixture.source);
    releaseAppend.resolve();

    await expect(ordinaryWrite).rejects.toMatchObject({ status: 409 });
    expect(await fixture.target.readFile("notes.txt")).toEqual(fixture.expected);
    const raw = await fixture.target.rawDump();
    expect(raw.at(-1)?.offset).toBe(receipt.mergeOffset);
    expect(raw.slice(-2).map(({ type }) => type)).toEqual(["fs/merge-change", "fs.branch.merge"]);
    expect(await fixture.target.readFile("notes.txt")).toEqual(fixture.expected);
  });
});
