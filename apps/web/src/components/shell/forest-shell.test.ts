import { describe, expect, it } from "vitest";
import { currentOrg } from "./ForestShell.js";

describe("ForestShell workspace resolution", () => {
  const orgs = ["alder", "test"];
  it("keeps the workspace stable across chat, repo, and org routes", () => {
    expect(currentOrg("/chat/test/general", orgs)).toBe("test");
    expect(currentOrg("/test/asdf", orgs)).toBe("test");
    expect(currentOrg("/test/asdf/tree/main", orgs)).toBe("test");
    expect(currentOrg("/orgs/test/repos/asdf/pulls", orgs)).toBe("test");
    expect(currentOrg("/organizations/test", orgs)).toBe("test");
    expect(currentOrg("/", orgs)).toBe("alder");
  });
});
