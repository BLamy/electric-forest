import { useEffect, useState, type MouseEvent } from "react";
import { isValidFsPath, type FsTree } from "@eforest/streamfs";
import { useStreamReducer } from "@eforest/web-hooks";
import type {
  RegistryRepoState,
  RegistryState,
  RepositoryBranchesState,
  RepositoryNamespaceState,
  RepositoryStatusState,
} from "@eforest/reducers";
import { IdentityRegion } from "./identity.js";

interface ProofReceiptValue {
  readonly identityStream: string;
  readonly offset: string;
  readonly digest: string;
  readonly cliDigest: string;
  readonly cliDigestMatches: boolean;
  readonly pkce: {
    readonly method: string;
    readonly challenge: string;
    readonly redeemed: boolean;
    readonly verifierExposed: boolean;
  };
}

function isProofReceipt(value: unknown): value is ProofReceiptValue {
  if (typeof value !== "object" || value === null) return false;
  const receipt = value as Partial<ProofReceiptValue>;
  return (
    typeof receipt.identityStream === "string" &&
    typeof receipt.offset === "string" &&
    typeof receipt.digest === "string" &&
    typeof receipt.cliDigest === "string" &&
    receipt.cliDigestMatches === true &&
    typeof receipt.pkce === "object" &&
    receipt.pkce !== null &&
    receipt.pkce.method === "S256" &&
    typeof receipt.pkce.challenge === "string" &&
    receipt.pkce.redeemed === true &&
    receipt.pkce.verifierExposed === false
  );
}

function ProofReceipt(): React.JSX.Element | null {
  const [receipt, setReceipt] = useState<ProofReceiptValue>();
  useEffect(() => {
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      try {
        const response = await fetch("/__proof/e3-t02", {
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (response.status === 404) return;
        if (response.status === 204) {
          retry = setTimeout(() => void load(), 250);
          return;
        }
        if (!response.ok) return;
        const value: unknown = await response.json();
        if (isProofReceipt(value)) setReceipt(value);
      } catch {
        if (!controller.signal.aborted) retry = setTimeout(() => void load(), 250);
      }
    };
    void load();
    return () => {
      controller.abort();
      if (retry !== undefined) clearTimeout(retry);
    };
  }, []);
  if (receipt === undefined) return null;
  return (
    <section className="proof-receipt" data-testid="proof-receipt">
      <div>
        <p className="eyebrow">Recorded proof receipt</p>
        <h2>PKCE and stream replay agree</h2>
      </div>
      <dl>
        <dt>PKCE method</dt>
        <dd data-testid="proof-pkce-method">{receipt.pkce.method}</dd>
        <dt>Challenge</dt>
        <dd data-testid="proof-pkce-challenge">{receipt.pkce.challenge}</dd>
        <dt>Authorization code</dt>
        <dd data-testid="proof-code-redeemed" className="proof-success">
          redeemed
        </dd>
        <dt>Verifier in browser</dt>
        <dd data-testid="proof-verifier-exposed">not exposed</dd>
        <dt>Identity stream</dt>
        <dd data-testid="proof-stream">{receipt.identityStream}</dd>
        <dt>Head offset</dt>
        <dd data-testid="proof-offset">{receipt.offset}</dd>
        <dt>Independent CLI digest</dt>
        <dd data-testid="proof-cli-digest">{receipt.cliDigest}</dd>
        <dt>DOM state digest</dt>
        <dd data-testid="proof-dom-digest">{receipt.digest}</dd>
        <dt>Literal equality</dt>
        <dd data-testid="proof-digest-match" className="proof-success">
          {receipt.cliDigestMatches ? "equal" : "different"}
        </dd>
      </dl>
    </section>
  );
}

function usePathname(): string {
  const [pathname, setPathname] = useState(window.location.pathname);
  useEffect(() => {
    const update = (): void => setPathname(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return pathname;
}

function RouteLink(props: {
  readonly href: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const navigate = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    window.history.pushState(null, "", props.href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  return (
    <a href={props.href} onClick={navigate}>
      {props.children}
    </a>
  );
}

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
  if (decoded.length === 0 || decoded.includes("/") || decoded.includes("\0")) return undefined;
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

function Route(props: { readonly pathname: string }): React.JSX.Element {
  const segments = props.pathname.split("/").filter(Boolean);
  if (segments.length === 4 && segments[0] === "inspect") {
    return <StreamInspector org={segments[1]!} repo={segments[2]!} branch={segments[3]!} />;
  }
  if (segments.length >= 4 && segments[2] === "tree") {
    const route = parseTreeRoute(segments);
    if (route === undefined) {
      return <h2 data-testid="route-not-found">404 — trail not found</h2>;
    }
    return (
      <TreeBrowser org={route.org} repo={route.repo} branch={route.branch} path={route.path} />
    );
  }
  if (segments.length === 1 && segments[0] === "repositories") {
    return <RegistryBrowse />;
  }
  if (segments.length === 2 && segments[0] === "organizations") {
    return <RegistryBrowse org={segments[1]!} />;
  }
  if (segments.length === 0) {
    return <h2 data-testid="route-home">Forest home</h2>;
  }
  if (segments.length === 1) {
    return <h2 data-testid="route-org">Organization: {segments[0]}</h2>;
  }
  if (segments.length === 2) {
    return <RepositoryHome org={segments[0]!} repo={segments[1]!} />;
  }
  return <h2 data-testid="route-not-found">404 — trail not found</h2>;
}

function ProjectionFacts(props: {
  readonly region: string;
  readonly checkpoint: string;
  readonly digest: string;
  readonly status: string;
}): React.JSX.Element {
  return (
    <dl className="projection-facts">
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
          {branchRows.length === 0 ? (
            <p>Loading branch catalog…</p>
          ) : (
            <ul className="branch-list" data-testid="branch-list">
              {branchRows.map((branch) => (
                <li key={branch.streamId} data-testid="branch-row" data-branch={branch.name}>
                  <strong>
                    <RouteLink
                      href={`/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}/tree/${encodeURIComponent(branch.name)}`}
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
        <p role="alert" data-testid="registry-refusal">
          The authorized repository projection was refused.
        </p>
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
                    {row.org}/{row.repo}
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

function TreeBrowser(props: {
  readonly org: string;
  readonly repo: string;
  readonly branch: string;
  readonly path: string;
}): React.JSX.Element {
  const streamId = `fs:${props.org}/${props.repo}:${props.branch}:meta`;
  const apiPath = `/api/repos/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}/${encodeURIComponent(props.branch)}/events`;
  const projection = useStreamReducer<FsTree>({
    apiPath,
    streamId,
    reducerId: "streamfs",
    followWaitMs: 1_000,
    reconnectDelayMs: 1_000,
  });
  const prefix = props.path.replace(/^\/+|\/+$/g, "");
  const entries = treeEntries(projection.state, prefix);
  const pathSegments = prefix === "" ? [] : prefix.split("/");
  const rootHref = `/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}/tree/${encodeURIComponent(props.branch)}`;
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
      <dl className="tree-facts">
        <dt>Stream</dt>
        <dd data-testid="tree-stream">{streamId}</dd>
        <dt>Application checkpoint</dt>
        <dd data-testid="tree-checkpoint">{projection.checkpoint}</dd>
        <dt>Tree digest</dt>
        <dd data-testid="tree-digest">{projection.digest}</dd>
      </dl>
      <nav className="tree-breadcrumbs" aria-label="Tree path" data-testid="tree-breadcrumbs">
        <RouteLink href={rootHref}>root</RouteLink>
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
                  <span>
                    <span aria-hidden="true">▱ </span>
                    {entry.name}
                  </span>
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

export function AppRoutes(): React.JSX.Element {
  const pathname = usePathname();
  return (
    <main data-testid="app-shell">
      <header>
        <div>
          <p className="eyebrow">electric forest</p>
          <h1>The canopy</h1>
        </div>
        <form action="/auth/logout" method="post">
          <button type="submit">Log out</button>
        </form>
      </header>
      <IdentityRegion />
      <nav aria-label="Canopy routes">
        <RouteLink href="/">Home</RouteLink>
        <RouteLink href="/maple">Maple</RouteLink>
        <RouteLink href="/maple/reading-room">Reading room</RouteLink>
        <RouteLink href="/maple/reading-room/tree/main">File tree</RouteLink>
        <RouteLink href="/repositories">Repositories</RouteLink>
        <RouteLink href="/inspect/maple/reading-room/main">Stream inspector</RouteLink>
        <RouteLink href="/lost/deep/trail">Missing trail</RouteLink>
      </nav>
      <ProofReceipt />
      <article>
        <Route pathname={pathname} />
        <p>Stream-backed views grow here in the next canopy gates.</p>
      </article>
    </main>
  );
}
