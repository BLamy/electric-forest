import { lazy, Suspense, useEffect, useState } from "react";
import { IdentityRegion } from "./identity.js";
import { ForestShell } from "./components/shell/ForestShell.js";
import { repositoryRoute } from "./components/shell/repository-route.js";
import { preloadPrDetail, preloadPrDetailWhenIdle } from "./prs/preload.js";
import { hasProofReceipt, hasReplayedSession, publicSitePage } from "./site/session.js";
import { isHosted } from "./preview.js";

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
    if (isHosted()) return;
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
    <section className="grid gap-2 text-[12px]" data-testid="proof-receipt">
      <div>
        <p className="m-0 text-muted-foreground">Recorded proof receipt</p>
        <h2>PKCE and stream replay agree</h2>
      </div>
      <dl>
        <dt>PKCE method</dt>
        <dd data-testid="proof-pkce-method">{receipt.pkce.method}</dd>
        <dt>Challenge</dt>
        <dd data-testid="proof-pkce-challenge">{receipt.pkce.challenge}</dd>
        <dt>Authorization code</dt>
        <dd data-testid="proof-code-redeemed" className="text-success">
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
        <dd data-testid="proof-digest-match" className="text-success">
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

const PageRouter = lazy(async () => {
  const module = await import("./route-pages.js");
  return { default: module.PageRouter };
});

const PublicSite = lazy(async () => {
  const module = await import("./site/PublicSite.js");
  return { default: module.PublicSite };
});

function RouteFallback(): React.JSX.Element {
  return (
    <p data-testid="route-loading" role="status" className="m-0 p-4 text-muted-foreground">
      Loading route…
    </p>
  );
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
  const session = hasReplayedSession();
  const proofReceipt = hasProofReceipt();
  const site = publicSitePage(pathname, session);
  const inRepository = site === undefined && repositoryRoute(pathname) !== undefined;
  // Optimistically load the PR detail chunk (@pierre/diffs + Shiki): right away inside a
  // repository, where a PR is one click off, otherwise once the app goes idle.
  useEffect(() => {
    if (site !== undefined) return undefined;
    if (inRepository) {
      preloadPrDetail();
      return undefined;
    }
    return preloadPrDetailWhenIdle();
  }, [inRepository, site]);
  if (site !== undefined) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <PublicSite page={site} session={session} />
      </Suspense>
    );
  }
  return (
    <div className="h-full" data-testid="app-shell">
      <ForestShell
        pathname={pathname}
        render={(path) => <Route pathname={path} />}
        diagnostics={
          <>
            <IdentityRegion />
            {proofReceipt ? <ProofReceipt /> : null}
          </>
        }
      />
    </div>
  );
}
