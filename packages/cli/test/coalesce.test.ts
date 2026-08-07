import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BASE_NONE } from "@eforest/workspace";
import { coalesce, isExcludedUplinkPath, type PendingFsEvent } from "../src/sync/coalesce.js";

const base = {
  files: {
    "existing.txt": {
      base: "0000000000000000_0000000000000010",
      contentSha256: "a".repeat(64),
      size: 1,
    },
    "old/name.txt": {
      base: "0000000000000000_0000000000000011",
      contentSha256: "b".repeat(64),
      size: 1,
    },
  },
  directories: ["old"],
};

function event(kind: PendingFsEvent["kind"], path: string): PendingFsEvent {
  return { kind, path };
}

describe("E4-T06 uplink coalescer", () => {
  it("coalesces rapid writes and keeps the ledger base", () => {
    expect(
      coalesce(
        [
          event("change", "existing.txt"),
          event("change", "existing.txt"),
          event("change", "existing.txt"),
        ],
        base,
      ),
    ).toEqual([{ kind: "write", path: "existing.txt", base: base.files["existing.txt"]!.base }]);
  });

  it("drops a create-then-delete flap with no stream history", () => {
    expect(coalesce([event("add", "flap.txt"), event("unlink", "flap.txt")], base)).toEqual([]);
  });

  it("represents a local rename as delete followed by create and full write", () => {
    const plan = coalesce([event("unlink", "old/name.txt"), event("add", "new/name.txt")], base);
    expect(plan).toEqual([
      { kind: "delete", path: "old/name.txt", base: base.files["old/name.txt"]!.base },
      { kind: "create", path: "new/name.txt", base: BASE_NONE },
      { kind: "write", path: "new/name.txt", base: BASE_NONE },
    ]);
  });

  it("orders directories before files and excludes only the pinned temporary names", () => {
    expect(
      coalesce(
        [
          event("add", "dir/z.txt"),
          event("addDir", "dir"),
          event("add", ".ef/journal.jsonl"),
          event("add", "notes.txt~"),
          event("add", "real.tmpx"),
        ],
        { files: {} },
      ),
    ).toEqual([
      { kind: "mkdir", path: "dir", base: BASE_NONE },
      { kind: "create", path: "dir/z.txt", base: BASE_NONE },
      { kind: "create", path: "real.tmpx", base: BASE_NONE },
      { kind: "write", path: "dir/z.txt", base: BASE_NONE },
      { kind: "write", path: "real.tmpx", base: BASE_NONE },
    ]);
    expect(isExcludedUplinkPath("real.tmpx")).toBe(false);
    expect(isExcludedUplinkPath(".ef/workspace.json")).toBe(true);
  });

  it("is stable for the committed randomized seed", () => {
    const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "eforest-e4-t06-coalesce-"));
    try {
      const seed = 0xe406;
      let value = seed;
      const events: PendingFsEvent[] = [];
      for (let index = 0; index < 128; index += 1) {
        value = (value * 1_664_525 + 1_013_904_223) >>> 0;
        const path = `generated/${String(value % 17)}.txt`;
        const kinds: PendingFsEvent["kind"][] = ["add", "change", "change", "unlink"];
        events.push(event(kinds[value % kinds.length]!, path));
      }
      const serialized = JSON.stringify(coalesce(events, { files: {} }));
      const finalEvents = new Map<string, PendingFsEvent>();
      for (const candidate of events) finalEvents.set(candidate.path, candidate);
      const expectedFiles = new Set<string>();
      for (const [path, candidate] of finalEvents) {
        if (candidate.kind !== "unlink") expectedFiles.add(path);
      }
      const appliedFiles = new Set<string>();
      for (const entry of coalesce(events, { files: {} })) {
        if (entry.kind === "create" || entry.kind === "write") appliedFiles.add(entry.path);
        if (entry.kind === "delete") appliedFiles.delete(entry.path);
      }
      expect([...appliedFiles].sort()).toEqual([...expectedFiles].sort());
      const path = join(scratch, "seed.json");
      writeFileSync(path, `${serialized}\n`);
      expect(readFileSync(path, "utf8")).toBe(`${serialized}\n`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
