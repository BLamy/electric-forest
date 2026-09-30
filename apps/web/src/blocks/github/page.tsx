/* Provenance: registry/blocks/github-clone/page.tsx — @brett_lamy/ui 2.0.0 registry block
   "github-clone" (https://blamy.github.io/ui/r/github-clone.json), installed as owned source.
   Every divergence from the upstream file carries an `ef:` marker. */
/* GitHub clone — a repository page (Code, Issues, Pull requests, Actions) with a file browser, README, issue and
   PR lists, a pull request conversation with a comment composer, and a "Files changed" diff.
   Wide: GitHub's desktop layout with sidebars. Phone: a NavigationStack pushes folders, files and PRs. */
// ef: the page is route-driven. The URL (not component state) names the tab, the open path, issue or PR;
// the app shell computes the phone stack levels from it and every level's content is a live route.
// ef:begin route-driven frame: navigation, namespace projection, layout context
import { createContext, useContext, type ReactNode } from "react";
import {
  NavigationStack,
  TabView,
  TabViewBar,
  TabViewList,
  TabViewPanels,
  useContainerWidth,
  type Screen,
} from "@brett_lamy/ui";
import { useStreamReducer } from "@eforest/web-hooks";
import type { RepositoryNamespaceState } from "@eforest/reducers";
import { navigate, repoSectionPath, type RepoSection } from "../../navigation.js";
import { RepoNamespaceContext } from "./code-tab.js";
import { RepoHeader } from "./repo-header.js";
import { FlowPanel, UnderlineTab, layoutFor, type Layout, type OctName } from "./parts.js";
// ef:end

/** ef: the measured layout, shared with every routed view under the frame. */
export const LayoutContext = createContext<Layout>(layoutFor(1200));
export function useLayout(): Layout {
  return useContext(LayoutContext);
}

/** ef: one level of the phone navigation stack: a route and the live view it renders. */
export interface StackLevel {
  readonly key: string;
  readonly title: string;
  readonly href: string;
  readonly content: ReactNode;
}

// ef:begin levels come from the URL; pop navigates to the previous route
// ef: the frame measures its own box (like the block) and switches between the wide layout (global
// header + scrolling page) and the package NavigationStack; `levels` come from the route.
export default function GithubClone({
  levels,
  header,
  wide,
  leading,
  trailing,
}: {
  levels: readonly StackLevel[];
  header: (ui: Layout, width: number) => ReactNode;
  wide: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const [ref, width] = useContainerWidth<HTMLDivElement>(1200);
  const ui = layoutFor(width);

  /* Phone: the repo page is the root screen; each folder level, the open file and the PR push on top. */
  const screens: Screen[] = levels.map((level, index) => ({
    key: level.key,
    title: level.title,
    content: (
      <LayoutContext.Provider value={ui}>
        <div data-stack-level={level.href}>{level.content}</div>
      </LayoutContext.Provider>
    ),
    hideChromeOnScroll: false,
    ...(index === 0 && leading !== undefined ? { leading } : {}),
    ...(index === 0 && trailing !== undefined ? { trailing } : {}),
  }));
  // ef: popping navigates to the previous level's route (browser history stays the source of truth).
  const pop = () => {
    const previous = levels[levels.length - 2];
    if (previous !== undefined) navigate(previous.href);
  };

  return (
    <div
      ref={ref}
      className="relative flex h-full min-h-0 w-full flex-col"
      data-layout={ui.phone ? "phone" : ui.wide ? "wide" : "regular"}
    >
      {ui.phone ? (
        // ef: the skip link's target on phones too (the stack is the main content there).
        <div id="main-content" tabIndex={-1} className="relative min-h-0 flex-1 outline-none">
          <NavigationStack screens={screens} onPop={pop} />
        </div>
      ) : (
        <>
          {header(ui, width)}
          <div
            id="main-content"
            tabIndex={-1}
            data-scroll-root=""
            className="bl-scroll min-h-0 flex-1 overflow-y-auto outline-none"
          >
            <LayoutContext.Provider value={ui}>{wide}</LayoutContext.Provider>
          </div>
        </>
      )}
    </div>
  );
}
// ef:end

const TABS: readonly { id: RepoSection; icon: OctName; label: string }[] = [
  { id: "code", icon: "code", label: "Code" },
  { id: "issues", icon: "issue", label: "Issues" },
  { id: "pulls", icon: "pr", label: "Pull requests" },
  { id: "wiki", icon: "wiki", label: "Wiki" },
  { id: "settings", icon: "gear", label: "Settings" },
];

// ef:begin live namespace header; tabs navigate; the panel is the routed view
/** Repo header + tabs; each tab shows its screen (on wide layouts the open folder / file / PR shows in place). */
// ef: the header is the live namespace projection; the tabs navigate; the panel is the routed view.
export function RepoPage({
  ui,
  org,
  repo,
  tab,
  actions,
  children,
}: {
  ui: Layout;
  org: string;
  repo: string;
  tab: RepoSection;
  actions?: ReactNode;
  children: ReactNode;
}) {
  // ef: one live namespace subscription feeds the header (evidence) and the About sidebar.
  const namespace = useStreamReducer<RepositoryNamespaceState>({
    apiPath: `/api/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/home/namespace`,
    streamId: `repo-home:${org}/${repo}:namespace`,
    reducerId: "repo-namespace",
    // The namespace (project, visibility, owners) is read once per repository page: it is
    // chrome above every section, and a live follow here would hold a socket on every tab.
    follow: false,
  });
  return (
    <RepoNamespaceContext.Provider value={namespace.state.metadata}>
      <TabView
        placement="top"
        selectedKey={tab}
        onSelectionChange={(k) => navigate(repoSectionPath(org, repo, k as RepoSection))}
      >
        <div className="border-b border-border">
          <RepoHeader ui={ui} org={org} repo={repo} namespace={namespace} actions={actions} />
          <TabViewBar
            variant="plain"
            className="mt-2 overflow-x-auto px-2 [scrollbar-width:none] md:px-4"
          >
            <TabViewList aria-label="Repository" className="flex gap-1">
              {TABS.map((item) => (
                <UnderlineTab key={item.id} id={item.id} icon={item.icon} label={item.label} />
              ))}
            </TabViewList>
          </TabViewBar>
        </div>
        <TabViewPanels
          className={ui.phone ? "w-full" : "mx-auto w-full max-w-[1280px] px-4 py-6 md:px-6"}
        >
          {TABS.map((item) => (
            <FlowPanel key={item.id} id={item.id}>
              {item.id === tab ? children : null}
            </FlowPanel>
          ))}
        </TabViewPanels>
      </TabView>
    </RepoNamespaceContext.Provider>
  );
}
// ef:end
