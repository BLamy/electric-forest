import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { NavigationStack, SplitView, TabBar, TouchKitProvider, type Screen } from "@brett_lamy/ui";
import { TOUCHKIT_DARK_TOKEN_BRIDGE } from "../touchkit/tokens.js";
import "../../styles/tokens.css";
import { useWhoami } from "../../chat/useWhoami.js";
import { personalAccount } from "../../personal-account.js";

export type MobileRepoSection = "code" | "pulls" | "issues" | "wiki" | "settings";
export type MobileWindowClass = "compact" | "medium" | "regular";

export interface MobileProductTab {
  readonly id: MobileRepoSection;
  readonly title: string;
  readonly icon: string;
}

export const MOBILE_PRODUCT_TABS: readonly MobileProductTab[] = [
  { id: "code", title: "Code", icon: "layers" },
  { id: "pulls", title: "Pulls", icon: "message" },
  { id: "issues", title: "Issues", icon: "info" },
  { id: "wiki", title: "Wiki", icon: "star" },
  { id: "settings", title: "Settings", icon: "sliders" },
];

export { TOUCHKIT_DARK_TOKEN_BRIDGE } from "../touchkit/tokens.js";

function currentWindowClass(): MobileWindowClass {
  if (typeof window === "undefined") return "compact";
  if (window.matchMedia("(min-width: 840px)").matches) return "regular";
  if (window.matchMedia("(min-width: 600px)").matches) return "medium";
  return "compact";
}

export function useMobileWindowClass(controlled?: MobileWindowClass): MobileWindowClass {
  const [responsive, setResponsive] = useState(currentWindowClass);

  useEffect(() => {
    if (controlled !== undefined) return;
    const medium = window.matchMedia("(min-width: 600px)");
    const regular = window.matchMedia("(min-width: 840px)");
    const update = (): void => setResponsive(currentWindowClass());
    medium.addEventListener("change", update);
    regular.addEventListener("change", update);
    update();
    return () => {
      medium.removeEventListener("change", update);
      regular.removeEventListener("change", update);
    };
  }, [controlled]);

  return controlled ?? responsive;
}

function navigateToRoute(href: string): void {
  if (window.location.pathname === href) return;
  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function withTabInset(
  screens: readonly Screen[],
  onRefresh: () => void,
  refreshVersion: number,
): Screen[] {
  return screens.map((screen, index) => ({
    ...screen,
    bottomInset: screen.bottomInset ?? 70,
    hideChromeOnScroll: screen.hideChromeOnScroll ?? true,
    ...(index === screens.length - 1
      ? {
          onRefresh: screen.onRefresh ?? onRefresh,
          content: (
            <div
              key={`mobile-refresh-${String(refreshVersion)}`}
              className="mobile-refresh-boundary"
              data-mobile-refresh-version={refreshVersion}
            >
              {screen.content}
            </div>
          ),
        }
      : {}),
  }));
}

export interface MobileProductShellProps {
  readonly org: string;
  readonly repo: string;
  readonly activeTab: MobileRepoSection;
  /**
   * The complete compact route depth, ordered repository root -> entity -> detail.
   * Keep prior screens in this array so NavigationStack can provide edge-swipe back.
   */
  readonly screens: readonly Screen[];
  readonly onPop: () => void;
  readonly routeForTab: (tab: MobileRepoSection) => string;
  readonly onNavigateTab?: (tab: MobileRepoSection, href: string) => void;
  readonly windowClass?: MobileWindowClass;
  /** Repository/product navigation used as SplitView's sidebar or compact drawer. */
  readonly sidebar?: ReactNode;
  /** A stable index/list pane used only by regular three-column SplitView. */
  readonly regularMaster?: ReactNode;
  /** A wide detail surface used only by regular three-column SplitView. */
  readonly regularDetail?: ReactNode;
  readonly drawerOpen?: boolean;
  readonly onCloseDrawer?: () => void;
  /** Optional route-specific refresh work after NavigationStack's pull gesture completes. */
  readonly onRefresh?: () => void;
  readonly overlays?: ReactNode;
  readonly safeTop?: boolean | number;
  readonly className?: string;
  readonly style?: CSSProperties;
}

/**
 * Shared responsive adapter for repository product routes.
 *
 * Compact and medium widths deliberately put the full route depth in SplitView's
 * master slot because @brett_lamy/ui 0.0.1 does not render its detail slot there.
 * Regular width uses the package's actual sidebar/master/detail composition.
 */
export function MobileProductShell(props: MobileProductShellProps): React.JSX.Element {
  const windowClass = useMobileWindowClass(props.windowClass);
  const personal = personalAccount(useWhoami());
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refresh = useCallback(() => {
    setRefreshVersion((version) => version + 1);
    window.dispatchEvent(
      new CustomEvent("eforest:mobile-refresh", {
        detail: { org: props.org, repo: props.repo, activeTab: props.activeTab },
      }),
    );
    props.onRefresh?.();
  }, [props.activeTab, props.onRefresh, props.org, props.repo]);
  const screens = useMemo(
    () => withTabInset(props.screens, refresh, refreshVersion),
    [props.screens, refresh, refreshVersion],
  );
  const rootScreen = screens[0];
  const compactStack = (
    <NavigationStack
      screens={screens}
      onPop={props.onPop}
      defIns={70}
      className="mobile-product-navigation-stack"
    />
  );
  const regularMaster =
    props.regularMaster ??
    (rootScreen === undefined ? null : (
      <NavigationStack
        screens={[rootScreen]}
        onPop={props.onPop}
        defIns={70}
        className="mobile-product-navigation-stack"
      />
    ));
  const regularDetail = props.regularDetail ?? compactStack;
  const tabs = MOBILE_PRODUCT_TABS.map((tab) => ({ ...tab }));

  return (
    <TouchKitProvider
      dark
      tint="var(--accent-primary)"
      safeTop={props.safeTop}
      className={["mobile-product-shell", props.className].filter(Boolean).join(" ")}
      style={{ ...TOUCHKIT_DARK_TOKEN_BRIDGE, ...props.style }}
    >
      <main
        className="mobile-product-layout"
        data-mobile-product-shell="@brett_lamy/ui@0.0.1"
        data-mobile-refresh="NavigationStack.Screen.onRefresh"
        data-mobile-hide-chrome="NavigationStack.Screen.hideChromeOnScroll"
        data-window-class={windowClass}
        aria-label={`${props.org} / ${props.repo}`}
      >
        {personal !== null && (
          <button
            className="mobile-personal-account"
            aria-label={`${personal.name} · Personal account`}
            onClick={() => navigateToRoute("/")}
          >
            {personal.name.slice(0, 1).toUpperCase()}
          </button>
        )}
        <SplitView
          wc={windowClass}
          sidebar={props.sidebar}
          master={windowClass === "regular" ? regularMaster : compactStack}
          detail={windowClass === "regular" ? regularDetail : undefined}
          drawerOpen={props.drawerOpen}
          onCloseDrawer={props.onCloseDrawer}
          className="mobile-product-split-view"
        />
        <nav className="mobile-product-tabs" aria-label="Repository sections">
          <TabBar
            items={tabs}
            selected={props.activeTab}
            hideOnScroll={false}
            onSelect={(id: string) => {
              const tab = id as MobileRepoSection;
              const href = props.routeForTab(tab);
              if (props.onNavigateTab === undefined) navigateToRoute(href);
              else props.onNavigateTab(tab, href);
            }}
          />
        </nav>
        {props.overlays}
      </main>
    </TouchKitProvider>
  );
}
