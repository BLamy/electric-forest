import { describe, expect, it } from "vitest";

import { taskBadge } from "./index.js";

describe("taskBadge", () => {
  it("marks a zero-task project as clear", () => {
    expect(taskBadge(0)).toBe("all-clear");
  });

  it("includes the number of open tasks when work remains", () => {
    expect(taskBadge(3)).toBe("open-3");
  });

  it("rejects invalid task counts", () => {
    expect(() => taskBadge(-1)).toThrow(RangeError);
  });
});
