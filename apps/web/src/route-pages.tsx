import { lazy, useState } from "react";
import {
  Avatar,
  Icon,
  List,
  ListRow,
  ListSection,
  PillButton,
  SearchField,
  Segmented,
} from "@brett_lamy/ui";
import {
  BookMarked,
  ChevronDown,
  Code2,
  Copy,
  EllipsisVertical,
  GitBranch,
  History,
  Plus,
  Tag,
} from "lucide-react";
import { useDispatch, useStreamReducer, type StreamReducerResult } from "@eforest/web-hooks";
import { isValidFsPath, type FsTree } from "@eforest/streamfs";
import { OFFSET_BEFORE_FIRST } from "@eforest/protocol";
import type {
  FileContentState,
  HistoryApplicationRecord,
  HistoryState,
  RegistryRepoState,
  RegistryState,
  RepositoryBranchesState,
  RepositoryBranch,
  RepositoryNamespaceState,
  RepositoryStatusState,
} from "@eforest/reducers";
import { fileViewStreamId } from "@eforest/reducers";
import { RouteLink } from "./navigation.js";
import { humanizeRecord } from "./history.js";
import { navigate } from "./prs/RepoChrome.js";
import { repositorySearchHref } from "./repository-search.js";
const LabelManagement = lazy(async () => {
  const module = await import("./label-management.js");
  return { default: module.LabelManagement };
});
const IssueBoardPage = lazy(async () => {
  const module = await import("./issues/IssueBoard.js");
  return { default: module.IssueBoardPage };
});
const IssueDetailPage = lazy(async () => {
  const module = await import("./issues/IssueDetail.js");
  return { default: module.IssueDetailPage };
});
const WikiRoute = lazy(async () => {
  const module = await import("./wiki/WikiRoute.js");
  return { default: module.WikiRoute };
});
import { isWikiSlug } from "./wiki/useWiki.js";
const PrListPage = lazy(async () => {
  const module = await import("./prs/PrList.js");
  return { default: module.PrListPage };
});
const PrDetailPage = lazy(async () => {
  const module = await import("./prs/PrDetail.js");
  return { default: module.PrDetailPage };
});
import type { PrDetailTab } from "./prs/PrDetail.js";
const RepositoryTree = lazy(async () => {
  const module = await import("./components/trees/RepositoryTree.js");
  return { default: module.RepositoryTree };
});
const Markdown = lazy(async () => {
  const module = await import("./components/markdown/Markdown.js");
  return { default: module.Markdown };
});
const ChatChannelPage = lazy(async () => {
  const module = await import("./chat/ChatChannelPage.js");
  return { default: module.ChatChannelPage };
});
const MembersPage = lazy(async () => {
  const module = await import("./members/MembersPage.js");
  return { default: module.MembersPage };
});
const InvitePage = lazy(async () => {
  const module = await import("./members/InvitePage.js");
  return { default: module.InvitePage };
});
import { Button } from "./components/ui/button.js";
import { DesktopTouchKit } from "./components/touchkit/DesktopTouchKit.js";
import { MobileCredenza } from "./components/mobile/MobileOverlays.js";
import { useRegistryProjection } from "./registry-context.js";

interface TreeRoute {
  readonly org: string;
  readonly repo: string;
  readonly branch: string;
  readonly path: string;
}

function decodeRouteSegment(encoded: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
  if (decoded.includes("/")) return undefined;
  return decoded;
}

function parseTreeRoute(segments: readonly string[]): TreeRoute | undefined {
  const org = decodeRouteSegment(segments[0]!);
  const repo = decodeRouteSegment(segments[1]!);
  const branch = decodeRouteSegment(segments[3]!);
  if (org === undefined || repo === undefined || branch === undefined) return undefined;

  const pathSegments: string[] = [];
  for (const encoded of segments.slice(4)) {
    const decoded = decodeRouteSegment(encoded);
    if (decoded === undefined) return undefined;
    pathSegments.push(decoded);
  }
  const path = pathSegments.join("/");
  if (path !== "" && !isValidFsPath(path)) return undefined;
  return { org, repo, branch, path };
}

const parseBlobRoute = parseTreeRoute;

function parseHistoryRoute(segments: readonly string[]): TreeRoute | undefined {
  const values =
    segments[0] === "history"
      ? [segments[1], segments[2], segments[3]]
      : segments[2] === "history"
        ? [segments[0], segments[1], segments[3]]
        : [];
  if (values.length !== 3) return undefined;
  const org = decodeRouteSegment(values[0]!);
  const repo = decodeRouteSegment(values[1]!);
  const branch = decodeRouteSegment(values[2]!);
  if (org === undefined || repo === undefined || branch === undefined) return undefined;
  return { org, repo, branch, path: "" };
}

const projectionCache = new Map<string, StreamReducerResult<unknown>>();

/** Relative time for real wall-clock stamps; fixtures with synthetic `ts` values show nothing. */
function relativeTime(ts: number | undefined): string | undefined {
  if (ts === undefined || !Number.isFinite(ts) || ts < 1_000_000_000_000) return undefined;
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${String(days)}d ago`;
  return `${String(Math.round(days / 30))}mo ago`;
}

function avatarName(actor: string): { readonly f: string; readonly l: string } {
  const cleaned = actor
    .replace(/^auth0\|/, "")
    .replace(/[@._|-]+/g, " ")
    .trim();
  const [first = "?", ...rest] = cleaned.split(/\s+/);
  return { f: first, l: rest.at(-1) ?? "" };
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    /* clipboard access is a browser permission, never a product error */
  }
}

function LatestCommitStrip(props: {
  readonly actor: string;
  readonly summary: string;
  readonly checkpoint: string;
  readonly ts: number | undefined;
  readonly historyHref: string;
}): React.JSX.Element {
  const when = relativeTime(props.ts);
  return (
    <div className="latest-commit-strip" data-testid="latest-commit-strip">
      <span className="commit-avatar" aria-hidden="true">
        <Avatar c={avatarName(props.actor)} size={20} />
      </span>
      <div>
        <strong>
          <span className="commit-actor">{props.actor}</span> {props.summary}
        </strong>
      </div>
      <code title={props.checkpoint}>{props.checkpoint.slice(-7)}</code>
      {when === undefined ? null : <small>{when}</small>}
      <RouteLink href={props.historyHref}>
        <History size={14} aria-hidden="true" />
        History
      </RouteLink>
    </div>
  );
}

function ProjectionFacts(props: {
  readonly region: string;
  readonly checkpoint: string;
  readonly digest: string;
  readonly status: string;
}): React.JSX.Element {
  return (
    <dl className="projection-facts" data-testid={props.region + "-projection-facts"}>
      <dt>Application checkpoint</dt>
      <dd data-testid={`${props.region}-checkpoint`}>{props.checkpoint}</dd>
      <dt>Canonical digest</dt>
      <dd data-testid={`${props.region}-digest`}>{props.digest}</dd>
      <dt>Stream</dt>
      <dd data-testid={`${props.region}-stream-status`}>{props.status}</dd>
    </dl>
  );
}

function RepositoryHome(props: { readonly org: string; readonly repo: string }): React.JSX.Element {
  const encodedOrg = encodeURIComponent(props.org);
  const encodedRepo = encodeURIComponent(props.repo);
  const base = `/api/repos/${encodedOrg}/${encodedRepo}/home`;
  const namespace = useStreamReducer<RepositoryNamespaceState>({
    apiPath: `${base}/namespace`,
    streamId: `repo-home:${props.org}/${props.repo}:namespace`,
    reducerId: "repo-namespace",
    followWaitMs: 1_000,
    reconnectDelayMs: 1_500,
  });
  const branches = useStreamReducer<RepositoryBranchesState>({
    apiPath: `${base}/branches`,
    streamId: `repo-home:${props.org}/${props.repo}:branches`,
    reducerId: "repo-branches",
    followWaitMs: 1_000,
    reconnectDelayMs: 1_500,
  });
  const projectStatus = useStreamReducer<RepositoryStatusState>({
    apiPath: `${base}/status`,
    streamId: `repo-home:${props.org}/${props.repo}:status`,
    reducerId: "repo-status",
    followWaitMs: 1_000,
    reconnectDelayMs: 1_500,
  });
  const metadata = namespace.state.metadata;
  const branchRows = Object.values(branches.state.branches).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const statuses = [namespace.status, branches.status, projectStatus.status];
  const refusal = statuses.find((status) => status.startsWith("error:"));

  return (
    <section className="repository-home" data-testid="repository-home">
      <div className="repository-heading">
        <div>
          <p className="eyebrow">Authorized live projections</p>
          <h1 data-testid="route-repo">
            {props.org} / {props.repo}
          </h1>
        </div>
        <span
          className={`project-status project-status-${projectStatus.state.status ?? "loading"}`}
          data-testid="project-status"
        >
          {projectStatus.state.status ?? "loading"}
        </span>
      </div>

      <nav aria-label="Repository settings">
        <RouteLink
          href={`/orgs/${encodeURIComponent(props.org)}/repos/${encodeURIComponent(props.repo)}/wiki`}
        >
          Wiki
        </RouteLink>
        <RouteLink
          href={`/orgs/${encodeURIComponent(props.org)}/repos/${encodeURIComponent(props.repo)}/issues`}
        >
          Issues
        </RouteLink>
        <RouteLink
          href={`/orgs/${encodeURIComponent(props.org)}/repos/${encodeURIComponent(props.repo)}/labels`}
        >
          Manage labels
        </RouteLink>
      </nav>

      {refusal === undefined ? null : (
        <p className="projection-refusal" role="alert" data-testid="repository-home-refusal">
          Repository projection refused: {refusal.slice("error:".length)}
        </p>
      )}

      <div className="repository-regions">
        <section
          className="repository-region"
          data-testid="repo-namespace-region"
          data-application-checkpoint={namespace.checkpoint}
          data-state-digest={namespace.digest}
          data-stream-status={namespace.status}
        >
          <p className="eyebrow">Namespace</p>
          <h3>Repository metadata</h3>
          <div className="metadata-slot" data-testid="repo-metadata-slot">
            {metadata === null ? (
              <p>Loading repository metadata…</p>
            ) : (
              <dl className="metadata-list">
                <dt>Project</dt>
                <dd data-testid="repo-project">{metadata.project}</dd>
                <dt>Visibility</dt>
                <dd data-testid="repo-visibility">{metadata.visibility}</dd>
                <dt>Repository owner</dt>
                <dd>{metadata.repoOwner}</dd>
                <dt>Project owner</dt>
                <dd>{metadata.projectOwner}</dd>
              </dl>
            )}
          </div>
          <ProjectionFacts
            region="namespace"
            checkpoint={namespace.checkpoint}
            digest={namespace.digest}
            status={namespace.status}
          />
        </section>

        <section
          className="repository-region"
          data-testid="repo-branches-region"
          data-application-checkpoint={branches.checkpoint}
          data-state-digest={branches.digest}
          data-stream-status={branches.status}
        >
          <p className="eyebrow">Branches</p>
          <h3>Native forks</h3>
          {branches.status === "loading" ? (
            <p data-testid="branch-loading">Loading branch catalog…</p>
          ) : branchRows.length === 0 ? (
            <p data-testid="branch-empty">No native forks yet.</p>
          ) : (
            <ul className="branch-list" data-testid="branch-list">
              {branchRows.map((branch) => (
                <li key={branch.streamId} data-testid="branch-row" data-branch={branch.name}>
                  <strong>
                    <RouteLink
                      href={`/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}/tree/${encodeURIComponent(branch.name)}`}
                      aria-label={branch.name === "main" ? "File tree" : undefined}
                    >
                      {branch.name}
                    </RouteLink>
                  </strong>
                  <span data-testid={`branch-parent-${branch.name}`}>
                    {branch.parentStreamId ?? "root"}
                  </span>
                  <code data-testid={`branch-fork-${branch.name}`}>{branch.forkOffset}</code>
                </li>
              ))}
            </ul>
          )}
          <ProjectionFacts
            region="branches"
            checkpoint={branches.checkpoint}
            digest={branches.digest}
            status={branches.status}
          />
        </section>

        <section
          className="repository-region"
          data-testid="repo-status-region"
          data-application-checkpoint={projectStatus.checkpoint}
          data-state-digest={projectStatus.digest}
          data-stream-status={projectStatus.status}
        >
          <p className="eyebrow">Project state</p>
          <h3 data-testid="project-state-value">{projectStatus.state.status ?? "loading"}</h3>
          <p>Only charter-defined project states cross this stream boundary.</p>
          <ProjectionFacts
            region="status"
            checkpoint={projectStatus.checkpoint}
            digest={projectStatus.digest}
            status={projectStatus.status}
          />
        </section>
      </div>
    </section>
  );
}

function useBranchCatalog(org: string, repo: string): StreamReducerResult<RepositoryBranchesState> {
  const encodedOrg = encodeURIComponent(org);
  const encodedRepo = encodeURIComponent(repo);
  const apiPath = `/api/repos/${encodedOrg}/${encodedRepo}/home/branches`;
  return useStreamReducer<RepositoryBranchesState>({
    apiPath,
    streamId: `repo-home:${org}/${repo}:branches`,
    reducerId: "repo-branches",
    followWaitMs: 1_000,
    reconnectDelayMs: 1_500,
    cache: projectionCache,
    cacheKey: `repo-branches:${org}/${repo}`,
  });
}

function branchFor(
  org: string,
  repo: string,
  branch: string,
  projection: StreamReducerResult<RepositoryBranchesState>,
): RepositoryBranch {
  return (
    projection.state.branches[branch] ?? {
      name: branch,
      streamId: `fs:${org}/${repo}:${branch}:meta`,
      parentStreamId: null,
      forkOffset: OFFSET_BEFORE_FIRST,
    }
  );
}

function BranchSelector(props: {
  readonly org: string;
  readonly repo: string;
  readonly branch: string;
  readonly path: string;
  readonly kind: "tree" | "blob" | "history";
  readonly projection: StreamReducerResult<RepositoryBranchesState>;
  readonly headCheckpoint: string;
  readonly digest: string;
}): React.JSX.Element {
  const selected = branchFor(props.org, props.repo, props.branch, props.projection);
  const branches = Object.values(props.projection.state.branches).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const root = `/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}/${props.kind}`;
  const suffix =
    props.path === "" ? "" : `/${props.path.split("/").map(encodeURIComponent).join("/")}`;
  const navigate = (branch: string): void => {
    const href = `${root}/${encodeURIComponent(branch)}${suffix}`;
    window.history.pushState(null, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  return (
    <div
      className="branch-switcher"
      data-testid="branch-switcher"
      data-branch={selected.name}
      data-parent-stream={selected.parentStreamId ?? ""}
      data-fork-checkpoint={selected.forkOffset}
      data-head-checkpoint={props.headCheckpoint}
      data-state-digest={props.digest}
      data-catalog-status={props.projection.status}
    >
      <label htmlFor="branch-switcher-select">Branch</label>
      <select
        id="branch-switcher-select"
        data-testid="branch-selector"
        aria-label="Repository branch"
        value={props.branch}
        disabled={props.projection.status === "loading" || branches.length === 0}
        onChange={(event) => navigate(event.currentTarget.value)}
      >
        {branches.length === 0 ? <option value={props.branch}>{props.branch}</option> : null}
        {branches.map((branch) => (
          <option key={branch.streamId} value={branch.name}>
            {branch.name}
          </option>
        ))}
      </select>
      <span data-testid="branch-parent-stream">{selected.parentStreamId ?? "root"}</span>
      <code data-testid="branch-fork-checkpoint">{selected.forkOffset}</code>
    </div>
  );
}

interface RepositoryRow extends RegistryRepoState {
  readonly org: string;
  readonly repo: string;
}

function registryRows(state: RegistryState, selectedOrg?: string): readonly RepositoryRow[] {
  const rows: RepositoryRow[] = [];
  for (const org of Object.keys(state.orgs).sort()) {
    if (selectedOrg !== undefined && org !== selectedOrg) continue;
    for (const repo of Object.keys(state.orgs[org]!.repos).sort()) {
      rows.push({ org, repo, ...state.orgs[org]!.repos[repo]! });
    }
  }
  return rows;
}

function RegistryBrowse(props: { readonly org?: string }): React.JSX.Element {
  const projection = useRegistryProjection();
  const organizations = Object.keys(projection.state.orgs).sort();
  const rows = registryRows(projection.state, props.org);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleRows =
    normalizedQuery === ""
      ? rows
      : rows.filter((row) =>
          `${row.org}/${row.repo} ${row.project} ${row.visibility}`
            .toLocaleLowerCase()
            .includes(normalizedQuery),
        );
  const [creating, setCreating] = useState(false);
  const [menuRow, setMenuRow] = useState<RepositoryRow | undefined>(undefined);
  const recent = rows.find((row) => row.repo === "reading-room") ?? rows[0];
  const recentRows =
    recent === undefined ? [] : [recent, ...rows.filter((row) => row !== recent)].slice(0, 3);
  const error = projection.status.startsWith("error:");
  const searchHref = repositorySearchHref(query, rows);
  return (
    <section
      className="registry-browser"
      data-testid="registry-browser"
      data-registry-scope={props.org ?? "me"}
      data-application-checkpoint={projection.checkpoint}
      data-state-digest={projection.digest}
      data-reducer-version="1"
      data-stream-status={projection.status}
    >
      <div className="registry-intro">
        <div>
          <h1 data-testid={props.org === undefined ? "route-home" : "route-org"}>
            {props.org === undefined ? "Brett Lamy" : `Organization: ${props.org}`}
          </h1>
          <p className="registry-meta">
            {props.org === undefined
              ? "Create and browse your Electric Forest repositories."
              : "Browse repositories reduced from this organization’s authorized event range."}
          </p>
        </div>
        {props.org === undefined ? (
          <Button variant="ghost" type="button">
            Settings
          </Button>
        ) : null}
      </div>
      <dl className="registry-checkpoint">
        <dt>Application checkpoint</dt>
        <dd data-testid="registry-checkpoint">{projection.checkpoint}</dd>
        <dt>Canonical digest</dt>
        <dd data-testid="registry-digest">{projection.digest}</dd>
        <dt>Status</dt>
        <dd data-testid="registry-status">{projection.status}</dd>
      </dl>
      {projection.status === "loading" ? (
        <p data-testid="registry-loading">Loading repositories…</p>
      ) : error ? (
        <div className="registry-refusal" data-testid="registry-refusal">
          <p role="alert">The authorized repository projection was refused.</p>
          <p>
            Sign in to view your repositories and live organization updates.{" "}
            <a data-testid="registry-sign-in" href="/auth/login">
              Sign in
            </a>
            .
          </p>
        </div>
      ) : (
        <>
          {props.org === undefined && recentRows.length > 0 ? (
            <section className="registry-recent" aria-labelledby="registry-recent-heading">
              <h3 id="registry-recent-heading">Recently viewed</h3>
              <div className="registry-recent-grid">
                {recentRows.map((row) => (
                  <RouteLink
                    key={`${row.org}/${row.repo}`}
                    href={`/${encodeURIComponent(row.org)}/${encodeURIComponent(row.repo)}`}
                  >
                    <BookMarked size={16} aria-hidden="true" />
                    <strong>{row.repo}</strong>
                    <small>
                      {row.org} · {row.project}
                    </small>
                  </RouteLink>
                ))}
              </div>
            </section>
          ) : null}
          {props.org === undefined && organizations.length > 0 ? (
            <nav className="organization-list" aria-label="Your organizations">
              {organizations.map((org) => (
                <RouteLink key={org} href={`/organizations/${encodeURIComponent(org)}`}>
                  {org}
                </RouteLink>
              ))}
            </nav>
          ) : null}
          <div className="registry-table-toolbar">
            <h3>All Repos</h3>
            <DesktopTouchKit>
              <form
                className="registry-search-form"
                data-testid="registry-search-form"
                aria-label="Repository search"
                onKeyDownCapture={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  const target = event.target;
                  const value = target instanceof HTMLInputElement ? target.value : query;
                  const href = repositorySearchHref(value, rows);
                  if (href !== undefined) navigate(href);
                }}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (searchHref !== undefined) navigate(searchHref);
                }}
              >
                <SearchField
                  q={query}
                  setQ={setQuery}
                  placeholder="Find repository…"
                  aria-label="Find repository"
                  className="registry-search"
                />
              </form>
            </DesktopTouchKit>
            <Button
              variant="secondary"
              type="button"
              onClick={() => setCreating(true)}
              data-testid="registry-new"
            >
              <Plus size={14} aria-hidden="true" />
              New
            </Button>
            <Button type="button">Sync from GitHub</Button>
          </div>
          {rows.length === 0 ? (
            <p data-testid="registry-empty">
              {props.org === undefined
                ? "No repositories yet."
                : "No repositories are visible in this organization."}
            </p>
          ) : visibleRows.length === 0 ? (
            <p className="registry-filter-empty">No repositories match “{query}”.</p>
          ) : (
            <div className="repository-table">
              <div className="repository-list-header" aria-hidden="true">
                <span>Name</span>
                <span>Project</span>
                <span>Visibility</span>
                <span />
              </div>
              <ul className="repository-list" data-testid="repository-list">
                {visibleRows.map((row) => (
                  <li
                    key={`${row.org}/${row.repo}`}
                    data-testid="repository-row"
                    data-org={row.org}
                    data-repo={row.repo}
                    data-visibility={row.visibility}
                  >
                    <RouteLink
                      href={`/${encodeURIComponent(row.org)}/${encodeURIComponent(row.repo)}`}
                    >
                      <BookMarked size={15} aria-hidden="true" />
                      {row.org}/{row.repo}
                    </RouteLink>
                    <span>{row.project}</span>
                    <span className="repository-visibility">{row.visibility}</span>
                    <button
                      type="button"
                      className="row-menu"
                      aria-label={`Actions for ${row.org}/${row.repo}`}
                      onClick={() => setMenuRow(row)}
                    >
                      <EllipsisVertical size={15} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <DesktopTouchKit>
        <MobileCredenza
          open={creating}
          onClose={() => setCreating(false)}
          label="New repository"
          compact
        >
          <NewRepositoryForm
            org={props.org ?? organizations[0] ?? "maple"}
            project={
              rows.find((row) => row.org === (props.org ?? organizations[0]))?.project ?? "canopy"
            }
            projects={Object.keys(
              projection.state.orgs[props.org ?? organizations[0] ?? ""]?.projects ?? {},
            )}
            onComplete={() => setCreating(false)}
          />
        </MobileCredenza>
        <MobileCredenza
          open={menuRow !== undefined}
          onClose={() => setMenuRow(undefined)}
          label={menuRow === undefined ? "Repository" : `${menuRow.org}/${menuRow.repo}`}
          compact
        >
          {menuRow === undefined ? null : (
            <RepositoryActions row={menuRow} onDone={() => setMenuRow(undefined)} />
          )}
        </MobileCredenza>
      </DesktopTouchKit>
    </section>
  );
}

function RepositoryActions(props: {
  readonly row: RepositoryRow;
  readonly onDone: () => void;
}): React.JSX.Element {
  const org = encodeURIComponent(props.row.org);
  const repo = encodeURIComponent(props.row.repo);
  const go = (href: string): void => {
    props.onDone();
    window.history.pushState(null, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  const streamId = `fs:${props.row.org}/${props.row.repo}:main:meta`;
  return (
    <List inset>
      <ListSection title="Open">
        <ListRow
          title="Code"
          leading={<Icon name="layers" />}
          accessory="chevron"
          onPress={() => go(`/${org}/${repo}/tree/main`)}
        />
        <ListRow
          title="Pull requests"
          leading={<Icon name="message" />}
          accessory="chevron"
          onPress={() => go(`/orgs/${org}/repos/${repo}/pulls`)}
        />
        <ListRow
          title="Issues"
          leading={<Icon name="info" />}
          accessory="chevron"
          onPress={() => go(`/orgs/${org}/repos/${repo}/issues`)}
        />
        <ListRow
          title="Settings"
          leading={<Icon name="sliders" />}
          accessory="chevron"
          onPress={() => go(`/orgs/${org}/repos/${repo}/settings`)}
        />
      </ListSection>
      <ListSection title="Stream" footer="Every list view is a reducer over this stream.">
        <ListRow
          title="Copy main stream id"
          subtitle={<code>{streamId}</code>}
          leading={<Icon name="wave" />}
          onPress={() => {
            void copyText(streamId);
            props.onDone();
          }}
        />
      </ListSection>
    </List>
  );
}

const NEW_PROJECT = "__new__";

function NewRepositoryForm(props: {
  readonly org: string;
  readonly project: string;
  /** Projects already reduced for this org; a new project is created first when needed. */
  readonly projects: readonly string[];
  readonly onComplete: () => void;
}): React.JSX.Element {
  const [name, setName] = useState("");
  // Grouping is optional: pick an existing project, start a new one, or leave it
  // alone and the repository is filed under a project named after itself.
  const [projectChoice, setProjectChoice] = useState<string>(
    props.projects.length > 0
      ? props.projects.includes(props.project)
        ? props.project
        : props.projects[0]!
      : "",
  );
  const [newProject, setNewProject] = useState("");
  const project =
    projectChoice === NEW_PROJECT
      ? newProject.trim() || name
      : projectChoice === ""
        ? name
        : projectChoice;
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const dispatch = useDispatch(`ns:org:${props.org}`);
  const valid = /^[a-z0-9][a-z0-9-]{0,62}$/.test(name) && /^[a-z0-9](?:-?[a-z0-9])*$/.test(project);
  const submit = async (): Promise<void> => {
    if (!valid || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (!props.projects.includes(project)) {
        await dispatch({
          type: "ns.project.create",
          payload: { v: 1, name: project },
          ts: Date.now(),
        });
      }
      await dispatch({
        type: "ns.repo.create",
        payload: { v: 1, name, project, visibility },
        ts: Date.now(),
      });
      props.onComplete();
      window.history.pushState(
        null,
        "",
        `/${encodeURIComponent(props.org)}/${encodeURIComponent(name)}`,
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The dispatch was refused.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="new-repository-form"
      data-testid="new-repository-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="new-repository-org">
        <Icon name="person2" size={16} /> {props.org} /
      </p>
      <label>
        <span>Repository name</span>
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.currentTarget.value.trim().toLowerCase())}
          placeholder="reading-room"
          aria-invalid={name.length > 0 && !valid}
        />
      </label>
      <label>
        <span>Group (optional)</span>
        <select
          value={projectChoice}
          data-testid="new-repository-project"
          onChange={(event) => setProjectChoice(event.currentTarget.value)}
        >
          <option value="">No group — file under “{name || "the repository name"}”</option>
          {props.projects.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
          <option value={NEW_PROJECT}>+ New group…</option>
        </select>
      </label>
      {projectChoice === NEW_PROJECT ? (
        <label>
          <span>New group name</span>
          <input
            value={newProject}
            onChange={(event) => setNewProject(event.currentTarget.value.trim().toLowerCase())}
            placeholder={name || "platform"}
            aria-invalid={newProject.length > 0 && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(newProject)}
          />
        </label>
      ) : null}
      <Segmented
        aria-label="Visibility"
        options={[
          { id: "public", label: "Public" },
          { id: "private", label: "Private" },
        ]}
        value={visibility}
        onChange={(id: string) => setVisibility(id === "private" ? "private" : "public")}
      />
      {error === undefined ? null : (
        <p role="alert" className="new-repository-error">
          {error}
        </p>
      )}
      <PillButton
        label={busy ? "Dispatching…" : "Create repository"}
        tone={valid && !busy ? "tint" : "soft"}
        onPress={() => void submit()}
      />
      <small>Creates one `ns.repo.create` event on the organization stream.</small>
    </form>
  );
}

function StreamInspector(props: {
  readonly org: string;
  readonly repo: string;
  readonly branch: string;
}): React.JSX.Element {
  const streamId = `fs:${props.org}/${props.repo}:${props.branch}:meta`;
  const apiPath = `/api/repos/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}/${encodeURIComponent(props.branch)}/events`;
  const projection = useStreamReducer({
    apiPath,
    streamId,
    reducerId: "streamfs",
    followWaitMs: 1_000,
  });
  return (
    <section
      data-testid="stream-inspector"
      data-stream-id={streamId}
      data-application-checkpoint={projection.checkpoint}
      data-state-digest={projection.digest}
      data-reducer-version="2"
      data-stream-status={projection.status}
    >
      <p className="eyebrow">Live application projection</p>
      <h1>Stream inspector</h1>
      <dl>
        <dt>Stream</dt>
        <dd data-testid="inspector-stream">{streamId}</dd>
        <dt>Application checkpoint</dt>
        <dd data-testid="inspector-checkpoint">{projection.checkpoint}</dd>
        <dt>Canonical digest</dt>
        <dd data-testid="inspector-digest">{projection.digest}</dd>
        <dt>Reducer</dt>
        <dd data-testid="inspector-reducer">streamfs@2</dd>
        <dt>Status</dt>
        <dd data-testid="inspector-status">{projection.status}</dd>
      </dl>
      <pre data-testid="inspector-state">{JSON.stringify(projection.state, null, 2)}</pre>
    </section>
  );
}

function HistoryView(props: {
  readonly org: string;
  readonly repo: string;
  readonly branch: string;
}): React.JSX.Element {
  const encodedOrg = encodeURIComponent(props.org);
  const encodedRepo = encodeURIComponent(props.repo);
  const encodedBranch = encodeURIComponent(props.branch);
  const streamId = `fs:${props.org}/${props.repo}:${props.branch}:meta`;
  const apiPath = `/api/repos/${encodedOrg}/${encodedRepo}/${encodedBranch}/events`;
  const branches = useBranchCatalog(props.org, props.repo);
  const selected = branchFor(props.org, props.repo, props.branch, branches);
  const projection = useStreamReducer<HistoryState>({
    apiPath,
    streamId,
    reducerId: "history",
    followWaitMs: 1_000,
    reconnectDelayMs: 1_000,
    cache: projectionCache,
    cacheKey: `history:${streamId}`,
  });
  const rows = [...projection.state.records].reverse();
  return (
    <section
      className="history-view"
      data-testid="history-view"
      data-stream-id={streamId}
      data-ef-stream={streamId}
      data-ef-offset={projection.checkpoint}
      data-application-checkpoint={projection.checkpoint}
      data-state-digest={projection.digest}
      data-stream-status={projection.status}
      data-record-count={String(rows.length)}
      data-branch={selected.name}
    >
      <p className="eyebrow">Canonical application history</p>
      <h1>History</h1>
      <BranchSelector
        org={props.org}
        repo={props.repo}
        branch={props.branch}
        path=""
        kind="history"
        projection={branches}
        headCheckpoint={projection.checkpoint}
        digest={projection.digest}
      />
      <dl className="history-facts">
        <dt>Stream</dt>
        <dd data-testid="history-stream">{streamId}</dd>
        <dt>Application checkpoint</dt>
        <dd data-testid="history-checkpoint">{projection.checkpoint}</dd>
        <dt>Canonical digest</dt>
        <dd data-testid="history-digest">{projection.digest}</dd>
        <dt>Status</dt>
        <dd data-testid="history-status">{projection.status}</dd>
      </dl>
      {projection.status.startsWith("error:") ? (
        <p role="alert" data-testid="history-refusal">
          History projection refused: {projection.status.slice("error:".length)}
        </p>
      ) : null}
      <ol data-testid="history-rows">
        {rows.map((record) => {
          const human = humanizeRecord(record);
          return (
            <li
              key={`${record.sourceStreamId}:${record.offset}`}
              data-testid="history-row"
              data-ef-stream={record.sourceStreamId}
              data-ef-offset={record.offset}
              data-history-source-stream={record.sourceStreamId}
              data-history-actor={human.actor}
              data-history-kind={human.kind}
              data-history-known={String(human.known)}
              data-history-raw={human.raw}
            >
              <div className="history-row-heading">
                <code data-testid="history-row-offset">{record.offset}</code>
                <strong data-testid="history-row-kind">{human.kind}</strong>
                <span data-testid="history-row-actor">{human.actor}</span>
              </div>
              <p data-testid="history-row-summary">{human.summary}</p>
              {!human.known ? <pre data-testid="history-row-raw">{human.raw}</pre> : null}
              <small data-testid="history-row-source">{record.sourceStreamId}</small>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

interface TreeEntry {
  readonly kind: "directory" | "file";
  readonly path: string;
  readonly name: string;
  readonly detail?: string;
}

function compareTreePaths(left: string, right: string): number {
  const a = left.split("/");
  const b = right.split("/");
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index]! < b[index]!) return -1;
    if (a[index]! > b[index]!) return 1;
  }
  return a.length - b.length;
}

function treeEntries(state: FsTree, prefix: string): readonly TreeEntry[] {
  const normalized = prefix === "" ? "" : `${prefix}/`;
  const directories = Object.keys(state.dirs).map((fullPath): TreeEntry | undefined => {
    if (!fullPath.startsWith(normalized)) return undefined;
    const remainder = fullPath.slice(normalized.length);
    if (remainder.length === 0 || remainder.includes("/")) return undefined;
    return { kind: "directory", path: fullPath, name: remainder };
  });
  const files = Object.entries(state.files).map(([fullPath, file]): TreeEntry | undefined => {
    if (!fullPath.startsWith(normalized)) return undefined;
    const remainder = fullPath.slice(normalized.length);
    if (remainder.length === 0 || remainder.includes("/")) return undefined;
    return {
      kind: "file",
      path: fullPath,
      name: remainder,
      detail: `${file.contentSha256} ${String(file.size)}`,
    };
  });
  return [...directories, ...files]
    .filter((entry): entry is TreeEntry => entry !== undefined)
    .sort((left, right) => compareTreePaths(left.path, right.path));
}

function TreeBrowser(props: TreeRoute): React.JSX.Element {
  const streamId = `fs:${props.org}/${props.repo}:${props.branch}:meta`;
  const [cloneOpen, setCloneOpen] = useState(false);
  const apiPath = `/api/repos/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}/${encodeURIComponent(props.branch)}/events`;
  const branches = useBranchCatalog(props.org, props.repo);
  const branch = branchFor(props.org, props.repo, props.branch, branches);
  const projection = useStreamReducer<FsTree>({
    apiPath,
    streamId,
    reducerId: "streamfs",
    followWaitMs: 1_000,
    reconnectDelayMs: 1_000,
    cache: projectionCache,
    cacheKey: `streamfs:${streamId}`,
  });
  const sessionProjection = useStreamReducer<FsTree>({
    apiPath: `${apiPath}?session=1`,
    streamId,
    reducerId: "streamfs",
    follow: false,
    cacheKey: `streamfs-session:${streamId}:${projection.checkpoint}`,
  });
  const prefix = props.path.replace(/^\/+|\/+$/g, "");
  const entries = treeEntries(projection.state, prefix);
  const pathSegments = prefix === "" ? [] : prefix.split("/");
  const rootHref = `/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}/tree/${encodeURIComponent(props.branch)}`;
  const blobRoot = `/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}/blob/${encodeURIComponent(props.branch)}`;
  const breadcrumbs = pathSegments.map((segment, index) => ({
    name: segment,
    href: `${rootHref}/${pathSegments
      .slice(0, index + 1)
      .map(encodeURIComponent)
      .join("/")}`,
  }));
  const status = projection.status;
  const error = status.startsWith("error:");
  const latestRecord = projection.records.at(-1);
  const latest =
    latestRecord === undefined
      ? undefined
      : humanizeRecord(latestRecord as HistoryApplicationRecord);
  const historyHref = `/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}/history/${encodeURIComponent(props.branch)}`;
  return (
    <section
      className="tree-browser"
      data-testid="tree-browser"
      data-ef-stream={streamId}
      data-ef-offset={projection.checkpoint}
      data-application-checkpoint={projection.checkpoint}
      data-branch={branch.name}
      data-parent-stream={branch.parentStreamId ?? ""}
      data-fork-checkpoint={branch.forkOffset}
      data-head-checkpoint={projection.checkpoint}
      data-state-digest={projection.digest}
      data-tree-digest={projection.digest}
      data-session-checkpoint={sessionProjection.checkpoint}
      data-session-digest={sessionProjection.digest}
      data-session-status={sessionProjection.status}
      data-reducer-version="2"
      data-stream-status={status}
    >
      <div className="repo-title-row tree-heading">
        <h1 data-testid="tree-title" className="repo-title">
          <BookMarked size={18} aria-hidden="true" />
          {props.repo}
          <span className="sr-only">
            {" "}
            ({props.org} / {props.branch})
          </span>
        </h1>
        <span data-testid="tree-stream-status" className="tree-status" data-status={status}>
          {status}
        </span>
      </div>
      <div className="repo-toolbar">
        <BranchSelector
          org={props.org}
          repo={props.repo}
          branch={props.branch}
          path={prefix}
          kind="tree"
          projection={branches}
          headCheckpoint={projection.checkpoint}
          digest={projection.digest}
        />
        <span className="repo-toolbar-meta">
          <GitBranch size={14} aria-hidden="true" />
          {Object.keys(branches.state.branches).length || 1} Branches
        </span>
        <span className="repo-toolbar-meta">
          <Tag size={14} aria-hidden="true" />0 Tags
        </span>
        <div className="repo-toolbar-actions">
          <Button variant="secondary" type="button">
            <Plus size={14} aria-hidden="true" />
            Automation
          </Button>
          <Button type="button" onClick={() => setCloneOpen(true)} data-testid="tree-code-menu">
            <Code2 size={14} aria-hidden="true" />
            Code
            <ChevronDown size={14} aria-hidden="true" />
          </Button>
        </div>
      </div>
      <DesktopTouchKit>
        <MobileCredenza
          open={cloneOpen}
          onClose={() => setCloneOpen(false)}
          label="Clone this repository"
          compact
        >
          <List inset>
            <ListSection
              title="ef CLI"
              footer="Two working directories converge through the branch stream."
            >
              <ListRow
                title="Clone"
                subtitle={<code>{`ef clone ${props.org}/${props.repo} ${props.branch}`}</code>}
                leading={<Icon name="layers" />}
                onPress={() => {
                  void copyText(`ef clone ${props.org}/${props.repo} ${props.branch}`);
                  setCloneOpen(false);
                }}
              />
              <ListRow
                title="Branch stream"
                subtitle={<code>{streamId}</code>}
                leading={<Icon name="wave" />}
                onPress={() => {
                  void copyText(streamId);
                  setCloneOpen(false);
                }}
              />
            </ListSection>
            <ListSection title="Inspect">
              <ListRow
                title="Event history"
                leading={<Icon name="clock" />}
                accessory="chevron"
                onPress={() => {
                  setCloneOpen(false);
                  window.history.pushState(null, "", historyHref);
                  window.dispatchEvent(new PopStateEvent("popstate"));
                }}
              />
              <ListRow
                title="Stream inspector"
                leading={<Icon name="pulse" />}
                accessory="chevron"
                onPress={() => {
                  setCloneOpen(false);
                  window.history.pushState(
                    null,
                    "",
                    `/inspect/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}/${encodeURIComponent(props.branch)}`,
                  );
                  window.dispatchEvent(new PopStateEvent("popstate"));
                }}
              />
            </ListSection>
          </List>
        </MobileCredenza>
      </DesktopTouchKit>
      {latestRecord === undefined || latest === undefined ? null : (
        <LatestCommitStrip
          actor={latest.actor}
          summary={latest.summary}
          checkpoint={projection.checkpoint}
          ts={latestRecord.ts}
          historyHref={historyHref}
        />
      )}
      <dl className="tree-facts">
        <dt>Stream</dt>
        <dd data-testid="tree-stream">{streamId}</dd>
        <dt>Application checkpoint</dt>
        <dd data-testid="tree-checkpoint">{projection.checkpoint}</dd>
        <dt>Tree digest</dt>
        <dd data-testid="tree-digest">{projection.digest}</dd>
      </dl>
      <nav className="tree-breadcrumbs" aria-label="Tree path" data-testid="tree-breadcrumbs">
        <RouteLink href={rootHref} aria-label="File tree">
          {props.repo}
        </RouteLink>
        {breadcrumbs.map((crumb) => (
          <span key={crumb.href}>
            <span aria-hidden="true"> / </span>
            <RouteLink href={crumb.href}>{crumb.name}</RouteLink>
          </span>
        ))}
      </nav>
      {status === "loading" ? <p data-testid="tree-loading">Loading tree…</p> : null}
      {error ? (
        <p role="alert" data-testid="tree-refusal" className="projection-refusal">
          StreamFS tree projection refused: {status.slice("error:".length)}
        </p>
      ) : null}
      {!error ? (
        <div className="tree-surface" data-testid="tree-surface">
          {status === "loading" ? (
            <ul className="tree-list tree-list-loading" data-testid="tree-list" aria-hidden="true">
              <li />
              <li />
              <li />
              <li />
              <li />
            </ul>
          ) : entries.length === 0 ? (
            <p data-testid="tree-empty">This directory is empty.</p>
          ) : (
            <RepositoryTree
              tree={projection.state}
              {...(prefix === "" ? {} : { selectedPath: prefix })}
              onOpen={(path, kind) => {
                const encodedPath = path.split("/").map(encodeURIComponent).join("/");
                const href =
                  kind === "directory"
                    ? `${rootHref}/${encodedPath}`
                    : `${blobRoot}/${encodedPath}`;
                window.history.pushState(null, "", href);
                window.dispatchEvent(new PopStateEvent("popstate"));
              }}
            />
          )}
        </div>
      ) : null}
    </section>
  );
}

function FileViewer(props: TreeRoute): React.JSX.Element {
  const streamId = fileViewStreamId(props.org, props.repo, props.branch, props.path);
  const apiPath = `/api/repos/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}/${encodeURIComponent(props.branch)}/blob/${props.path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const branches = useBranchCatalog(props.org, props.repo);
  const branch = branchFor(props.org, props.repo, props.branch, branches);
  const projection = useStreamReducer<FileContentState>({
    apiPath,
    streamId,
    reducerId: "file-content",
    followWaitMs: 1_000,
    reconnectDelayMs: 1_000,
    cache: projectionCache,
    cacheKey: `file-content:${streamId}`,
  });
  const state = projection.state;
  const treeRoot = `/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}/tree/${encodeURIComponent(props.branch)}`;
  const historyHref = `/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}/history/${encodeURIComponent(props.branch)}`;
  const streamStatus = projection.status;
  const refusal = streamStatus.startsWith("error:");
  const filePath = state.currentPath ?? props.path;
  const renderedMarkdown = /\.md$/i.test(filePath);
  const [fileMode, setFileMode] = useState<"preview" | "code">("preview");
  const lines =
    state.status === "text" && state.text !== null ? state.text.split("\n").length : undefined;
  const fileSegments = filePath.split("/").filter(Boolean);
  const pathSegments = fileSegments.map((name, index) => ({
    name,
    href: `${treeRoot}/${fileSegments
      .slice(0, index + 1)
      .map(encodeURIComponent)
      .join("/")}`,
  }));
  const latestFileRecord = [...projection.records].reverse().find((record) => {
    const payload = record.payload as { readonly path?: unknown; readonly to?: unknown } | null;
    return payload?.path === filePath || payload?.to === filePath;
  });
  const latestFile =
    latestFileRecord === undefined
      ? undefined
      : humanizeRecord(latestFileRecord as HistoryApplicationRecord);
  return (
    <section
      className="file-viewer"
      data-testid="file-viewer"
      data-ef-stream={streamId}
      data-ef-offset={projection.checkpoint}
      data-application-checkpoint={projection.checkpoint}
      data-branch={branch.name}
      data-parent-stream={branch.parentStreamId ?? ""}
      data-fork-checkpoint={branch.forkOffset}
      data-head-checkpoint={projection.checkpoint}
      data-state-digest={projection.digest}
      data-content-digest={state.contentDigest}
      data-content-stream={state.contentStreamId ?? ""}
      data-file-path={state.currentPath ?? props.path}
      data-file-identity={state.identity ?? ""}
      data-file-status={state.status}
      data-reducer-version="1"
      data-stream-status={streamStatus}
    >
      <div className="file-heading">
        <h2 data-testid="file-title" className="sr-only">
          {state.currentPath ?? props.path}
        </h2>
        <div className="file-path-row">
          <BranchSelector
            org={props.org}
            repo={props.repo}
            branch={props.branch}
            path={props.path}
            kind="blob"
            projection={branches}
            headCheckpoint={projection.checkpoint}
            digest={projection.digest}
          />
          <nav aria-label="File path" data-testid="file-breadcrumbs" className="file-breadcrumbs">
            <RouteLink href={treeRoot} aria-label="File tree">
              {props.repo}
            </RouteLink>
            {pathSegments.map((segment, index) => (
              <span key={segment.href}>
                <span aria-hidden="true"> / </span>
                {index === pathSegments.length - 1 ? (
                  <strong>{segment.name}</strong>
                ) : (
                  <RouteLink href={segment.href}>{segment.name}</RouteLink>
                )}
              </span>
            ))}
            <button
              type="button"
              className="copy-path"
              aria-label="Copy file path"
              onClick={() => void navigator.clipboard?.writeText(state.currentPath ?? props.path)}
            >
              <Copy size={13} aria-hidden="true" />
            </button>
          </nav>
        </div>
        <span data-testid="file-stream-status" className="tree-status" data-status={streamStatus}>
          {streamStatus}
        </span>
      </div>
      {latestFileRecord === undefined || latestFile === undefined ? null : (
        <LatestCommitStrip
          actor={latestFile.actor}
          summary={latestFile.summary}
          checkpoint={projection.checkpoint}
          ts={latestFileRecord.ts}
          historyHref={historyHref}
        />
      )}
      <div className="file-panel">
        <div className="file-toolbar">
          <div className="file-toolbar-tabs">
            <DesktopTouchKit>
              {renderedMarkdown ? (
                <Segmented
                  aria-label="File view"
                  options={[
                    { id: "preview", label: "Preview" },
                    { id: "code", label: "Code" },
                  ]}
                  value={fileMode}
                  onChange={(id: string) => setFileMode(id === "code" ? "code" : "preview")}
                />
              ) : (
                <Segmented
                  aria-label="File view"
                  options={[
                    { id: "code", label: "Code" },
                    { id: "blame", label: "Blame" },
                  ]}
                  value="code"
                  onChange={() => undefined}
                />
              )}
            </DesktopTouchKit>
          </div>
          <small className="file-toolbar-facts">
            {lines === undefined ? null : <>{lines} lines · </>}
            {formatBytes(state.size)}
            <span aria-hidden="true"> · </span>
            <code title={state.contentDigest}>{state.contentDigest.slice(0, 7)}</code>
          </small>
        </div>
        <dl className="file-facts">
          <dt>Content stream</dt>
          <dd data-testid="file-content-stream">{state.contentStreamId ?? "—"}</dd>
          <dt>Application checkpoint</dt>
          <dd data-testid="file-checkpoint">{projection.checkpoint}</dd>
          <dt>Content digest</dt>
          <dd data-testid="file-digest">{state.contentDigest}</dd>
          <dt>Bytes</dt>
          <dd data-testid="file-size">{state.size}</dd>
        </dl>
        {streamStatus === "loading" ? <p data-testid="file-loading">Loading file…</p> : null}
        {refusal ? (
          <p role="alert" data-testid="file-refusal" className="projection-refusal">
            File projection refused: {streamStatus.slice("error:".length)}
          </p>
        ) : null}
        {!refusal && streamStatus !== "loading" && state.identity === null ? (
          <p role="alert" data-testid="file-missing" className="projection-refusal">
            This file is not present at the displayed checkpoint.
          </p>
        ) : null}
        {!refusal && state.status === "deleted" ? (
          <p role="alert" data-testid="file-deleted" className="projection-refusal">
            This file was deleted from the live stream.
          </p>
        ) : null}
        {!refusal && state.status === "binary" ? (
          <p data-testid="file-binary">Binary bytes are preserved; text coercion is disabled.</p>
        ) : null}
        {!refusal && state.status === "oversize" ? (
          <p data-testid="file-oversize">This file is larger than the safe browser view limit.</p>
        ) : null}
        {!refusal && state.status === "empty" && state.identity !== null ? (
          <p data-testid="file-empty">Waiting for the committed content generation…</p>
        ) : null}
        {!refusal && state.status === "text" ? (
          renderedMarkdown && fileMode === "preview" ? (
            <Markdown
              source={state.text ?? ""}
              className="file-markdown"
              data-testid="file-content"
            />
          ) : (
            <pre data-testid="file-content" tabIndex={0} className="file-code">
              {(state.text ?? "").split("\n").map((line, index) => (
                <span className="file-line" key={index}>
                  <span className="file-line-number" aria-hidden="true">
                    {index + 1}
                  </span>
                  <span className="file-line-text">{line}</span>
                </span>
              ))}
            </pre>
          )
        ) : null}
      </div>
    </section>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${String(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(2)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function DeepTrail(): React.JSX.Element {
  return (
    <section className="deep-trail" data-testid="deep-trail">
      <p className="eyebrow">Canopy trail</p>
      <h1>Deep trail</h1>
      <p>This trail is a valid application route. Follow the live canopy projections from here.</p>
      <nav aria-label="Deep trail links">
        <RouteLink href="/">Return home</RouteLink>
        <RouteLink href="/repositories">Repositories</RouteLink>
      </nav>
    </section>
  );
}

function RepositorySettings(props: {
  readonly org: string;
  readonly repo: string;
}): React.JSX.Element {
  return (
    <section className="repository-settings" data-testid="repository-settings">
      <p className="eyebrow">Repository preferences</p>
      <h1>Settings</h1>
      <p>
        Manage presentation and stream-backed collaboration defaults for {props.org} / {props.repo}.
      </p>
      <div className="settings-list">
        <label>
          <span>Default branch</span>
          <select defaultValue="main" aria-label="Default branch">
            <option value="main">main</option>
          </select>
        </label>
        <label>
          <span>Merge evidence required</span>
          <input type="checkbox" defaultChecked />
        </label>
      </div>
    </section>
  );
}

export function PageRouter(props: { readonly pathname: string }): React.JSX.Element {
  const segments = props.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return <RegistryBrowse />;
  if (
    segments.length === 5 &&
    segments[0] === "orgs" &&
    segments[2] === "repos" &&
    segments[4] === "settings"
  ) {
    const org = decodeRouteSegment(segments[1]!);
    const repo = decodeRouteSegment(segments[3]!);
    if (org === undefined || repo === undefined) {
      return <h2 data-testid="route-not-found">404 — trail not found</h2>;
    }
    return <RepositorySettings org={org} repo={repo} />;
  }
  if (
    segments.length >= 5 &&
    segments.length <= 7 &&
    segments[0] === "orgs" &&
    segments[2] === "repos" &&
    segments[4] === "pulls"
  ) {
    const org = decodeRouteSegment(segments[1]!);
    const repo = decodeRouteSegment(segments[3]!);
    const prId = segments.length >= 6 ? decodeRouteSegment(segments[5]!) : undefined;
    const tab = segments.length === 7 ? decodeRouteSegment(segments[6]!) : "activity";
    const tabs: readonly PrDetailTab[] = ["activity", "commits", "checks", "changes"];
    if (
      org === undefined ||
      repo === undefined ||
      (segments.length >= 6 && prId === undefined) ||
      tab === undefined ||
      !tabs.includes(tab as PrDetailTab)
    ) {
      return <h2 data-testid="route-not-found">404 — trail not found</h2>;
    }
    return prId === undefined ? (
      <PrListPage org={org} repo={repo} />
    ) : (
      <PrDetailPage
        key={`pr:${org}/${repo}/${prId}`}
        org={org}
        repo={repo}
        prId={prId}
        tab={tab as PrDetailTab}
      />
    );
  }
  if (
    segments.length >= 5 &&
    segments.length <= 7 &&
    segments[0] === "orgs" &&
    segments[2] === "repos" &&
    segments[4] === "wiki"
  ) {
    const org = decodeRouteSegment(segments[1]!);
    const repo = decodeRouteSegment(segments[3]!);
    const slug = segments.length >= 6 ? decodeRouteSegment(segments[5]!) : undefined;
    const editor = segments.length === 7 && segments[6] === "edit";
    if (
      org === undefined ||
      repo === undefined ||
      (segments.length >= 6 && (slug === undefined || !isWikiSlug(slug))) ||
      (segments.length === 7 && !editor)
    ) {
      return <h2 data-testid="route-not-found">404 — trail not found</h2>;
    }
    return (
      <WikiRoute
        key={`wiki:${org}/${repo}/${slug ?? "index"}:${editor ? "edit" : "view"}`}
        org={org}
        repo={repo}
        {...(slug === undefined ? {} : { slug })}
        {...(editor ? { editor: true } : {})}
      />
    );
  }
  if (
    (segments.length === 5 || segments.length === 6) &&
    segments[0] === "orgs" &&
    segments[2] === "repos" &&
    segments[4] === "issues"
  ) {
    const org = decodeRouteSegment(segments[1]!);
    const repo = decodeRouteSegment(segments[3]!);
    const issueId = segments.length === 6 ? decodeRouteSegment(segments[5]!) : undefined;
    if (
      org === undefined ||
      repo === undefined ||
      (segments.length === 6 && issueId === undefined)
    ) {
      return <h2 data-testid="route-not-found">404 — trail not found</h2>;
    }
    return issueId === undefined ? (
      <IssueBoardPage org={org} repo={repo} />
    ) : (
      <IssueDetailPage
        key={`issue:${org}/${repo}/${issueId}`}
        org={org}
        repo={repo}
        issueId={issueId}
      />
    );
  }
  if (
    segments.length === 5 &&
    segments[0] === "orgs" &&
    segments[2] === "repos" &&
    segments[4] === "labels"
  ) {
    const org = decodeRouteSegment(segments[1]!);
    const repo = decodeRouteSegment(segments[3]!);
    if (org === undefined || repo === undefined) {
      return <h2 data-testid="route-not-found">404 — trail not found</h2>;
    }
    return <LabelManagement org={org} repo={repo} />;
  }
  if (segments.length === 2 && segments[0] === "members") {
    const org = decodeRouteSegment(segments[1]!);
    if (org === undefined) return <h2 data-testid="route-not-found">404 — trail not found</h2>;
    return <MembersPage key={`members:${org}`} org={org} />;
  }
  if (segments.length === 3 && segments[0] === "invite") {
    const org = decodeRouteSegment(segments[1]!);
    const token = decodeRouteSegment(segments[2]!);
    if (org === undefined || token === undefined) {
      return <h2 data-testid="route-not-found">404 — trail not found</h2>;
    }
    return <InvitePage key={`invite:${org}/${token}`} org={org} token={token} />;
  }
  if (segments.length === 3 && segments[0] === "chat") {
    const org = decodeRouteSegment(segments[1]!);
    const channel = decodeRouteSegment(segments[2]!);
    if (org === undefined || channel === undefined) {
      return <h2 data-testid="route-not-found">404 — trail not found</h2>;
    }
    return <ChatChannelPage key={`chat:${org}/${channel}`} org={org} channel={channel} />;
  }
  if (segments.length === 4 && segments[0] === "inspect") {
    return <StreamInspector org={segments[1]!} repo={segments[2]!} branch={segments[3]!} />;
  }
  if (segments.length === 4 && (segments[0] === "history" || segments[2] === "history")) {
    const route = parseHistoryRoute(segments);
    if (route === undefined) return <h2 data-testid="route-not-found">404 — trail not found</h2>;
    return (
      <HistoryView
        key={`history:${route.org}/${route.repo}/${route.branch}`}
        org={route.org}
        repo={route.repo}
        branch={route.branch}
      />
    );
  }
  if (segments.length >= 4 && segments[2] === "blob") {
    const route = parseBlobRoute(segments);
    if (route === undefined || route.path === "") {
      return <h2 data-testid="route-not-found">404 — trail not found</h2>;
    }
    return (
      <FileViewer
        key={`blob:${route.org}/${route.repo}/${route.branch}/${route.path}`}
        {...route}
      />
    );
  }
  if (segments.length >= 4 && segments[2] === "tree") {
    const route = parseTreeRoute(segments);
    if (route === undefined) {
      return <h2 data-testid="route-not-found">404 — trail not found</h2>;
    }
    return (
      <TreeBrowser
        key={`tree:${route.org}/${route.repo}/${route.branch}/${route.path}`}
        {...route}
      />
    );
  }
  if (segments.length === 1 && segments[0] === "repositories") return <RegistryBrowse />;
  if (segments.length === 1) return <RegistryBrowse org={segments[0]!} />;
  if (segments.length === 2 && segments[0] === "organizations") {
    return <RegistryBrowse org={segments[1]!} />;
  }
  if (segments.length === 2) return <RepositoryHome org={segments[0]!} repo={segments[1]!} />;
  if (segments.join("/") === "lost/deep/trail") return <DeepTrail />;
  return <h2 data-testid="route-not-found">404 — trail not found</h2>;
}
