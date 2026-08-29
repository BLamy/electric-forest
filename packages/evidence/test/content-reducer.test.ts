import { describe, expect, it } from "vitest";
import { sha256Hex, stateDigest } from "@eforest/protocol";
import {
  ATTACHMENT_EVENT_VERSION,
  contentBytes,
  contentInitialStateValue,
  contentReducer,
  encodeCanonicalBase64,
  reduceContentEvents,
} from "../src/index.js";
import { event } from "./helpers.js";

describe("content reducer", () => {
  it("derives SHA-256 from decoded chunks and accepts a truthful seal", () => {
    const first = Uint8Array.from([0, 1, 2, 255]);
    const second = new TextEncoder().encode("canonical bytes");
    const bytes = new Uint8Array(first.byteLength + second.byteLength);
    bytes.set(first);
    bytes.set(second, first.byteLength);
    const state = reduceContentEvents([
      event("content.chunk", {
        v: ATTACHMENT_EVENT_VERSION,
        seq: 0,
        bytes: encodeCanonicalBase64(first),
      }),
      event("content.chunk", {
        v: ATTACHMENT_EVENT_VERSION,
        seq: 1,
        bytes: encodeCanonicalBase64(second),
      }),
      event("content.sealed", {
        v: ATTACHMENT_EVENT_VERSION,
        sha256: sha256Hex(bytes),
        size: bytes.byteLength,
        chunks: 2,
      }),
    ]);
    expect(state).toEqual({
      v: 1,
      size: bytes.byteLength,
      chunks: 2,
      sha256: sha256Hex(bytes),
      sealed: true,
    });
    expect(contentBytes(state)).toEqual(bytes);
    expect(() => stateDigest(state)).not.toThrow();
    expect(stateDigest(state)).toBe(
      stateDigest({
        v: 1,
        size: bytes.byteLength,
        chunks: 2,
        sha256: sha256Hex(bytes),
        sealed: true,
      }),
    );
  });

  it.each([
    ["chunk-out-of-order", { chunks: 2, size: 3, sha256: sha256Hex(Uint8Array.of(1, 2, 3)) }],
    ["size-mismatch", { chunks: 1, size: 4, sha256: sha256Hex(Uint8Array.of(1, 2, 3)) }],
    ["digest-mismatch", { chunks: 1, size: 3, sha256: "0".repeat(64) }],
  ] as const)("records a lying seal as %s without trusting it", (sealError, claim) => {
    const bytes = Uint8Array.of(1, 2, 3);
    const state = reduceContentEvents([
      event("content.chunk", {
        v: ATTACHMENT_EVENT_VERSION,
        seq: 0,
        bytes: encodeCanonicalBase64(bytes),
      }),
      event("content.sealed", { v: ATTACHMENT_EVENT_VERSION, ...claim }),
    ]);
    expect(state).toMatchObject({
      sealed: false,
      sealError,
      sha256: sha256Hex(bytes),
      size: 3,
      chunks: 1,
    });
  });

  it("keeps the first seal attempt terminal when a later seal tells the truth", () => {
    const bytes = Uint8Array.of(1, 2, 3);
    const firstSeal = event("content.sealed", {
      v: ATTACHMENT_EVENT_VERSION,
      chunks: 1,
      size: bytes.byteLength,
      sha256: "0".repeat(64),
    });
    const truthfulSeal = event("content.sealed", {
      v: ATTACHMENT_EVENT_VERSION,
      chunks: 1,
      size: bytes.byteLength,
      sha256: sha256Hex(bytes),
    });
    const chunk = event("content.chunk", {
      v: ATTACHMENT_EVENT_VERSION,
      seq: 0,
      bytes: encodeCanonicalBase64(bytes),
    });
    const failed = contentReducer(contentReducer(contentInitialStateValue(), chunk), firstSeal);

    expect(failed).toMatchObject({
      sealed: false,
      sealError: "digest-mismatch",
      sha256: sha256Hex(bytes),
      size: bytes.byteLength,
      chunks: 1,
    });
    expect(contentReducer(failed, truthfulSeal)).toBe(failed);
    expect(
      contentReducer(
        failed,
        event("content.chunk", {
          v: ATTACHMENT_EVENT_VERSION,
          seq: 1,
          bytes: encodeCanonicalBase64(Uint8Array.of(4)),
        }),
      ),
    ).toBe(failed);
  });

  it("ignores out-of-order and post-seal events without throwing", () => {
    const bytes = Uint8Array.of(9);
    const chunk = event("content.chunk", {
      v: ATTACHMENT_EVENT_VERSION,
      seq: 0,
      bytes: encodeCanonicalBase64(bytes),
    });
    const sealed = contentReducer(
      contentReducer(contentInitialStateValue(), chunk),
      event("content.sealed", {
        v: ATTACHMENT_EVENT_VERSION,
        sha256: sha256Hex(bytes),
        size: 1,
        chunks: 1,
      }),
    );
    expect(contentReducer(sealed, chunk)).toBe(sealed);
    expect(
      contentReducer(
        contentInitialStateValue(),
        event("content.chunk", {
          v: ATTACHMENT_EVENT_VERSION,
          seq: 7,
          bytes: encodeCanonicalBase64(bytes),
        }),
      ),
    ).toEqual(contentInitialStateValue());
  });

  it("strips only server-stamped actor/writer fields before exact guards", () => {
    const bytes = Uint8Array.of(7, 8, 9);
    const state = reduceContentEvents([
      event("content.chunk", {
        v: ATTACHMENT_EVENT_VERSION,
        seq: 0,
        bytes: encodeCanonicalBase64(bytes),
        actor: "user:brett",
        writer: "browser:1",
      }),
      event("content.sealed", {
        v: ATTACHMENT_EVENT_VERSION,
        sha256: sha256Hex(bytes),
        size: bytes.byteLength,
        chunks: 1,
        actor: "user:brett",
        writer: "browser:1",
      }),
    ]);
    expect(state).toMatchObject({ sealed: true, size: 3, sha256: sha256Hex(bytes) });

    const withUnknown = contentReducer(
      contentInitialStateValue(),
      event("content.chunk", {
        v: ATTACHMENT_EVENT_VERSION,
        seq: 0,
        bytes: encodeCanonicalBase64(bytes),
        surprise: true,
      }),
    );
    expect(withUnknown).toEqual(contentInitialStateValue());
  });
});
