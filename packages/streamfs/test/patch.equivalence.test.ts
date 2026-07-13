import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson, replay, stateDigest } from "@eforest/protocol";
import { describe, expect, it } from "vitest";
import { emptyTree, fsReducer } from "../src/index.js";

interface FixtureEvent {
  readonly offset: string;
  readonly payload: Record<string, unknown>;
  readonly ts: number;
  readonly type: string;
}

function load(path: string): readonly FixtureEvent[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as FixtureEvent);
}

function wireBytes(events: readonly FixtureEvent[]): number {
  return events.reduce(
    (total, event) =>
      total +
      (event.type === "fs.file.content"
        ? Buffer.from(String(event.payload.contentBase64), "base64").byteLength
        : Buffer.byteLength(canonicalJson(event.payload))),
    0,
  );
}

describe("committed patch/full-write parity", () => {
  it("folds every combined fixture to the same canonical tree digest", () => {
    const root = resolve("packages/streamfs/fixtures/patches");
    for (const name of readdirSync(root).sort()) {
      const fixture = resolve(root, name);
      const expected = JSON.parse(readFileSync(resolve(fixture, "expected.json"), "utf8")) as {
        readonly treeDigest: string;
        readonly patchedWireBytes: number;
        readonly fullwriteWireBytes: number;
      };
      const patched = load(resolve(fixture, "patched.events.jsonl"));
      const fullwrite = load(resolve(fixture, "fullwrite.events.jsonl"));
      const patchDigest = stateDigest(replay(patched, fsReducer, emptyTree()));
      const fullDigest = stateDigest(replay(fullwrite, fsReducer, emptyTree()));
      expect(patchDigest).toBe(expected.treeDigest);
      expect(fullDigest).toBe(expected.treeDigest);
      expect(wireBytes(patched)).toBe(expected.patchedWireBytes);
      expect(wireBytes(fullwrite)).toBe(expected.fullwriteWireBytes);
      expect(expected.patchedWireBytes).toBeLessThan(expected.fullwriteWireBytes);
    }
  });
});
