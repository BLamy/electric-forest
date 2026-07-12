import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "../../..");
const task = join(repo, ".eforest/tasks/epic-0-the-seed/E0-T04-ef-replay-digest");
const evidence = join(task, "evidence");
const golden = join(evidence, "golden.jsonl");
const expectedDigest = readFileSync(join(evidence, "golden.digest"), "utf8").trim();
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

  it("loads the committed alternate reducer in separate CLI processes", () => {
    const reducer = join(evidence, "alt-reducer.mjs");
    const first = run(["replay", golden, "--digest", "--reducer", reducer]);
    const second = run(["replay", golden, "--digest", "--reducer", reducer]);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout.trim()).not.toBe(expectedDigest);
    const missing = run(["replay", golden, "--digest", "--reducer", join(temp, "missing.mjs")]);
    expect(missing.status).not.toBe(0);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).not.toBe("");
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
  });
});
