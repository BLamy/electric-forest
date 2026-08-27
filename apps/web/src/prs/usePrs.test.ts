import { describe, expect, it } from "vitest";
import { branchNameFromStream, openedEvent } from "./model.js";

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
});
