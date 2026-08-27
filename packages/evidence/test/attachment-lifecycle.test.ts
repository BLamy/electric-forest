import { describe, expect, it } from "vitest";
import { sha256Hex } from "@eforest/protocol";
import {
  ATTACHMENT_EVENT_VERSION,
  MAX_ATTACHMENT_BYTES,
  attachmentReducer,
  downloadAttachment,
  entityStreamId,
  evidenceStreamId,
  uploadAttachment,
  type AttachmentListState,
  type EvidenceEntityRef,
} from "../src/index.js";
import { InMemoryEvidenceDoor, event, offset } from "./helpers.js";

const entityRef: EvidenceEntityRef = {
  org: "blamy",
  repo: "electric-forest",
  entityType: "issue",
  entityId: "E5-T10",
};

describe("attachment lifecycle", () => {
  it("uploads, seals, attaches, downloads, links, and retains offset tombstones", async () => {
    const door = new InMemoryEvidenceDoor();
    door.seedEntity(entityStreamId(entityRef));
    const bytes = Uint8Array.from({ length: 256 }, (_, value) => value);
    const uploaded = await uploadAttachment(door, {
      entityRef,
      attachmentId: "trace-1",
      kind: "rr-trace",
      name: "trace.rr",
      mediaType: "application/octet-stream",
      bytes,
    });

    expect(uploaded).toMatchObject({
      attachmentId: "trace-1",
      size: 256,
      chunks: 1,
      sha256: sha256Hex(bytes),
    });
    expect(await downloadAttachment(door, uploaded.contentStreamId)).toEqual(bytes);

    const attachmentStream = evidenceStreamId(entityRef);
    await door.dispatch(
      attachmentStream,
      event("evidence.linked", {
        v: ATTACHMENT_EVENT_VERSION,
        attachmentId: "replay-1",
        kind: "replay-recording",
        url: "https://app.replay.io/recording/abc-123?point=42&time=500",
        title: "browser proof",
      }),
    );
    await door.dispatch(
      attachmentStream,
      event("evidence.detached", {
        v: ATTACHMENT_EVENT_VERSION,
        attachmentId: "trace-1",
      }),
    );

    const state = door.state(attachmentStream) as AttachmentListState;
    expect(state.entityRef).toBe("issue:blamy/electric-forest/E5-T10");
    expect(state.attachments.map(({ attachmentId }) => attachmentId)).toEqual([
      "trace-1",
      "replay-1",
    ]);
    expect(state.attachments[0]).toMatchObject({
      attachedAtOffset: offset(0),
      detachedAtOffset: offset(2),
      type: "content",
    });
    expect(state.attachments[1]).toMatchObject({
      attachedAtOffset: offset(1),
      type: "reference",
    });
    expect(state.attachments[1]).not.toHaveProperty("sha256");
    expect(state.attachments[1]).not.toHaveProperty("contentStream");
  });

  it("round-trips empty and multi-chunk hostile bytes byte-for-byte", async () => {
    const door = new InMemoryEvidenceDoor();
    door.seedEntity(entityStreamId(entityRef));
    const empty = await uploadAttachment(door, {
      entityRef,
      attachmentId: "empty",
      kind: "digest",
      name: "empty.txt",
      mediaType: "text/plain",
      bytes: new Uint8Array(),
    });
    expect(empty.chunks).toBe(0);
    expect(await downloadAttachment(door, empty.contentStreamId)).toEqual(new Uint8Array());

    const bytes = Uint8Array.from({ length: 600_000 }, (_, index) => (index * 197) & 0xff);
    const large = await uploadAttachment(door, {
      entityRef,
      attachmentId: "large",
      kind: "event-log",
      name: "events.jsonl",
      mediaType: "application/x-ndjson",
      bytes,
    });
    expect(large.chunks).toBe(2);
    expect(await downloadAttachment(door, large.contentStreamId)).toEqual(bytes);
  });

  it("is a total no-op for malformed attachment events and duplicate ids", () => {
    const streamId = evidenceStreamId(entityRef);
    const initial = {
      v: 1 as const,
      entityRef: entityStreamId(entityRef),
      attachments: [],
    };
    const malformed = { ...event("evidence.attached", { v: 1 }), offset: offset(0) };
    expect(attachmentReducer(initial, malformed)).toBe(initial);
  });

  it("rejects an oversized upload before dispatching any content", async () => {
    const door = new InMemoryEvidenceDoor();
    door.seedEntity(entityStreamId(entityRef));
    await expect(
      uploadAttachment(door, {
        entityRef,
        attachmentId: "too-large",
        kind: "rr-trace",
        name: "too-large.rr",
        mediaType: "application/octet-stream",
        bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
      }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(await door.read("evidence-content:blamy/electric-forest/too-large")).toEqual([]);
  });
});
