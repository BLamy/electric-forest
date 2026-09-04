import { lazy, Suspense, useEffect, useState } from "react";
import { Icon, List, ListRow, ListSection } from "@brett_lamy/ui";
import { IdentityRegion } from "./identity.js";
import { MobileProductShell } from "./components/mobile/MobileProductShell.js";
import { DesktopProductShell, repositoryRoute } from "./components/shell/ProductShell.js";
import { navigate, repoSectionPath, type RepoSection } from "./prs/RepoChrome.js";
import { hasReplayedSession, publicSitePage } from "./site/session.js";

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

function useCompactProductShell(): boolean {
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 899px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 899px)");
    const update = (): void => setCompact(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return compact;
}

const PageRouter = lazy(async () => {
  const module = await import("./route-pages.js");
  return { default: module.PageRouter };
});

const PublicSite = lazy(async () => {
  const module = await import("./site/PublicSite.js");
  return { default: module.PublicSite };
});

function RouteFallback(): React.JSX.Element {
  return <p data-testid="route-loading">Loading route…</p>;
}

function Route(props: { readonly pathname: string }): React.JSX.Element {
  return (
    <Suspense fallback={<RouteFallback />}>
      <PageRouter pathname={props.pathname} />
    </Suspense>
  );
}

const repositorySections: readonly {
  id: RepoSection;
  title: string;
  subtitle: string;
  icon: string;
}[] = [
  { id: "code", title: "Code", subtitle: "Browse branches and files", icon: "layers" },
  { id: "pulls", title: "Pull Requests", subtitle: "Review activity and changes", icon: "message" },
  { id: "issues", title: "Issues", subtitle: "Plan and track work", icon: "info" },
  { id: "wiki", title: "Wiki", subtitle: "Read repository documentation", icon: "star" },
  { id: "settings", title: "Settings", subtitle: "Configure this repository", icon: "sliders" },
];

function MobileRepositoryRoute(props: {
  readonly pathname: string;
  readonly org: string;
  readonly repo: string;
  readonly active: RepoSection;
}): React.JSX.Element {
  const section = repositorySections.find((item) => item.id === props.active);
  const rootContent = (
    <List inset>
      <ListSection
        title={`${props.org} / ${props.repo}`}
        footer="Every mutation is backed by a durable stream."
      >
        {repositorySections.map((item) => (
          <ListRow
            key={item.id}
            title={item.title}
            subtitle={item.subtitle}
            leading={<Icon name={item.icon} />}
            accessory="chevron"
            selected={item.id === props.active}
            onPress={() => navigate(repoSectionPath(props.org, props.repo, item.id))}
          />
        ))}
      </ListSection>
    </List>
  );
  const rootScreen = {
    key: "repository",
    title: props.repo,
    largeTitle: true,
    content: rootContent,
    bottomInset: 78,
  };
  const detailScreen = {
    key: props.pathname,
    title: section?.title ?? "Repository",
    content: (
      <article id="main-content" className="mobile-repository-content" tabIndex={-1}>
        <Route pathname={props.pathname} />
      </article>
    ),
    bottomInset: 78,
  };
  return (
    <MobileProductShell
      org={props.org}
      repo={props.repo}
      activeTab={props.active}
      screens={[rootScreen, detailScreen]}
      onPop={() => navigate(`/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}`)}
      routeForTab={(tab) => repoSectionPath(props.org, props.repo, tab)}
      sidebar={rootContent}
      regularMaster={rootContent}
      className="mobile-repository-shell"
    />
  );
}

export function AppRoutes(): React.JSX.Element {
  const pathname = usePathname();
  const compact = useCompactProductShell();
  const session = hasReplayedSession();
  const site = publicSitePage(pathname, session);
  if (site !== undefined) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <PublicSite page={site} session={session} />
      </Suspense>
    );
  }
  const repository = repositoryRoute(pathname);
  const mobileRepository = compact && repository !== undefined && repository.active !== "pulls";
  return (
    <main className="app-shell-repository" data-testid="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {mobileRepository ? (
        <MobileRepositoryRoute
          pathname={pathname}
          org={repository.org}
          repo={repository.repo}
          active={repository.active}
        />
      ) : (
        <DesktopProductShell
          pathname={pathname}
          diagnostics={
            <>
              <IdentityRegion />
              <ProofReceipt />
            </>
          }
        >
          <article id="main-content" tabIndex={-1}>
            <Route pathname={pathname} />
          </article>
        </DesktopProductShell>
      )}
    </main>
  );
}
