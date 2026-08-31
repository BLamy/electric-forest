import { lazy, Suspense, useEffect, useState } from "react";
import { IdentityRegion } from "./identity.js";
import { repositoryRoute } from "./components/shell/repository-route.js";
import { hasProofReceipt, hasReplayedSession, publicSitePage } from "./site/session.js";

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

const DesktopProductShell = lazy(async () => {
  const module = await import("./components/shell/ProductShell.js");
  return { default: module.DesktopProductShell };
});

const MobileRepositoryRoute = lazy(async () => {
  const module = await import("./MobileRepositoryRoute.js");
  return { default: module.MobileRepositoryRoute };
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

export function AppRoutes(): React.JSX.Element {
  const pathname = usePathname();
  const compact = useCompactProductShell();
  const session = hasReplayedSession();
  const proofReceipt = hasProofReceipt();
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
        <Suspense fallback={<RouteFallback />}>
          <MobileRepositoryRoute
            pathname={pathname}
            org={repository.org}
            repo={repository.repo}
            active={repository.active}
            detail={<Route pathname={pathname} />}
          />
        </Suspense>
      ) : (
        <DesktopProductShell
          pathname={pathname}
          diagnostics={
            <>
              <IdentityRegion />
              {proofReceipt ? <ProofReceipt /> : null}
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
