export interface RepositorySearchTarget {
  readonly org: string;
  readonly repo: string;
}

/** Parse the exact `organization/repository` form accepted by the registry search. */
export function parseRepositorySearch(query: string): RepositorySearchTarget | undefined {
  const normalized = query.trim().replace(/^\/+/, "");
  const segments = normalized.split("/");
  if (
    segments.length !== 2 ||
    segments.some((segment) => segment.length === 0 || /\s/.test(segment))
  ) {
    return undefined;
  }
  return { org: segments[0]!, repo: segments[1]! };
}

/** Build a safe client-side route, preserving the canonical casing from the registry when available. */
export function repositorySearchHref(
  query: string,
  rows: readonly RepositorySearchTarget[],
): string | undefined {
  const target = parseRepositorySearch(query);
  if (target === undefined) return undefined;
  const normalizedOrg = target.org.toLocaleLowerCase();
  const normalizedRepo = target.repo.toLocaleLowerCase();
  const canonical = rows.find(
    (row) =>
      row.org.toLocaleLowerCase() === normalizedOrg &&
      row.repo.toLocaleLowerCase() === normalizedRepo,
  );
  const resolved = canonical ?? target;
  return `/${encodeURIComponent(resolved.org)}/${encodeURIComponent(resolved.repo)}`;
}
