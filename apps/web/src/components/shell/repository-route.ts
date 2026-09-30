import type { RepoSection } from "../../navigation.js";

interface RepositoryRoute {
  readonly org: string;
  readonly repo: string;
  readonly active: RepoSection;
}

function decoded(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function repositoryRoute(pathname: string): RepositoryRoute | undefined {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] === "orgs" && segments[2] === "repos") {
    const org = decoded(segments[1]);
    const repo = decoded(segments[3]);
    if (org === undefined || repo === undefined) return undefined;
    const section = segments[4];
    const active: RepoSection =
      section === "pulls"
        ? "pulls"
        : section === "issues"
          ? "issues"
          : section === "wiki"
            ? "wiki"
            : section === "settings"
              ? "settings"
              : "code";
    return { org, repo, active };
  }
  if (segments.length >= 2 && ["tree", "blob", "history", "branches"].includes(segments[2] ?? "")) {
    const org = decoded(segments[0]);
    const repo = decoded(segments[1]);
    if (org !== undefined && repo !== undefined) return { org, repo, active: "code" };
  }
  if (
    segments.length === 2 &&
    !["organizations", "members", "invite", "chat", "roadmap", "docs"].includes(segments[0] ?? "")
  ) {
    const org = decoded(segments[0]);
    const repo = decoded(segments[1]);
    if (org !== undefined && repo !== undefined) return { org, repo, active: "code" };
  }
  return undefined;
}
