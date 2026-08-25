import { describe, expect, it } from "vitest";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import type { Event } from "@eforest/protocol";
import { ISSUE_CATALOG_EVENT, isIssueCatalogEvent } from "../src/index.js";

function catalogEvent(sourceOffset: unknown): Event {
  return {
    type: ISSUE_CATALOG_EVENT,
    payload: {
      v: 1,
      issueStreamId: "issue:maple/reading-room/i-1",
      sourceOffset,
    },
    ts: 1,
  };
}

describe("issue catalog event validation", () => {
  it("accepts an allocated source offset and rejects malformed or sentinel values", () => {
    expect(isIssueCatalogEvent(catalogEvent(offsetForOrdinal(0)))).toBe(true);
    for (const sourceOffset of ["", "garbage", "0_", "_0", "1_2_3", "-1", 0, null]) {
      expect(isIssueCatalogEvent(catalogEvent(sourceOffset)), String(sourceOffset)).toBe(false);
    }
  });
});
