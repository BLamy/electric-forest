import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Avatar,
  Button,
  ChatShellNavTrigger,
  Icon,
  List,
  ListRow,
  ListSection,
  SearchField,
  cn,
} from "@brett_lamy/ui";
import { useDispatch, useStreamReducer } from "@eforest/web-hooks";
import { agentsStreamId, type RegistryState } from "@eforest/reducers";
import DiscordClone, { type Workspace } from "../../blocks/chat/page.js";
import { ChannelGroup, ChannelItem } from "../../blocks/chat/components/channel-list.js";
import GithubClone, { RepoPage, useLayout, type StackLevel } from "../../blocks/github/page.js";
import { GlobalHeader } from "../../blocks/github/repo-header.js";
import { Oct, ghButton, ghField, userOf } from "../../blocks/github/parts.js";
import { useChatCatalog } from "../../chat/useChat.js";
import { useWhoami, type WhoamiUser } from "../../chat/useWhoami.js";
import { seedDefaultAgents } from "../../members/useRoster.js";
import { RouteLink, navigate, repoSectionPath } from "../../navigation.js";
import { personalAccount } from "../../personal-account.js";
import { AppSheet } from "../overlay.js";
import { repositoryRoute } from "./repository-route.js";
import { repositoryStack, routeCrumbs, routeTitle } from "./stack.js";
import { StreamDevtools } from "./StreamDevtools.js";
import { LIVE_FOLLOW } from "../../live.js";

/**
 * The Electric Forest frame at every width, composed from the discord-clone block (the
 * package's ChatShell, workspace rail and channel sidebar) and the github-clone block (global
 * header, repository header + underline tabs, NavigationStack on phones). Workspaces are
 * namespace orgs from the live registry; the sidebar's channels are repositories and chat
 * channels — every entry a route backed by a stream, never local state.
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
    ...LIVE_FOLLOW,
  });
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

function FormField(props: {
  readonly label: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <label className="grid gap-1 text-[13px] font-semibold">
      <span>{props.label}</span>
      {props.children}
    </label>
  );
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
      className="grid gap-3"
      data-testid="new-channel-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <FormField label="Channel name">
        <input
          autoFocus
          className={ghField}
          value={name}
          onChange={(event) => setName(event.currentTarget.value.trim().toLowerCase())}
          placeholder="general"
          aria-invalid={name.length > 0 && !valid}
        />
      </FormField>
      <FormField label="Topic">
        <input
          className={ghField}
          value={topic}
          onChange={(event) => setTopic(event.currentTarget.value)}
          placeholder="What is this channel for?"
        />
      </FormField>
      {error === undefined ? null : (
        <p role="alert" className="m-0 text-destructive">
          {error}
        </p>
      )}
      <button type="submit" className={ghButton(true)} disabled={!valid || busy}>
        {busy ? "Dispatching…" : "Create channel"}
      </button>
      <small className="text-muted-foreground">
        Creates one `chat.channel.create` event on the workspace chat stream.
      </small>
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
      className="grid gap-3"
      data-testid="new-workspace-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <FormField label="Workspace name">
        <input
          autoFocus
          className={ghField}
          value={name}
          onChange={(event) => setName(event.currentTarget.value.trim().toLowerCase())}
          placeholder="maple"
          aria-invalid={name.length > 0 && !valid}
        />
      </FormField>
      {error === undefined ? null : (
        <p role="alert" className="m-0 text-destructive">
          {error}
        </p>
      )}
      <button type="submit" className={ghButton(true)} disabled={!valid || busy}>
        {busy ? "Dispatching…" : "Create workspace"}
      </button>
      <small className="text-muted-foreground">
        Creates one `ns.org.create` event on the root namespace stream.
      </small>
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
    <div className="grid gap-3" data-testid="invite-people">
      <FormField label="Invite by email">
        <textarea
          rows={3}
          className={cn(ghField, "h-auto py-2")}
          value={emails}
          onChange={(event) => setEmails(event.currentTarget.value)}
          placeholder="ada@example.test, grace@example.test"
        />
      </FormField>
      <List className="overflow-hidden rounded-xl border border-border">
        <ListSection
          title="Invite link"
          footer="Anyone who signs in with Auth0 can open this workspace's public repositories from the link."
        >
          <ListRow
            title={copied ? "Copied" : "Copy invite link"}
            subtitle={<code>{link}</code>}
            leading={<Icon name="link" />}
            onPress={() => {
              void navigator.clipboard?.writeText(link).then(() => setCopied(true));
            }}
          />
        </ListSection>
      </List>
      <Button
        className={ghButton(people.length > 0)}
        isDisabled={people.length === 0}
        onPress={() => {
          const subject = encodeURIComponent(`Join the ${props.org} workspace on Electric Forest`);
          const body = encodeURIComponent(`Sign in and open ${link}`);
          window.location.href = `mailto:${people.join(",")}?subject=${subject}&body=${body}`;
        }}
      >
        {people.length === 0
          ? "Add people"
          : `Invite ${String(people.length)} ${people.length === 1 ? "person" : "people"}`}
      </Button>
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
    <List className="overflow-hidden rounded-xl border border-border">
      <ListSection title={props.org}>
        <ListRow
          title="Invite people"
          leading={<Icon name="person" />}
          accessory="chevron"
          onPress={props.onInvite}
        />
        <ListRow
          title="Repositories"
          leading={<Icon name="layers" />}
          accessory="chevron"
          onPress={() => go(`/organizations/${encodeURIComponent(props.org)}`)}
        />
        <ListRow
          title="Members and agents"
          leading={<Icon name="person" />}
          accessory="chevron"
          onPress={() => go(`/members/${encodeURIComponent(props.org)}`)}
        />
      </ListSection>
      <ListSection title="Stream">
        <ListRow
          title="Copy namespace stream id"
          subtitle={<code>{`ns:org:${props.org}`}</code>}
          leading={<Icon name="pulse" />}
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
    <div className="grid gap-3" data-testid="repository-search">
      <SearchField
        value={query}
        onChange={setQuery}
        placeholder="Search repositories"
        aria-label="Search repositories"
        autoFocus
      />
      <List className="overflow-hidden rounded-xl border border-border">
        <ListSection title={needle === "" ? "Repositories" : `Matches for “${query}”`}>
          {matches.length === 0 ? (
            <ListRow title="No repositories match" leading={<Icon name="magnifyingglass" />} />
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

function AccountMenu(props: {
  readonly user: WhoamiUser | null;
  readonly onClose: () => void;
}): React.JSX.Element {
  const email = props.user?.email ?? "Signed-in account";
  const go = (href: string): void => {
    props.onClose();
    if (href === "/settings/cli-tokens") {
      window.location.assign(href);
      return;
    }
    navigate(href);
  };
  return (
    <div className="grid gap-3" data-testid="account-menu">
      <p className="m-0 text-muted-foreground">
        Signed in as <strong className="text-foreground">{email}</strong>
      </p>
      <List className="overflow-hidden rounded-xl border border-border">
        <ListSection title="Account">
          <ListRow
            title="Docs"
            leading={<Icon name="layers" />}
            accessory="chevron"
            onPress={() => go("/docs")}
          />
          <ListRow
            title="CLI tokens"
            leading={<Icon name="gear" />}
            accessory="chevron"
            onPress={() => go("/settings/cli-tokens")}
          />
        </ListSection>
      </List>
      <form action="/auth/logout" method="post">
        <button className={cn(ghButton(), "w-full")} type="submit">
          Log out
        </button>
      </form>
    </div>
  );
}

type Sheet =
  | "none"
  | "create-workspace"
  | "workspace-menu"
  | "invite"
  | "search"
  | "create-channel"
  | "account-menu";

function SidebarLink(props: {
  readonly href: string;
  readonly active: boolean;
  readonly testId: string;
  readonly icon: ReactNode;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <RouteLink
      href={props.href}
      data-testid={props.testId}
      className={cn(
        "flex items-center gap-[7px] rounded-[8px] px-[8px] py-[5px] text-[13.5px] text-muted-foreground hover:bg-accent hover:no-underline",
        props.active && "bg-secondary-strong font-[650] text-foreground",
      )}
    >
      {props.icon}
      {props.children}
    </RouteLink>
  );
}

/** Routes whose main column is a full-bleed conversation (the chat block's own header/footer). */
export function isConversationRoute(pathname: string): boolean {
  return chatRoute(pathname) !== undefined;
}

export function ForestShell(props: {
  readonly pathname: string;
  readonly diagnostics?: ReactNode;
  /** Renders the routed page for a path (each NavigationStack level is a route). */
  readonly render: (pathname: string) => ReactNode;
}): React.JSX.Element {
  const registry = useRegistry();
  const user = useWhoami();
  const personal = personalAccount(user);
  const orgs = Object.keys(registry.state.orgs)
    .filter((name) => name !== personal?.namespace)
    .sort();
  const routedOrg = currentOrg(props.pathname, orgs);
  const personalActive =
    props.pathname === "/" ||
    props.pathname === "/repositories" ||
    (personal !== null && routedOrg === personal.namespace);
  const org = personalActive ? personal?.namespace : routedOrg;
  const [sheet, setSheet] = useState<Sheet>("none");
  // The compact navigation drawer closes on every route change except a workspace switch,
  // which keeps it open so the new workspace's channels can be picked (Discord's behaviour).
  const [navOpen, setNavOpen] = useState(false);
  const keepNavOpen = useRef(false);
  useEffect(() => {
    if (keepNavOpen.current) keepNavOpen.current = false;
    else setNavOpen(false);
  }, [props.pathname]);
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
  const repos =
    personalActive &&
    (user === null || org === undefined || registry.state.orgs[org]?.owner !== user.sub)
      ? []
      : rows.filter((row) => row.org === org).map((row) => row.repo);
  const repository = repositoryRoute(props.pathname);
  const diagnosticRepo = repository ?? rows[0];
  const workspaces: Workspace[] = [
    ...(personal === null
      ? []
      : [
          {
            id: "__personal__",
            label: personal.name.slice(0, 1).toUpperCase(),
            color: "#6eafff",
            title: `${personal.name} · Personal account`,
          },
        ]),
    ...orgs.map((name) => ({
      id: name,
      label: name.slice(0, 1).toUpperCase(),
      color: workspaceColor(name),
      title: name,
    })),
  ];
  const chat = chatRoute(props.pathname);
  const codebaseActive =
    chat === undefined &&
    props.pathname !== "/settings/cli-tokens" &&
    !props.pathname.startsWith("/members/") &&
    !props.pathname.startsWith("/invite/");
  const codebaseHref =
    repository === undefined
      ? org === undefined
        ? "/"
        : `/organizations/${encodeURIComponent(org)}`
      : repoSectionPath(repository.org, repository.repo, "code");
  const selectedChannel =
    chat !== undefined
      ? `chat:${chat.channel}`
      : repository !== undefined
        ? `repo:${repository.repo}`
        : null;

  const account = user?.email ?? null;
  const header = (ui: Parameters<typeof GlobalHeader>[0]["ui"], width: number) => (
    <GlobalHeader
      ui={ui}
      width={width}
      crumbs={routeCrumbs(props.pathname)}
      account={account}
      onSearch={() => setSheet("search")}
      onCreate={() =>
        navigate(
          org === undefined || personalActive ? "/" : `/organizations/${encodeURIComponent(org)}`,
        )
      }
    />
  );
  const trailing =
    account === null ? undefined : (
      <span className="mr-2.5 flex" title={account}>
        <Avatar c={userOf(account)} size={28} />
      </span>
    );
  const leading = (
    <ChatShellNavTrigger className={cn(ghButton(), "ml-2 w-8 bg-transparent px-0")} />
  );

  let main: ReactNode;
  if (chat !== undefined) {
    main = props.render(props.pathname);
  } else {
    const stack = repositoryStack(props.pathname);
    if (stack !== undefined) {
      const levels: StackLevel[] = stack.levels.map((level, index) => ({
        ...level,
        content:
          index === 0 ? (
            <RepoPageForRoute org={stack.org} repo={stack.repo} section={stack.section}>
              {props.render(level.href)}
            </RepoPageForRoute>
          ) : (
            props.render(level.href)
          ),
      }));
      main = (
        <GithubClone
          levels={levels}
          header={header}
          leading={leading}
          {...(trailing === undefined ? {} : { trailing })}
          wide={
            <RepoPageForRoute org={stack.org} repo={stack.repo} section={stack.section}>
              {props.render(props.pathname)}
            </RepoPageForRoute>
          }
        />
      );
    } else {
      main = (
        <GithubClone
          levels={[
            {
              key: props.pathname,
              title: routeTitle(props.pathname),
              href: props.pathname,
              content: props.render(props.pathname),
            },
          ]}
          header={header}
          leading={leading}
          {...(trailing === undefined ? {} : { trailing })}
          wide={
            <div className="mx-auto w-full max-w-[1280px] px-4 py-6 md:px-6">
              {props.render(props.pathname)}
            </div>
          }
        />
      );
    }
  }

  const orgName = personalActive ? personal?.name : org;

  return (
    <>
      <DiscordClone
        workspaces={workspaces}
        workspace={personalActive ? "__personal__" : (org ?? null)}
        onSelectWorkspace={(id) => {
          keepNavOpen.current = true;
          navigate(id === "__personal__" ? "/" : `/organizations/${encodeURIComponent(id)}`);
        }}
        navOpen={navOpen}
        onNavOpenChange={setNavOpen}
        onAddWorkspace={() => setSheet("create-workspace")}
        serverName={orgName ?? "Electric Forest"}
        serverAction={
          org === undefined ? null : personalActive ? (
            <span className="text-[11px] text-tertiary-foreground">Personal</span>
          ) : (
            <button
              type="button"
              data-testid="workspace-menu"
              aria-label={`${org} workspace menu`}
              onClick={() => setSheet("workspace-menu")}
              className="grid cursor-pointer border-0 bg-transparent p-[4px] text-tertiary-foreground hover:text-muted-foreground"
            >
              <Oct name="chevDown" size={13} />
            </button>
          )
        }
        sidebarLinks={
          org === undefined ? (
            <div data-testid="workspace-nav-empty" />
          ) : (
            <nav aria-label="Workspace" className="grid gap-px px-[8px] pt-[6px]">
              <button
                type="button"
                data-testid="rail-search"
                aria-label="Search repositories"
                onClick={() => setSheet("search")}
                className="flex cursor-pointer items-center gap-[7px] rounded-[8px] border-0 bg-transparent px-[8px] py-[5px] text-left text-[13.5px] text-muted-foreground hover:bg-accent"
              >
                <Oct name="search" size={14} /> Search
              </button>
              <SidebarLink
                href={personalActive ? "/" : codebaseHref}
                active={codebaseActive}
                testId="codebase-tab"
                icon={<Oct name="code" size={14} />}
              >
                {personalActive ? "Your repositories" : "Codebase"}
                <span className="ml-auto text-[11px] text-tertiary-foreground">{repos.length}</span>
              </SidebarLink>
              {personalActive ? null : (
                <>
                  <SidebarLink
                    href={`/members/${encodeURIComponent(org)}`}
                    active={props.pathname.startsWith("/members/")}
                    testId="members-tab"
                    icon={<Oct name="people" size={14} />}
                  >
                    Members
                  </SidebarLink>
                  <button
                    type="button"
                    data-testid="new-channel"
                    onClick={() => setSheet("create-channel")}
                    className="flex cursor-pointer items-center gap-[7px] rounded-[8px] border-0 bg-transparent px-[8px] py-[5px] text-left text-[13.5px] text-muted-foreground hover:bg-accent"
                  >
                    <Oct name="plus" size={14} /> New channel
                  </button>
                </>
              )}
            </nav>
          )
        }
        channels={
          org === undefined ? null : (
            <>
              <ChannelGroup label={personalActive ? "Repositories" : "Codebase"}>
                {repos.map((repo) => (
                  <ChannelItem key={repo} id={`repo:${repo}`} icon={<Oct name="book" size={13} />}>
                    {repo}
                  </ChannelItem>
                ))}
              </ChannelGroup>
              {personalActive ? null : <OrgChannels org={org} />}
            </>
          )
        }
        selectedChannel={selectedChannel}
        onSelectChannel={(id) => {
          if (id.startsWith("repo:") && org !== undefined) {
            navigate(`/${encodeURIComponent(org)}/${encodeURIComponent(id.slice(5))}`);
          } else if (id.startsWith("chat:") && org !== undefined) {
            navigate(`/chat/${encodeURIComponent(org)}/${encodeURIComponent(id.slice(5))}`);
          }
        }}
        user={{
          name: "Electric Forest",
          status: user?.email ?? "stream native",
          trigger: (
            <button
              type="button"
              data-testid="account-menu-trigger"
              aria-label={`Account menu for ${user?.email ?? "Electric Forest"}`}
              onClick={() => setSheet("account-menu")}
              className="grid cursor-pointer border-0 bg-transparent p-0 text-tertiary-foreground hover:text-muted-foreground"
            >
              <Icon name="gear" size={15} />
            </button>
          ),
        }}
        {...(personalActive && personal !== null
          ? { sidebarProps: { "data-testid": "personal-account-nav" } }
          : {})}
      >
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        {main}
        {props.diagnostics === undefined ? null : (
          <StreamDevtools
            diagnostics={props.diagnostics}
            inspector={
              diagnosticRepo === undefined ? undefined : (
                <RouteLink
                  href={`/inspect/${encodeURIComponent(diagnosticRepo.org)}/${encodeURIComponent(diagnosticRepo.repo)}/main`}
                >
                  Open Stream Inspector
                </RouteLink>
              )
            }
          />
        )}
      </DiscordClone>
      <AppSheet
        open={sheet === "create-workspace"}
        onClose={() => setSheet("none")}
        title="New workspace"
      >
        <CreateWorkspaceForm onComplete={() => setSheet("none")} />
      </AppSheet>
      <AppSheet
        open={sheet === "workspace-menu"}
        onClose={() => setSheet("none")}
        title={org ?? "Workspace"}
      >
        {org === undefined ? null : (
          <WorkspaceMenu
            org={org}
            onInvite={() => setSheet("invite")}
            onClose={() => setSheet("none")}
          />
        )}
      </AppSheet>
      <AppSheet open={sheet === "invite"} onClose={() => setSheet("none")} title="Invite people">
        {org === undefined ? null : <InvitePeople org={org} />}
      </AppSheet>
      <AppSheet
        open={sheet === "create-channel"}
        onClose={() => setSheet("none")}
        title="New channel"
      >
        {org === undefined ? null : (
          <CreateChannelForm
            org={org}
            onComplete={(channel) => {
              setSheet("none");
              navigate(`/chat/${encodeURIComponent(org)}/${encodeURIComponent(channel)}`);
            }}
          />
        )}
      </AppSheet>
      <AppSheet
        open={sheet === "search"}
        onClose={() => setSheet("none")}
        title="Search repositories"
      >
        <RepositorySearch rows={rows} onClose={() => setSheet("none")} />
      </AppSheet>
      <AppSheet open={sheet === "account-menu"} onClose={() => setSheet("none")} title="Account">
        <AccountMenu user={user} onClose={() => setSheet("none")} />
      </AppSheet>
    </>
  );
}

/** The workspace's live chat catalog (`chat:<org>`) as channel rows. */
function OrgChannels(props: { readonly org: string }): React.JSX.Element {
  const catalog = useChatCatalog(props.org);
  const names = Object.keys(catalog.projection.state.channels).sort();
  return (
    <ChannelGroup label="Channels">
      {names.map((name) => (
        <ChannelItem key={name} id={`chat:${name}`}>
          {name}
        </ChannelItem>
      ))}
    </ChannelGroup>
  );
}

/** The repository page (live header + underline tabs) around a routed view, at the frame's layout. */
function RepoPageForRoute(props: {
  readonly org: string;
  readonly repo: string;
  readonly section: Parameters<typeof RepoPage>[0]["tab"];
  readonly children: ReactNode;
}): React.JSX.Element {
  const ui = useLayout();
  const base = `/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}`;
  return (
    <RepoPage
      ui={ui}
      org={props.org}
      repo={props.repo}
      tab={props.section}
      actions={
        <>
          <RouteLink
            href={`${base}/history/main`}
            className={cn(ghButton(), "text-foreground hover:no-underline")}
          >
            <Oct name="history" className="text-muted-foreground" />
            History
          </RouteLink>
          <RouteLink
            href={`/inspect/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}/main`}
            className={cn(ghButton(), "text-foreground hover:no-underline")}
          >
            <Oct name="stream" className="text-muted-foreground" />
            Stream
          </RouteLink>
        </>
      }
    >
      {props.children}
    </RepoPage>
  );
}
