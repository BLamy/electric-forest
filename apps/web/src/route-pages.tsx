import { useStreamReducer, type StreamReducerResult } from "@eforest/web-hooks";
import { isValidFsPath, type FsTree } from "@eforest/streamfs";
import { OFFSET_BEFORE_FIRST } from "@eforest/protocol";
import type {
  FileContentState,
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
import { LabelManagement } from "./label-management.js";
import { IssueBoardPage } from "./issues/IssueBoard.js";
import { IssueDetailPage } from "./issues/IssueDetail.js";
import { WikiRoute } from "./wiki/WikiRoute.js";
import { isWikiSlug } from "./wiki/useWiki.js";

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
          <h2 data-testid="route-repo">
            {props.org} / {props.repo}
          </h2>
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
  const projection = useStreamReducer<RegistryState>({
    apiPath: "/registry/me",
    streamId: "__registry__",
    reducerId: "registry",
    followWaitMs: 1_000,
  });
  const organizations = Object.keys(projection.state.orgs).sort();
  const rows = registryRows(projection.state, props.org);
  const error = projection.status.startsWith("error:");
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
      <p className="eyebrow">Live registry projection</p>
      <h2 data-testid={props.org === undefined ? "route-home" : "route-org"}>
        {props.org === undefined ? "Your repositories" : `Organization: ${props.org}`}
      </h2>
      <p className="registry-meta">
        Reduced from the authorized registry event range. New repositories appear here live.
      </p>
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
          {props.org === undefined && organizations.length > 0 ? (
            <nav className="organization-list" aria-label="Your organizations">
              {organizations.map((org) => (
                <RouteLink key={org} href={`/organizations/${encodeURIComponent(org)}`}>
                  {org}
                </RouteLink>
              ))}
            </nav>
          ) : null}
          {rows.length === 0 ? (
            <p data-testid="registry-empty">
              {props.org === undefined
                ? "No repositories yet."
                : "No repositories are visible in this organization."}
            </p>
          ) : (
            <ul className="repository-list" data-testid="repository-list">
              {rows.map((row) => (
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
                    {row.repo === "reading-room" ? "Reading room" : `${row.org}/${row.repo}`}
                  </RouteLink>
                  <span>{row.project}</span>
                  <span>{row.visibility}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
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
      <h2>Stream inspector</h2>
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
      <h2>History</h2>
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
      data-reducer-version="2"
      data-stream-status={status}
    >
      <div className="tree-heading">
        <div>
          <p className="eyebrow">Live StreamFS tree</p>
          <h2 data-testid="tree-title">
            {props.org} / {props.repo} / {props.branch}
          </h2>
        </div>
        <span data-testid="tree-stream-status" className="tree-status">
          {status}
        </span>
      </div>
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
      <dl className="tree-facts">
        <dt>Stream</dt>
        <dd data-testid="tree-stream">{streamId}</dd>
        <dt>Application checkpoint</dt>
        <dd data-testid="tree-checkpoint">{projection.checkpoint}</dd>
        <dt>Tree digest</dt>
        <dd data-testid="tree-digest">{projection.digest}</dd>
      </dl>
      <nav className="tree-breadcrumbs" aria-label="Tree path" data-testid="tree-breadcrumbs">
        <RouteLink href={rootHref}>File tree</RouteLink>
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
      {!error && status === "loading" ? (
        <ul className="tree-list tree-list-loading" data-testid="tree-list" aria-hidden="true">
          <li />
          <li />
          <li />
          <li />
          <li />
        </ul>
      ) : null}
      {!error && status !== "loading" ? (
        entries.length === 0 ? (
          <p data-testid="tree-empty">This directory is empty.</p>
        ) : (
          <ul className="tree-list" data-testid="tree-list">
            {entries.map((entry) => (
              <li
                key={entry.path}
                data-testid="tree-row"
                data-path={entry.path}
                data-kind={entry.kind}
              >
                {entry.kind === "directory" ? (
                  <RouteLink
                    href={`${rootHref}/${entry.path.split("/").map(encodeURIComponent).join("/")}`}
                  >
                    <span aria-hidden="true">▸ </span>
                    {entry.name}/
                  </RouteLink>
                ) : (
                  <RouteLink
                    href={`${blobRoot}/${entry.path.split("/").map(encodeURIComponent).join("/")}`}
                  >
                    <span aria-hidden="true">▱ </span>
                    {entry.name}
                  </RouteLink>
                )}
                {entry.detail === undefined ? null : <code>{entry.detail}</code>}
              </li>
            ))}
          </ul>
        )
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
  const streamStatus = projection.status;
  const refusal = streamStatus.startsWith("error:");
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
        <div>
          <p className="eyebrow">Live StreamFS file</p>
          <h2 data-testid="file-title">{state.currentPath ?? props.path}</h2>
        </div>
        <span data-testid="file-stream-status" className="tree-status">
          {streamStatus}
        </span>
      </div>
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
      <nav aria-label="File path" data-testid="file-breadcrumbs">
        <RouteLink href={treeRoot}>File tree</RouteLink>
        <span aria-hidden="true"> / </span>
        <span>{state.currentPath ?? props.path}</span>
      </nav>
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
        <pre data-testid="file-content" tabIndex={0}>
          {state.text}
        </pre>
      ) : null}
    </section>
  );
}

function DeepTrail(): React.JSX.Element {
  return (
    <section className="deep-trail" data-testid="deep-trail">
      <p className="eyebrow">Canopy trail</p>
      <h2>Deep trail</h2>
      <p>This trail is a valid application route. Follow the live canopy projections from here.</p>
      <nav aria-label="Deep trail links">
        <RouteLink href="/">Return home</RouteLink>
        <RouteLink href="/repositories">Repositories</RouteLink>
      </nav>
    </section>
  );
}

export function PageRouter(props: { readonly pathname: string }): React.JSX.Element {
  const segments = props.pathname.split("/").filter(Boolean);
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
  if (segments.length === 2 && segments[0] === "organizations") {
    return <RegistryBrowse org={segments[1]!} />;
  }
  if (segments.length === 2) return <RepositoryHome org={segments[0]!} repo={segments[1]!} />;
  if (segments.join("/") === "lost/deep/trail") return <DeepTrail />;
  return <h2 data-testid="route-not-found">404 — trail not found</h2>;
}
