import { createHash } from "node:crypto";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { describe, expect, it } from "vitest";
import {
  applyPatch,
  chooseWriteEvent,
  diffText,
  emptyFsWatchState,
  fsEventsToWatchEvents,
  isPatchOps,
  PatchError,
  type FsEvent,
} from "../src/index.js";

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);
const digest = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

describe("StreamFS domain model", () => {
  it("round-trips deterministic Unicode patches and enforces the canonical grammar", () => {
    const base = "zero 🌲 café\r\nlast\n";
    const target = "zero brave 🌲 café\nlast line\n";
    const first = diffText(base, target);
    expect(first).toEqual(diffText(base, target));
    expect(applyPatch(bytes(base), first)).toEqual(bytes(target));
    expect(isPatchOps([])).toBe(true);
    expect(
      isPatchOps([
        ["=", 1],
        ["=", 1],
      ]),
    ).toBe(false);
    expect(isPatchOps([["+", "\ud800"]])).toBe(false);
    expect(() => applyPatch(bytes("abc"), [["=", 2]])).toThrowError(PatchError);
  });

  it("chooses a patch only when its canonical wire form is smaller", () => {
    const base = bytes("a".repeat(240));
    const target = bytes(`${"a".repeat(239)}b`);
    const choice = chooseWriteEvent(base, target, "notes.txt");
    expect(choice.type).toBe("fs.file.patch");
    if (choice.type === "fs.file.patch") {
      expect(applyPatch(base, choice.payload.ops)).toEqual(target);
      expect(choice.payload.baseDigest).toBe(digest(base));
      expect(choice.payload.resultDigest).toBe(digest(target));
    }
    expect(chooseWriteEvent(new Uint8Array([0, 1]), new Uint8Array([0, 2]), "bin").type).toBe(
      "fs.file.write",
    );
  });

  it("maps repository events to stable watcher events without a server", () => {
    const events: FsEvent[] = [
      { type: "fs.dir.create", payload: { v: 2, path: "src" }, ts: 1 },
      {
        type: "fs.file.create",
        payload: { v: 2, path: "src/a.ts", contentStreamId: "content-a" },
        ts: 2,
      },
      {
        type: "fs.file.write",
        payload: {
          v: 2,
          path: "src/a.ts",
          base: "BASE_NONE",
          contentSha256: "0".repeat(64),
          size: 0,
        },
        ts: 3,
      },
      { type: "fs.rename", payload: { v: 2, from: "src", to: "lib" }, ts: 4 },
    ];
    const records = events.map((event, index) => ({ ...event, offset: offsetForOrdinal(index) }));
    const mapped = fsEventsToWatchEvents(records, emptyFsWatchState());
    expect(mapped.events.map(({ event, path }) => ({ event, path }))).toEqual([
      { event: "addDir", path: "src" },
      { event: "add", path: "src/a.ts" },
      { event: "change", path: "src/a.ts" },
      { event: "unlink", path: "src/a.ts" },
      { event: "unlinkDir", path: "src" },
      { event: "addDir", path: "lib" },
      { event: "add", path: "lib/a.ts" },
    ]);
  });
});
