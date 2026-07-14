import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, type Event, type Offset } from "@eforest/protocol";
import {
  digestBytes,
  fsInitialState,
  fsReducer,
  mergePlanId,
  treeDigest,
  type FsMergeChange,
} from "@eforest/streamfs";

const repo = resolve(import.meta.dirname, "../../..");
const task = join(repo, ".eforest/tasks/epic-1-the-trunk/E1-T06-convergence-harness");
const evidence = join(task, "evidence");
const golden = join(evidence, "golden-scenario.jsonl");
const expected = readFileSync(join(evidence, "golden-tree.digest"), "utf8").trim();
const reducer = join(repo, "packages/streamfs/reducer.mjs");
const ef = join(repo, "packages/cli/dist/src/bin.js");
const temp = mkdtempSync(join(repo, ".eforest-materialize-test-"));

function run(args: readonly string[]) {
  return spawnSync(process.execPath, [ef, ...args], { cwd: repo, encoding: "utf8" });
}

function writeDump(name: string, lines: readonly string[]): string {
  const path = join(temp, name);
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}

function offset(ordinal: number): Offset {
  return `0000000000000000_${String(ordinal).padStart(16, "0")}` as Offset;
}

function replacementRenameDump(): readonly Record<string, unknown>[] {
  const streamA = "fs:e1-t10-materialize:main:file:a";
  const streamB = "fs:e1-t10-materialize:main:file:b";
  const bytesA = Buffer.from("A\n");
  const bytesB = Buffer.from("B\n");
  const baseRecords = [
    {
      offset: offset(0),
      payload: { contentBase64: bytesA.toString("base64"), contentStreamId: streamA, v: 2 },
      ts: 0,
      type: "fs.file.content",
    },
    {
      offset: offset(1),
      payload: { contentStreamId: streamA, path: "a.txt", v: 2 },
      ts: 0,
      type: "fs.file.create",
    },
    {
      offset: offset(2),
      payload: {
        base: "BASE_NONE",
        contentSha256: digestBytes(bytesA),
        path: "a.txt",
        size: bytesA.byteLength,
        v: 2,
      },
      ts: 0,
      type: "fs.file.write",
    },
    {
      offset: offset(3),
      payload: { contentBase64: bytesB.toString("base64"), contentStreamId: streamB, v: 2 },
      ts: 0,
      type: "fs.file.content",
    },
    {
      offset: offset(4),
      payload: { contentStreamId: streamB, path: "b.txt", v: 2 },
      ts: 0,
      type: "fs.file.create",
    },
    {
      offset: offset(5),
      payload: {
        base: "BASE_NONE",
        contentSha256: digestBytes(bytesB),
        path: "b.txt",
        size: bytesB.byteLength,
        v: 2,
      },
      ts: 0,
      type: "fs.file.write",
    },
  ];
  const base = baseRecords.reduce((state, event) => fsReducer(state, event), fsInitialState);
  const changes: readonly FsMergeChange[] = [
    { type: "fs.file.delete", payload: { v: 2, path: "b.txt" } },
    { type: "fs.rename", payload: { v: 2, from: "a.txt", to: "b.txt" } },
  ];
  const result = changes.reduce(
    (state, change) =>
      fsReducer(state, { ...change, offset: offset(8), ts: 1 } as unknown as Event),
    base,
  );
  const targetStreamId = "fs:e1-t10-materialize:main:meta";
  const sourceStreamId = "fs:e1-t10-materialize:feature:meta";
  const mergeId = mergePlanId({
    base: { streamId: targetStreamId, offset: offset(5), treeDigest: treeDigest(base) },
    target: { streamId: targetStreamId, offset: offset(5), treeDigest: treeDigest(base) },
    source: { streamId: sourceStreamId, offset: offset(7), treeDigest: treeDigest(result) },
    changes,
    conflicts: [],
  });
  return [
    ...baseRecords,
    ...changes.map((change, index) => ({
      offset: offset(6 + index),
      payload: { change, index, mergeId, v: 1 },
      ts: 1,
      type: "fs/merge-change",
    })),
    {
      offset: offset(8),
      payload: {
        baseTreeDigest: treeDigest(base),
        changes,
        conflicts: [],
        forkOffset: offset(5),
        kind: "three-way",
        mergeId,
        mergedThroughOffset: offset(7),
        resultTreeDigest: treeDigest(result),
        sourceHeadOffset: offset(7),
        sourceStreamId,
        sourceTreeDigest: treeDigest(result),
        targetHeadOffset: offset(5),
        targetStreamId,
        targetTreeDigest: treeDigest(base),
        v: 2,
      },
      ts: 1,
      type: "fs.branch.merge",
    },
  ];
}

function renameContentDump(): readonly Record<string, unknown>[] {
  const inheritedStream = "fs:e1-t10-rename-content:main:file:before";
  const branchStream = "fs:e1-t10-rename-content:feature:file:after";
  const before = Buffer.from("before\n");
  const after = Buffer.from("after edit\n");
  const baseRecords = [
    {
      offset: offset(0),
      payload: {
        contentBase64: before.toString("base64"),
        contentStreamId: inheritedStream,
        v: 2,
      },
      ts: 0,
      type: "fs.file.content",
    },
    {
      offset: offset(1),
      payload: { contentStreamId: inheritedStream, path: "before.txt", v: 2 },
      ts: 0,
      type: "fs.file.create",
    },
    {
      offset: offset(2),
      payload: {
        base: "BASE_NONE",
        contentSha256: digestBytes(before),
        path: "before.txt",
        size: before.byteLength,
        v: 2,
      },
      ts: 0,
      type: "fs.file.write",
    },
    {
      offset: offset(3),
      payload: {
        contentBase64: after.toString("base64"),
        contentStreamId: branchStream,
        v: 2,
      },
      ts: 0,
      type: "fs.file.content",
    },
  ];
  const base = baseRecords.reduce((state, event) => fsReducer(state, event), fsInitialState);
  const changes: readonly FsMergeChange[] = [
    { type: "fs.rename", payload: { v: 2, from: "before.txt", to: "after.txt" } },
    {
      type: "fs.file.write",
      payload: {
        v: 2,
        path: "after.txt",
        base: offset(2),
        contentSha256: digestBytes(after),
        size: after.byteLength,
      },
    },
    {
      type: "fs.file.create",
      payload: { v: 2, path: "after.txt", contentStreamId: branchStream },
    },
  ];
  const result = changes.reduce(
    (state, change) =>
      fsReducer(state, { ...change, offset: offset(7), ts: 1 } as unknown as Event),
    base,
  );
  const targetStreamId = "fs:e1-t10-rename-content:main:meta";
  const sourceStreamId = "fs:e1-t10-rename-content:feature:meta";
  const mergeId = mergePlanId({
    base: { streamId: targetStreamId, offset: offset(2), treeDigest: treeDigest(base) },
    target: { streamId: targetStreamId, offset: offset(2), treeDigest: treeDigest(base) },
    source: { streamId: sourceStreamId, offset: offset(6), treeDigest: treeDigest(result) },
    changes,
    conflicts: [],
  });
  return [
    ...baseRecords,
    ...changes.map((change, index) => ({
      offset: offset(4 + index),
      payload: { change, index, mergeId, v: 1 },
      ts: 1,
      type: "fs/merge-change",
    })),
    {
      offset: offset(7),
      payload: {
        baseTreeDigest: treeDigest(base),
        changes,
        conflicts: [],
        forkOffset: offset(2),
        kind: "three-way",
        mergeId,
        mergedThroughOffset: offset(6),
        resultTreeDigest: treeDigest(result),
        sourceHeadOffset: offset(6),
        sourceStreamId,
        sourceTreeDigest: treeDigest(result),
        targetHeadOffset: offset(2),
        targetStreamId,
        targetTreeDigest: treeDigest(base),
        v: 2,
      },
      ts: 1,
      type: "fs.branch.merge",
    },
  ];
}

beforeAll(() => {
  execFileSync("pnpm", ["--filter", "@eforest/streamfs", "build"], { cwd: repo });
  execFileSync("pnpm", ["--filter", "@eforest/cli", "build"], { cwd: repo });
});

afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("ef materialize", () => {
  it("materializes two fresh trees with the frozen digest", () => {
    const first = join(temp, "first");
    const second = join(temp, "second");
    const one = run(["materialize", golden, "--out", first, "--reducer", reducer]);
    const two = run(["materialize", golden, "--out", second]);
    expect(one.status).toBe(0);
    expect(two.status).toBe(0);
    expect(one.stdout).toBe(`${expected}\n`);
    expect(two.stdout).toBe(one.stdout);
    execFileSync("diff", ["-r", first, second], { cwd: repo });
    execFileSync("diff", ["-r", first, join(evidence, "golden-tree")], { cwd: repo });
  });

  it("agrees with replay at first, middle, and head offsets", () => {
    const lines = readFileSync(golden, "utf8").trimEnd().split("\n");
    for (const index of [0, Math.floor(lines.length / 2), lines.length - 1]) {
      const records = lines.map((line) => JSON.parse(line));
      const offset = records[index]!.offset;
      const prefix = join(temp, `prefix-${index}.jsonl`);
      writeFileSync(prefix, `${lines.slice(0, index + 1).join("\n")}\n`);
      const replay = run(["replay", prefix, "--digest", "--reducer", reducer]);
      const materialized = run([
        "materialize",
        golden,
        "--at",
        offset,
        "--out",
        join(temp, `at-${index}`),
        "--reducer",
        reducer,
      ]);
      expect(replay.status).toBe(0);
      expect(materialized.status).toBe(0);
      expect(materialized.stdout).toBe(replay.stdout);
    }
  });

  it("keeps stdout empty for rejected offsets, reducers, outputs, and paths", () => {
    const missingAt = run([
      "materialize",
      golden,
      "--at",
      "0000000000000000_9999999999999999",
      "--out",
      join(temp, "missing-at"),
    ]);
    const missingReducer = run([
      "materialize",
      golden,
      "--out",
      join(temp, "missing-reducer"),
      "--reducer",
      join(temp, "missing.mjs"),
    ]);
    const nonEmpty = join(temp, "non-empty");
    mkdirSync(nonEmpty);
    writeFileSync(join(nonEmpty, "existing"), "x");
    const occupied = run(["materialize", golden, "--out", nonEmpty]);
    const escapeDump = join(temp, "escape.jsonl");
    writeFileSync(
      escapeDump,
      `${canonicalJson({ offset: "0000000000000000_0000000000000000", payload: { contentStreamId: "x", path: "../escape", v: 2 }, ts: 1, type: "fs.file.create" })}\n`,
    );
    const escape = run(["materialize", escapeDump, "--out", join(temp, "escape-out")]);
    for (const result of [missingAt, missingReducer, occupied, escape]) {
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
    }
  });

  it("materializes identity-preserving replacement renames and rejects staged prefixes", () => {
    const records = replacementRenameDump();
    const complete = writeDump(
      "replacement-rename.jsonl",
      records.map((record) => canonicalJson(record)),
    );
    const completeOut = join(temp, "replacement-rename");
    const materialized = run(["materialize", complete, "--out", completeOut]);
    expect(materialized.status).toBe(0);
    expect(materialized.stdout).toMatch(/^[0-9a-f]{64}\n$/);
    expect(readFileSync(join(completeOut, "b.txt"), "utf8")).toBe("A\n");

    const truncated = writeDump(
      "replacement-rename-truncated.jsonl",
      records.slice(0, 7).map((record) => canonicalJson(record)),
    );
    const rejected = run([
      "materialize",
      truncated,
      "--out",
      join(temp, "replacement-rename-truncated"),
    ]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stdout).toBe("");
    expect(rejected.stderr).toContain("merge/incomplete-batch");
  });

  it("materializes a rename plus source content handoff through the real CLI", () => {
    const dump = writeDump(
      "rename-content.jsonl",
      renameContentDump().map((record) => canonicalJson(record)),
    );
    const output = join(temp, "rename-content");
    const materialized = run(["materialize", dump, "--out", output]);
    const replayed = run(["replay", dump, "--digest"]);
    expect(materialized.status, materialized.stderr).toBe(0);
    expect(replayed.status, replayed.stderr).toBe(0);
    expect(materialized.stdout).toBe(replayed.stdout);
    expect(readFileSync(join(output, "after.txt"), "utf8")).toBe("after edit\n");
    expect(() => readFileSync(join(output, "before.txt"), "utf8")).toThrow();
  });
});
