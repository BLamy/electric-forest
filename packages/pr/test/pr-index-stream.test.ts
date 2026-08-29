import { describe, expect, it } from "vitest";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import type { Event } from "@eforest/protocol";
import {
  derivePrIndex,
  prIndexInitialState,
  prIndexReducer,
  prIndexReplacementEvent,
  repoPrIndexStreamId,
} from "../src/index.js";

function event(type: string, payload: Record<string, unknown>, ordinal: number): Event {
  return { type, payload, ts: ordinal, offset: offsetForOrdinal(ordinal) } as Event;
}

function opened(title: string): Event {
  return event(
    "pr.opened",
    {
      v: 1,
      sourceBranch: "feature",
      targetBranch: "main",
      forkOffset: offsetForOrdinal(0),
      title,
      body: "body",
      author: "alice",
    },
    0,
  );
}

describe("PR index stream", () => {
  it("derives canonical rows and rebuilds from the same logs", () => {
    const logs = [
      {
        prStream: "pr:maple/reading-room/7",
        events: [opened("Seven"), event("pr.approved", { v: 1, reviewer: "bob" }, 1)],
      },
      { prStream: "pr:maple/reading-room/4", events: [opened("Four")] },
    ];
    const first = derivePrIndex(logs);
    const rebuilt = derivePrIndex(logs.map((log) => ({ ...log, events: [...log.events] })));
    expect(rebuilt).toEqual(first);
    expect(first.rows.map((row) => [row.prId, row.status])).toEqual([
      ["7", "approved"],
      ["4", "open"],
    ]);
    expect(repoPrIndexStreamId("maple", "reading-room")).toBe("pr-index:maple/reading-room");
    expect(prIndexReducer(prIndexInitialState, prIndexReplacementEvent(first, 1))).toEqual(first);
  });

  it("keeps a conflicted PR conflicted while comments continue", () => {
    const state = derivePrIndex([
      {
        prStream: "pr:maple/reading-room/9",
        events: [
          opened("Conflict"),
          event("pr.approved", { v: 1, reviewer: "bob" }, 1),
          event(
            "pr.merge-conflicted",
            {
              v: 1,
              targetMergeOffset: offsetForOrdinal(1),
              conflicts: [{ path: "src/a.ts", kind: "edit-edit" }],
            },
            2,
          ),
          event("pr.review-comment", { v: 2, author: "bob", body: "Resolve it" }, 3),
        ],
      },
    ]);
    expect(state.rows[0]?.status).toBe("conflicted");
  });
});
