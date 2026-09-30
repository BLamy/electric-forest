/* Provenance: registry/blocks/github-clone/repo-header.tsx — @brett_lamy/ui 2.0.0 registry block
   "github-clone" (https://blamy.github.io/ui/r/github-clone.json), installed as owned source.
   Every divergence from the upstream file carries an `ef:` marker. */
/* The site header (desktop) and the repository header: owner / name, visibility, Watch / Fork / Star. */
import type { ReactNode } from "react";
import { Avatar, Badge, ChatShellNavTrigger, cn } from "@brett_lamy/ui";
import type { StreamReducerResult } from "@eforest/web-hooks";
import type { RepositoryNamespaceState } from "@eforest/reducers";
import { RouteLink } from "../../navigation.js";
import { Mark, Oct, ghButton, userOf, type Layout } from "./parts.js";

/** ef: one breadcrumb segment of the current route (owner, repository, page). */
export interface Crumb {
  readonly label: string;
  readonly href?: string;
}

// ef:begin route breadcrumb, repository search sheet, signed-in account
// ef: the header reads the route's live breadcrumb and the signed-in account instead of the block's mock repository and viewer.
export function GlobalHeader({
  ui,
  width,
  crumbs,
  account,
  onSearch,
  onCreate,
}: {
  ui: Layout;
  width: number;
  crumbs: readonly Crumb[];
  account: string | null;
  onSearch: () => void;
  onCreate: () => void;
}) {
  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border bg-[var(--gh-inset)] px-4">
      {/* ef: the menu button is the package's ChatShellNavTrigger (renders only while the nav is a drawer). */}
      <ChatShellNavTrigger className={cn(ghButton(), "w-8 bg-transparent px-0")} />
      <RouteLink href="/" aria-label="Electric Forest home" className="rounded-full">
        <Mark />
      </RouteLink>
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-[14px]">
        {crumbs.map((crumb, index) => (
          <span key={`${crumb.label}:${String(index)}`} className="flex min-w-0 items-center gap-1">
            {index > 0 ? <span className="text-tertiary-foreground">/</span> : null}
            {crumb.href === undefined ? (
              <span
                className={cn(
                  "truncate rounded-md px-1.5 py-1",
                  index === crumbs.length - 1 && "font-semibold",
                )}
              >
                {crumb.label}
              </span>
            ) : (
              <RouteLink
                href={crumb.href}
                className={cn(
                  "truncate rounded-md px-1.5 py-1 text-foreground hover:bg-secondary",
                  index === crumbs.length - 1 && "font-semibold",
                )}
              >
                {crumb.label}
              </RouteLink>
            )}
          </span>
        ))}
      </nav>
      <span className="flex-1" />
      {width >= 900 ? (
        // ef: the search box opens the live repository search sheet.
        <button
          type="button"
          onClick={onSearch}
          data-testid="rail-search"
          aria-label="Search repositories"
          className="flex h-8 w-[300px] cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-2 text-left text-muted-foreground hover:bg-secondary"
        >
          <Oct name="search" />
          <span className="flex-1">
            Type <kbd className="rounded border border-border px-1 font-mono text-[11px]">/</kbd> to
            search
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={onSearch}
          data-testid="rail-search"
          aria-label="Search repositories"
          className={cn(ghButton(), "w-8 bg-transparent px-0 text-muted-foreground")}
        >
          <Oct name="search" />
        </button>
      )}
      {ui.wide ? <span className="h-5 w-px bg-border" /> : null}
      <button
        type="button"
        aria-label="Create new repository"
        onClick={onCreate}
        className={cn(ghButton(), "gap-1 bg-transparent px-2 text-muted-foreground")}
      >
        <Oct name="plus" />
        <Oct name="chevDown" size={12} />
      </button>
      {/* ef: the issue / PR / inbox shortcuts are not installed (no global inbox stream yet). */}
      {account === null ? null : (
        <span title={account} className="flex">
          <Avatar c={userOf(account)} size={32} />
        </span>
      )}
    </header>
  );
}
// ef:end

// ef:begin live namespace projection (repo-chrome evidence, visibility)
/** ef: the repository header renders the live namespace projection (repo-home …:namespace) its page
    subscribes to once. */
export function RepoHeader({
  ui,
  org,
  repo,
  namespace,
  actions,
}: {
  ui: Layout;
  org: string;
  repo: string;
  namespace: StreamReducerResult<RepositoryNamespaceState>;
  actions?: ReactNode;
}) {
  const streamId = `repo-home:${org}/${repo}:namespace`;
  const metadata = namespace.state.metadata;
  return (
    <div
      className="px-4 pt-4 md:px-6"
      data-testid="repo-chrome"
      data-ef-stream={streamId}
      data-ef-offset={namespace.checkpoint}
      data-ef-digest={namespace.digest}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
        <div className="flex min-w-0 items-center gap-2 text-[20px]">
          <Oct name="book" className="text-muted-foreground" />
          <RouteLink href={`/organizations/${encodeURIComponent(org)}`} className="text-link">
            {org}
          </RouteLink>
          <span className="text-tertiary-foreground">/</span>
          <strong className="truncate font-semibold">
            <RouteLink
              href={`/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`}
              className="text-link"
            >
              {repo}
            </RouteLink>
          </strong>
          {/* ef: visibility comes from the namespace stream (shown as GitHub labels it: Public /
              Private); nothing renders until it replays. */}
          <Badge
            variant="outline"
            className="h-5 px-2 text-[12px] font-medium text-muted-foreground"
            data-testid="repo-visibility"
          >
            {metadata === undefined || metadata === null
              ? null
              : metadata.visibility === "private"
                ? "Private"
                : "Public"}
          </Badge>
        </div>
        {!ui.phone && actions !== undefined ? (
          // ef: Watch / Fork / Star counters have no stream behind them; the header carries the
          // repository's real actions (history, stream inspector) instead.
          <div className="ml-auto flex flex-wrap gap-2">{actions}</div>
        ) : null}
      </div>
      {!ui.wide && metadata !== null ? (
        <div className="mt-3 space-y-3">
          <p className="m-0 text-[14px] leading-5 text-muted-foreground">
            {/* ef: the description line is the replayed project / owner metadata. */}
            Project <b className="text-foreground">{metadata.project}</b> · owned by{" "}
            {metadata.repoOwner}
          </p>
        </div>
      ) : null}
    </div>
  );
}
// ef:end
