import { describe, expect, it } from "vitest";
import { repositoryStack, routeCrumbs } from "./stack.js";

const hrefs = (pathname: string): readonly string[] | undefined =>
  repositoryStack(pathname)?.levels.map((level) => level.href);

describe("compact NavigationStack levels are derived from the URL", () => {
  it("roots each repository section at its list", () => {
    expect(hrefs("/maple/reading-room")).toEqual(["/maple/reading-room"]);
    expect(hrefs("/orgs/maple/repos/reading-room/pulls")).toEqual([
      "/orgs/maple/repos/reading-room/pulls",
    ]);
    expect(repositoryStack("/orgs/maple/repos/reading-room/issues")?.section).toBe("issues");
    expect(repositoryStack("/orgs/maple/repos/reading-room/settings")?.section).toBe("settings");
  });

  it("pushes one level per folder and the open file", () => {
    expect(hrefs("/maple/reading-room/blob/main/apps/web/product.ts")).toEqual([
      "/maple/reading-room",
      "/maple/reading-room/tree/main",
      "/maple/reading-room/tree/main/apps",
      "/maple/reading-room/tree/main/apps/web",
      "/maple/reading-room/blob/main/apps/web/product.ts",
    ]);
    expect(hrefs("/maple/reading-room/tree/main/apps")).toEqual([
      "/maple/reading-room",
      "/maple/reading-room/tree/main",
      "/maple/reading-room/tree/main/apps",
    ]);
  });

  it("keeps a pull request's tabs on one stack level", () => {
    const activity = repositoryStack("/orgs/maple/repos/reading-room/pulls/60");
    const changes = repositoryStack("/orgs/maple/repos/reading-room/pulls/60/changes");
    expect(activity?.levels.map((level) => level.key)).toEqual(["root:pulls", "pr:60"]);
    expect(changes?.levels.map((level) => level.key)).toEqual(["root:pulls", "pr:60"]);
    expect(changes?.levels.at(-1)?.href).toBe("/orgs/maple/repos/reading-room/pulls/60/changes");
  });

  it("stacks issues, labels, wiki pages, history and branches under their roots", () => {
    expect(hrefs("/orgs/maple/repos/reading-room/issues/visual-capstone")).toEqual([
      "/orgs/maple/repos/reading-room/issues",
      "/orgs/maple/repos/reading-room/issues/visual-capstone",
    ]);
    expect(hrefs("/orgs/maple/repos/reading-room/labels")).toEqual([
      "/orgs/maple/repos/reading-room/issues",
      "/orgs/maple/repos/reading-room/labels",
    ]);
    expect(hrefs("/orgs/maple/repos/reading-room/wiki/home/edit")).toEqual([
      "/orgs/maple/repos/reading-room/wiki",
      "/orgs/maple/repos/reading-room/wiki/home",
      "/orgs/maple/repos/reading-room/wiki/home/edit",
    ]);
    expect(hrefs("/maple/reading-room/history/main")).toEqual([
      "/maple/reading-room",
      "/maple/reading-room/history/main",
    ]);
    expect(hrefs("/maple/reading-room/branches")).toEqual([
      "/maple/reading-room",
      "/maple/reading-room/branches",
    ]);
  });

  it("is undefined outside repositories and names every page in the breadcrumb", () => {
    expect(repositoryStack("/chat/maple/general")).toBeUndefined();
    expect(repositoryStack("/members/maple")).toBeUndefined();
    expect(routeCrumbs("/members/maple").map((crumb) => crumb.label)).toEqual(["maple", "Members"]);
    expect(routeCrumbs("/orgs/maple/repos/reading-room/pulls").map((crumb) => crumb.label)).toEqual(
      ["maple", "reading-room"],
    );
  });
});
