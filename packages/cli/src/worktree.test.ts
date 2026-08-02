import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const ef = join(repo, "packages/cli/dist/src/bin.js");
const taskEvidence = join(
  repo,
  ".eforest/tasks/epic-4-the-roots/E4-T01-worktree-digest-and-ef-format/evidence",
);
const fixture = join(taskEvidence, "fixture-tree");
const golden = join(taskEvidence, "golden-worktree.jsonl");
const expected = readFileSync(join(taskEvidence, "golden-worktree.digest"), "utf8").trim();

function run(args: readonly string[]) {
  return spawnSync(process.execPath, [ef, ...args], { cwd: repo, encoding: "utf8" });
}

describe("E4-T01 CLI digest mouths", () => {
  it("makes tree-digest, replay, and materialize byte-identical", () => {
    const materialized = mkdtempSync(join(tmpdir(), "eforest-materialized-"));
    const tree = run(["tree-digest", fixture]);
    const replay = run(["replay", golden, "--worktree-digest"]);
    const materialize = run(["materialize", golden, "--out", materialized]);
    expect(tree.status).toBe(0);
    expect(replay.status).toBe(0);
    expect(materialize.status).toBe(0);
    expect(tree.stderr).toBe("");
    expect(tree.stdout).toBe(`${expected}\n`);
    expect(replay.stdout).toBe(tree.stdout);
    expect(materialize.stdout).toBe(tree.stdout);
    expect(run(["tree-digest", fixture]).stdout).toBe(tree.stdout);
    expect(run(["replay", golden, "--worktree-digest"]).stdout).toBe(replay.stdout);
    expect(
      run(["materialize", golden, "--out", mkdtempSync(join(tmpdir(), "eforest-materialized-"))])
        .stdout,
    ).toBe(materialize.stdout);
  });

  it("changes for every representative byte and structural mutation", () => {
    const copy = mkdtempSync(join(tmpdir(), "eforest-sensitivity-"));
    const target = join(copy, "blob.bin");
    mkdirSync(join(copy, "nested", ".ef"), { recursive: true });
    copyFileSync(join(fixture, "blob.bin"), target);
    writeFileSync(join(copy, "nested", ".ef", "marker"), "nested");
    const before = run(["tree-digest", copy]);
    const bytes = readFileSync(target);
    bytes[0] = bytes[0]! ^ 0xff;
    writeFileSync(target, bytes);
    const after = run(["tree-digest", copy]);
    expect(before.status).toBe(0);
    expect(after.status).toBe(0);
    expect(after.stdout).not.toBe(before.stdout);
  });

  it("refuses a symlink with zero digest stdout", () => {
    const copy = mkdtempSync(join(tmpdir(), "eforest-refusal-"));
    symlinkSync("missing", join(copy, "escape"));
    const result = run(["tree-digest", copy]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("escape");
  });

  it("keeps root .ef excluded while materialized nested .ef remains measured", () => {
    const copy = mkdtempSync(join(tmpdir(), "eforest-ef-"));
    writeFileSync(join(copy, "file.txt"), "bytes");
    const base = run(["tree-digest", copy]).stdout;
    mkdirSync(join(copy, ".ef"));
    writeFileSync(join(copy, ".ef", "state"), "ignored");
    expect(run(["tree-digest", copy]).stdout).toBe(base);
    mkdirSync(join(copy, "sub", ".ef"), { recursive: true });
    writeFileSync(join(copy, "sub", ".ef", "state"), "counted");
    expect(run(["tree-digest", copy]).stdout).not.toBe(base);
  });
});
