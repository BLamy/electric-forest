import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex, stateDigest } from "./digest.js";

describe("browser-safe canonical digest", () => {
  it("matches the published SHA-256 vector", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches Node over canonical UTF-8 state bytes", () => {
    const canonical = '{"nested":{"ok":true},"unicode":"🌲"}';
    expect(stateDigest({ unicode: "🌲", nested: { ok: true } })).toBe(
      createHash("sha256").update(canonical, "utf8").digest("hex"),
    );
  });
});
