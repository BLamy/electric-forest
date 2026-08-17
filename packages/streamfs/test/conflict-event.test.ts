import { describe, expect, it } from "vitest";
import { digestBytes } from "../src/index.js";
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
});
