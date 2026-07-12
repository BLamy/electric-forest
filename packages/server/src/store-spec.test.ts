import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareOffsets, type Event, type Offset } from "@eforest/protocol";
import { describe, expect, it } from "vitest";
import { FileStreamStore } from "./store/file.js";
import { MemoryStreamStore } from "./store/memory.js";
import type { StreamStore } from "./store/types.js";

interface StoreHarness {
  readonly store: StreamStore;
  readonly cleanup: () => void;
}

type StoreFactory = () => StoreHarness;

const factories: readonly [string, StoreFactory][] = [
  ["memory", () => ({ store: new MemoryStreamStore(), cleanup: () => undefined })],
  [
    "file",
    () => {
      const dataDir = mkdtempSync(join(tmpdir(), "eforest-store-spec-"));
      return {
        store: new FileStreamStore(dataDir),
        cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
      };
    },
  ],
];

describe.each(factories)("shared StreamStore contract: %s", (_name, makeHarness) => {
  it("creates idempotently, fences appends, and reads exact suffixes", () => {
    const { store, cleanup } = makeHarness();
    try {
      expect(store.create("alpha", { version: 1 })).toEqual({
        created: true,
        head: "-1",
        sequence: -1,
      });
      expect(store.create("alpha", { version: 1 })).toEqual({
        created: false,
        head: "-1",
        sequence: -1,
      });
      expect(() => store.create("alpha", { version: 2 })).toThrow(/different configuration/);

      const events: readonly Event[] = [
        { type: "set", payload: 3, ts: 1 },
        { type: "push", payload: "tail", ts: 2 },
      ];
      const appended = store.append("alpha", events, 0);
      expect(appended.records).toHaveLength(2);
      expect(appended.head).toBe(appended.records[1]!.offset);
      expect(store.sequence("alpha")).toBe(0);
      expect(() => store.append("alpha", [{ type: "set", payload: 4, ts: 3 }], 0)).toThrow(
        /sequence 0 is current/,
      );
      expect(store.read("alpha", "-1" as Offset)).toEqual(appended.records);
      expect(store.read("alpha", appended.records[0]!.offset)).toEqual([appended.records[1]]);
      expect(store.read("alpha", appended.head)).toEqual([]);
      expect(compareOffsets(appended.records[0]!.offset, appended.records[1]!.offset)).toBeLessThan(
        0,
      );
      expect(store.dump("alpha")).toEqual(appended.records);
    } finally {
      cleanup();
    }
  });

  it("notifies live readers only after an accepted append", () => {
    const { store, cleanup } = makeHarness();
    try {
      store.create("live", {});
      const notifications: string[] = [];
      const unsubscribe = store.subscribe("live", (result) => {
        notifications.push(result.records.at(-1)!.offset);
      });
      store.append("live", [{ type: "set", payload: 1, ts: 1 }], 0);
      expect(notifications).toHaveLength(1);
      expect(() => store.append("live", [{ type: "set", payload: 2, ts: 2 }], 0)).toThrow(
        /sequence 0 is current/,
      );
      expect(notifications).toHaveLength(1);
      unsubscribe();
      store.append("live", [{ type: "set", payload: 3, ts: 3 }], 1);
      expect(notifications).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});
