import { describe, expect, it } from "vitest";
import { planUplink } from "../src/sync/reconcile.js";

describe("offline reconcile overlap ordering", () => {
  it("does not re-uplink a path already touched by downlink", () => {
    const plan = planUplink(
      { added: [], deleted: [], modified: ["docs/shared.txt", "docs/local.txt"] },
      ["docs/shared.txt"],
      { files: { "docs/shared.txt": { base: "0000000000000000_0000000000000002" } } } as never,
    );
    expect(plan.map(({ path }) => path)).toEqual(["docs/local.txt"]);
    expect(plan.some(({ path }) => path === "docs/shared.txt")).toBe(false);
  });
});
