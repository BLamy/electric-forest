import { describe, expect, it } from "vitest";
import { assertOffsetOpacity, collectBoth } from "../conformance.js";

describe("protocol conformance", () => {
  it("runs the same URL-level cases against both cold stores", async () => {
    const run = await collectBoth();
    expect(run.variants.map((variant) => variant.variant)).toEqual(["memory", "file"]);
    expect(run.variants[0]?.caseCount).toBeGreaterThan(10);
    expect(run.variants[0]?.caseCount).toBe(run.variants[1]?.caseCount);
    expect(run.variants[0]?.corpus.length).toBe(run.variants[1]?.corpus.length);
    expect(run.variants[0]?.transcripts).toEqual(run.variants[1]?.transcripts);
  }, 30_000);

  it("keeps offsets opaque in the conformance source", () => {
    expect(() => assertOffsetOpacity()).not.toThrow();
  });
});
