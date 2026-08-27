import { describe, expect, it } from "vitest";
import { sha256Hex, type Event } from "@eforest/protocol";
import {
  ATTACHMENT_EVENT_VERSION,
  EVIDENCE_REFUSAL_REASONS,
  EvidenceRefusalError,
  EvidenceSchemaError,
  EvidenceUnknownActionError,
  MAX_CHUNK_BYTES,
  attachmentInitialStateForStream,
  contentInitialStateForStream,
  contentReducer,
  decodeCanonicalBase64,
  encodeCanonicalBase64,
  entityStreamId,
  evidenceActionValidators,
  evidenceContentStreamId,
  evidenceStreamId,
  isEvidenceActionType,
  isEvidenceContentActionType,
  isEvidenceContentStreamId,
  isEvidenceStreamId,
  parseEvidenceContentStreamId,
  parseEvidenceStreamIdentity,
  parseEvidenceStreamId,
  validateEvidenceAction,
  type AttachmentListState,
  type ContentState,
  type EvidenceActionValidationContext,
  type EvidenceEntityRef,
} from "../src/index.js";
import { InMemoryEvidenceDoor, event, offset } from "./helpers.js";

const ref: EvidenceEntityRef = {
  org: "blamy",
  repo: "electric-forest",
  entityType: "pr",
  entityId: "60",
};

function context(
  streamId: string,
  state: AttachmentListState | ContentState,
  records: readonly Event[] = [],
  resolved = new Map<string, readonly Event[]>(),
): EvidenceActionValidationContext {
  return {
    streamId,
    state,
    records,
    headOffset: records.length === 0 ? ("-1" as never) : offset(records.length - 1),
    nextOffset: offset(records.length),
    resolveStream: async (target) => {
      const found = resolved.get(target);
      return found === undefined ? undefined : { records: found };
    },
  };
}

async function expectReason(promise: Promise<unknown>, reason: string): Promise<void> {
  await expect(promise).rejects.toEqual(expect.objectContaining({ reason }));
}

describe("gateway helpers and schemas", () => {
  it("exposes stream parsers, stream guards, action guards, and one validator per action", () => {
    const attachment = evidenceStreamId(ref);
    const content = evidenceContentStreamId(ref.org, ref.repo, "artifact-1");
    expect(parseEvidenceStreamId(attachment)).toEqual(ref);
    expect(parseEvidenceContentStreamId(content)).toEqual({
      org: ref.org,
      repo: ref.repo,
      attachmentId: "artifact-1",
    });
    expect(isEvidenceStreamId(attachment)).toBe(true);
    expect(isEvidenceContentStreamId(content)).toBe(true);
    expect(isEvidenceActionType("evidence.waived")).toBe(true);
    expect(isEvidenceContentActionType("content.sealed")).toBe(true);
    expect(evidenceActionValidators.map(({ actionType }) => actionType)).toEqual([
      "evidence.attached",
      "evidence.linked",
      "evidence.waived",
      "evidence.detached",
      "content.chunk",
      "content.sealed",
    ]);
  });

  it("pins path-safe ids and canonical base64", () => {
    expect(() => evidenceContentStreamId("blamy", "repo", "../escape")).toThrow(TypeError);
    expect(() => evidenceStreamId({ ...ref, entityId: "bad/id" })).toThrow(TypeError);
    expect(parseEvidenceStreamId("evidence:blamy/repo/wiki/home")).toBeUndefined();
    expect(parseEvidenceStreamIdentity("evidence:blamy/repo/wiki/home")).toEqual({
      org: "blamy",
      repo: "repo",
      entityType: "wiki",
      entityId: "home",
    });
    expect(isEvidenceStreamId("evidence:blamy/repo/wiki/home")).toBe(false);
    expect(decodeCanonicalBase64("AQID")).toEqual(Uint8Array.of(1, 2, 3));
    for (const invalid of ["AQID\n", "AQID ", "AQI", "AQI===", "-_=="]) {
      expect(decodeCanonicalBase64(invalid)).toBeUndefined();
    }
    const allBytes = Uint8Array.from({ length: 256 }, (_, value) => value);
    expect(decodeCanonicalBase64(encodeCanonicalBase64(allBytes))).toEqual(allBytes);
  });

  it("classifies malformed known actions as schema violations", async () => {
    const streamId = evidenceContentStreamId("blamy", "repo", "x");
    await expect(
      validateEvidenceAction(
        event("content.chunk", { v: 1, seq: 0, bytes: "not-base64" }),
        context(streamId, contentInitialStateForStream(streamId)),
      ),
    ).rejects.toBeInstanceOf(EvidenceSchemaError);
  });

  it("classifies unknown actions separately", async () => {
    const streamId = evidenceContentStreamId("blamy", "repo", "x");
    await expect(
      validateEvidenceAction(
        event("content.surprise", { v: 1 }),
        context(streamId, contentInitialStateForStream(streamId)),
      ),
    ).rejects.toBeInstanceOf(EvidenceUnknownActionError);
  });
});

describe("semantic refusal reasons", () => {
  it("freezes all fourteen reasons", () => {
    expect(EVIDENCE_REFUSAL_REASONS).toHaveLength(14);
    expect(new Set(EVIDENCE_REFUSAL_REASONS).size).toBe(14);
  });

  it("refuses unknown entity types and missing entities", async () => {
    const unknownType = "evidence:blamy/electric-forest/wiki/home";
    await expectReason(
      validateEvidenceAction(
        event("evidence.waived", { v: 1, justification: "server-only proof" }),
        context(unknownType, { v: 1, entityRef: "", attachments: [] }),
      ),
      "evidence/unknown-entity-type",
    );
    const streamId = evidenceStreamId(ref);
    await expectReason(
      validateEvidenceAction(
        event("evidence.waived", { v: 1, justification: "server-only proof" }),
        context(streamId, attachmentInitialStateForStream(streamId)),
      ),
      "evidence/unknown-entity",
    );
  });

  it("refuses chunk order, oversize chunks, lying seals, and post-seal events", async () => {
    const streamId = evidenceContentStreamId("blamy", "electric-forest", "blob");
    const initial = contentInitialStateForStream(streamId);
    const one = Uint8Array.of(1);
    await expectReason(
      validateEvidenceAction(
        event("content.chunk", {
          v: 1,
          seq: 1,
          bytes: encodeCanonicalBase64(one),
        }),
        context(streamId, initial),
      ),
      "evidence/chunk-out-of-order",
    );
    await expectReason(
      validateEvidenceAction(
        event("content.chunk", {
          v: 1,
          seq: 0,
          bytes: encodeCanonicalBase64(new Uint8Array(MAX_CHUNK_BYTES + 1)),
        }),
        context(streamId, initial),
      ),
      "evidence/oversized",
    );

    const chunk = event("content.chunk", {
      v: 1,
      seq: 0,
      bytes: encodeCanonicalBase64(one),
    });
    const chunked = contentReducer(initial, chunk);
    await expectReason(
      validateEvidenceAction(
        event("content.sealed", { v: 1, sha256: sha256Hex(one), size: 2, chunks: 1 }),
        context(streamId, chunked, [chunk]),
      ),
      "evidence/size-mismatch",
    );
    await expectReason(
      validateEvidenceAction(
        event("content.sealed", { v: 1, sha256: "0".repeat(64), size: 1, chunks: 1 }),
        context(streamId, chunked, [chunk]),
      ),
      "evidence/digest-mismatch",
    );
    const sealed = contentReducer(
      chunked,
      event("content.sealed", { v: 1, sha256: sha256Hex(one), size: 1, chunks: 1 }),
    );
    await expectReason(
      validateEvidenceAction(chunk, context(streamId, sealed)),
      "evidence/sealed-terminal",
    );
  });

  it("accepts exactly 512 KiB and refuses one byte more", async () => {
    const streamId = evidenceContentStreamId("blamy", "electric-forest", "boundary");
    const initial = contentInitialStateForStream(streamId);
    await expect(
      validateEvidenceAction(
        event("content.chunk", {
          v: 1,
          seq: 0,
          bytes: encodeCanonicalBase64(new Uint8Array(MAX_CHUNK_BYTES)),
        }),
        context(streamId, initial),
      ),
    ).resolves.toBeUndefined();
    await expectReason(
      validateEvidenceAction(
        event("content.chunk", {
          v: 1,
          seq: 0,
          bytes: encodeCanonicalBase64(new Uint8Array(MAX_CHUNK_BYTES + 1)),
        }),
        context(streamId, initial),
      ),
      "evidence/oversized",
    );
  });

  it("refuses invalid and smuggled Replay URLs", async () => {
    const streamId = evidenceStreamId(ref);
    const resolved = new Map([[entityStreamId(ref), [event("pr.opened", { v: 1 })]]]);
    const state = attachmentInitialStateForStream(streamId);
    const urls = [
      "http://app.replay.io/recording/a",
      "javascript:alert(1)",
      "data:text/html,x",
      "https://example.com/recording/a",
      "https://app.replay.io/not-recording/a",
      `https://app.replay.io/recording/${"a".repeat(2049)}`,
      "//app.replay.io/recording/a",
      "https://app.replay.io/recording/a#fragment",
    ];
    for (const url of urls) {
      await expectReason(
        validateEvidenceAction(
          event("evidence.linked", {
            v: 1,
            attachmentId: "link",
            kind: "replay-recording",
            url,
          }),
          context(streamId, state, [], resolved),
        ),
        "evidence/invalid-url",
      );
    }
  });

  it("refuses missing, unsealed, cross-wired, and mismatched content", async () => {
    const door = new InMemoryEvidenceDoor();
    door.seedEntity(entityStreamId(ref));
    const streamId = evidenceStreamId(ref);
    const attach = (contentStream: string, sha256 = sha256Hex(new Uint8Array()), size = 0) =>
      event("evidence.attached", {
        v: ATTACHMENT_EVENT_VERSION,
        attachmentId: "artifact",
        kind: "digest",
        name: "digest.txt",
        mediaType: "text/plain",
        size,
        sha256,
        contentStream,
      });

    await expectReason(
      door.dispatch(streamId, attach(evidenceContentStreamId(ref.org, ref.repo, "artifact"))),
      "evidence/content-not-found",
    );
    const contentStream = evidenceContentStreamId(ref.org, ref.repo, "artifact");
    await door.dispatch(
      contentStream,
      event("content.chunk", {
        v: 1,
        seq: 0,
        bytes: encodeCanonicalBase64(Uint8Array.of(1)),
      }),
    );
    await expectReason(door.dispatch(streamId, attach(contentStream)), "evidence/unsealed-content");
    await door.dispatch(
      contentStream,
      event("content.sealed", {
        v: 1,
        sha256: sha256Hex(Uint8Array.of(1)),
        size: 1,
        chunks: 1,
      }),
    );
    await expectReason(
      door.dispatch(streamId, attach(contentStream, "0".repeat(64), 1)),
      "evidence/digest-mismatch",
    );
    await expectReason(
      door.dispatch(streamId, attach(contentStream, sha256Hex(Uint8Array.of(1)), 2)),
      "evidence/size-mismatch",
    );
    await expectReason(
      door.dispatch(streamId, attach(evidenceContentStreamId("other", "repo", "artifact"))),
      "evidence/content-not-found",
    );
  });

  it("refuses unknown kinds, duplicate ids, and illegal detaches", async () => {
    const door = new InMemoryEvidenceDoor();
    door.seedEntity(entityStreamId(ref));
    const streamId = evidenceStreamId(ref);
    await expectReason(
      door.dispatch(
        streamId,
        event("evidence.linked", {
          v: 1,
          attachmentId: "link",
          kind: "video",
          url: "https://app.replay.io/recording/a",
        }),
      ),
      "evidence/unknown-kind",
    );
    await expectReason(
      door.dispatch(streamId, event("evidence.detached", { v: 1, attachmentId: "missing" })),
      "evidence/unknown-attachment",
    );
    await door.dispatch(
      streamId,
      event("evidence.linked", {
        v: 1,
        attachmentId: "link",
        kind: "replay-recording",
        url: "https://app.replay.io/recording/a",
      }),
    );
    await expectReason(
      door.dispatch(
        streamId,
        event("evidence.linked", {
          v: 1,
          attachmentId: "link",
          kind: "replay-recording",
          url: "https://app.replay.io/recording/b",
        }),
      ),
      "evidence/duplicate-attachment-id",
    );
    await door.dispatch(streamId, event("evidence.detached", { v: 1, attachmentId: "link" }));
    await expectReason(
      door.dispatch(streamId, event("evidence.detached", { v: 1, attachmentId: "link" })),
      "evidence/already-detached",
    );
  });

  it("uses typed refusal errors", () => {
    const error = new EvidenceRefusalError("evidence/oversized");
    expect(error.reason).toBe("evidence/oversized");
    expect(error.message).toBe("evidence/oversized");
  });
});
