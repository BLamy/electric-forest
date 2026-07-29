import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson } from "@eforest/protocol";

const repo = resolve(import.meta.dirname, "../../..");
const task = join(repo, ".eforest/tasks/epic-0-the-seed/E0-T04-ef-replay-digest");
const evidence = join(task, "evidence");
const golden = join(evidence, "golden.jsonl");
const expectedDigest = readFileSync(join(evidence, "golden.digest"), "utf8").trim();
const snapshotTask = join(repo, ".eforest/tasks/epic-1-the-trunk/E1-T07-snapshots-and-retention");
const snapshotEvidence = join(snapshotTask, "evidence");
const branchTask = join(repo, ".eforest/tasks/epic-1-the-trunk/E1-T08-branch-fork-cow");
const branchEvidence = join(branchTask, "evidence");
const mergeTask = join(repo, ".eforest/tasks/epic-1-the-trunk/E1-T10-three-way-merge-conflicts");
const mergeEvidence = join(mergeTask, "evidence");
const ef = join(repo, "packages/cli/dist/src/bin.js");
const temp = mkdtempSync(join(tmpdir(), "ef-replay-test-"));

interface Result {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: readonly string[], cwd = repo, env?: NodeJS.ProcessEnv): Result {
  const result = spawnSync(process.execPath, [ef, ...args], {
    cwd,
    encoding: "utf8",
    env: env ?? process.env,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function writeDump(name: string, lines: readonly string[], trailingNewline = true): string {
  const path = join(temp, name);
  writeFileSync(path, lines.join("\n") + (trailingNewline ? "\n" : ""));
  return path;
}

beforeAll(() => {
  if (process.env.EFOREST_TEST_PREBUILT === "1") return;
  execFileSync("pnpm", ["--filter", "@eforest/protocol", "build"], { cwd: repo });
  execFileSync("pnpm", ["--filter", "@eforest/cli", "build"], { cwd: repo });
});

afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("ef replay digest", () => {
  it("prints exactly the frozen digest and nothing else", () => {
    const result = run(["replay", golden, "--digest"]);
    expect(result).toEqual({ status: 0, stdout: `${expectedDigest}\n`, stderr: "" });
    expect(result.stdout).toMatch(/^[0-9a-f]{64}\n$/);
    expect(Buffer.byteLength(result.stdout)).toBe(65);
  });

  it("is deterministic across cwd, timezone, and locale", () => {
    const first = run(["replay", golden, "--digest"], temp, {
      ...process.env,
      TZ: "Pacific/Kiritimati",
      LANG: "C",
    });
    const second = run(["replay", golden, "--digest"], repo, {
      ...process.env,
      TZ: "UTC",
      LANG: "en_US.UTF-8",
    });
    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout.trim()).toBe(expectedDigest);
  });

  it("loads the committed alternate reducer deterministically in separate CLI processes", () => {
    const reducer = join(evidence, "alt-reducer.mjs");
    const first = run(["replay", golden, "--digest", "--reducer", reducer]);
    const second = run(["replay", golden, "--digest", "--reducer", reducer]);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout.trim()).not.toBe(expectedDigest);
  });

  it("rejects a missing alternate reducer in a separate CLI process", () => {
    const missing = run(["replay", golden, "--digest", "--reducer", join(temp, "missing.mjs")]);
    expect(missing.status).not.toBe(0);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).not.toBe("");
  });

  it("isolates stdout from a noisy reducer module", () => {
    const reducer = join(evidence, "noisy-reducer.mjs");
    const result = run(["replay", golden, "--digest", "--reducer", reducer]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^[0-9a-f]{64}\n$/);
    expect(Buffer.byteLength(result.stdout)).toBe(65);
    expect(result.stdout).not.toContain("NOISE");
  });

  it("isolates descriptor-level stdout writes in a reducer worker", () => {
    const reducer = join(evidence, "fd-noisy-reducer.mjs");
    const result = run(["replay", golden, "--digest", "--reducer", reducer]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^[0-9a-f]{64}\n$/);
    expect(Buffer.byteLength(result.stdout)).toBe(65);
    expect(result.stdout).not.toContain("NOISE");
    expect(result.stderr).toBe("");
  });

  it.each(["early-ipc-reducer.mjs", "forged-ipc-reducer.mjs"])(
    "hides the result channel from %s and returns only the wrapper digest",
    (name) => {
      const reducer = join(evidence, name);
      const result = run(["replay", golden, "--digest", "--reducer", reducer]);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/^[0-9a-f]{64}\n$/);
      expect(result.stdout).not.toBe(`${"0".repeat(64)}\n`);
      expect(result.stderr).toBe("");
    },
  );

  it("rejects a reducer that sends one forged result and exits during import", () => {
    const reducer = join(evidence, "exit-forged-ipc-reducer.mjs");
    const result = run(["replay", golden, "--digest", "--reducer", reducer]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toBe("");
  });

  it("replays the E1-T07 snapshot golden and proves its hard cases", () => {
    const full = run(["replay", join(snapshotEvidence, "e1-t07-fs-log.jsonl"), "--digest"]);
    const bootstrap = run([
      "replay",
      "--bootstrap",
      join(snapshotEvidence, "e1-t07-snapshot.bin"),
      "--tail",
      join(snapshotEvidence, "e1-t07-compacted-tail.jsonl"),
      "--digest",
    ]);
    const announced = JSON.parse(
      readFileSync(join(snapshotEvidence, "e1-t07-snapshot-event.json"), "utf8"),
    ) as { payload: { stateDigest: string } };
    expect(full.status).toBe(0);
    expect(bootstrap.status).toBe(0);
    expect(full.stdout).toBe(bootstrap.stdout);
    expect(full.stdout.trim()).toBe(announced.payload.stateDigest);

    const records = readFileSync(join(snapshotEvidence, "e1-t07-fs-log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
    expect(records.filter((record) => record.type === "fs.file.patch")).toHaveLength(3);
    expect(
      records.some(
        (record) =>
          record.type === "fs.rename" &&
          record.payload.from === "src/nested" &&
          record.payload.to === "moved",
      ),
    ).toBe(true);
    const deleted = records.findIndex(
      (record) => record.type === "fs.file.delete" && record.payload.path === "src/a.txt",
    );
    const recreated = records.findIndex(
      (record) =>
        record.type === "fs.file.create" &&
        record.payload.path === "src/a.txt" &&
        record.payload.contentStreamId === "fs:e1-t07:file:c",
    );
    expect(deleted).toBeGreaterThanOrEqual(0);
    expect(recreated).toBeGreaterThan(deleted);
  });

  it("rejects truncated merge stages in direct and bootstrap replay processes", () => {
    const renameLines = readFileSync(join(mergeEvidence, "e1-t10-renames.jsonl"), "utf8")
      .trimEnd()
      .split("\n");
    const directPath = writeDump("truncated-merge-stage.jsonl", renameLines.slice(0, -1));
    const direct = run(["replay", directPath, "--digest"]);
    expect(direct.status).not.toBe(0);
    expect(direct.stdout).toBe("");
    expect(direct.stderr).toContain("merge/incomplete-batch");

    const tailPath = writeDump("truncated-bootstrap-tail.jsonl", [
      canonicalJson({
        offset: "9999999999999999_9999999999999999",
        payload: {
          change: { payload: { path: "staged", v: 2 }, type: "fs.dir.create" },
          index: 0,
          mergeId: "0".repeat(64),
          v: 1,
        },
        ts: 0,
        type: "fs/merge-change",
      }),
    ]);
    const bootstrap = run([
      "replay",
      "--bootstrap",
      join(snapshotEvidence, "e1-t07-snapshot.bin"),
      "--tail",
      tailPath,
      "--digest",
    ]);
    expect(bootstrap.status).not.toBe(0);
    expect(bootstrap.stdout).toBe("");
    expect(bootstrap.stderr).toContain("merge/incomplete-batch");
  });

  it("rejects a structurally wrong branch parent even when offsets overlap", () => {
    const result = run([
      "replay",
      join(branchEvidence, "e1-t08-golden-nested.jsonl"),
      "--parent",
      join(branchEvidence, "e1-t08-golden-main.jsonl"),
      "--parent-stream-id",
      "fs:e1-t08-golden:main:meta",
      "--digest",
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/branch\/parent-mismatch/);
  });

  it("rejects a wrong branch-shaped parent when its declared identity is changed", () => {
    const nested = readFileSync(join(branchEvidence, "e1-t08-golden-nested.jsonl"), "utf8");
    const wrongNested = nested.replace(
      '"parentStreamId":"fs:e1-t08-golden:feature:meta"',
      '"parentStreamId":"fs:e1-t08-golden:not-feature:meta"',
    );
    expect(wrongNested).not.toBe(nested);
    const wrongNestedPath = writeDump(
      "branch-wrong-shaped-parent.jsonl",
      wrongNested.trimEnd().split("\n"),
    );
    const result = run([
      "replay",
      wrongNestedPath,
      "--parent",
      join(branchEvidence, "e1-t08-golden-feature.jsonl"),
      "--parent-stream-id",
      "fs:e1-t08-golden:feature:meta",
      "--parent",
      join(branchEvidence, "e1-t08-golden-main.jsonl"),
      "--parent-stream-id",
      "fs:e1-t08-golden:main:meta",
      "--digest",
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/branch\/parent-mismatch/);
  });

  it("resolves parent dumps, cuts at fork offsets, and emits a fork-free log", () => {
    const parent = writeDump("branch-parent.jsonl", [
      canonicalJson({
        offset: "0000000000000000_0000000000000000",
        payload: { path: "src", v: 2 },
        ts: 1,
        type: "fs.dir.create",
      }),
    ]);
    const branch = writeDump("branch.jsonl", [
      canonicalJson({
        offset: "0000000000000000_0000000000000000",
        payload: {
          forkOffset: "0000000000000000_0000000000000000",
          parentStreamId: "fs:branch-cli:main:meta",
          v: 1,
        },
        ts: 2,
        type: "fs.branch.fork",
      }),
      canonicalJson({
        offset: "0000000000000000_0000000000000001",
        payload: { path: "src/new", v: 2 },
        ts: 3,
        type: "fs.dir.create",
      }),
    ]);
    const emitted = join(temp, "resolved-branch.jsonl");
    const resolved = run([
      "replay",
      branch,
      "--parent",
      parent,
      "--parent-stream-id",
      "fs:branch-cli:main:meta",
      "--digest",
      "--emit-log",
      emitted,
    ]);
    expect(resolved.status).toBe(0);
    expect(resolved.stdout).toMatch(/^[0-9a-f]{64}\n$/);
    expect(readFileSync(emitted, "utf8")).not.toContain("fs.branch.fork");
    const emittedDigest = run(["replay", emitted, "--digest"]);
    expect(emittedDigest).toEqual(resolved);
    const prefix = run([
      "replay",
      branch,
      "--parent",
      parent,
      "--parent-stream-id",
      "fs:branch-cli:main:meta",
      "--until",
      "0000000000000000_0000000000000000",
      "--digest",
    ]);
    expect(prefix.status).toBe(0);
    expect(prefix.stdout).not.toBe(resolved.stdout);
  });

  const usageCases: ReadonlyArray<readonly [readonly string[]]> = [
    [[]],
    [["bogus"]],
    [["replay", golden]],
  ];
  it.each(usageCases)("pins usage failure for %j", (args) => {
    const result = run(args);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/usage/i);
  });
});

describe("rejection corpus", () => {
  const cases = [
    ["invalid-json.jsonl", 1],
    ["noncanonical.jsonl", 1],
    ["out-of-order.jsonl", 2],
    ["duplicate-offset.jsonl", 2],
    ["missing-field.jsonl", 1],
    ["wrong-type.jsonl", 1],
    ["truncated-mid-record.jsonl", 1],
  ] as const;

  it.each(cases)("%s fails with line %s and empty stdout", (name, line) => {
    const result = run(["replay", join(evidence, "fuzz", name), "--digest"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`line ${line}`);
  });

  it("rejects empty, missing, and physically truncated files", () => {
    const empty = run(["replay", join(evidence, "fuzz/empty.jsonl"), "--digest"]);
    expect(empty.status).not.toBe(0);
    expect(empty.stdout).toBe("");
    expect(empty.stderr).not.toBe("");

    const missing = run(["replay", join(temp, "missing.jsonl"), "--digest"]);
    expect(missing.status).not.toBe(0);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).not.toBe("");

    const line = readFileSync(golden, "utf8").split("\n")[0]!;
    const truncated = run(["replay", writeDump("truncated.jsonl", [line], false), "--digest"]);
    expect(truncated.status).not.toBe(0);
    expect(truncated.stdout).toBe("");
    expect(truncated.stderr).toContain("line 1");
  });

  it.each([
    ["bom.jsonl", `\ufeff${readFileSync(golden, "utf8")}`],
    ["crlf.jsonl", readFileSync(golden, "utf8").replaceAll("\n", "\r\n")],
    ["duplicate-key.jsonl", '{"offset":"0001","offset":"0002","payload":2,"ts":1,"type":"set"}\n'],
    [
      "numeric-order.jsonl",
      '{"offset":"9","payload":2,"ts":1,"type":"set"}\n{"offset":"10","payload":3,"ts":2,"type":"increment"}\n',
    ],
  ])("rejects adversarial format %s", (name, contents) => {
    const path = join(temp, name);
    writeFileSync(path, contents);
    const result = run(["replay", path, "--digest"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });

  it("rejects invalid UTF-8 instead of normalizing it", () => {
    const valid = Buffer.from('{"offset":"0001","payload":"�","ts":1,"type":"set"}\n', "utf8");
    const replacement = Buffer.from([0xff]);
    const encodedReplacement = Buffer.from("�", "utf8");
    const at = valid.indexOf(encodedReplacement);
    expect(at).toBeGreaterThan(0);
    const corrupt = Buffer.concat([
      valid.subarray(0, at),
      replacement,
      valid.subarray(at + encodedReplacement.length),
    ]);
    const path = join(temp, "invalid-utf8.jsonl");
    writeFileSync(path, corrupt);
    const result = run(["replay", path, "--digest"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("line 1");
    expect(result.stderr).toMatch(/UTF-8/i);
  });
});

describe("mutation and prefix localization", () => {
  const lines = readFileSync(golden, "utf8").trimEnd().split("\n");
  const prefixes = new Map(
    readFileSync(join(evidence, "golden.prefix-digests"), "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const [count, digest] = line.split("\t");
        return [Number(count), digest!];
      }),
  );

  it("detects a one-byte payload mutation at its exact record", () => {
    const mutated = [...lines];
    mutated[1] = mutated[1]!.replace('"payload":3', '"payload":4');
    let firstDivergence: number | undefined;
    for (let count = 1; count <= mutated.length; count += 1) {
      const path = writeDump(`mutated-prefix-${count}.jsonl`, mutated.slice(0, count));
      const result = run(["replay", path, "--digest"]);
      expect(result.status).toBe(0);
      if (result.stdout.trim() !== prefixes.get(count) && firstDivergence === undefined) {
        firstDivergence = count;
      }
    }
    expect(firstDivergence).toBe(2);
  });

  it("detects every payload byte sweep as parse failure or digest change", () => {
    const source = readFileSync(golden, "utf8");
    const marker = '"payload":{"a":1,"z":"done"}';
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThan(0);
    for (let index = start; index < start + marker.length; index += 1) {
      const replacement = source[index] === "x" ? "y" : "x";
      const path = join(temp, `byte-${index}.jsonl`);
      writeFileSync(path, source.slice(0, index) + replacement + source.slice(index + 1));
      const result = run(["replay", path, "--digest"]);
      expect(
        result.status === 0 ? result.stdout.trim() !== expectedDigest : result.stdout === "",
      ).toBe(true);
    }
  }, 30_000);
});
