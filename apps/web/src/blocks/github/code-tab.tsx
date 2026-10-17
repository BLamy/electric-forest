/* Provenance: registry/blocks/github-clone/code-tab.tsx — @brett_lamy/ui 2.0.0 registry block
   "github-clone" (https://blamy.github.io/ui/r/github-clone.json), installed as owned source.
   Every divergence from the upstream file carries an `ef:` marker. */
/* Code tab: branch toolbar, file table, README and About sidebar; folders and files with GitHub's file-tree sidebar. */
// ef: every view reads StreamFS projections (fs:<org>/<repo>:<branch>:meta, file-content views) and the
// repo-home branch catalog; the block's mock tree, readme and repository are not installed.
// ef:begin reads StreamFS projections, the branch catalog and the Docstream adapter
import { createContext, useContext, useState, type ReactNode } from "react";
import { Avatar, Button, Segmented, SyntaxHighlightingCopyButton, cn } from "@brett_lamy/ui";
import { useStreamReducer, type StreamReducerResult } from "@eforest/web-hooks";
import type { FsTree } from "@eforest/streamfs";
import { OFFSET_BEFORE_FIRST } from "@eforest/protocol";
import {
  fileViewStreamId,
  type FileContentState,
  type HistoryApplicationRecord,
  type RepositoryBranch,
  type RepositoryBranchesState,
  type RepositoryNamespaceState,
} from "@eforest/reducers";
import { Markdown } from "../../components/markdown/Markdown.js";
import { RepositoryTree } from "../../components/trees/RepositoryTree.js";
import { useSyntaxLines } from "../../components/code/syntax.js";
import { humanizeRecord } from "../../history.js";
import { RouteLink, navigate } from "../../navigation.js";
import { CloneDialog } from "./dialogs.js";
import { Box, Oct, ghButton, githubMarkdown, userOf, type Layout } from "./parts.js";
import { LIVE_FOLLOW } from "../../live.js"; // ef: the app-wide bounded long-poll hold
// ef:end

/* ── Live projections shared by the Code views ── */

const projectionCache = new Map<string, StreamReducerResult<unknown>>();

function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** ef: the repository's branch catalog (repo-home …:branches), followed live. */
export function useBranchCatalog(
  org: string,
  repo: string,
): StreamReducerResult<RepositoryBranchesState> {
  return useStreamReducer<RepositoryBranchesState>({
    apiPath: `/api/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/home/branches`,
    streamId: `repo-home:${org}/${repo}:branches`,
    reducerId: "repo-branches",
    ...LIVE_FOLLOW,
    reconnectDelayMs: 1_500,
    cache: projectionCache,
    cacheKey: `repo-branches:${org}/${repo}`,
  });
}

export function branchFor(
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

/** ef: the replayed namespace metadata, provided once by the repository frame (repo-header.tsx). */
export const RepoNamespaceContext = createContext<RepositoryNamespaceState["metadata"]>(null);

/** Relative time for real wall-clock stamps; fixtures with synthetic `ts` values show nothing. */
export function relativeTime(ts: number | undefined): string | undefined {
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

/* ── Code home ── */

// ef: the repository home resolves its default branch from the live catalog, then shows that tree.
export function CodeHome({ ui, org, repo }: { ui: Layout; org: string; repo: string }) {
  const branches = useBranchCatalog(org, repo);
  if (branches.status === "loading")
    return (
      <p role="status" className="text-muted-foreground">
        Loading repository…
      </p>
    );
  if (branches.status.startsWith("error:"))
    return (
      <p role="alert" className="text-destructive">
        This repository is unavailable or you do not have access.
      </p>
    );
  const names = Object.keys(branches.state.branches).sort();
  const branch = names.includes("main") ? "main" : names[0];
  if (branch === undefined)
    return (
      <Box className="grid place-items-center px-6 py-16 text-center">
        <Oct name="book" size={24} className="text-muted-foreground" />
        <h2 className="mt-3 mb-1 text-[20px] font-semibold">{repo}</h2>
        <p className="m-0 text-muted-foreground">This repository has no branches yet.</p>
      </Box>
    );
  return (
    <div data-testid="repository-home">
      <PathView
        key={`${org}/${repo}/${branch}`}
        ui={ui}
        org={org}
        repo={repo}
        branch={branch}
        path=""
        home
      />
    </div>
  );
}

export function Readme({
  markdown,
  phone,
  testId,
}: {
  markdown: string;
  phone: boolean;
  testId?: string;
}) {
  // ef: Markdown enters the Docstream adapter (URL policy) — never the package renderer.
  return (
    <Markdown
      source={markdown}
      {...(testId === undefined ? {} : { "data-testid": testId })}
      className={cn(
        githubMarkdown,
        "text-[16px] leading-[1.5] [&_table]:text-[14px]",
        phone ? "px-4 py-5" : "px-8 py-6",
      )}
    />
  );
}

// ef:begin native select over the live branch catalog (branch-switcher evidence)
/** ef: the branch picker is a native select over the live catalog (the evidence control). */
export function BranchSelector(props: {
  org: string;
  repo: string;
  branch: string;
  path: string;
  kind: "tree" | "blob" | "history";
  projection: StreamReducerResult<RepositoryBranchesState>;
  headCheckpoint: string;
  digest: string;
}) {
  const selected = branchFor(props.org, props.repo, props.branch, props.projection);
  // The catalog is a live projection, so branches registered after page load stream in.
  // The branch in the URL is always an option even when the catalog has not caught up
  // (or never will, e.g. a fork whose registration was skipped): otherwise the <select>
  // silently shows its first option and the picker lies about which branch is on screen.
  const catalog = Object.values(props.projection.state.branches);
  const branches = (
    catalog.some((branch) => branch.name === props.branch) ? catalog : [...catalog, selected]
  ).sort((left, right) => left.name.localeCompare(right.name));
  const root = `/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}/${props.kind}`;
  const suffix = props.path === "" ? "" : `/${encodedPath(props.path)}`;
  return (
    <div
      className="flex min-w-0 items-center"
      data-testid="branch-switcher"
      data-branch={selected.name}
      data-parent-stream={selected.parentStreamId ?? ""}
      data-fork-checkpoint={selected.forkOffset}
      data-head-checkpoint={props.headCheckpoint}
      data-state-digest={props.digest}
      data-catalog-status={props.projection.status}
    >
      <label htmlFor={`branch-switcher-${props.kind}`} className="sr-only">
        Branch
      </label>
      <span className={cn(ghButton(), "relative gap-1.5 pr-7")}>
        <Oct name="branch" className="text-muted-foreground" />
        <select
          id={`branch-switcher-${props.kind}`}
          data-testid="branch-selector"
          aria-label="Repository branch"
          value={props.branch}
          disabled={props.projection.status === "loading" && catalog.length === 0}
          onChange={(event) => {
            const branch = event.currentTarget.value;
            if (branch !== props.branch) navigate(`${root}/${encodeURIComponent(branch)}${suffix}`);
          }}
          className="max-w-[160px] cursor-pointer appearance-none truncate border-0 bg-transparent text-[14px] font-medium text-foreground [field-sizing:content]"
        >
          {branches.map((branch) => (
            <option key={branch.streamId} value={branch.name}>
              {branch.name}
            </option>
          ))}
        </select>
        <Oct
          name="chevDown"
          size={12}
          className="pointer-events-none absolute right-2 text-muted-foreground"
        />
      </span>
      <span className="sr-only" data-testid="branch-parent-stream">
        {selected.parentStreamId ?? "root"}
      </span>
      <code className="sr-only" data-testid="branch-fork-checkpoint">
        {selected.forkOffset}
      </code>
    </div>
  );
}
// ef:end

// ef:begin branch picker, live branch count and the ef CLI clone dialog
export function CodeToolbar({
  ui,
  org,
  repo,
  branch,
  path,
  branches,
  headCheckpoint,
  digest,
}: {
  ui: Layout;
  org: string;
  repo: string;
  branch: string;
  path: string;
  branches: StreamReducerResult<RepositoryBranchesState>;
  headCheckpoint: string;
  digest: string;
}) {
  const [cloneOpen, setCloneOpen] = useState(false);
  const count = Object.keys(branches.state.branches).length || 1;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <BranchSelector
        org={org}
        repo={repo}
        branch={branch}
        path={path}
        kind="tree"
        projection={branches}
        headCheckpoint={headCheckpoint}
        digest={digest}
      />
      {!ui.phone ? (
        // ef: the branch count links to the live branch catalog page (no tags stream exists).
        <RouteLink
          href={`/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/branches`}
          className="flex items-center gap-1.5 px-2 text-muted-foreground hover:text-link"
        >
          <Oct name="branch" />
          <b className="text-foreground">{count}</b> {count === 1 ? "Branch" : "Branches"}
        </RouteLink>
      ) : null}
      <span className="flex-1" />
      <Button
        className={ghButton(true)}
        onPress={() => setCloneOpen(true)}
        data-testid="tree-code-menu"
      >
        <Oct name="code" />
        Code
        <Oct name="chevDown" size={12} />
      </Button>
      <CloneDialog
        open={cloneOpen}
        onClose={() => setCloneOpen(false)}
        org={org}
        repo={repo}
        branch={branch}
      />
    </div>
  );
}
// ef:end

// ef:begin newest StreamFS record touching the view, humanized
// ef: the latest change is the newest StreamFS record touching the view, humanized, with its actor.
export function LastCommit({
  ui,
  actor,
  message,
  ts,
  checkpoint,
  historyHref,
}: {
  ui: Layout;
  actor: string;
  message: string;
  ts: number | undefined;
  checkpoint: string;
  historyHref: string;
}) {
  const when = relativeTime(ts);
  const known = actor !== "unknown-actor";
  return (
    <div className="flex w-full min-w-0 items-center gap-2" data-testid="latest-commit-strip">
      {known ? <Avatar c={userOf(actor)} size={24} /> : null}
      <b className="shrink-0 font-semibold">{known ? actor : "Latest change"}</b>
      <span className="min-w-0 truncate text-muted-foreground">{message}</span>
      <span className="sr-only">Event offset {checkpoint}</span>
      <span className="flex-1" />
      {!ui.phone && when !== undefined ? (
        <span className="shrink-0 font-mono text-[12px] text-muted-foreground">{when}</span>
      ) : null}
      <RouteLink
        href={historyHref}
        className="flex shrink-0 items-center gap-1.5 font-semibold text-foreground"
      >
        <Oct name="history" className="text-muted-foreground" />
        {ui.phone ? <span className="sr-only">History</span> : "History"}
      </RouteLink>
    </div>
  );
}
// ef:end

// ef:begin directory listing derived from the live FsTree
interface TreeEntry {
  readonly kind: "directory" | "file";
  readonly path: string;
  readonly name: string;
}
// ef:end

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
  const files = Object.keys(state.files).map((fullPath): TreeEntry | undefined => {
    if (!fullPath.startsWith(normalized)) return undefined;
    const remainder = fullPath.slice(normalized.length);
    if (remainder.length === 0 || remainder.includes("/")) return undefined;
    return { kind: "file", path: fullPath, name: remainder };
  });
  return [...directories, ...files]
    .filter((entry): entry is TreeEntry => entry !== undefined)
    .sort((left, right) =>
      left.kind === right.kind
        ? compareTreePaths(left.path, right.path)
        : left.kind === "directory"
          ? -1
          : 1,
    );
}

// ef:begin rows rendered by the caller from the live tree (tree-list / repository-file-table)
export function FileTable({
  ui,
  header,
  children,
}: {
  ui: Layout;
  header: ReactNode;
  children: ReactNode;
}) {
  // ef: rows are rendered by the caller from the live tree (entries + per-entry latest change).
  void ui;
  return (
    <Box header={header} data-testid="repository-file-table">
      <ul className="m-0 list-none p-0" data-testid="tree-list" aria-label="Repository files">
        {children}
      </ul>
    </Box>
  );
}
// ef:end

// ef:begin route links and evidence attributes on each row
export function FileRow({
  ui,
  icon,
  name,
  href,
  commit,
  when,
  rowProps,
}: {
  ui: Layout;
  icon: ReactNode;
  name: string;
  href: string;
  commit?: string;
  when?: string;
  rowProps?: Record<string, string>;
}) {
  return (
    <li
      {...rowProps}
      className="flex h-10 items-center gap-3 border-t border-border px-4 first:border-t-0 hover:bg-muted"
    >
      {icon}
      {/* ef: a route link instead of a state-setting button. */}
      <RouteLink
        href={href}
        className={cn(
          "min-w-0 truncate text-left text-[14px] text-foreground hover:text-link",
          ui.phone ? "flex-1" : "w-[34%] shrink-0",
        )}
      >
        {name}
      </RouteLink>
      {!ui.phone ? (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{commit}</span>
      ) : null}
      <span className="shrink-0 text-right text-muted-foreground">{when}</span>
    </li>
  );
}
// ef:end

// ef:begin replayed namespace metadata and live branch count
// ef: About shows the replayed namespace metadata (project, visibility, owners) and live branch count.
export function About({
  org,
  repo,
  branchCount,
  readmeHref,
}: {
  org: string;
  repo: string;
  branchCount: number;
  readmeHref: string | undefined;
}) {
  const metadata = useContext(RepoNamespaceContext);
  const section = "border-b border-border py-6 first:pt-0 last:border-0";
  const base = `/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
  return (
    <aside className="w-[296px] shrink-0 text-[14px]" aria-label="About">
      <div className={section}>
        <h2 className="mt-0 mb-4 text-[16px] font-semibold">About</h2>
        <p className="m-0 text-[16px] leading-6">
          {metadata === null ? (
            <span className="text-muted-foreground">Replaying repository metadata…</span>
          ) : (
            <>
              A {metadata.visibility} repository in the <b>{metadata.project}</b> project.
            </>
          )}
        </p>
        <ul className="mt-4 mb-0 list-none space-y-2 p-0 text-muted-foreground">
          {readmeHref === undefined ? null : (
            <li className="flex items-center gap-2">
              <Oct name="book" />
              <RouteLink href={readmeHref} className="text-muted-foreground hover:text-link">
                Readme
              </RouteLink>
            </li>
          )}
          <li className="flex items-center gap-2">
            <Oct name="pulse" />
            <RouteLink
              href={`${base}/history/main`}
              className="text-muted-foreground hover:text-link"
            >
              Activity
            </RouteLink>
          </li>
          <li className="flex items-center gap-2">
            <Oct name="branch" />
            <RouteLink href={`${base}/branches`} className="text-muted-foreground hover:text-link">
              {branchCount} {branchCount === 1 ? "branch" : "branches"}
            </RouteLink>
          </li>
          {metadata === null ? null : (
            <li className="flex items-center gap-2">
              <Oct name="people" />
              {metadata.repoOwner}
            </li>
          )}
        </ul>
      </div>
      <div className={section}>
        <h2 className="mt-0 mb-3 flex items-center gap-2 text-[16px] font-semibold">Stream</h2>
        <code className="block text-[12px] break-all text-muted-foreground">{`fs:${org}/${repo}:main:meta`}</code>
      </div>
    </aside>
  );
}
// ef:end

// ef:begin the live tree-browser evidence region with the Pierre RepositoryTree sidebar
/** A folder listing or a file viewer, with GitHub's file-tree sidebar at wide widths. */
// ef: PathView is the live tree browser (tree-browser evidence region); `home` renders the repository home
// layout (toolbar, file table, README, About) and a path renders the Pierre file-tree sidebar.
export function PathView({
  ui,
  org,
  repo,
  branch,
  path,
  home = false,
}: {
  ui: Layout;
  org: string;
  repo: string;
  branch: string;
  path: string;
  home?: boolean;
}) {
  const streamId = `fs:${org}/${repo}:${branch}:meta`;
  const apiPath = `/api/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/events`;
  const branches = useBranchCatalog(org, repo);
  const selected = branchFor(org, repo, branch, branches);
  const projection = useStreamReducer<FsTree>({
    apiPath,
    streamId,
    reducerId: "streamfs",
    ...LIVE_FOLLOW,
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
  const prefix = path.replace(/^\/+|\/+$/g, "");
  const entries = treeEntries(projection.state, prefix);
  const parts = prefix === "" ? [] : prefix.split("/");
  const base = `/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
  const rootHref = `${base}/tree/${encodeURIComponent(branch)}`;
  const blobRoot = `${base}/blob/${encodeURIComponent(branch)}`;
  const historyHref = `${base}/history/${encodeURIComponent(branch)}`;
  const crumbHref = (index: number): string =>
    `${rootHref}/${encodedPath(parts.slice(0, index + 1).join("/"))}`;
  const status = projection.status;
  const error = status.startsWith("error:");
  const latestRecord = projection.records.at(-1);
  const latest =
    latestRecord === undefined
      ? undefined
      : humanizeRecord(latestRecord as HistoryApplicationRecord);
  const readme = entries.find((entry) => entry.kind === "file" && /^readme\.md$/i.test(entry.name));
  const crumbs = (
    <nav
      className="flex min-w-0 flex-wrap items-center gap-1 text-[16px]"
      aria-label="Tree path"
      data-testid="tree-breadcrumbs"
    >
      <RouteLink href={rootHref} aria-label={`${repo} file tree`} className="font-semibold">
        {repo}
      </RouteLink>
      {parts.map((p, i) => (
        <span key={crumbHref(i)} className="flex items-center gap-1">
          <span className="text-tertiary-foreground" aria-hidden="true">
            /
          </span>
          {i === parts.length - 1 ? (
            <b className="font-semibold">{p}</b>
          ) : (
            <RouteLink href={crumbHref(i)}>{p}</RouteLink>
          )}
        </span>
      ))}
    </nav>
  );
  const table = (
    <FileTable
      ui={ui}
      header={
        latestRecord === undefined || latest === undefined ? (
          <span className="text-muted-foreground">No changes yet</span>
        ) : (
          <LastCommit
            ui={ui}
            actor={latest.actor}
            message={latest.summary}
            ts={latestRecord.ts}
            checkpoint={projection.checkpoint}
            historyHref={historyHref}
          />
        )
      }
    >
      {prefix === "" ? null : (
        <FileRow
          ui={ui}
          icon={<Oct name="folder" className="text-[var(--gh-folder)]" />}
          name=".."
          href={parts.length > 1 ? crumbHref(parts.length - 2) : rootHref}
        />
      )}
      {entries.map((entry) => {
        const href = `${entry.kind === "directory" ? rootHref : blobRoot}/${encodedPath(entry.path)}`;
        const record = [...projection.records].reverse().find((item) => {
          const payload = item.payload as { path?: string; to?: string };
          const changed = payload.path ?? payload.to;
          return (
            typeof changed === "string" &&
            (changed === entry.path ||
              (entry.kind === "directory" && changed.startsWith(`${entry.path}/`)))
          );
        });
        const change =
          record === undefined ? undefined : humanizeRecord(record as HistoryApplicationRecord);
        return (
          <FileRow
            key={entry.path}
            ui={ui}
            name={entry.name}
            href={href}
            commit={change?.summary ?? ""}
            when={record === undefined ? "" : (relativeTime(record.ts) ?? "")}
            rowProps={{ "data-testid": "repository-file-row", "data-path": entry.path }}
            icon={
              entry.kind === "directory" ? (
                <Oct name="folder" className="text-[var(--gh-folder)]" />
              ) : (
                <Oct name="file" className="text-muted-foreground" />
              )
            }
          />
        );
      })}
    </FileTable>
  );
  return (
    <section
      className={cn("flex gap-6", ui.phone && "px-4 py-4")}
      data-testid="tree-browser"
      data-ef-stream={streamId}
      data-ef-offset={projection.checkpoint}
      data-ef-digest={projection.digest}
      data-application-checkpoint={projection.checkpoint}
      data-branch={selected.name}
      data-parent-stream={selected.parentStreamId ?? ""}
      data-fork-checkpoint={selected.forkOffset}
      data-head-checkpoint={projection.checkpoint}
      data-state-digest={projection.digest}
      data-tree-digest={projection.digest}
      data-session-checkpoint={sessionProjection.checkpoint}
      data-session-digest={sessionProjection.digest}
      data-session-status={sessionProjection.status}
      data-reducer-version="2"
      data-stream-status={status}
    >
      {!home && !ui.phone ? (
        // ef: GitHub's file-tree sidebar is @pierre/trees over the live StreamFS tree (not parts.FileTree).
        <aside className="w-[280px] shrink-0 border-r border-border pr-4" aria-label="Files">
          <div className="mb-3 flex items-center gap-2">
            <Oct name="sidebar" className="text-muted-foreground" />
            <b className="text-[16px] font-semibold">Files</b>
          </div>
          <RepositoryTree
            tree={projection.state}
            {...(prefix === "" ? {} : { selectedPath: prefix })}
            onOpen={(target, kind) =>
              navigate(`${kind === "directory" ? rootHref : blobRoot}/${encodedPath(target)}`)
            }
          />
        </aside>
      ) : null}
      <div className="min-w-0 flex-1 space-y-4">
        <h2 data-testid="tree-title" className="sr-only">
          {repo} ({org} / {branch})
        </h2>
        <span data-testid="tree-stream-status" className="sr-only" data-status={status}>
          {status}
        </span>
        <CodeToolbar
          ui={ui}
          org={org}
          repo={repo}
          branch={branch}
          path={prefix}
          branches={branches}
          headCheckpoint={projection.checkpoint}
          digest={projection.digest}
        />
        {home || ui.phone ? null : crumbs}
        {home ? <div className="sr-only">{crumbs}</div> : null}
        <dl className="sr-only">
          <dt>Stream</dt>
          <dd data-testid="tree-stream">{streamId}</dd>
          <dt>Application checkpoint</dt>
          <dd data-testid="tree-checkpoint">{projection.checkpoint}</dd>
          <dt>Tree digest</dt>
          <dd data-testid="tree-digest">{projection.digest}</dd>
        </dl>
        {status === "loading" ? (
          <Box data-testid="tree-loading">
            <p className="m-0 px-4 py-3 text-muted-foreground" role="status">
              Loading tree…
            </p>
          </Box>
        ) : null}
        {error ? (
          <p role="alert" data-testid="tree-refusal" className="m-0 text-destructive">
            StreamFS tree projection refused: {status.slice("error:".length)}
          </p>
        ) : null}
        {!error && status !== "loading" ? (
          entries.length === 0 ? (
            <Box
              className="grid place-items-center px-6 py-12 text-center"
              data-testid="tree-empty"
            >
              <Oct name="book" size={24} className="text-muted-foreground" />
              <h2 className="mt-3 mb-1 text-[20px] font-semibold">
                {prefix === "" ? "Your repository is ready" : "This directory is empty"}
              </h2>
              <p className="m-0 text-muted-foreground">
                {prefix === ""
                  ? "Add your first files with the Electric Forest CLI."
                  : "Files added here will appear automatically."}
              </p>
              {prefix === "" ? (
                <code className="mt-3 rounded-md bg-muted px-2 py-1 font-mono text-[13px]">{`ef clone ${org}/${repo} ${branch}`}</code>
              ) : (
                <RouteLink href={rootHref} className="mt-3">
                  Back to repository
                </RouteLink>
              )}
            </Box>
          ) : (
            table
          )
        ) : null}
        {!error && status !== "loading" && readme !== undefined && (home || prefix === "") ? (
          <RepositoryReadme ui={ui} org={org} repo={repo} branch={branch} path={readme.path} />
        ) : null}
      </div>
      {home && ui.wide ? (
        <About
          org={org}
          repo={repo}
          branchCount={Object.keys(branches.state.branches).length || 1}
          readmeHref={readme === undefined ? undefined : `${blobRoot}/${encodedPath(readme.path)}`}
        />
      ) : null}
    </section>
  );
}
// ef:end

// ef:begin README from the file-content projection through the Docstream adapter
function RepositoryReadme(props: {
  ui: Layout;
  org: string;
  repo: string;
  branch: string;
  path: string;
}) {
  const streamId = fileViewStreamId(props.org, props.repo, props.branch, props.path);
  const projection = useStreamReducer<FileContentState>({
    apiPath: `/api/repos/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}/${encodeURIComponent(props.branch)}/blob/${encodedPath(props.path)}`,
    streamId,
    reducerId: "file-content",
    ...LIVE_FOLLOW,
  });
  const license = props.path.split("/").at(-1);
  return (
    <Box
      data-testid="repository-readme"
      data-ef-stream={streamId}
      data-ef-offset={projection.checkpoint}
      data-ef-digest={projection.digest}
      header={
        <div className="-my-2 flex items-center gap-4 self-stretch">
          <span className="relative flex h-full items-center gap-2 font-semibold after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-[var(--gh-tab)]">
            <Oct name="book" className="text-muted-foreground" />
            <RouteLink
              href={`/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}/blob/${encodeURIComponent(props.branch)}/${encodedPath(props.path)}`}
              className="text-foreground"
            >
              {license}
            </RouteLink>
          </span>
        </div>
      }
    >
      {projection.status.startsWith("error:") ? (
        <p role="alert" className="m-0 px-4 py-3 text-destructive">
          The README could not be loaded.
        </p>
      ) : projection.state.text === null ? (
        <p className="m-0 px-4 py-3 text-muted-foreground">Loading README…</p>
      ) : (
        <Readme markdown={projection.state.text} phone={props.ui.phone} />
      )}
    </Box>
  );
}
// ef:end

function formatBytes(size: number): string {
  if (size < 1024) return `${String(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(2)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

/** ef: the code view renders exact file text; line numbers are CSS counters so textContent is the file. */
function CodeLines({ text }: { text: string }) {
  const syntax = useSyntaxLines(text);
  const lines = text.split("\n");
  const trailingNewline = lines.length > 1 && lines.at(-1) === "";
  if (trailingNewline) lines.pop();
  return (
    <pre
      data-testid="file-content"
      tabIndex={0}
      aria-label="File contents"
      className="m-0 overflow-x-auto py-2 font-mono text-[12px] leading-5 [counter-reset:line] focus-visible:outline-2 focus-visible:outline-ring"
    >
      {lines.map((line, index) => (
        <span
          key={index}
          className="block pr-6 whitespace-pre [counter-increment:line] before:inline-block before:w-12 before:pr-4 before:text-right before:text-tertiary-foreground before:content-[counter(line)] before:select-none"
        >
          {syntax?.[index] === undefined
            ? line
            : syntax[index].map((segment, part) =>
                segment.type === "plain" ? (
                  segment.text
                ) : (
                  <span key={part} className={`bl-tok-${segment.type}`}>
                    {segment.text}
                  </span>
                ),
              )}
          {index < lines.length - 1 || trailingNewline ? "\n" : null}
        </span>
      ))}
    </pre>
  );
}

// ef: the file viewer is the live file-content projection with its typed states (missing, deleted,
// binary, oversize, empty, refused) and every evidence attribute of the view stream.
export function FileViewer({
  ui,
  org,
  repo,
  branch,
  path,
}: {
  ui: Layout;
  org: string;
  repo: string;
  branch: string;
  path: string;
}) {
  const streamId = fileViewStreamId(org, repo, branch, path);
  const branches = useBranchCatalog(org, repo);
  const selected = branchFor(org, repo, branch, branches);
  const projection = useStreamReducer<FileContentState>({
    apiPath: `/api/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/blob/${encodedPath(path)}`,
    streamId,
    reducerId: "file-content",
    ...LIVE_FOLLOW,
    reconnectDelayMs: 1_000,
    cache: projectionCache,
    cacheKey: `file-content:${streamId}`,
  });
  const state = projection.state;
  const base = `/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
  const treeRoot = `${base}/tree/${encodeURIComponent(branch)}`;
  const historyHref = `${base}/history/${encodeURIComponent(branch)}`;
  const streamStatus = projection.status;
  const refusal = streamStatus.startsWith("error:");
  const filePath = state.currentPath ?? path;
  const isMd = /\.md$/i.test(filePath);
  const [view, setView] = useState<"preview" | "code">("preview");
  const lines =
    state.status === "text" && state.text !== null
      ? state.text.replace(/\n$/, "").split("\n").length
      : undefined;
  const fileSegments = filePath.split("/").filter(Boolean);
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
      className={cn("min-w-0 space-y-4", ui.phone && "px-4 py-4")}
      data-testid="file-viewer"
      data-ef-stream={streamId}
      data-ef-offset={projection.checkpoint}
      data-ef-digest={projection.digest}
      data-application-checkpoint={projection.checkpoint}
      data-branch={selected.name}
      data-parent-stream={selected.parentStreamId ?? ""}
      data-fork-checkpoint={selected.forkOffset}
      data-head-checkpoint={projection.checkpoint}
      data-state-digest={projection.digest}
      data-content-digest={state.contentDigest}
      data-content-stream={state.contentStreamId ?? ""}
      data-file-path={filePath}
      data-file-identity={state.identity ?? ""}
      data-file-status={state.status}
      data-reducer-version="1"
      data-stream-status={streamStatus}
    >
      <h2 data-testid="file-title" className="sr-only">
        {filePath}
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        <BranchSelector
          org={org}
          repo={repo}
          branch={branch}
          path={path}
          kind="blob"
          projection={branches}
          headCheckpoint={projection.checkpoint}
          digest={projection.digest}
        />
        <nav
          aria-label="File path"
          data-testid="file-breadcrumbs"
          className="flex min-w-0 flex-wrap items-center gap-1 text-[16px]"
        >
          <RouteLink href={treeRoot} aria-label={`${repo} file tree`} className="font-semibold">
            {repo}
          </RouteLink>
          {fileSegments.map((name, index) => {
            const href = `${treeRoot}/${encodedPath(fileSegments.slice(0, index + 1).join("/"))}`;
            return (
              <span key={href} className="flex items-center gap-1">
                <span className="text-tertiary-foreground" aria-hidden="true">
                  /
                </span>
                {index === fileSegments.length - 1 ? (
                  <b className="font-semibold">{name}</b>
                ) : (
                  <RouteLink href={href}>{name}</RouteLink>
                )}
              </span>
            );
          })}
          <SyntaxHighlightingCopyButton
            value={filePath}
            label="Copy file path"
            className={cn(ghButton(), "ml-1 h-7 w-7 border-0 bg-transparent px-0")}
          />
        </nav>
        <span data-testid="file-stream-status" className="sr-only" data-status={streamStatus}>
          {streamStatus}
        </span>
      </div>
      {latestFileRecord === undefined || latestFile === undefined ? null : (
        <Box className="px-4 py-3">
          <LastCommit
            ui={ui}
            actor={latestFile.actor}
            message={latestFile.summary}
            ts={latestFileRecord.ts}
            checkpoint={projection.checkpoint}
            historyHref={historyHref}
          />
        </Box>
      )}
      <Box
        header={
          <div className="flex w-full flex-wrap items-center gap-3">
            {isMd ? (
              <Segmented
                aria-label="File view"
                value={view}
                onChange={(id) => setView(id === "code" ? "code" : "preview")}
                className="w-[150px] rounded-md"
                options={[
                  { id: "preview", label: "Preview" },
                  { id: "code", label: "Code" },
                ]}
              />
            ) : (
              // ef: no blame projection exists yet, so a plain label replaces the Code / Blame toggle.
              <span className="font-semibold">Code</span>
            )}
            {!ui.phone ? (
              <span className="text-[12px] text-muted-foreground">
                {lines === undefined ? null : <>{lines} lines · </>}
                {formatBytes(state.size)} ·{" "}
                <code title={state.contentDigest}>{state.contentDigest.slice(0, 7)}</code>
              </span>
            ) : null}
            <span className="flex-1" />
            {state.status === "text" && state.text !== null ? (
              <SyntaxHighlightingCopyButton
                value={state.text}
                label="Copy raw file"
                className={cn(ghButton(), "h-7 w-7 px-0")}
              />
            ) : null}
          </div>
        }
      >
        <dl className="sr-only">
          <dt>Content stream</dt>
          <dd data-testid="file-content-stream">{state.contentStreamId ?? "—"}</dd>
          <dt>Application checkpoint</dt>
          <dd data-testid="file-checkpoint">{projection.checkpoint}</dd>
          <dt>Content digest</dt>
          <dd data-testid="file-digest">{state.contentDigest}</dd>
          <dt>Bytes</dt>
          <dd data-testid="file-size">{state.size}</dd>
        </dl>
        {streamStatus === "loading" ? (
          <p data-testid="file-loading" className="m-0 px-4 py-3 text-muted-foreground">
            Loading file…
          </p>
        ) : null}
        {refusal ? (
          <p role="alert" data-testid="file-refusal" className="m-0 px-4 py-3 text-destructive">
            File projection refused: {streamStatus.slice("error:".length)}
          </p>
        ) : null}
        {!refusal && streamStatus !== "loading" && state.identity === null ? (
          <p role="alert" data-testid="file-missing" className="m-0 px-4 py-3 text-destructive">
            This file is not present at the displayed checkpoint.
          </p>
        ) : null}
        {!refusal && state.status === "deleted" ? (
          <p role="alert" data-testid="file-deleted" className="m-0 px-4 py-3 text-destructive">
            This file was deleted from the live stream.
          </p>
        ) : null}
        {!refusal && state.status === "binary" ? (
          <p data-testid="file-binary" className="m-0 px-4 py-3 text-muted-foreground">
            Binary bytes are preserved; text coercion is disabled.
          </p>
        ) : null}
        {!refusal && state.status === "oversize" ? (
          <p data-testid="file-oversize" className="m-0 px-4 py-3 text-muted-foreground">
            This file is larger than the safe browser view limit.
          </p>
        ) : null}
        {!refusal && state.status === "empty" && state.identity !== null ? (
          <p data-testid="file-empty" className="m-0 px-4 py-3 text-muted-foreground">
            Waiting for the committed content generation…
          </p>
        ) : null}
        {!refusal && state.status === "text" ? (
          isMd && view === "preview" ? (
            <Readme markdown={state.text ?? ""} phone={ui.phone} testId="file-content" />
          ) : (
            <CodeLines text={state.text ?? ""} />
          )
        ) : null}
      </Box>
    </section>
  );
}
