import { describe, expect, it } from "vitest";
import { mergeTextBytes } from "../src/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("three-way text patch composition", () => {
  it("composes adjacent replacements but rejects insertions on the same boundary", () => {
    const adjacent = mergeTextBytes(
      encoder.encode("abcdef"),
      encoder.encode("abXdef"),
      encoder.encode("abcYef"),
    );
    expect(adjacent.kind).toBe("clean");
    if (adjacent.kind === "clean") expect(decoder.decode(adjacent.bytes)).toBe("abXYef");

    expect(
      mergeTextBytes(
        encoder.encode("abcdef"),
        encoder.encode("abcXdef"),
        encoder.encode("abcYdef"),
      ),
    ).toEqual({ kind: "conflict", reason: "overlap" });
  });

  it("classifies invalid UTF-8 and NUL-delimited content as binary", () => {
    expect(
      mergeTextBytes(new Uint8Array([0, 1]), new Uint8Array([0, 2]), new Uint8Array([0, 3])),
    ).toEqual({ kind: "conflict", reason: "binary" });
    expect(
      mergeTextBytes(new Uint8Array([0xff]), new Uint8Array([0xfe]), new Uint8Array([0xfd])),
    ).toEqual({ kind: "conflict", reason: "binary" });
  });
});
