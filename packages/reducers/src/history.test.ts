import { OFFSET_BEFORE_FIRST } from "@eforest/protocol";
import { describe, expect, it } from "vitest";
import { historyInitialState, historyReducer } from "./history.js";

describe("history reducer", () => {
  it("normalizes missing platform metadata without losing the event", () => {
    const state = historyReducer(historyInitialState, {
      type: "future.event",
      payload: { v: 99, path: "legacy.txt" },
      ts: 1,
    });

    expect(state.records).toEqual([
      {
        offset: OFFSET_BEFORE_FIRST,
        type: "future.event",
        payload: { v: 99, path: "legacy.txt" },
        ts: 1,
        sourceStreamId: "unknown-stream",
        actor: "unknown-actor",
      },
    ]);
  });
});
