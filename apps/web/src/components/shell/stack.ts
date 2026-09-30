import { repoLabelsPath, repoSectionPath, type RepoSection } from "../../navigation.js";
import { repositoryRoute } from "./repository-route.js";

/** One level of the compact NavigationStack: a route, keyed so tab changes don't push. */
export interface RouteLevel {
  readonly key: string;
  readonly title: string;
  readonly href: string;
}

export interface RepositoryStack {
  readonly org: string;
  readonly repo: string;
  /** The underline tab the route belongs to. */
  readonly section: RepoSection;
  /** Root first (the section's list), current route last. */
  readonly levels: readonly RouteLevel[];
}

function decoded(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/**
 * The compact navigation stack for a repository route, derived from the URL alone: the
 * section root (its list) and one pushed level per folder, file, issue, pull request, wiki
 * page or sub-page. Browser history stays the single source of truth — popping a level
 * navigates to the previous level's href.
 */
export function repositoryStack(pathname: string): RepositoryStack | undefined {
  const route = repositoryRoute(pathname);
  if (route === undefined) return undefined;
  const { org, repo } = route;
  const segments = pathname.split("/").filter(Boolean);
  const base = `/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
  const levels: RouteLevel[] = [];
  let section: RepoSection = route.active;

  if (segments[0] === "orgs") {
    const kind = segments[4];
    const id = decoded(segments[5]);
    if (kind === "labels") section = "issues";
    levels.push({
      key: `root:${section}`,
      title: repo,
      href: repoSectionPath(org, repo, section),
    });
    if (kind === "labels") {
      levels.push({ key: "labels", title: "Labels", href: repoLabelsPath(org, repo) });
    } else if (kind === "pulls" && id !== undefined) {
      levels.push({ key: `pr:${id}`, title: `#${id}`, href: pathname });
    } else if (kind === "issues" && id !== undefined) {
      levels.push({ key: `issue:${id}`, title: id, href: pathname });
    } else if (kind === "wiki" && id !== undefined) {
      const page = `${repoSectionPath(org, repo, "wiki")}/${encodeURIComponent(id)}`;
      levels.push({ key: `wiki:${id}`, title: id, href: page });
      if (segments[6] === "edit")
        levels.push({ key: `wiki:${id}:edit`, title: "Edit", href: pathname });
    }
    return { org, repo, section, levels };
  }

  section = "code";
  levels.push({ key: "root:code", title: repo, href: base });
  const kind = segments[2];
  const branch = decoded(segments[3]);
  if (kind === "branches") {
    levels.push({ key: "branches", title: "Branches", href: `${base}/branches` });
  } else if (kind === "history" && branch !== undefined) {
    levels.push({ key: `history:${branch}`, title: "History", href: pathname });
  } else if ((kind === "tree" || kind === "blob") && branch !== undefined) {
    const branchHref = `${base}/tree/${encodeURIComponent(branch)}`;
    const parts = segments.slice(4).map((part) => decoded(part) ?? part);
    if (kind === "tree" || parts.length > 0) {
      levels.push({ key: `tree:${branch}`, title: branch, href: branchHref });
    }
    parts.forEach((part, index) => {
      const last = index === parts.length - 1;
      const path = parts
        .slice(0, index + 1)
        .map(encodeURIComponent)
        .join("/");
      const href =
        last && kind === "blob"
          ? `${base}/blob/${encodeURIComponent(branch)}/${path}`
          : `${branchHref}/${path}`;
      levels.push({
        key: `${last && kind === "blob" ? "blob" : "tree"}:${branch}:${parts.slice(0, index + 1).join("/")}`,
        title: part,
        href,
      });
    });
  }
  return { org, repo, section, levels };
}

/** GlobalHeader breadcrumb for any authenticated route. */
export function routeCrumbs(pathname: string): readonly { label: string; href?: string }[] {
  const stack = repositoryStack(pathname);
  if (stack !== undefined) {
    return [
      { label: stack.org, href: `/organizations/${encodeURIComponent(stack.org)}` },
      { label: stack.repo, href: repoSectionPath(stack.org, stack.repo, "code") },
    ];
  }
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decoded(part) ?? part);
  if (segments.length === 0) return [{ label: "Your repositories" }];
  if (segments[0] === "organizations" && segments[1] !== undefined)
    return [{ label: segments[1], href: pathname }];
  if (segments[0] === "members" && segments[1] !== undefined)
    return [
      { label: segments[1], href: `/organizations/${encodeURIComponent(segments[1])}` },
      { label: "Members" },
    ];
  if (segments[0] === "invite" && segments[1] !== undefined)
    return [{ label: segments[1] }, { label: "Invitation" }];
  if (segments[0] === "inspect" && segments[1] !== undefined && segments[2] !== undefined)
    return [
      { label: segments[1], href: `/organizations/${encodeURIComponent(segments[1])}` },
      {
        label: segments[2],
        href: `/${encodeURIComponent(segments[1])}/${encodeURIComponent(segments[2])}`,
      },
      { label: "Stream inspector" },
    ];
  return segments.map((label) => ({ label }));
}

/** The compact title of a non-repository route. */
export function routeTitle(pathname: string): string {
  return routeCrumbs(pathname).at(-1)?.label ?? "Electric Forest";
}
