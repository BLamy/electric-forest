import { describe, expect, it } from "vitest";
import type { Offset } from "@eforest/protocol";
import type { ApplicationRecord } from "@eforest/web-hooks";
import { branchNameFromStream, openedEvent } from "./model.js";
import { threadPrTimeline } from "./timeline.js";

function record(offset: string, type: string, payload: Record<string, unknown>): ApplicationRecord {
  return { offset: offset as Offset, type, payload, ts: 1 };
}

describe("pull-request web binding", () => {
  it("separates metadata stream provenance from URL branch names", () => {
    expect(branchNameFromStream("fs:maple/reading-room:feature-ui:meta")).toBe("feature-ui");
  });

  it("dispatches full branch stream identities and structured issue refs", () => {
    const event = openedEvent({
      org: "maple",
      repo: "reading-room",
      sourceBranch: "fs:maple/reading-room:feature-ui:meta",
      targetBranch: "fs:maple/reading-room:main:meta",
      forkOffset: "0000000000000000_0000000000000004",
      title: "Live pull requests",
      body: "Render the review surface.",
      author: "reviewer@example.com",
      closes: ["issue-42"],
    });

    expect(event.payload).toMatchObject({
      sourceBranch: "fs:maple/reading-room:feature-ui:meta",
      targetBranch: "fs:maple/reading-room:main:meta",
      closes: [{ entity: "issue", stream: "issue:maple/reading-room/issue-42" }],
    });
  });

  it("threads review replies by durable root offset without hiding dangling events", () => {
    const timeline = threadPrTimeline([
      record("0001", "pr.review-comment", { v: 2, author: "a", body: "root" }),
      record("0002", "pr.approved", { v: 1, reviewer: "b" }),
      record("0003", "pr.review-comment", {
        v: 2,
        author: "c",
        body: "reply",
        replyTo: "0001",
      }),
      record("0004", "pr.review-comment", {
        v: 2,
        author: "d",
        body: "deep reply",
        replyTo: "0003",
      }),
      record("0005", "pr.review-comment", {
        v: 2,
        author: "e",
        body: "dangling",
        replyTo: "9999",
      }),
    ]);

    expect(timeline.map((node) => node.record.offset)).toEqual(["0001", "0002", "0005"]);
    expect(timeline[0]?.replies.map((node) => node.record.offset)).toEqual(["0003"]);
    expect(timeline[0]?.replies[0]?.replies.map((node) => node.record.offset)).toEqual(["0004"]);
  });
});
