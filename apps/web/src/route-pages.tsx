import { lazy, useState } from "react";
import { Button, Icon, List, ListRow, ListSection, SearchField, cn } from "@brett_lamy/ui";
import { useDispatch, useStreamReducer } from "@eforest/web-hooks";
import { isValidFsPath } from "@eforest/streamfs";
import type { HistoryState, RegistryRepoState, RegistryState } from "@eforest/reducers";
import { isWikiSlug } from "@eforest/meadow";
import { RouteLink, navigate, repoLabelsPath } from "./navigation.js";
import { humanizeRecord } from "./history.js";
import { loadPrDetail } from "./prs/preload.js";
import { personalAccount } from "./personal-account.js";
import { useWhoami } from "./chat/useWhoami.js";
import { AppSheet } from "./components/overlay.js";
import { useLayout } from "./blocks/github/page.js";
import { Box, Counter, Oct, ghButton, ghField, type Layout } from "./blocks/github/parts.js";
import {
  BranchSelector,
  CodeHome,
  FileViewer,
  PathView,
  branchFor,
  useBranchCatalog,
} from "./blocks/github/code-tab.js";
import { PullList } from "./blocks/github/pulls-tab.js";
import { IssueList } from "./blocks/github/issues-tab.js";
import type { PullRequestTab } from "./blocks/github/pull-request.js";
import { LIVE_FOLLOW } from "./live.js";
import { useRefreshRegistry, useRegistryProjection } from "./registry-context.js";
import { repositorySearchHref } from "./repository-search.js";

const LabelManagement = lazy(async () => {
  const module = await import("./label-management.js");
  return { default: module.LabelManagement };
});
const IssueDetailPage = lazy(async () => {
  const module = await import("./issues/IssueDetail.js");
  return { default: module.IssueDetailPage };
});
const WikiRoute = lazy(async () => {
  const module = await import("./wiki/WikiRoute.js");
  return { default: module.WikiRoute };
});
const PullRequestView = lazy(async () => {
  const module = await loadPrDetail();
  return { default: module.PullRequestView };
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

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    /* clipboard access is a browser permission, never a product error */
  }
}

function NotFound(): React.JSX.Element {
  return (
    <Box className="grid place-items-center px-6 py-16 text-center">
      <Oct name="x" size={24} className="text-muted-foreground" />
      <h2 data-testid="route-not-found" className="mt-3 mb-1 text-[20px] font-semibold">
        404 — trail not found
      </h2>
      <RouteLink href="/">Return home</RouteLink>
    </Box>
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

function RegistryBrowse(props: { readonly ui: Layout; readonly org?: string }): React.JSX.Element {
  const refreshRegistry = useRefreshRegistry();
  const [syncStatus, setSyncStatus] = useState<string | undefined>(undefined);
  const projection = useRegistryProjection();
  const user = useWhoami();
  const personal = personalAccount(user);
  const scope = props.org ?? personal?.namespace;
  const personalOrg = personal === null ? undefined : projection.state.orgs[personal.namespace];
  const personalOwned = user !== null && personalOrg?.owner === user.sub;
  const organizations = Object.keys(projection.state.orgs)
    .filter((name) => name !== personal?.namespace)
    .sort();
  const rows =
    scope === undefined || (props.org === undefined && !personalOwned)
      ? []
      : registryRows(projection.state, scope);
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
  const openFirst = (): void => {
    const exact = repositorySearchHref(query, registryRows(projection.state));
    if (exact !== undefined) {
      navigate(exact);
      return;
    }
    const first = visibleRows[0];
    if (first !== undefined)
      navigate(`/${encodeURIComponent(first.org)}/${encodeURIComponent(first.repo)}`);
  };
  return (
    <section
      className={cn("grid gap-6", props.ui.phone && "px-4 py-4")}
      data-testid="registry-browser"
      data-registry-scope={props.org ?? "me"}
      data-application-checkpoint={projection.checkpoint}
      data-state-digest={projection.digest}
      data-reducer-version="1"
      data-stream-status={projection.status}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1
            className="m-0 text-[24px] font-semibold"
            data-testid={props.org === undefined ? "route-home" : "route-org"}
          >
            {props.org === undefined ? (personal?.name ?? "Your repositories") : props.org}
          </h1>
          <p className="mt-1 mb-0 text-muted-foreground">
            {props.org === undefined
              ? "Create and browse your Electric Forest repositories."
              : "Repositories in this workspace."}
          </p>
        </div>
        {props.org === undefined ? (
          <Button
            className={ghButton()}
            data-testid="dashboard-settings"
            onPress={() => window.location.assign("/settings/cli-tokens")}
          >
            <Oct name="gear" className="text-muted-foreground" />
            Settings
          </Button>
        ) : null}
      </div>
      <dl className="sr-only">
        <dt>Application checkpoint</dt>
        <dd data-testid="registry-checkpoint">{projection.checkpoint}</dd>
        <dt>Canonical digest</dt>
        <dd data-testid="registry-digest">{projection.digest}</dd>
        <dt>Status</dt>
        <dd data-testid="registry-status">{projection.status}</dd>
      </dl>
      {projection.status === "loading" ? (
        <p data-testid="registry-loading" role="status" className="m-0 text-muted-foreground">
          Loading repositories…
        </p>
      ) : error ? (
        <Box data-testid="registry-refusal" className="px-4 py-3">
          <p role="alert" className="m-0 font-semibold text-destructive">
            The authorized repository projection was refused.
          </p>
          <p className="mt-1 mb-0">
            Sign in to view your repositories and live organization updates.{" "}
            <a data-testid="registry-sign-in" href="/auth/login" className="text-link">
              Sign in
            </a>
            .
          </p>
        </Box>
      ) : (
        <>
          {props.org === undefined && recentRows.length > 0 ? (
            <section aria-labelledby="registry-recent-heading">
              <h2 id="registry-recent-heading" className="mt-0 mb-3 text-[16px] font-semibold">
                Recently viewed
              </h2>
              <div className="grid gap-3 sm:grid-cols-3">
                {recentRows.map((row) => (
                  <RouteLink
                    key={`${row.org}/${row.repo}`}
                    href={`/${encodeURIComponent(row.org)}/${encodeURIComponent(row.repo)}`}
                    className="grid gap-1 rounded-md border border-border bg-card p-3 text-foreground hover:bg-muted hover:no-underline"
                  >
                    <span className="flex items-center gap-2 font-semibold text-link">
                      <Oct name="book" />
                      {row.org}/{row.repo}
                    </span>
                    <small className="text-muted-foreground">
                      {row.org} · {row.project}
                    </small>
                  </RouteLink>
                ))}
              </div>
            </section>
          ) : null}
          {props.org === undefined && organizations.length > 0 ? (
            <nav className="flex flex-wrap gap-2" aria-label="Your organizations">
              {organizations.map((org) => (
                <RouteLink
                  key={org}
                  href={`/organizations/${encodeURIComponent(org)}`}
                  className={cn(ghButton(), "text-foreground hover:no-underline")}
                >
                  <Oct name="people" className="text-muted-foreground" />
                  {org}
                </RouteLink>
              ))}
            </nav>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="m-0 mr-auto text-[16px] font-semibold">
              {props.org === undefined ? "Your repositories" : "Repositories"}
            </h2>
            <SearchField
              value={query}
              onChange={setQuery}
              onSubmit={openFirst}
              placeholder="Find repository…"
              aria-label="Find repository"
              className="h-8 w-[240px] rounded-md border border-border bg-muted px-2 py-0 text-[14px] [&_input]:text-[14px]"
            />
            <Button
              className={ghButton(true)}
              onPress={() => setCreating(true)}
              data-testid="registry-new"
              isDisabled={scope === undefined}
            >
              <Oct name="plus" />
              New
            </Button>
            <Button
              className={ghButton()}
              data-testid="registry-sync"
              onPress={() => {
                setSyncStatus("Registry projection refreshed from the authorized durable stream.");
                refreshRegistry();
              }}
            >
              Sync from GitHub
            </Button>
          </div>
          {syncStatus === undefined ? null : (
            <p
              className="m-0 text-muted-foreground"
              role="status"
              data-testid="registry-sync-status"
            >
              {syncStatus}
            </p>
          )}
          {rows.length === 0 ? (
            <Box className="grid place-items-center px-6 py-12 text-center">
              <Oct name="book" size={24} className="text-muted-foreground" />
              <p data-testid="registry-empty" className="mt-3 mb-0 text-muted-foreground">
                {props.org === undefined
                  ? "No repositories yet."
                  : "No repositories are visible in this organization."}
              </p>
            </Box>
          ) : visibleRows.length === 0 ? (
            <p className="m-0 text-muted-foreground">No repositories match “{query}”.</p>
          ) : (
            <Box
              header={
                <>
                  <b className="font-semibold">{visibleRows.length} repositories</b>
                  <Counter>{rows.length}</Counter>
                </>
              }
            >
              <ul className="m-0 list-none p-0" data-testid="repository-list">
                {visibleRows.map((row) => (
                  <li
                    key={`${row.org}/${row.repo}`}
                    data-testid="repository-row"
                    data-org={row.org}
                    data-repo={row.repo}
                    data-visibility={row.visibility}
                    className="flex items-center gap-3 border-t border-border px-4 py-3 first:border-t-0 hover:bg-muted"
                  >
                    <Oct name="book" className="text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <RouteLink
                        href={`/${encodeURIComponent(row.org)}/${encodeURIComponent(row.repo)}`}
                        className="font-semibold"
                      >
                        {row.org}/{row.repo}
                      </RouteLink>
                      <div className="text-[12px] text-muted-foreground">{row.project}</div>
                    </div>
                    <span className="rounded-full border border-border px-2 text-[12px] text-muted-foreground">
                      {row.visibility}
                    </span>
                    <button
                      type="button"
                      className={cn(ghButton(), "w-8 bg-transparent px-0")}
                      aria-label={`Actions for ${row.org}/${row.repo}`}
                      onClick={() => setMenuRow(row)}
                    >
                      <Oct name="kebab" />
                    </button>
                  </li>
                ))}
              </ul>
            </Box>
          )}
        </>
      )}
      <AppSheet open={creating} onClose={() => setCreating(false)} title="New repository">
        {scope === undefined ? (
          <p className="m-0">Sign in to create a repository.</p>
        ) : (
          <NewRepositoryForm
            key={scope}
            org={scope}
            project={rows[0]?.project ?? ""}
            projects={Object.keys(projection.state.orgs[scope]?.projects ?? {})}
            personal={props.org === undefined}
            namespaceReady={props.org !== undefined || personalOwned}
            namespaceConflict={
              props.org === undefined && personalOrg !== undefined && !personalOwned
            }
            onComplete={() => setCreating(false)}
          />
        )}
      </AppSheet>
      <AppSheet
        open={menuRow !== undefined}
        onClose={() => setMenuRow(undefined)}
        title={menuRow === undefined ? "Repository" : `${menuRow.org}/${menuRow.repo}`}
      >
        {menuRow === undefined ? null : (
          <RepositoryActions row={menuRow} onDone={() => setMenuRow(undefined)} />
        )}
      </AppSheet>
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
    navigate(href);
  };
  const streamId = `fs:${props.row.org}/${props.row.repo}:main:meta`;
  return (
    <List className="overflow-hidden rounded-xl border border-border">
      <ListSection title="Open">
        <ListRow
          title="Code"
          leading={<Icon name="layers" />}
          accessory="chevron"
          onPress={() => go(`/${org}/${repo}/tree/main`)}
        />
        <ListRow
          title="Pull requests"
          leading={<Icon name="text-bubble" />}
          accessory="chevron"
          onPress={() => go(`/orgs/${org}/repos/${repo}/pulls`)}
        />
        <ListRow
          title="Issues"
          leading={<Icon name="number" />}
          accessory="chevron"
          onPress={() => go(`/orgs/${org}/repos/${repo}/issues`)}
        />
        <ListRow
          title="Settings"
          leading={<Icon name="gear" />}
          accessory="chevron"
          onPress={() => go(`/orgs/${org}/repos/${repo}/settings`)}
        />
      </ListSection>
      <ListSection title="Stream" footer="Every list view is a reducer over this stream.">
        <ListRow
          title="Copy main stream id"
          subtitle={<code>{streamId}</code>}
          leading={<Icon name="pulse" />}
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

function dispatchErrorMessage(cause: unknown, fallback: string): string {
  const message = cause instanceof Error ? cause.message : fallback;
  if (message.includes("ns/name-taken")) {
    return "That repository name is already in use. Choose a different name.";
  }
  if (message.includes("ns/project-exists")) {
    return "That group already exists. Choose it from the Group menu or use another name.";
  }
  return message;
}

function NewRepositoryForm(props: {
  readonly org: string;
  readonly project: string;
  readonly personal?: boolean;
  readonly namespaceReady?: boolean;
  readonly namespaceConflict?: boolean;
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
  const rootDispatch = useDispatch("ns:root");
  const [namespaceCreated, setNamespaceCreated] = useState(false);
  const [createdProjects, setCreatedProjects] = useState<readonly string[]>([]);
  const valid = /^[a-z0-9][a-z0-9-]{0,62}$/.test(name) && /^[a-z0-9](?:-?[a-z0-9])*$/.test(project);
  const submit = async (): Promise<void> => {
    if (!valid || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (props.namespaceConflict)
        throw new Error("Your personal namespace is unavailable. No repository was created.");
      if (props.personal && !props.namespaceReady && !namespaceCreated) {
        await rootDispatch({
          type: "ns.org.create",
          payload: { v: 1, name: props.org },
          ts: Date.now(),
        });
        setNamespaceCreated(true);
      }
      if (!props.projects.includes(project) && !createdProjects.includes(project)) {
        await dispatch({
          type: "ns.project.create",
          payload: { v: 1, name: project },
          ts: Date.now(),
        });
        setCreatedProjects((previous) => [...previous, project]);
      }
      await dispatch({
        type: "ns.repo.create",
        payload: { v: 1, name, project, visibility },
        ts: Date.now(),
      });
      props.onComplete();
      navigate(`/${encodeURIComponent(props.org)}/${encodeURIComponent(name)}`);
    } catch (cause) {
      setError(dispatchErrorMessage(cause, "The repository could not be created."));
    } finally {
      setBusy(false);
    }
  };
  const label = "grid gap-1 text-[13px] font-semibold";
  return (
    <form
      className="grid gap-3"
      data-testid="new-repository-form"
      data-owner={props.org}
      data-personal={props.personal ?? false}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="m-0 flex items-center gap-1.5 text-muted-foreground">
        <Oct name="people" /> {props.org} {props.personal ? "· Personal account" : ""} /
      </p>
      <label className={label}>
        <span>Repository name</span>
        <input
          autoFocus
          className={ghField}
          value={name}
          onChange={(event) => setName(event.currentTarget.value.trim().toLowerCase())}
          placeholder="reading-room"
          aria-invalid={name.length > 0 && !valid}
        />
      </label>
      <label className={label}>
        <span>Group (optional)</span>
        <select
          className={ghField}
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
        <label className={label}>
          <span>New group name</span>
          <input
            className={ghField}
            value={newProject}
            onChange={(event) => setNewProject(event.currentTarget.value.trim().toLowerCase())}
            placeholder={name || "platform"}
            aria-invalid={newProject.length > 0 && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(newProject)}
          />
        </label>
      ) : null}
      <fieldset className="m-0 flex gap-4 border-0 p-0" data-testid="visibility-options">
        <legend className="mb-1 text-[13px] font-semibold">Visibility</legend>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name="visibility"
            value="public"
            checked={visibility === "public"}
            onChange={() => setVisibility("public")}
          />
          Public
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name="visibility"
            value="private"
            checked={visibility === "private"}
            onChange={() => setVisibility("private")}
          />
          Private
        </label>
      </fieldset>
      {error === undefined ? null : (
        <p role="alert" className="m-0 text-destructive">
          {error}
        </p>
      )}
      <button type="submit" className={ghButton(true)} disabled={!valid || busy}>
        {busy ? "Dispatching…" : "Create repository"}
      </button>
      <small className="text-muted-foreground">
        {props.personal
          ? "Creates a repository in your personal account. No workspace setup is needed."
          : "Creates a repository in this workspace."}
      </small>
    </form>
  );
}

function FactList(props: {
  readonly facts: readonly [string, string, string][];
}): React.JSX.Element {
  return (
    <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 px-4 py-3 text-[12px]">
      {props.facts.map(([label, testId, value]) => (
        <div key={testId} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd data-testid={testId} className="m-0 font-mono break-all">
            {value}
          </dd>
        </div>
      ))}
    </dl>
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
    ...LIVE_FOLLOW,
  });
  return (
    <Box
      data-testid="stream-inspector"
      data-stream-id={streamId}
      data-application-checkpoint={projection.checkpoint}
      data-state-digest={projection.digest}
      data-reducer-version="2"
      data-stream-status={projection.status}
      header={
        <>
          <Oct name="stream" className="text-muted-foreground" />
          <h1 className="m-0 text-[14px] font-semibold">Stream inspector</h1>
          <span className="text-muted-foreground">Live application projection</span>
        </>
      }
    >
      <FactList
        facts={[
          ["Stream", "inspector-stream", streamId],
          ["Application checkpoint", "inspector-checkpoint", projection.checkpoint],
          ["Canonical digest", "inspector-digest", projection.digest],
          ["Reducer", "inspector-reducer", "streamfs@2"],
          ["Status", "inspector-status", projection.status],
        ]}
      />
      <pre
        data-testid="inspector-state"
        className="m-0 max-h-[60vh] overflow-auto border-t border-border px-4 py-3 font-mono text-[12px]"
      >
        {JSON.stringify(projection.state, null, 2)}
      </pre>
    </Box>
  );
}

function HistoryView(props: {
  readonly ui: Layout;
  readonly org: string;
  readonly repo: string;
  readonly branch: string;
}): React.JSX.Element {
  const streamId = `fs:${props.org}/${props.repo}:${props.branch}:meta`;
  const apiPath = `/api/repos/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}/${encodeURIComponent(props.branch)}/events`;
  const branches = useBranchCatalog(props.org, props.repo);
  const selected = branchFor(props.org, props.repo, props.branch, branches);
  const projection = useStreamReducer<HistoryState>({
    apiPath,
    streamId,
    reducerId: "history",
    ...LIVE_FOLLOW,
    reconnectDelayMs: 1_000,
    cacheKey: `history:${streamId}`,
  });
  const rows = [...projection.state.records].reverse();
  return (
    <section
      className={cn("grid gap-4", props.ui.phone && "px-4 py-4")}
      data-testid="history-view"
      data-stream-id={streamId}
      data-ef-stream={streamId}
      data-ef-offset={projection.checkpoint}
      data-ef-digest={projection.digest}
      data-application-checkpoint={projection.checkpoint}
      data-state-digest={projection.digest}
      data-stream-status={projection.status}
      data-record-count={String(rows.length)}
      data-branch={selected.name}
    >
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 mr-auto text-[20px] font-semibold">History</h1>
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
      </div>
      <dl className="sr-only">
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
        <p role="alert" data-testid="history-refusal" className="m-0 text-destructive">
          History projection refused: {projection.status.slice("error:".length)}
        </p>
      ) : null}
      <Box
        header={
          <>
            <Oct name="commit" className="text-muted-foreground" />
            <b className="font-semibold">Canonical application history</b>
            <Counter>{rows.length}</Counter>
          </>
        }
      >
        <ol data-testid="history-rows" className="m-0 list-none p-0">
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
                className="grid gap-1 border-t border-border px-4 py-3 first:border-t-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <strong data-testid="history-row-kind">{human.kind}</strong>
                  <span data-testid="history-row-actor" className="text-muted-foreground">
                    {human.actor}
                  </span>
                  <code
                    data-testid="history-row-offset"
                    className="ml-auto text-[12px] text-muted-foreground"
                  >
                    {record.offset}
                  </code>
                </div>
                <p data-testid="history-row-summary" className="m-0">
                  {human.summary}
                </p>
                {!human.known ? (
                  <pre
                    data-testid="history-row-raw"
                    className="m-0 overflow-x-auto font-mono text-[12px]"
                  >
                    {human.raw}
                  </pre>
                ) : null}
                <small data-testid="history-row-source" className="text-tertiary-foreground">
                  {record.sourceStreamId}
                </small>
              </li>
            );
          })}
        </ol>
      </Box>
    </section>
  );
}

/** The repository's branch catalog (repo-home …:branches): every native fork with its parent and fork point. */
function BranchesPage(props: {
  readonly ui: Layout;
  readonly org: string;
  readonly repo: string;
}): React.JSX.Element {
  const branches = useBranchCatalog(props.org, props.repo);
  const rows = Object.values(branches.state.branches).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  return (
    <section className={cn("grid gap-4", props.ui.phone && "px-4 py-4")}>
      <h1 className="m-0 text-[20px] font-semibold">Branches</h1>
      <Box
        data-testid="repo-branches-region"
        data-application-checkpoint={branches.checkpoint}
        data-state-digest={branches.digest}
        data-stream-status={branches.status}
        header={
          <>
            <Oct name="branch" className="text-muted-foreground" />
            <b className="font-semibold">Native forks</b>
            <Counter>{rows.length}</Counter>
          </>
        }
      >
        {branches.status === "loading" ? (
          <p data-testid="branch-loading" className="m-0 px-4 py-3 text-muted-foreground">
            Loading branch catalog…
          </p>
        ) : rows.length === 0 ? (
          <p data-testid="branch-empty" className="m-0 px-4 py-3 text-muted-foreground">
            No native forks yet.
          </p>
        ) : (
          <ul className="m-0 list-none p-0" data-testid="branch-list">
            {rows.map((branch) => (
              <li
                key={branch.streamId}
                data-testid="branch-row"
                data-branch={branch.name}
                className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3 first:border-t-0"
              >
                <Oct name="branch" className="text-muted-foreground" />
                <RouteLink
                  href={`/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}/tree/${encodeURIComponent(branch.name)}`}
                  aria-label={`${branch.name} branch file tree`}
                  className="font-semibold"
                >
                  {branch.name}
                </RouteLink>
                <span
                  data-testid={`branch-parent-${branch.name}`}
                  className="text-muted-foreground"
                >
                  {branch.parentStreamId ?? "root"}
                </span>
                <code
                  data-testid={`branch-fork-${branch.name}`}
                  className="ml-auto text-[12px] text-muted-foreground"
                >
                  {branch.forkOffset}
                </code>
              </li>
            ))}
          </ul>
        )}
        <FactList
          facts={[
            ["Application checkpoint", "branches-checkpoint", branches.checkpoint],
            ["Canonical digest", "branches-digest", branches.digest],
            ["Stream", "branches-stream-status", branches.status],
          ]}
        />
      </Box>
    </section>
  );
}

function DeepTrail(): React.JSX.Element {
  return (
    <Box data-testid="deep-trail" className="px-6 py-8">
      <p className="m-0 text-muted-foreground">Canopy trail</p>
      <h1 className="mt-1 mb-2 text-[20px] font-semibold">Deep trail</h1>
      <p className="m-0">
        This trail is a valid application route. Follow the live canopy projections from here.
      </p>
      <nav aria-label="Deep trail links" className="mt-3 flex gap-3">
        <RouteLink href="/">Return home</RouteLink>
        <RouteLink href="/repositories">Repositories</RouteLink>
      </nav>
    </Box>
  );
}

function RepositorySettings(props: {
  readonly ui: Layout;
  readonly org: string;
  readonly repo: string;
}): React.JSX.Element {
  return (
    <Box
      data-testid="repository-settings"
      className={props.ui.phone ? "mx-4 my-4" : ""}
      header={
        <>
          <Oct name="gear" className="text-muted-foreground" />
          <h1 className="m-0 text-[14px] font-semibold">Settings</h1>
        </>
      }
    >
      <div className="grid gap-4 px-4 py-4">
        <p className="m-0 text-muted-foreground">
          Manage presentation and stream-backed collaboration defaults for {props.org} /{" "}
          {props.repo}.
        </p>
        <p className="m-0">
          <RouteLink href={repoLabelsPath(props.org, props.repo)}>Manage labels</RouteLink>
        </p>
        <label className="grid max-w-sm gap-1 text-[13px] font-semibold">
          <span>Default branch</span>
          <select defaultValue="main" aria-label="Default branch" className={ghField}>
            <option value="main">main</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-[13px] font-semibold">
          <input type="checkbox" defaultChecked />
          <span>Merge evidence required</span>
        </label>
      </div>
    </Box>
  );
}

export function PageRouter(props: { readonly pathname: string }): React.JSX.Element {
  const ui = useLayout();
  const segments = props.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return <RegistryBrowse ui={ui} />;
  if (
    segments.length === 5 &&
    segments[0] === "orgs" &&
    segments[2] === "repos" &&
    segments[4] === "settings"
  ) {
    const org = decodeRouteSegment(segments[1]!);
    const repo = decodeRouteSegment(segments[3]!);
    if (org === undefined || repo === undefined) return <NotFound />;
    return <RepositorySettings ui={ui} org={org} repo={repo} />;
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
    const tabs: readonly PullRequestTab[] = ["activity", "commits", "checks", "changes"];
    if (
      org === undefined ||
      repo === undefined ||
      (segments.length >= 6 && prId === undefined) ||
      tab === undefined ||
      !tabs.includes(tab as PullRequestTab)
    ) {
      return <NotFound />;
    }
    return prId === undefined ? (
      <PullList ui={ui} org={org} repo={repo} />
    ) : (
      <PullRequestView
        key={`pr:${org}/${repo}/${prId}`}
        ui={ui}
        org={org}
        repo={repo}
        prId={prId}
        tab={tab as PullRequestTab}
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
      return <NotFound />;
    }
    return (
      <WikiRoute
        key={`wiki:${org}/${repo}/${slug ?? "index"}:${editor ? "edit" : "view"}`}
        ui={ui}
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
      return <NotFound />;
    }
    return issueId === undefined ? (
      <IssueList ui={ui} org={org} repo={repo} />
    ) : (
      <IssueDetailPage
        key={`issue:${org}/${repo}/${issueId}`}
        ui={ui}
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
    if (org === undefined || repo === undefined) return <NotFound />;
    return <LabelManagement ui={ui} org={org} repo={repo} />;
  }
  if (segments.length === 2 && segments[0] === "members") {
    const org = decodeRouteSegment(segments[1]!);
    if (org === undefined) return <NotFound />;
    return <MembersPage key={`members:${org}`} org={org} />;
  }
  if (segments.length === 3 && segments[0] === "invite") {
    const org = decodeRouteSegment(segments[1]!);
    const token = decodeRouteSegment(segments[2]!);
    if (org === undefined || token === undefined) return <NotFound />;
    return <InvitePage key={`invite:${org}/${token}`} org={org} token={token} />;
  }
  if (segments.length === 3 && segments[0] === "chat") {
    const org = decodeRouteSegment(segments[1]!);
    const channel = decodeRouteSegment(segments[2]!);
    if (org === undefined || channel === undefined) return <NotFound />;
    return <ChatChannelPage key={`chat:${org}/${channel}`} org={org} channel={channel} />;
  }
  if (segments.length === 4 && segments[0] === "inspect") {
    return <StreamInspector org={segments[1]!} repo={segments[2]!} branch={segments[3]!} />;
  }
  if (segments.length === 4 && (segments[0] === "history" || segments[2] === "history")) {
    const route = parseHistoryRoute(segments);
    if (route === undefined) return <NotFound />;
    return (
      <HistoryView
        key={`history:${route.org}/${route.repo}/${route.branch}`}
        ui={ui}
        org={route.org}
        repo={route.repo}
        branch={route.branch}
      />
    );
  }
  if (segments.length >= 4 && segments[2] === "blob") {
    const route = parseBlobRoute(segments);
    if (route === undefined || route.path === "") return <NotFound />;
    return (
      <FileViewer
        key={`blob:${route.org}/${route.repo}/${route.branch}/${route.path}`}
        ui={ui}
        {...route}
      />
    );
  }
  if (segments.length >= 4 && segments[2] === "tree") {
    const route = parseTreeRoute(segments);
    if (route === undefined) return <NotFound />;
    return (
      <PathView
        key={`tree:${route.org}/${route.repo}/${route.branch}/${route.path}`}
        ui={ui}
        {...route}
      />
    );
  }
  if (segments.length === 3 && segments[2] === "branches") {
    const org = decodeRouteSegment(segments[0]!);
    const repo = decodeRouteSegment(segments[1]!);
    if (org === undefined || repo === undefined) return <NotFound />;
    return <BranchesPage ui={ui} org={org} repo={repo} />;
  }
  if (segments.length === 1 && segments[0] === "repositories") return <RegistryBrowse ui={ui} />;
  if (segments.length === 1) return <RegistryBrowse ui={ui} org={segments[0]!} />;
  if (segments.length === 2 && segments[0] === "organizations") {
    return <RegistryBrowse ui={ui} org={segments[1]!} />;
  }
  if (segments.length === 2)
    return (
      <CodeHome
        key={`${segments[0]!}/${segments[1]!}`}
        ui={ui}
        org={segments[0]!}
        repo={segments[1]!}
      />
    );
  if (segments.join("/") === "lost/deep/trail") return <DeepTrail />;
  return <NotFound />;
}
