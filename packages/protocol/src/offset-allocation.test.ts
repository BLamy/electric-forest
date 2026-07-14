import { describe, expect, it } from "vitest";
import { isWellFormedOffset, offsetForOrdinal } from "./offset-allocation.js";

describe("authority-only offset allocation", () => {
  it("allocates monotone opaque positions without parsing prior offsets", () => {
    expect(offsetForOrdinal(0)).toBe("0000000000000000_0000000000000000");
    expect(offsetForOrdinal(17)).toBe("0000000000000000_0000000000000017");
    expect(isWellFormedOffset("-1")).toBe(true);
    expect(isWellFormedOffset(offsetForOrdinal(1))).toBe(true);
    expect(isWellFormedOffset("-2")).toBe(false);
    expect(isWellFormedOffset("not-an-offset")).toBe(false);
  });

  it("rejects invalid allocation ordinals", () => {
    expect(() => offsetForOrdinal(-1)).toThrow(RangeError);
    expect(() => offsetForOrdinal(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });
});
