import { describe, expect, it } from "vitest";
import type { RegistryState } from "@eforest/reducers";
import { codebaseOptions, filterReferenceOptions, humanHandle } from "./referenceSources.js";

describe("chat reference sources", () => {
  it("derives @handles from emails, falling back to the subject", () => {
    expect(humanHandle({ sub: "auth0|x", email: "Brett.Lamy@replay.io" })).toBe("brett.lamy");
    expect(humanHandle({ sub: "auth0|abc123", email: null })).toBe("u_abc123");
    expect(humanHandle({ sub: "auth0|abc", email: "42@example.test" })).toBe("u_abc");
  });

  it("lists this workspace's codebases by name and others as org/repo", () => {
    const registry = {
      orgs: {
        maple: { repos: { "reading-room": {}, "stream-lab": {} } },
        willow: { repos: { garden: {} } },
      },
    } as unknown as RegistryState;
    expect(codebaseOptions(registry, "maple").map((option) => option.id)).toEqual([
      "reading-room",
      "stream-lab",
      "willow/garden",
    ]);
  });

  it("filters by id or label, case-insensitively", () => {
    const options = [
      { id: "luna", label: "Luna" },
      { id: "brett", label: "brett@replay.io" },
    ];
    expect(filterReferenceOptions(options, "REPLAY").map((option) => option.id)).toEqual(["brett"]);
    expect(filterReferenceOptions(options, "")).toHaveLength(2);
  });
});
