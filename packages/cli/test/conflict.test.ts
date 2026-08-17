import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCollision, conflictFileName, surfaceConflict } from "../src/sync/conflict.js";

const ledger = {
  base: "0001",
  contentSha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  size: 5,
};

function event(
  type: string,
  payload: Record<string, unknown>,
  offset = "0000000000000000_0000000000000002",
) {
  return { type, payload, ts: 1, offset };
}

describe("conflict naming and preservation", () => {
  it("escapes hostile offset bytes without interpreting the offset", () => {
    expect(conflictFileName("docs/readme.md", "a/b c\n😀")).toBe(
      "docs/readme.md.conflict-a%2Fb%20c%0A%F0%9F%98%80",
    );
  });

  it("writes loser bytes durably and re-surfaces idempotently", () => {
    const root = mkdtempSync(join(tmpdir(), "eforest-conflict-"));
    try {
      const bytes = Uint8Array.from([0, 1, 2, 255]);
      const first = surfaceConflict({
        workspaceRoot: root,
        path: "src/data.bin",
        winningOffset: "opaque/7",
        loserBytes: bytes,
      });
      const second = surfaceConflict({
        workspaceRoot: root,
        path: "src/data.bin",
        winningOffset: "opaque/7",
        loserBytes: bytes,
      });
      expect(second).toEqual(first);
      expect(readFileSync(join(root, first.conflictFile))).toEqual(Buffer.from(bytes));
      expect(() =>
        surfaceConflict({
          workspaceRoot: root,
          path: "src/data.bin",
          winningOffset: "opaque/7",
          loserBytes: Uint8Array.from([9]),
        }),
      ).toThrow(/different bytes/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("collision rule table", () => {
  it("distinguishes every file collision and journal echo", () => {
    const write = (bytes: Uint8Array) =>
      event("fs.file.write", {
        v: 2,
        path: "a.txt",
        base: "0001",
        contentSha256: "a".repeat(64),
        size: bytes.byteLength,
      });
    expect(
      classifyCollision(write(Uint8Array.from([1])), ledger, Uint8Array.from([2])),
    ).toMatchObject({ kind: "content-vs-modify", preservesLoser: true });
    expect(
      classifyCollision(write(Uint8Array.from([1])), undefined, Uint8Array.from([2])),
    ).toMatchObject({ kind: "content-vs-add" });
    expect(
      classifyCollision(
        event("fs.file.delete", { v: 2, path: "a.txt" }),
        ledger,
        Uint8Array.from([2]),
      ),
    ).toMatchObject({ kind: "delete-vs-modify" });
    expect(
      classifyCollision(
        event("fs.file.delete", { v: 2, path: "a.txt" }),
        undefined,
        Uint8Array.from([2]),
      ),
    ).toMatchObject({ kind: "delete-vs-add" });
    expect(
      classifyCollision(event("fs.file.delete", { v: 2, path: "a.txt" }), ledger, undefined),
    ).toMatchObject({ kind: "delete-vs-delete", preservesLoser: false });
    expect(classifyCollision(write(Uint8Array.from([1])), ledger, undefined)).toMatchObject({
      kind: "content-vs-delete",
      preservesLoser: false,
    });
    expect(
      classifyCollision(
        event("fs.file.write", {
          v: 2,
          path: "a.txt",
          base: "0001",
          contentSha256: ledger.contentSha256,
          size: 5,
        }),
        ledger,
        Uint8Array.from([104, 101, 108, 108, 111]),
      ),
    ).toMatchObject({ kind: "equal-bytes" });
    expect(
      classifyCollision(write(Uint8Array.from([1])), ledger, Uint8Array.from([2]), {
        offsets: ["0000000000000000_0000000000000002"],
      }),
    ).toMatchObject({ kind: "echo" });
  });
});
