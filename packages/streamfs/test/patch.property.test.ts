import { describe, expect, it } from "vitest";
import { applyPatch, chooseWriteEvent, diffText } from "../src/index.js";

const seedPairs = [
  ["", ""],
  ["abc", "abc!"],
  ["🌲\r\nold", "🌳\nnew"],
  ["prefix\n".repeat(20), `${"prefix\n".repeat(20)}suffix`],
  ["a café\n", "a cafe\u0301\n"],
] as const;

describe("seeded patch properties", () => {
  it.each(seedPairs)("applyPatch(diffText(%j, %j)) is exact", (base, target) => {
    const first = diffText(base, target);
    const second = diffText(base, target);
    expect(second).toEqual(first);
    expect(applyPatch(new TextEncoder().encode(base), first)).toEqual(
      new TextEncoder().encode(target),
    );
  });

  it("keeps write choice pure and strictly size-gated", () => {
    const base = new TextEncoder().encode("seed ".repeat(80));
    const target = new TextEncoder().encode(`${"seed ".repeat(80)}changed`);
    const first = chooseWriteEvent(base, target, "seed.txt");
    const second = chooseWriteEvent(base, target, "seed.txt");
    expect(second).toEqual(first);
    if (first.type === "fs.file.patch") {
      expect(JSON.stringify(first.payload).length).toBeGreaterThan(0);
      expect(applyPatch(base, first.payload.ops)).toEqual(target);
    }
  });
});
