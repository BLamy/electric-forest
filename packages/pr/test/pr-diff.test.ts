import { describe, expect, it } from "vitest";
import { digestBytes, sortedTree, withContentMap, type FsTree } from "@eforest/streamfs";
import { computeSinceForkDiff, prDiffDigest } from "../src/index.js";

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

describe("computeSinceForkDiff", () => {
  it("is canonical, pure, and empty for equal trees", () => {
    const input = tree({ "README.md": "hello\n" });
    const first = computeSinceForkDiff(input, input);
    const second = computeSinceForkDiff(input, input);
    expect(first).toEqual({ files: [] });
    expect(second).toEqual(first);
    expect(prDiffDigest(second)).toBe(prDiffDigest(first));
  });

  it("sorts unicode paths and records add, remove, and modify hunks", () => {
    const base = tree({ "z-old.txt": "gone\n", "docs/é.md": "one\ntwo\n" });
    const source = tree({ "a-new.txt": "new\n", "docs/é.md": "one\nthree\n" });
    const diff = computeSinceForkDiff(base, source);
    expect(diff.files.map(({ path, status }) => [path, status])).toEqual([
      ["a-new.txt", "added"],
      ["docs/é.md", "modified"],
      ["z-old.txt", "removed"],
    ]);
    expect(diff.files[1]!.hunks[0]!.lines.map((line) => line.kind)).toEqual([
      "context",
      "deletion",
      "addition",
    ]);
    expect(prDiffDigest(diff)).toMatch(/^[a-f0-9]{64}$/);
  });
});
