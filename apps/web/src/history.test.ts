import type { HistoryApplicationRecord } from "@eforest/reducers";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { describe, expect, it } from "vitest";
import { humanizeRecord } from "./history.js";

describe("history conflict events", () => {
  it("renders sync/conflict as a known citable history row", () => {
    const record: HistoryApplicationRecord = {
      offset: offsetForOrdinal(7),
      sourceStreamId: "fs:org/repo:main:meta",
      actor: "local-writer",
      type: "sync/conflict",
      payload: {
        v: 1,
        path: "docs/readme.md",
        conflictFile: "docs/readme.md.conflict-0007",
        winningOffset: "0000000000000000_0000000000000006",
        loserSha256: "a".repeat(64),
      },
      ts: 1,
    };
    expect(humanizeRecord(record)).toMatchObject({
      known: true,
      kind: "sync/conflict",
      summary: "preserved local conflict for docs/readme.md as docs/readme.md.conflict-0007",
    });
  });
});
