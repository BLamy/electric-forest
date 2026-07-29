import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

describe("the E3 canopy sensitivity spine", () => {
  it("rejects deletion of the registered sensitivity invocation", () => {
    const output = execFileSync(
      process.execPath,
      [path.join(root, "tools/verify/canopy_sensitivity_spine_sabotage.mjs")],
      { cwd: root, encoding: "utf8" },
    );
    expect(output).toContain("CANOPY_SENSITIVITY_SPINE_SABOTAGE_OK mutation=delete-invocation");
  });
});
