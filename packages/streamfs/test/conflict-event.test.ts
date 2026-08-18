import { describe, expect, it } from "vitest";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { digestBytes, treeDigest } from "../src/index.js";
import { fsInitialState, fsReducer } from "../src/reducer.js";
import { isFsEvent } from "../src/events.js";

describe("sync/conflict event", () => {
  it("validates its frozen payload and leaves the fs tree unchanged", () => {
    const event = {
      type: "sync/conflict",
      payload: {
        v: 1,
        path: "docs/readme.md",
        conflictFile: "docs/readme.md.conflict-0002",
        winningOffset: "0002",
        loserSha256: digestBytes(new TextEncoder().encode("loser")),
      },
      ts: 1,
    } as const;
    expect(isFsEvent(event)).toBe(true);
    const before = fsInitialState;
    const after = fsReducer(before, event);
    expect(after).toEqual(before);
  });

  it("is tree-neutral at a dump boundary, not only by object equality", () => {
    const prefix = [
      {
        type: "fs.dir.create",
        payload: { v: 2, path: "docs" },
        ts: 0,
        offset: offsetForOrdinal(0),
      },
      {
        type: "fs.file.create",
        payload: {
          v: 2,
          path: "docs/readme.md",
          contentStreamId: "content-winner",
        },
        ts: 1,
        offset: offsetForOrdinal(1),
      },
    ] as const;
    const conflict = {
      type: "sync/conflict",
      payload: {
        v: 1,
        path: "docs/readme.md",
        conflictFile: "docs/readme.md.conflict-0002",
        winningOffset: "0002",
        loserSha256: digestBytes(new TextEncoder().encode("loser")),
      },
      ts: 2,
      offset: offsetForOrdinal(2),
    } as const;
    const before = prefix.reduce(fsReducer, fsInitialState);
    const after = [...prefix, conflict].reduce(fsReducer, fsInitialState);
    expect(treeDigest(after)).toBe(treeDigest(before));
  });
});
