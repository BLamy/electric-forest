import {
  cpSync,
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runCli } from "./cli.js";

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

async function runInProcess(args: readonly string[]) {
  let stdout = "";
  let stderr = "";
  const status = await runCli(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { status, stdout, stderr };
}

function fixtureFiles(root: string, current = root): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (current === root && entry.name === ".ef") continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) result.push(...fixtureFiles(root, path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

describe("E4-T01 CLI digest mouths", () => {
  it("makes tree-digest, replay, and materialize byte-identical", () => {
    const materialized = mkdtempSync(join(tmpdir(), "eforest-materialized-"));
    const tree = run(["tree-digest", fixture]);
    const replay = run(["replay", golden, "--worktree-digest"]);
    const materialize = run(["materialize", golden, "--out", materialized, "--worktree-digest"]);
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
      run([
        "materialize",
        golden,
        "--out",
        mkdtempSync(join(tmpdir(), "eforest-materialized-")),
        "--worktree-digest",
      ]).stdout,
    ).toBe(materialize.stdout);
  });

  it("changes for every byte and structural mutation", async () => {
    const copy = mkdtempSync(join(tmpdir(), "eforest-sensitivity-"));
    cpSync(fixture, copy, { recursive: true });
    const baseline = await runInProcess(["tree-digest", copy]);
    expect(baseline.status).toBe(0);
    const files = fixtureFiles(copy);
    let flips = 0;
    for (const target of files) {
      const bytes = readFileSync(target);
      for (let offset = 0; offset < bytes.byteLength; offset += 1) {
        bytes[offset] = bytes[offset]! ^ 0xff;
        writeFileSync(target, bytes);
        const mutated = await runInProcess(["tree-digest", copy]);
        expect(mutated.status).toBe(0);
        expect(mutated.stdout).not.toBe(baseline.stdout);
        bytes[offset] = bytes[offset]! ^ 0xff;
        writeFileSync(target, bytes);
        flips += 1;
      }
    }
    expect(flips).toBeGreaterThan(0);

    const blob = join(copy, "blob.bin");
    const renamed = join(copy, "renamed.bin");
    renameSync(blob, renamed);
    expect((await runInProcess(["tree-digest", copy])).stdout).not.toBe(baseline.stdout);
    renameSync(renamed, blob);
    const deleted = join(copy, "empty.txt");
    renameSync(deleted, join(copy, "deleted.txt"));
    expect((await runInProcess(["tree-digest", copy])).stdout).not.toBe(baseline.stdout);
    renameSync(join(copy, "deleted.txt"), deleted);
    writeFileSync(join(copy, "added.txt"), "");
    expect((await runInProcess(["tree-digest", copy])).stdout).not.toBe(baseline.stdout);
    unlinkSync(join(copy, "added.txt"));
    const originalBlob = readFileSync(blob);
    writeFileSync(blob, originalBlob.subarray(0, originalBlob.byteLength - 1));
    expect((await runInProcess(["tree-digest", copy])).stdout).not.toBe(baseline.stdout);
    writeFileSync(blob, originalBlob);
    const originalReadme = readFileSync(join(copy, "README.md"));
    writeFileSync(blob, originalReadme);
    writeFileSync(join(copy, "README.md"), originalBlob);
    expect((await runInProcess(["tree-digest", copy])).stdout).not.toBe(baseline.stdout);
  });

  it("pins empty-directory creation and removal", async () => {
    const copy = mkdtempSync(join(tmpdir(), "eforest-empty-dir-"));
    cpSync(fixture, copy, { recursive: true });
    const before = (await runInProcess(["tree-digest", copy])).stdout;
    const empty = join(copy, "new-empty-directory");
    mkdirSync(empty);
    expect((await runInProcess(["tree-digest", copy])).stdout).toBe(before);
    rmdirSync(empty);
    expect((await runInProcess(["tree-digest", copy])).stdout).toBe(before);
  });

  it("refuses on-disk symlink, FIFO, NFD, and unreadable entries with empty stdout", () => {
    const symlinkRoot = mkdtempSync(join(tmpdir(), "eforest-cli-symlink-"));
    symlinkSync("missing", join(symlinkRoot, "escape"));
    const symlink = run(["tree-digest", symlinkRoot]);
    expect(symlink.status).not.toBe(0);
    expect(symlink.stdout).toBe("");
    expect(symlink.stderr).toContain("escape");

    const fifoRoot = mkdtempSync(join(tmpdir(), "eforest-cli-fifo-"));
    const fifo = join(fifoRoot, "pipe");
    const fifoCreate = spawnSync("mkfifo", [fifo]);
    if (fifoCreate.status !== 0) {
      throw new Error(`mkfifo unavailable: ${fifoCreate.stderr.toString()}`);
    }
    const fifoResult = run(["tree-digest", fifoRoot]);
    expect(fifoResult.status).not.toBe(0);
    expect(fifoResult.stdout).toBe("");
    expect(fifoResult.stderr).toContain("pipe");

    const nfdRoot = mkdtempSync(join(tmpdir(), "eforest-cli-nfd-"));
    const nfd = "e\u0301.txt";
    writeFileSync(join(nfdRoot, nfd), "nfd");
    if (!readdirSync(nfdRoot).includes(nfd)) {
      throw new Error("filesystem normalized the NFD test name; on-disk refusal is untestable");
    } else {
      const nfdResult = run(["tree-digest", nfdRoot]);
      expect(nfdResult.status).not.toBe(0);
      expect(nfdResult.stdout).toBe("");
      expect(nfdResult.stderr).toContain(nfd);
    }

    if (process.getuid?.() === 0) {
      console.log("CONDITIONAL-SKIP: unreadable-file reason=euid-0-can-read-mode-000");
      return;
    }
    const unreadableRoot = mkdtempSync(join(tmpdir(), "eforest-cli-unreadable-"));
    const unreadable = join(unreadableRoot, "private.txt");
    writeFileSync(unreadable, "private");
    chmodSync(unreadable, 0o000);
    try {
      const unreadableResult = run(["tree-digest", unreadableRoot]);
      expect(unreadableResult.status).not.toBe(0);
      expect(unreadableResult.stdout).toBe("");
      expect(unreadableResult.stderr).toContain("private.txt");
    } finally {
      chmodSync(unreadable, 0o600);
    }
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

  it("counts prototype-looking filenames in the on-disk digest", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "eforest-cli-prototype-empty-"));
    const populatedRoot = mkdtempSync(join(tmpdir(), "eforest-cli-prototype-files-"));
    for (const name of ["__proto__", "constructor", "prototype"]) {
      writeFileSync(join(populatedRoot, name), "secret-bytes");
    }

    const empty = run(["tree-digest", emptyRoot]);
    const populated = run(["tree-digest", populatedRoot]);
    expect(empty.status).toBe(0);
    expect(populated.status).toBe(0);
    expect(populated.stdout).not.toBe(empty.stdout);
  });

  it("measures a root .ef regular file", () => {
    const fileRoot = mkdtempSync(join(tmpdir(), "eforest-cli-root-ef-file-"));
    writeFileSync(join(fileRoot, ".ef"), "ordinary content");
    const emptyRoot = mkdtempSync(join(tmpdir(), "eforest-cli-root-ef-empty-"));
    expect(run(["tree-digest", fileRoot]).stdout).not.toBe(run(["tree-digest", emptyRoot]).stdout);
  });
});
