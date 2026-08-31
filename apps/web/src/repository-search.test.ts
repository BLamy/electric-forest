import { describe, expect, it } from "vitest";
import { parseRepositorySearch, repositorySearchHref } from "./repository-search.js";

describe("repository search", () => {
  it("accepts an exact organization/repository path and rejects free text", () => {
    expect(parseRepositorySearch(" maple/reading-room ")).toEqual({
      org: "maple",
      repo: "reading-room",
    });
    expect(parseRepositorySearch("reading-room")).toBeUndefined();
    expect(parseRepositorySearch("maple/reading-room/tree/main")).toBeUndefined();
  });

  it("builds an encoded route and uses the registry's canonical casing", () => {
    const rows = [{ org: "Maple", repo: "Reading-Room" }];
    expect(repositorySearchHref("maple/reading-room", rows)).toBe("/Maple/Reading-Room");
    expect(repositorySearchHref("maple/reading-room", [])).toBe("/maple/reading-room");
  });
});
