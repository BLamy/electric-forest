import type { NamespaceView } from "./reducer.js";

export interface NamespaceNotFound {
  readonly found: false;
  readonly reason: "not-found";
  readonly path: string;
}

export interface ResolvedOrg {
  readonly org: string;
  readonly owner: string;
  readonly projects: readonly string[];
  readonly repos: readonly {
    readonly name: string;
    readonly project: string;
    readonly visibility: "public" | "private";
  }[];
}

export interface ResolvedRepo {
  readonly repoStreamPrefix: string;
  readonly visibility: "public" | "private";
  readonly owner: string;
  readonly project: string;
}

export type NamespaceResolution = NamespaceNotFound | ResolvedOrg | ResolvedRepo | string;

function notFound(path: string): NamespaceNotFound {
  return { found: false, reason: "not-found", path };
}

export function resolvePath(state: NamespaceView, path: string): NamespaceResolution {
  const parts = path.split("/");
  if (parts.length < 1 || parts.length > 3 || parts.some((part) => part.length === 0)) {
    return notFound(path);
  }
  const [orgName, repoName, branch] = parts as [string, string | undefined, string | undefined];
  const org = Object.hasOwn(state.orgs, orgName) ? state.orgs[orgName] : undefined;
  if (org === undefined) return notFound(path);
  if (repoName === undefined) {
    return {
      org: orgName,
      owner: org.owner,
      projects: Object.keys(org.projects).sort(),
      repos: Object.entries(org.repos)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, repo]) => ({
          name,
          project: repo.project,
          visibility: repo.visibility,
        })),
    };
  }
  const repo = Object.hasOwn(org.repos, repoName) ? org.repos[repoName] : undefined;
  if (repo === undefined) return notFound(path);
  const prefix = `fs:${orgName}/${repoName}`;
  // A slash-containing branch segment can never reach this point: it splits
  // into four or more parts, refused by the parts-length check above, and a
  // split("/") part cannot itself contain "/". Asserted literally by the
  // 4-segment not-found case in packages/platform/test/ns.test.ts.
  if (branch !== undefined) return `${prefix}:${branch}:meta`;
  return {
    repoStreamPrefix: prefix,
    visibility: repo.visibility,
    owner: repo.owner,
    project: repo.project,
  };
}
