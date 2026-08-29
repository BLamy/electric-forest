import { readFileSync } from "node:fs";
import { canonicalJson, stateDigest, type Event } from "@eforest/protocol";
import { describe, expect, it } from "vitest";
import {
  attachmentInitialStateForStream,
  attachmentReducer,
  contentInitialStateForStream,
  contentReducer,
} from "../src/index.js";

const evidenceDirectory = new URL(
  "../../../.eforest/tasks/epic-5-the-meadow/E5-T10-evidence-attachment-model/evidence/",
  import.meta.url,
);

function artifact(name: string): string {
  return readFileSync(new URL(name, evidenceDirectory), "utf8");
}

function events(name: string): readonly Event[] {
  const source = artifact(name);
  expect(source.endsWith("\n")).toBe(true);
  expect(source.includes("\r")).toBe(false);
  return source
    .slice(0, -1)
    .split("\n")
    .map((line) => {
      const parsed = JSON.parse(line) as Event;
      expect(canonicalJson(parsed)).toBe(line);
      return parsed;
    });
}

function expectedDigests(): ReadonlyMap<string, string> {
  return new Map(
    artifact("e5-t10-digests.txt")
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf(" ");
        return [line.slice(0, separator), line.slice(separator + 1)] as const;
      }),
  );
}

describe("committed E5-T10 replay goldens", () => {
  it("replays the attachment lifecycle to its frozen digest", () => {
    const name = "e5-t10-attachments.jsonl";
    const state = events(name).reduce(
      attachmentReducer,
      attachmentInitialStateForStream("evidence:maple/reading-room/issue/e5-t10-golden"),
    );
    const digest = stateDigest(state);
    if (process.env.EFOREST_E5_T10_PRINT === "1") {
      console.log(`E5_T10_DIGEST ${name} ${digest}`);
    }
    expect(digest).toBe(expectedDigests().get(name));
    expect(state.attachments).toHaveLength(2);
    expect(state.attachments[0]?.detachedAtOffset).toBe("0000000000000000_0000000000000002");
    expect(state.attachments[1]).toMatchObject({ type: "reference", kind: "replay-recording" });
  });

  it("replays the binary content to its frozen digest", () => {
    const name = "e5-t10-content.jsonl";
    const state = events(name).reduce(
      contentReducer,
      contentInitialStateForStream("evidence-content:maple/reading-room/issue-golden"),
    );
    const digest = stateDigest(state);
    if (process.env.EFOREST_E5_T10_PRINT === "1") {
      console.log(`E5_T10_DIGEST ${name} ${digest}`);
    }
    expect(digest).toBe(expectedDigests().get(name));
    expect(state).toMatchObject({ sealed: true, size: 802, chunks: 1 });
    expect(state).not.toHaveProperty("sealError");
  });

  it("keeps the first lying seal terminal in its frozen replay", () => {
    const name = "e5-t10-lying-seal.jsonl";
    const state = events(name).reduce(
      contentReducer,
      contentInitialStateForStream("evidence-content:maple/reading-room/lying-seal"),
    );
    const digest = stateDigest(state);
    if (process.env.EFOREST_E5_T10_PRINT === "1") {
      console.log(`E5_T10_DIGEST ${name} ${digest}`);
    }
    expect(digest).toBe(expectedDigests().get(name));
    expect(state).toMatchObject({
      sealed: false,
      sealError: "digest-mismatch",
      size: 3,
      chunks: 1,
      sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    });
  });
});
