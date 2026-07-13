import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson } from "@eforest/protocol";

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
});
