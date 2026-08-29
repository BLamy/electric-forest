import { describe, expect, it } from "vitest";
import type { Event } from "@eforest/protocol";
import {
  browserSha256,
  byteExactBlob,
  dispatchEvidenceUpload,
  replayLinkEvent,
  safeHttpsHref,
  textPreview,
} from "./model.js";

describe("evidence UI model", () => {
  it("recomputes SHA-256 with Web Crypto and preserves byte-exact blobs", async () => {
    const bytes = new TextEncoder().encode("abc\n");
    expect(await browserSha256(bytes)).toBe(
      "edeaaff3f1774ad2888673770c6d64097e391bc362d7d6fb34982ddf0efd18cb",
    );
    expect(new Uint8Array(await byteExactBlob(bytes, "text/plain").arrayBuffer())).toEqual(bytes);
    expect(textPreview(bytes)).toEqual({ text: "abc\n", truncated: false });
  });

  it("accepts only HTTPS links defensively without rewriting the href", () => {
    const href = "https://app.replay.io/recording/run-17?point=abc&time=12";
    expect(safeHttpsHref(href)).toBe(href);
    expect(safeHttpsHref("http://app.replay.io/recording/run-17")).toBeUndefined();
    expect(safeHttpsHref("javascript:alert(1)")).toBeUndefined();

    const event = replayLinkEvent({
      attachmentId: "replay-run-17",
      url: href,
      title: "Final walkthrough",
      now: () => 17,
    });
    expect(event.payload.url).toBe(href);
    expect(event.ts).toBe(17);
    expect(() =>
      replayLinkEvent({
        attachmentId: "replay-run-17",
        url: "http://app.replay.io/recording/run-17",
      }),
    ).toThrow("invalid Replay recording URL");
  });

  it("dispatches chunks, seal, then exactly one attachment event", async () => {
    const calls: { readonly streamId: string; readonly event: Event }[] = [];
    const bytes = new TextEncoder().encode("stream evidence\n");
    const result = await dispatchEvidenceUpload({
      upload: {
        entityRef: { org: "maple", repo: "reading-room", entityType: "issue", entityId: "17" },
        attachmentId: "run-17",
        kind: "event-log",
        name: "run.jsonl",
        mediaType: "application/x-ndjson",
        bytes,
      },
      contentDispatch: async (streamId, event) => {
        calls.push({ streamId, event });
      },
      parentDispatch: async (event) => {
        calls.push({ streamId: "evidence:maple/reading-room/issue/17", event });
      },
    });

    expect(calls.map(({ event }) => event.type)).toEqual([
      "content.chunk",
      "content.sealed",
      "evidence.attached",
    ]);
    expect(calls.filter(({ event }) => event.type === "evidence.attached")).toHaveLength(1);
    expect(calls.map(({ streamId }) => streamId)).toEqual([
      "evidence-content:maple/reading-room/run-17",
      "evidence-content:maple/reading-room/run-17",
      "evidence:maple/reading-room/issue/17",
    ]);
    expect(result.size).toBe(bytes.byteLength);
    expect(result.chunks).toBe(1);
  });

  it("does not attach metadata when content sealing is refused", async () => {
    const parentEvents: Event[] = [];
    await expect(
      dispatchEvidenceUpload({
        upload: {
          entityRef: { org: "maple", repo: "reading-room", entityType: "pr", entityId: "60" },
          attachmentId: "run-60",
          kind: "digest",
          name: "digest.txt",
          mediaType: "text/plain",
          bytes: new TextEncoder().encode("abc"),
        },
        contentDispatch: async (_streamId, event) => {
          if (event.type === "content.sealed") throw new Error("seal refused");
        },
        parentDispatch: async (event) => {
          parentEvents.push(event);
        },
      }),
    ).rejects.toThrow("seal refused");
    expect(parentEvents).toEqual([]);
  });

  it("seals and attaches an empty file without inventing a chunk", async () => {
    const calls: Event[] = [];
    const result = await dispatchEvidenceUpload({
      upload: {
        entityRef: { org: "maple", repo: "reading-room", entityType: "issue", entityId: "empty" },
        attachmentId: "empty-file",
        kind: "digest",
        name: "empty.txt",
        mediaType: "text/plain",
        bytes: new Uint8Array(),
      },
      contentDispatch: async (_streamId, event) => {
        calls.push(event);
      },
      parentDispatch: async (event) => {
        calls.push(event);
      },
    });

    expect(calls.map(({ type }) => type)).toEqual(["content.sealed", "evidence.attached"]);
    expect(result).toMatchObject({ size: 0, chunks: 0 });
  });
});
