import { useMemo, useState, type ReactNode } from "react";
import { Settings2 } from "lucide-react";
import { Icon, List, ListRow, ListSection, PillButton, SearchField } from "@brett_lamy/ui";
import { useDispatch, useStreamReducer } from "@eforest/web-hooks";
import type { RegistryState } from "@eforest/reducers";
import {
  ChannelList,
  ChatAvatar,
  ChatIcon,
  chatIconPaths,
  ChatShell,
  K,
  KFONT,
  WorkspaceRail,
  type ChatChannels,
  type Workspace,
} from "../../vendor/chatkit/index.js";
import { navigate, repoSectionPath } from "../../prs/RepoChrome.js";
import { useChatCatalog } from "../../chat/useChat.js";
import { seedDefaultAgents } from "../../members/useRoster.js";
import { agentsStreamId } from "@eforest/reducers";
import { MobileCredenza } from "../mobile/MobileOverlays.js";
import { DesktopTouchKit } from "../touchkit/DesktopTouchKit.js";
import { repositoryRoute } from "./repository-route.js";
import { RegistryProvider } from "../../registry-context.js";

/**
 * The Discord-style product frame from TouchKit's chatkit: a workspace rail (one tile
 * per organization), a channel column with **Codebase** as its own tab above per-repo
 * channel categories, and the routed content as the main pane. Workspaces are namespace
 * orgs; channels are the repository's conversation surfaces (pull requests, issues,
 * wiki, history) — every one of them a route backed by a stream, never local state.
 */

const WORKSPACE_COLORS = ["#48b979", "#6eafff", "#bf5af2", "#ff9f0a", "#ff6b6b", "#5ac8fa"];

function workspaceColor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return WORKSPACE_COLORS[hash % WORKSPACE_COLORS.length]!;
}

function useRegistry() {
  return useStreamReducer<RegistryState>({
    apiPath: "/registry/me",
    streamId: "__registry__",
    reducerId: "registry",
    // Keep the single shared tail quiet when the registry is idle. A one-second
    // poll multiplied by route remounts created a long-poll waterfall in Replay.
    followWaitMs: 10_000,
  });
}

export function currentOrg(pathname: string, orgs: readonly string[]): string | undefined {
  const segments = pathname.split("/").filter(Boolean);
  const fromChat = chatRoute(pathname)?.org;
  if (fromChat !== undefined) return fromChat;
  if ((segments[0] === "members" || segments[0] === "invite") && segments[1] !== undefined) {
    return decodeURIComponent(segments[1]);
  }
  const fromRepo = repositoryRoute(pathname)?.org;
  if (fromRepo !== undefined) return fromRepo;
  if (segments[0] === "organizations" && segments[1] !== undefined) {
    return decodeURIComponent(segments[1]);
  }
  if (segments.length === 1 && segments[0] !== "repositories") {
    return decodeURIComponent(segments[0]!);
  }
  return orgs[0];
}

function chatRoute(
  pathname: string,
): { readonly org: string; readonly channel: string } | undefined {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "chat" || segments[1] === undefined || segments[2] === undefined)
    return undefined;
  try {
    return { org: decodeURIComponent(segments[1]), channel: decodeURIComponent(segments[2]) };
  } catch {
    return undefined;
  }
}

function CreateChannelForm(props: {
  readonly org: string;
  readonly onComplete: (channel: string) => void;
}): React.JSX.Element {
  const catalog = useChatCatalog(props.org);
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const valid = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(name);
  const submit = async (): Promise<void> => {
    if (!valid || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await catalog.dispatch({
        type: "chat.channel.create",
        payload: { v: 1, name, topic },
        ts: Date.now(),
      });
      props.onComplete(name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The dispatch was refused.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="new-repository-form"
      data-testid="new-channel-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label>
        <span>Channel name</span>
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.currentTarget.value.trim().toLowerCase())}
          placeholder="general"
          aria-invalid={name.length > 0 && !valid}
        />
      </label>
      <label>
        <span>Topic</span>
        <input
          value={topic}
          onChange={(event) => setTopic(event.currentTarget.value)}
          placeholder="What is this channel for?"
        />
      </label>
      {error === undefined ? null : (
        <p role="alert" className="new-repository-error">
          {error}
        </p>
      )}
      <PillButton
        label={busy ? "Dispatching…" : "Create channel"}
        tone={valid && !busy ? "tint" : "soft"}
        onPress={() => void submit()}
      />
      <small>Creates one `chat.channel.create` event on the workspace chat stream.</small>
    </form>
  );
}

function CreateWorkspaceForm(props: { readonly onComplete: () => void }): React.JSX.Element {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const dispatch = useDispatch("ns:root");
  const seedAgents = useDispatch(agentsStreamId(name || "pending"));
  const valid = /^(?=[a-z0-9-]{1,40}$)[a-z0-9](?:-?[a-z0-9])*$/.test(name);
  const submit = async (): Promise<void> => {
    if (!valid || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await dispatch({ type: "ns.org.create", payload: { v: 1, name }, ts: Date.now() });
      // Every workspace starts with the default agent roster, as ordinary events.
      await seedDefaultAgents(seedAgents, new Set());
      props.onComplete();
      navigate(`/organizations/${encodeURIComponent(name)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The dispatch was refused.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="new-repository-form"
      data-testid="new-workspace-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label>
        <span>Workspace name</span>
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.currentTarget.value.trim().toLowerCase())}
          placeholder="maple"
          aria-invalid={name.length > 0 && !valid}
        />
      </label>
      {error === undefined ? null : (
        <p role="alert" className="new-repository-error">
          {error}
        </p>
      )}
      <PillButton
        label={busy ? "Dispatching…" : "Create workspace"}
        tone={valid && !busy ? "tint" : "soft"}
        onPress={() => void submit()}
      />
      <small>Creates one `ns.org.create` event on the root namespace stream.</small>
    </form>
  );
}

function InvitePeople(props: { readonly org: string }): React.JSX.Element {
  const [emails, setEmails] = useState("");
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/organizations/${encodeURIComponent(props.org)}`;
  const people = emails
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item.includes("@"));
  return (
    <div className="new-repository-form" data-testid="invite-people">
      <label>
        <span>Invite by email</span>
        <textarea
          rows={3}
          value={emails}
          onChange={(event) => setEmails(event.currentTarget.value)}
          placeholder="ada@example.test, grace@example.test"
        />
      </label>
      <List inset>
        <ListSection
          title="Invite link"
          footer="Anyone who signs in with Auth0 can open this workspace's public repositories from the link. Membership grants are identity events and arrive with the loop epic (E6), so this link is the honest invite today."
        >
          <ListRow
            title={copied ? "Copied" : "Copy invite link"}
            subtitle={<code>{link}</code>}
            leading={<Icon name="person2" />}
            onPress={() => {
              void navigator.clipboard?.writeText(link).then(() => setCopied(true));
            }}
          />
        </ListSection>
      </List>
      <PillButton
        label={
          people.length === 0
            ? "Add people"
            : `Invite ${String(people.length)} ${people.length === 1 ? "person" : "people"}`
        }
        tone={people.length > 0 ? "tint" : "soft"}
        onPress={() => {
          if (people.length === 0) return;
          const subject = encodeURIComponent(`Join the ${props.org} workspace on Electric Forest`);
          const body = encodeURIComponent(`Sign in and open ${link}`);
          window.location.href = `mailto:${people.join(",")}?subject=${subject}&body=${body}`;
        }}
      />
    </div>
  );
}

function WorkspaceMenu(props: {
  readonly org: string;
  readonly onInvite: () => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const go = (href: string): void => {
    props.onClose();
    navigate(href);
  };
  return (
    <List inset>
      <ListSection title={props.org}>
        <ListRow
          title="Invite people"
          leading={<Icon name="person2" />}
          accessory="chevron"
          onPress={props.onInvite}
        />
        <ListRow
          title="New repository"
          leading={<Icon name="layers" />}
          accessory="chevron"
          onPress={() => go(`/organizations/${encodeURIComponent(props.org)}`)}
        />
        <ListRow
          title="Workspace settings"
          leading={<Icon name="sliders" />}
          accessory="chevron"
          onPress={() => go(`/organizations/${encodeURIComponent(props.org)}`)}
        />
      </ListSection>
      <ListSection title="Stream">
        <ListRow
          title="Copy namespace stream id"
          subtitle={<code>{`ns:org:${props.org}`}</code>}
          leading={<Icon name="wave" />}
          onPress={() => {
            void navigator.clipboard?.writeText(`ns:org:${props.org}`);
            props.onClose();
          }}
        />
      </ListSection>
    </List>
  );
}

function RepositorySearch(props: {
  readonly rows: readonly { org: string; repo: string; project: string }[];
  readonly onClose: () => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase();
  const matches = props.rows
    .filter((row) => needle === "" || `${row.org}/${row.repo} ${row.project}`.includes(needle))
    .slice(0, 8);
  return (
    <div className="repository-search" data-testid="repository-search">
      <SearchField
        q={query}
        setQ={setQuery}
        placeholder="Search repositories"
        aria-label="Search repositories"
      />
      <List inset>
        <ListSection title={needle === "" ? "Repositories" : `Matches for “${query}”`}>
          {matches.length === 0 ? (
            <ListRow title="No repositories match" leading={<Icon name="search" />} />
          ) : (
            matches.map((row) => (
              <ListRow
                key={`${row.org}/${row.repo}`}
                title={`${row.org}/${row.repo}`}
                subtitle={row.project}
                leading={<Icon name="layers" />}
                accessory="chevron"
                onPress={() => {
                  props.onClose();
                  navigate(`/${encodeURIComponent(row.org)}/${encodeURIComponent(row.repo)}`);
                }}
              />
            ))
          )}
        </ListSection>
      </List>
    </div>
  );
}

type Sheet =
  "none" | "create-workspace" | "workspace-menu" | "invite" | "search" | "create-channel";

/** Channel column for one workspace; hooks here only run once the org is known. */
function WorkspaceNav(props: {
  readonly org: string;
  readonly current: string;
  readonly codebaseActive: boolean;
  readonly membersActive: boolean;
  readonly codebaseHref: string;
  readonly repoCount: number;
  readonly onSheet: (sheet: Sheet) => void;
}): React.JSX.Element {
  const catalog = useChatCatalog(props.org);
  const channels: ChatChannels = {};
  for (const name of Object.keys(catalog.projection.state.channels).sort()) {
    channels[name] = { section: "Channels", label: name, msgs: [], unread: false };
  }
  const { current, codebaseActive, codebaseHref } = props;
  return (
    <ChannelList
      chans={channels}
      cur={current}
      tint="var(--accent-primary)"
      onPick={(id) => {
        navigate(`/chat/${encodeURIComponent(props.org)}/${encodeURIComponent(id)}`);
      }}
      header={
        <div className="forest-nav-head">
          <button
            type="button"
            className="forest-workspace-button"
            data-testid="workspace-menu"
            onClick={() => props.onSheet("workspace-menu")}
          >
            <span>{props.org}</span>
            <ChatIcon d={chatIconPaths.chev} size={13} style={{ transform: "rotate(90deg)" }} />
          </button>
          <button
            type="button"
            className="forest-icon-button"
            aria-label="Search repositories"
            data-testid="rail-search"
            onClick={() => props.onSheet("search")}
          >
            <Icon name="search" size={15} />
          </button>
          <a
            className={codebaseActive ? "forest-tab forest-tab-active" : "forest-tab"}
            href={codebaseHref}
            data-testid="codebase-tab"
            aria-current={codebaseActive ? "page" : undefined}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.button !== 0) return;
              event.preventDefault();
              navigate(codebaseHref);
            }}
          >
            <Icon name="layers" size={16} />
            <span>Codebase</span>
            <small>{props.repoCount}</small>
          </a>
          <a
            className={props.membersActive ? "forest-tab forest-tab-active" : "forest-tab"}
            href={`/members/${encodeURIComponent(props.org)}`}
            data-testid="members-tab"
            aria-current={props.membersActive ? "page" : undefined}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.button !== 0) return;
              event.preventDefault();
              navigate(`/members/${encodeURIComponent(props.org)}`);
            }}
          >
            <Icon name="person2" size={16} />
            <span>Members</span>
          </a>
          <button
            type="button"
            className="forest-tab forest-tab-new"
            data-testid="new-channel"
            onClick={() => props.onSheet("create-channel")}
          >
            <ChatIcon d={chatIconPaths.plus} size={14} />
            <span>New channel</span>
          </button>
        </div>
      }
      footer={
        <div className="forest-nav-foot">
          <ChatAvatar user={{ name: props.org, c: "#48b979", role: K.label }} size={26} />
          <div>
            <strong style={{ fontFamily: KFONT }}>Electric Forest</strong>
            <small>● stream native</small>
          </div>
          <a href="/settings/cli-tokens" aria-label="CLI tokens" className="forest-icon-button">
            <Settings2 size={15} />
          </a>
        </div>
      }
    />
  );
}

export function ForestShell(props: {
  readonly pathname: string;
  readonly header?: ReactNode;
  readonly diagnostics?: ReactNode;
  readonly children: ReactNode;
}): React.JSX.Element {
  const registry = useRegistry();
  const orgs = Object.keys(registry.state.orgs).sort();
  const org = currentOrg(props.pathname, orgs);
  const repository = repositoryRoute(props.pathname);
  const [sheet, setSheet] = useState<Sheet>("none");
  const rows = useMemo(
    () =>
      Object.entries(registry.state.orgs).flatMap(([owner, state]) =>
        Object.entries(state.repos).map(([repo, item]) => ({
          org: owner,
          repo,
          project: item.project,
        })),
      ),
    [registry.state.orgs],
  );
  const repos = rows.filter((row) => row.org === org).map((row) => row.repo);
  const workspaces: Workspace[] = orgs.map((name) => ({
    id: name,
    label: name.slice(0, 1).toUpperCase(),
    color: workspaceColor(name),
    active: name === org,
    title: name,
  }));
  const chat = chatRoute(props.pathname);
  const codebaseActive =
    chat === undefined &&
    props.pathname !== "/settings/cli-tokens" &&
    !props.pathname.startsWith("/members/") &&
    !props.pathname.startsWith("/invite/");
  const current = chat?.channel ?? "";
  const codebaseHref =
    repository === undefined
      ? org === undefined
        ? "/"
        : `/organizations/${encodeURIComponent(org)}`
      : repoSectionPath(repository.org, repository.repo, "code");

  return (
    <RegistryProvider value={registry}>
      <>
        <ChatShell breakpoint={0} className="forest-shell">
          <ChatShell.Rail>
            <WorkspaceRail
              workspaces={workspaces}
              tint="var(--accent-primary)"
              onSelect={(id) => navigate(`/organizations/${encodeURIComponent(id)}`)}
              onAdd={() => setSheet("create-workspace")}
            />
          </ChatShell.Rail>
          <ChatShell.Nav>
            {org === undefined ? (
              <div className="forest-nav-empty" data-testid="workspace-nav-empty" />
            ) : (
              <WorkspaceNav
                org={org}
                current={current}
                codebaseActive={codebaseActive}
                membersActive={props.pathname.startsWith("/members/")}
                codebaseHref={codebaseHref}
                repoCount={repos.length}
                onSheet={setSheet}
              />
            )}
          </ChatShell.Nav>
          <ChatShell.Main>
            <div className="product-stage forest-main ck-scroll">
              {props.header}
              <div className="product-content">{props.children}</div>
              {props.diagnostics === undefined ? null : (
                <details className="product-diagnostics">
                  <summary>Stream diagnostics</summary>
                  {props.diagnostics}
                </details>
              )}
            </div>
          </ChatShell.Main>
        </ChatShell>
        {/* ChatShell renders only its slot children; overlays live beside it. */}
        <DesktopTouchKit>
          <MobileCredenza
            open={sheet === "create-workspace"}
            onClose={() => setSheet("none")}
            label="New workspace"
            compact
          >
            <CreateWorkspaceForm onComplete={() => setSheet("none")} />
          </MobileCredenza>
          <MobileCredenza
            open={sheet === "workspace-menu"}
            onClose={() => setSheet("none")}
            label={org ?? "Workspace"}
            compact
          >
            {org === undefined ? null : (
              <WorkspaceMenu
                org={org}
                onInvite={() => setSheet("invite")}
                onClose={() => setSheet("none")}
              />
            )}
          </MobileCredenza>
          <MobileCredenza
            open={sheet === "invite"}
            onClose={() => setSheet("none")}
            label="Invite people"
            compact
          >
            {org === undefined ? null : <InvitePeople org={org} />}
          </MobileCredenza>
          <MobileCredenza
            open={sheet === "create-channel"}
            onClose={() => setSheet("none")}
            label="New channel"
            compact
          >
            {org === undefined || sheet !== "create-channel" ? null : (
              <CreateChannelForm
                org={org}
                onComplete={(channel) => {
                  setSheet("none");
                  navigate(`/chat/${encodeURIComponent(org)}/${encodeURIComponent(channel)}`);
                }}
              />
            )}
          </MobileCredenza>
          <MobileCredenza
            open={sheet === "search"}
            onClose={() => setSheet("none")}
            label="Search repositories"
            compact
          >
            {sheet === "search" ? (
              <RepositorySearch rows={rows} onClose={() => setSheet("none")} />
            ) : null}
          </MobileCredenza>
        </DesktopTouchKit>
      </>
    </RegistryProvider>
  );
}
