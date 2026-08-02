import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, type Event, type Offset } from "@eforest/protocol";
import {
  chooseWriteEvent,
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
const mergeEvidence = join(
  repo,
  ".eforest/tasks/epic-1-the-trunk/E1-T10-three-way-merge-conflicts/evidence",
);
const ef = join(repo, "packages/cli/dist/src/bin.js");
const temp = mkdtempSync(join(repo, ".eforest-materialize-test-"));

function run(args: readonly string[]) {
  const legacyArgs =
    args[0] === "materialize" &&
    !args.includes("--tree-digest") &&
    !args.includes("--worktree-digest")
      ? [...args, "--tree-digest"]
      : args;
  return spawnSync(process.execPath, [ef, ...legacyArgs], { cwd: repo, encoding: "utf8" });
}

function writeDump(name: string, lines: readonly string[]): string {
  const path = join(temp, name);
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}

function dumpDigest(path: string): string {
  const state = readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .reduce((tree, line) => fsReducer(tree, JSON.parse(line)), fsInitialState);
  return treeDigest(state);
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
  if (process.env.EFOREST_TEST_PREBUILT === "1") return;
  execFileSync("pnpm", ["--filter", "@eforest/streamfs", "build"], { cwd: repo });
  execFileSync("pnpm", ["--filter", "@eforest/cli", "build"], { cwd: repo });
});

afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("ef materialize", () => {
  it.each(["explicit-reducer", "default-reducer"] as const)(
    "materializes a fresh tree with the frozen digest (%s)",
    (mode) => {
      const output = join(temp, mode);
      const result = run([
        "materialize",
        golden,
        "--out",
        output,
        ...(mode === "explicit-reducer" ? ["--reducer", reducer] : []),
      ]);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${expected}\n`);
      execFileSync("diff", ["-r", output, join(evidence, "golden-tree")], { cwd: repo });
    },
  );

  it.each(["first", "middle", "head"] as const)(
    "agrees with in-process replay at the %s offset",
    (position) => {
      const lines = readFileSync(golden, "utf8").trimEnd().split("\n");
      const index =
        position === "first"
          ? 0
          : position === "middle"
            ? Math.floor(lines.length / 2)
            : lines.length - 1;
      const records = lines.map((line) => JSON.parse(line));
      const offset = records[index]!.offset;
      const materialized = run([
        "materialize",
        golden,
        "--at",
        offset,
        "--out",
        join(temp, `at-${position}`),
        "--reducer",
        reducer,
      ]);
      const prefixState = records
        .slice(0, index + 1)
        .reduce((tree, record) => fsReducer(tree, record), fsInitialState);
      expect(materialized.status).toBe(0);
      expect(materialized.stdout).toBe(`${treeDigest(prefixState)}\n`);
    },
  );

  it.each(["missing-offset", "missing-reducer", "occupied-output", "escape-path"] as const)(
    "keeps stdout empty for rejected %s",
    (rejection) => {
      let result: ReturnType<typeof run>;
      if (rejection === "missing-offset") {
        result = run([
          "materialize",
          golden,
          "--at",
          "0000000000000000_9999999999999999",
          "--out",
          join(temp, "missing-at"),
        ]);
      } else if (rejection === "missing-reducer") {
        result = run([
          "materialize",
          golden,
          "--out",
          join(temp, "missing-reducer"),
          "--reducer",
          join(temp, "missing.mjs"),
        ]);
      } else if (rejection === "occupied-output") {
        const nonEmpty = join(temp, "non-empty");
        mkdirSync(nonEmpty);
        writeFileSync(join(nonEmpty, "existing"), "x");
        result = run(["materialize", golden, "--out", nonEmpty]);
      } else {
        const escapeDump = join(temp, "escape.jsonl");
        writeFileSync(
          escapeDump,
          `${canonicalJson({ offset: "0000000000000000_0000000000000000", payload: { contentStreamId: "x", path: "../escape", v: 2 }, ts: 1, type: "fs.file.create" })}\n`,
        );
        result = run(["materialize", escapeDump, "--out", join(temp, "escape-out")]);
      }
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
    },
  );

  it("materializes an identity-preserving replacement rename", () => {
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
  });

  it("rejects a staged replacement-rename prefix", () => {
    const records = replacementRenameDump();
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
    expect(materialized.status, materialized.stderr).toBe(0);
    expect(materialized.stdout).toBe(`${dumpDigest(dump)}\n`);
    expect(readFileSync(join(output, "after.txt"), "utf8")).toBe("after edit\n");
    expect(() => readFileSync(join(output, "before.txt"), "utf8")).toThrow();
  });

  it.each([
    ["e1-t10-common-rename-content.jsonl", [["after.txt", "source edit after common rename\n"]]],
    [
      "e1-t10-sibling-renames.jsonl",
      [
        ["dest/x.txt", "X edited\n"],
        ["dest/y.txt", "Y edited\n"],
      ],
    ],
  ] as const)("materializes rename evidence from %s", (name, expectedFiles) => {
    const dump = join(mergeEvidence, name);
    const output = join(temp, name.replace(".jsonl", ""));
    const materialized = run(["materialize", dump, "--out", output]);
    expect(materialized.status, materialized.stderr).toBe(0);
    expect(materialized.stdout).toBe(`${dumpDigest(dump)}\n`);
    for (const [path, content] of expectedFiles) {
      expect(readFileSync(join(output, path), "utf8")).toBe(content);
    }
  });

  it.each(["e1-t10-cross-rename-patches.jsonl", "e1-t10-equivalent-renames.jsonl"])(
    "materializes cross-rename and equivalent-rename evidence from %s",
    (name) => {
      const dump = join(mergeEvidence, name);
      const output = join(temp, name.replace(".jsonl", ""));
      const materialized = run(["materialize", dump, "--out", output]);
      expect(materialized.status, materialized.stderr).toBe(0);
      expect(materialized.stdout).toBe(`${dumpDigest(dump)}\n`);
      if (name.includes("cross-rename")) {
        const content = readFileSync(join(output, "after.txt"), "utf8");
        expect(content).toContain("target patch before rename");
        expect(content).toContain("source patch after rename");
      } else {
        expect(readFileSync(join(output, "c.txt"), "utf8")).toBe(
          "source edit through equivalent chain\n",
        );
      }
    },
  );

  it.each(["alias-reuse", "suffix-conflict"] as const)("materializes %s evidence", (scenario) => {
    const dump = join(mergeEvidence, `e1-t10-${scenario}.jsonl`);
    const output = join(temp, scenario);
    const materialized = run(["materialize", dump, "--out", output]);
    expect(materialized.status, materialized.stderr).toBe(0);
    expect(materialized.stdout).toBe(`${dumpDigest(dump)}\n`);
    if (scenario === "alias-reuse") {
      expect(readFileSync(join(output, "a.txt"), "utf8")).toBe("unrelated full write\n");
      const merged = readFileSync(join(output, "b.txt"), "utf8");
      expect(merged).toContain("target identity patch");
      expect(merged).toContain("source identity patch");
    } else {
      expect(readFileSync(join(output, "b.txt"), "utf8")).toBe("target edit\n");
      expect(() => readFileSync(join(output, "c.txt"), "utf8")).toThrow();
    }
  });

  it("materializes metadata from an actual content-stream sidecar", () => {
    const bytes = Buffer.from("sidecar bytes\n");
    const streamId = "fs:sidecar:main:file:1";
    const contentRecord = {
      offset: offset(0),
      payload: { contentBase64: bytes.toString("base64"), contentStreamId: streamId, v: 2 },
      ts: 0,
      type: "fs.file.content",
    };
    const metadataRecords = [
      {
        offset: offset(0),
        payload: { contentStreamId: streamId, path: "actual.txt", v: 2 },
        ts: 1,
        type: "fs.file.create",
      },
      {
        offset: offset(1),
        payload: {
          base: "BASE_NONE",
          contentSha256: digestBytes(bytes),
          path: "actual.txt",
          size: bytes.byteLength,
          v: 2,
        },
        ts: 2,
        type: "fs.file.write",
      },
    ];
    const metadata = writeDump(
      "sidecar-metadata.jsonl",
      metadataRecords.map((record) => canonicalJson(record)),
    );
    const content = writeDump("sidecar-content.jsonl", [canonicalJson(contentRecord)]);
    const output = join(temp, "sidecar-output");
    const materialized = run(["materialize", metadata, "--content", content, "--out", output]);
    const expectedState = [contentRecord, ...metadataRecords].reduce(
      (state, event) => fsReducer(state, event as unknown as Event),
      fsInitialState,
    );
    expect(materialized.status, materialized.stderr).toBe(0);
    expect(materialized.stdout).toBe(`${treeDigest(expectedState)}\n`);
    expect(readFileSync(join(output, "actual.txt"), "utf8")).toBe("sidecar bytes\n");

    const invalidContent = writeDump("sidecar-invalid-content.jsonl", [
      canonicalJson(metadataRecords[0]),
    ]);
    const rejected = run([
      "materialize",
      metadata,
      "--content",
      invalidContent,
      "--out",
      join(temp, "sidecar-rejected"),
    ]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("content dump contains non-content event");
  });

  it("materializes same-stream full, patch, and later full generations in causal order", () => {
    const streamId = "fs:sidecar-causal:main:file:1";
    const path = "causal.txt";
    const original = Buffer.from(
      `${Array.from({ length: 128 }, (_, index) => `base-${index}`).join("\n")}\n`,
    );
    const patched = Buffer.from(original.toString("utf8").replace("base-64", "edit-64"));
    const final = Buffer.from("final full generation\n");
    const patch = chooseWriteEvent(original, patched, path, offset(1));
    expect(patch.type).toBe("fs.file.patch");
    if (patch.type !== "fs.file.patch") throw new Error("fixture did not choose a patch");

    const firstContent = {
      offset: offset(0),
      payload: { contentBase64: original.toString("base64"), contentStreamId: streamId, v: 2 },
      ts: 0,
      type: "fs.file.content",
    };
    const secondContent = {
      offset: offset(1),
      payload: { contentBase64: final.toString("base64"), contentStreamId: streamId, v: 2 },
      ts: 0,
      type: "fs.file.content",
    };
    const metadataRecords = [
      {
        offset: offset(0),
        payload: { contentStreamId: streamId, path, v: 2 },
        ts: 1,
        type: "fs.file.create",
      },
      {
        offset: offset(1),
        payload: {
          base: "BASE_NONE",
          contentSha256: digestBytes(original),
          path,
          size: original.byteLength,
          v: 2,
        },
        ts: 2,
        type: "fs.file.write",
      },
      { ...patch, offset: offset(2), ts: 3 },
      {
        offset: offset(3),
        payload: {
          base: offset(2),
          contentSha256: digestBytes(final),
          path,
          size: final.byteLength,
          v: 2,
        },
        ts: 4,
        type: "fs.file.write",
      },
    ];
    const metadata = writeDump(
      "sidecar-causal-metadata.jsonl",
      metadataRecords.map((record) => canonicalJson(record)),
    );
    const content = writeDump("sidecar-causal-content.jsonl", [
      canonicalJson(firstContent),
      canonicalJson(secondContent),
    ]);

    const fullOutput = join(temp, "sidecar-causal-full");
    const full = run(["materialize", metadata, "--content", content, "--out", fullOutput]);
    const fullState = [
      firstContent,
      ...metadataRecords.slice(0, 3),
      secondContent,
      metadataRecords[3],
    ].reduce((state, event) => fsReducer(state, event as unknown as Event), fsInitialState);
    expect(full.status, full.stderr).toBe(0);
    expect(full.stdout).toBe(`${treeDigest(fullState)}\n`);
    expect(readFileSync(join(fullOutput, path))).toEqual(final);

    const prefixOutput = join(temp, "sidecar-causal-prefix");
    const prefix = run([
      "materialize",
      metadata,
      "--content",
      content,
      "--at",
      offset(2),
      "--out",
      prefixOutput,
    ]);
    const prefixState = [firstContent, ...metadataRecords.slice(0, 3)].reduce(
      (state, event) => fsReducer(state, event as unknown as Event),
      fsInitialState,
    );
    expect(prefix.status, prefix.stderr).toBe(0);
    expect(prefix.stdout).toBe(`${treeDigest(prefixState)}\n`);
    expect(readFileSync(join(prefixOutput, path))).toEqual(patched);
  });
});
