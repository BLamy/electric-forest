import { useEffect, useState, type MouseEvent } from "react";
import { useStreamReducer } from "@eforest/web-hooks";
import { IdentityRegion } from "./identity.js";

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

function RouteLink(props: {
  readonly href: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  const navigate = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    window.history.pushState(null, "", props.href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  return (
    <a href={props.href} onClick={navigate}>
      {props.children}
    </a>
  );
}

function Route(props: { readonly pathname: string }): React.JSX.Element {
  const segments = props.pathname.split("/").filter(Boolean);
  if (segments.length === 4 && segments[0] === "inspect") {
    return <StreamInspector org={segments[1]!} repo={segments[2]!} branch={segments[3]!} />;
  }
  if (segments.length === 0) {
    return <h2 data-testid="route-home">Forest home</h2>;
  }
  if (segments.length === 1) {
    return <h2 data-testid="route-org">Organization: {segments[0]}</h2>;
  }
  if (segments.length === 2) {
    return (
      <h2 data-testid="route-repo">
        Repository: {segments[0]}/{segments[1]}
      </h2>
    );
  }
  return <h2 data-testid="route-not-found">404 — trail not found</h2>;
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
    followWaitMs: 1_000,
  });
  return (
    <section
      data-testid="stream-inspector"
      data-stream-id={streamId}
      data-application-checkpoint={projection.checkpoint}
      data-state-digest={projection.digest}
      data-reducer-version="2"
      data-stream-status={projection.status}
    >
      <p className="eyebrow">Live application projection</p>
      <h2>Stream inspector</h2>
      <dl>
        <dt>Stream</dt>
        <dd data-testid="inspector-stream">{streamId}</dd>
        <dt>Application checkpoint</dt>
        <dd data-testid="inspector-checkpoint">{projection.checkpoint}</dd>
        <dt>Canonical digest</dt>
        <dd data-testid="inspector-digest">{projection.digest}</dd>
        <dt>Reducer</dt>
        <dd data-testid="inspector-reducer">streamfs@2</dd>
        <dt>Status</dt>
        <dd data-testid="inspector-status">{projection.status}</dd>
      </dl>
      <pre data-testid="inspector-state">{JSON.stringify(projection.state, null, 2)}</pre>
    </section>
  );
}

export function AppRoutes(): React.JSX.Element {
  const pathname = usePathname();
  return (
    <main data-testid="app-shell">
      <header>
        <div>
          <p className="eyebrow">electric forest</p>
          <h1>The canopy</h1>
        </div>
        <form action="/auth/logout" method="post">
          <button type="submit">Log out</button>
        </form>
      </header>
      <IdentityRegion />
      <nav aria-label="Canopy routes">
        <RouteLink href="/">Home</RouteLink>
        <RouteLink href="/maple">Maple</RouteLink>
        <RouteLink href="/maple/reading-room">Reading room</RouteLink>
        <RouteLink href="/inspect/maple/reading-room/main">Stream inspector</RouteLink>
        <RouteLink href="/lost/deep/trail">Missing trail</RouteLink>
      </nav>
      <ProofReceipt />
      <article>
        <Route pathname={pathname} />
        <p>Stream-backed views grow here in the next canopy gates.</p>
      </article>
    </main>
  );
}
