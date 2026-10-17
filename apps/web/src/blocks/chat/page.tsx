/* Provenance: registry/blocks/discord-clone/page.tsx — @brett_lamy/ui 2.0.0 registry block
   "discord-clone" (https://blamy.github.io/ui/r/discord-clone.json), installed as owned source.
   Every divergence from the upstream file carries an `ef:` marker. */
// ef: this is the Electric Forest app frame at every width: the package ChatShell with the workspace
// rail (TabView variant="workspace"), the channel sidebar and the routed main column. Workspaces are
// namespace orgs from the live registry, channel groups are repositories and chat channels from the
// org's chat catalog, and the user panel is the signed-in identity. The block's mock
// channel, user, workspace and presence fixtures, its canned bot reply and its local `useChannels` state are not installed; the
// transcript lives in chat/ChatChannelPage.tsx and only ever renders the live channel stream.
// ef:begin the frame composes ChatShell with the owned sidebar parts only
import { useEffect, type ReactNode } from "react";
import {
  ChatShell,
  ChatShellMain,
  ChatShellNav,
  ChatShellSidebar,
  TabView,
  TabViewAction,
  TabViewBar,
  TabViewFooter,
  TabViewIndicator,
  TabViewList,
  TabViewTab,
} from "@brett_lamy/ui";
import { ChannelList } from "./components/channel-list.js";
import { ChatAvatar } from "./components/chat-avatar.js";
import { ServerHeader } from "./components/server-header.js";
import {
  UserPanel,
  UserPanelInfo,
  UserPanelName,
  UserPanelStatus,
} from "./components/user-panel.js";
import { WorkspaceTile } from "./components/workspace-rail.js";
// ef:end

/** ef: a workspace tile on the rail (a namespace org, or the personal account). */
export interface Workspace {
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly color: string;
}

// ef:begin types for live workspaces from the registry
/** react-aria's tabs drop `title`, so the rail's tooltips go on through a ref. */
const titleRef = (title: string) => (el: HTMLElement | null) => {
  if (el) el.title = title;
};
// ef:end

export interface DiscordCloneProps {
  workspaces: readonly Workspace[];
  /** ef: the routed workspace (controlled by the URL). */
  workspace: string | null;
  onSelectWorkspace: (id: string) => void;
  onAddWorkspace: () => void;
  /** ef: the server header's name and trailing control (the workspace menu). */
  serverName: ReactNode;
  serverAction?: ReactNode;
  /** ef: links between the server header and the channel list (Codebase, Members, New channel). */
  sidebarLinks?: ReactNode;
  /** ef: ChannelGroup / ChannelItem children (repositories and live chat channels) for the list. */
  channels: ReactNode;
  selectedChannel: string | null;
  onSelectChannel: (id: string) => void;
  /** ef: the signed-in account (from whoami); pressing it opens the account menu. */
  user: { readonly name: string; readonly status: string; readonly trigger: ReactNode } | null;
  sidebarProps?: Record<string, string>;
  /** ef: the compact navigation drawer is controlled so every route change can close it. */
  navOpen: boolean;
  onNavOpenChange: (open: boolean) => void;
  children: ReactNode;
}

// ef:begin frame driven by routes and live registry/catalog data; no local channel state
export default function DiscordClone({
  workspaces,
  workspace,
  onSelectWorkspace,
  onAddWorkspace,
  serverName,
  serverAction,
  sidebarLinks,
  channels,
  selectedChannel,
  onSelectChannel,
  user,
  sidebarProps,
  navOpen,
  onNavOpenChange,
  children,
}: DiscordCloneProps) {
  useCompactDrawerKeyboard(navOpen, onNavOpenChange);
  return (
    // ef: dark forest palette from styles/app.css; the tint is the theme primary.
    <ChatShell
      appearance="dark"
      breakpoint={880}
      navOpen={navOpen}
      onNavOpenChange={onNavOpenChange}
      data-testid="app-frame"
    >
      <ChatShellNav>
        <TabView
          orientation="vertical"
          // ef: no tab is selected while the route has no workspace (react-aria takes an explicit null).
          selectedKey={workspace as string}
          onSelectionChange={(key) => onSelectWorkspace(String(key))}
          className="contents"
        >
          <TabViewBar variant="workspace">
            <TabViewList aria-label="Workspaces">
              {workspaces.map((w) => (
                <TabViewTab
                  key={w.id}
                  id={w.id}
                  textValue={w.title}
                  // ef: the tile shows one letter; the tab's accessible name is the workspace.
                  aria-label={w.title}
                  ref={titleRef(w.title)}
                >
                  <TabViewIndicator variant="pill" />
                  <WorkspaceTile color={w.color}>{w.label}</WorkspaceTile>
                </TabViewTab>
              ))}
            </TabViewList>
            <TabViewFooter>
              <TabViewAction aria-label="Add workspace" icon="plus" onPress={onAddWorkspace} />
            </TabViewFooter>
          </TabViewBar>
        </TabView>
        <ChatShellSidebar data-frame-sidebar="" {...sidebarProps}>
          <ServerHeader {...(serverAction === undefined ? {} : { action: serverAction })}>
            {serverName}
          </ServerHeader>
          {sidebarLinks}
          <ChannelList selectedKey={selectedChannel} onSelectionChange={onSelectChannel}>
            {channels}
          </ChannelList>
          {user === null ? null : (
            <UserPanel>
              <ChatAvatar user={{ name: user.name, c: "#48b979", role: "#48b979" }} size={26} />
              <UserPanelInfo>
                <UserPanelName>{user.name}</UserPanelName>
                <UserPanelStatus status="online">{user.status}</UserPanelStatus>
              </UserPanelInfo>
              {user.trigger}
            </UserPanel>
          )}
        </ChatShellSidebar>
      </ChatShellNav>

      <ChatShellMain>{children}</ChatShellMain>
    </ChatShell>
  );
}
// ef:end

// ef:begin keyboard for the compact drawer. The package drawer (ChatShellNav at compact widths)
// has no Escape handling or focus management: opening it moves focus to the first control in the
// sidebar, Escape closes it, and closing returns focus to whatever opened it.
function useCompactDrawerKeyboard(navOpen: boolean, onNavOpenChange: (open: boolean) => void) {
  useEffect(() => {
    if (!navOpen) return;
    const shell = document.querySelector<HTMLElement>('[data-testid="app-frame"]');
    if (shell === null || !shell.hasAttribute("data-compact")) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    shell
      .querySelector<HTMLElement>(
        '[data-frame-sidebar] :is(a[href], button, input, [tabindex]):not([tabindex="-1"]):not([disabled])',
      )
      ?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onNavOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (opener?.isConnected === true) opener.focus();
    };
  }, [navOpen, onNavOpenChange]);
}
// ef:end
