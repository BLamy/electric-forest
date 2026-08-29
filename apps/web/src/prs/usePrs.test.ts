import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { reduceMeadowPrEvents } from "@eforest/meadow";
import { computeSinceForkDiff, prDiffDigest } from "@eforest/pr";
import { OFFSET_BEFORE_FIRST, type Event, type Offset } from "@eforest/protocol";
import { digestBytes, sortedTree, withContentMap, type FsTree } from "@eforest/streamfs";
import type { ApplicationRecord } from "@eforest/web-hooks";
import { ConflictPanel } from "./PrDetail.js";
import { branchNameFromStream, openedEvent } from "./model.js";
import { threadPrTimeline } from "./timeline.js";
import { computePrDetailDiff } from "./usePrs.js";

const root = resolve(import.meta.dirname, "../../../..");

function tree(files: Readonly<Record<string, string>>): FsTree {
  const encoder = new TextEncoder();
  const contents = new Map<string, Uint8Array>();
  const metadata: Record<
    string,
    { contentStreamId: string; contentSha256: string; size: number; lastContentOffset: string }
  > = {};
  for (const [path, text] of Object.entries(files)) {
    const bytes = encoder.encode(text);
    const streamId = `content:${path}`;
    contents.set(streamId, bytes);
    metadata[path] = {
      contentStreamId: streamId,
      contentSha256: digestBytes(bytes),
      size: bytes.byteLength,
      lastContentOffset: "0000000000000000_0000000000000000",
    };
  }
  return withContentMap(sortedTree(metadata), contents);
}

function jsonlEvents(path: string): readonly Event[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Event);
}

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

  it("publishes the canonical diff digest from the frozen base and live source", () => {
    const base = tree({ "README.md": "frozen base\n" });
    const afterSourcePush = tree({
      "README.md": "frozen base\n",
      "src/pushed.ts": "export const live = true;\n",
    });
    const expectedDiff = computeSinceForkDiff(base, afterSourcePush);
    const published = computePrDetailDiff(
      "0000000000000000_0000000000000000",
      base,
      afterSourcePush,
    );

    expect(published.diff).toEqual(expectedDiff);
    expect(published.diffDigest).toBe(prDiffDigest(expectedDiff));
    expect(published.diff.files.map(({ path, status }) => [path, status])).toEqual([
      ["src/pushed.ts", "added"],
    ]);
    expect(computePrDetailDiff(OFFSET_BEFORE_FIRST, base, afterSourcePush).diff.files).toEqual([]);
  });

  it("renders the verified T06 conflicted payload without merged styling", () => {
    const path = resolve(
      root,
      ".eforest/tasks/epic-5-the-meadow/E5-T06-pr-merge-execution/evidence/streams/conflict-pr-after.jsonl",
    );
    const state = reduceMeadowPrEvents("pr:maple/conflict-proof/7", jsonlEvents(path));
    const markup = renderToStaticMarkup(createElement(ConflictPanel, { state }));

    expect(state.status).toBe("conflicted");
    expect(markup).toContain('data-target-merge-offset="0000000000000000_0000000000000002"');
    expect(markup).toContain("same.txt");
    expect(markup).toContain("add-add");
    expect(markup).toContain("The target branch is unchanged");
    expect(markup).not.toContain("Merged");
  });
});
