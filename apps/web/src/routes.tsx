import { useEffect, useState, type MouseEvent } from "react";
import { IdentityRegion } from "./identity.js";

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
        <RouteLink href="/lost/deep/trail">Missing trail</RouteLink>
      </nav>
      <article>
        <Route pathname={pathname} />
        <p>Stream-backed views grow here in the next canopy gates.</p>
      </article>
    </main>
  );
}
