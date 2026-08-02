import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { worktreeDigest } from "./worktree.js";
import { readWorktree, worktreeDigestDirectory } from "./worktree-node.js";

function tempTree(): string {
  const root = mkdtempSync(join(tmpdir(), "eforest-worktree-"));
  mkdirSync(join(root, "docs"));
  mkdirSync(join(root, "sub", ".ef"), { recursive: true });
  writeFileSync(join(root, "empty.txt"), Buffer.alloc(0));
  writeFileSync(join(root, "docs", "café.txt"), Buffer.from("NFC content\n", "utf8"));
  writeFileSync(join(root, "blob.bin"), Buffer.from([0, 1, 2, 127, 128, 255]));
  writeFileSync(join(root, "sub", ".ef", "nested-state"), "ordinary nested metadata");
  mkdirSync(join(root, ".ef"));
  writeFileSync(join(root, ".ef", "workspace.json"), "ignored root state");
  return root;
}

describe("worktree digest", () => {
  it("uses exact bytes, excludes only root .ef, and includes nested .ef", () => {
    const root = tempTree();
    const baseline = worktreeDigestDirectory(root);
    writeFileSync(join(root, ".ef", "garbage"), "a different root-only value");
    expect(worktreeDigestDirectory(root)).toBe(baseline);
    writeFileSync(join(root, "sub", ".ef", "nested-state"), "changed nested metadata");
    expect(worktreeDigestDirectory(root)).not.toBe(baseline);
  });

  it("does not represent empty directories", () => {
    const root = tempTree();
    const before = worktreeDigestDirectory(root);
    mkdirSync(join(root, "empty-directory"));
    expect(worktreeDigestDirectory(root)).toBe(before);
  });

  it("ignores mtime and mode metadata", () => {
    const root = tempTree();
    const target = join(root, "blob.bin");
    const before = worktreeDigestDirectory(root);
    const old = new Date(1_234_567_890_000);
    utimesSync(target, old, old);
    expect(worktreeDigestDirectory(root)).toBe(before);
    const modeBefore = readFileSync(target).byteLength;
    chmodSync(target, 0o600);
    expect(readFileSync(target).byteLength).toBe(modeBefore);
    expect(worktreeDigestDirectory(root)).toBe(before);
  });

  it("refuses symlinks and names the offending path", () => {
    const root = tempTree();
    symlinkSync("blob.bin", join(root, "escape"));
    expect(() => worktreeDigestDirectory(root)).toThrowError(
      expect.objectContaining({ code: "symlink", path: "escape" }),
    );
  });

  it("refuses FIFOs and names the offending path", () => {
    const root = tempTree();
    const fifo = join(root, "pipe");
    const created = spawnSync("mkfifo", [fifo]);
    if (created.status !== 0) {
      console.log("CONDITIONAL-SKIP: fifo-refusal reason=mkfifo-unavailable");
      return;
    }
    expect(() => worktreeDigestDirectory(root)).toThrowError(
      expect.objectContaining({ code: "non-regular", path: "pipe" }),
    );
  });

  it("refuses invalid projection paths at the library boundary", () => {
    const file = { contentSha256: "0".repeat(64), size: 0 };
    for (const path of [
      "",
      "/leading",
      "trailing/",
      "a//b",
      "a/./b",
      "a/../b",
      "bad\0path",
      "e\u0301.txt",
    ]) {
      expect(() => worktreeDigest({ files: { [path]: file } })).toThrowError(
        expect.objectContaining({ code: "invalid-path", path }),
      );
    }
  });

  it("preserves the frozen content projection shape", () => {
    const state = {
      files: {
        "a.txt": {
          contentStreamId: "session-one",
          contentSha256: "0".repeat(64),
          size: 3,
          lastContentOffset: "0000000000000000_0000000000000001",
        },
      },
      dirs: { empty: {} },
      tombstones: {},
    };
    const changedSession = {
      ...state,
      files: { "a.txt": { ...state.files["a.txt"], contentStreamId: "session-two" } },
    };
    expect(worktreeDigest(state)).toBe(worktreeDigest(changedSession));
    expect(readWorktree(tempTree()).files["blob.bin"]?.size).toBe(6);
  });

  it("pins case-only behavior to the host filesystem", () => {
    const root = mkdtempSync(join(tmpdir(), "eforest-case-"));
    writeFileSync(join(root, "Case.txt"), "one");
    const one = worktreeDigestDirectory(root);
    try {
      writeFileSync(join(root, "case.txt"), "two");
    } catch {
      console.log(
        "CONDITIONAL-SKIP: case-collision reason=filesystem-cannot-construct-case-distinct-names",
      );
      return;
    }
    expect(worktreeDigestDirectory(root)).not.toBe(one);
  });

  it("reports a loud conditional marker for unreadable files only when root", () => {
    if (process.getuid?.() === 0) {
      console.log("CONDITIONAL-SKIP: unreadable-file reason=euid-0-can-read-mode-000");
      return;
    }
    const root = tempTree();
    const target = join(root, "unreadable.txt");
    writeFileSync(target, "private");
    chmodSync(target, 0o000);
    try {
      expect(() => worktreeDigestDirectory(root)).toThrowError(
        expect.objectContaining({ code: "unreadable", path: "unreadable.txt" }),
      );
    } finally {
      chmodSync(target, 0o600);
    }
  });
});
