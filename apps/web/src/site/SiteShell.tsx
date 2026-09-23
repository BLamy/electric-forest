import type { ReactNode } from "react";
import { RouteLink } from "../navigation.js";
import { GITHUB_URL } from "./content.js";

export function SiteShell(props: {
  readonly session: boolean;
  readonly page: "landing" | "roadmap" | "docs";
  readonly wide?: boolean;
  readonly children: ReactNode;
}): React.JSX.Element {
  const homeHref = props.session ? "/home" : "/";
  return (
    <div className="site" data-testid="public-site" data-site-page={props.page}>
      <header className="site-nav">
        <div className="site-wrap site-nav-in">
          <RouteLink href={homeHref} aria-label="Electric Forest home">
            <span className="site-brand">
              <span className="site-brand-dot" aria-hidden="true" />
              <b>electric forest</b>
            </span>
          </RouteLink>
          <nav className="site-nav-links" aria-label="Site">
            <a href={`${homeHref}#features`}>Features</a>
            <a href={`${homeHref}#model`}>How it works</a>
            <RouteLink href="/roadmap">Roadmap</RouteLink>
            <RouteLink href="/docs">Docs</RouteLink>
            <a href={GITHUB_URL} target="_blank" rel="noopener" aria-label="Star on GitHub">
              GitHub
            </a>
            {props.session ? (
              <RouteLink href="/">
                <span className="site-btn">
                  Open the forest <span className="site-arrow">→</span>
                </span>
              </RouteLink>
            ) : (
              <a
                className="site-btn"
                href="/auth/login"
                data-testid="site-login"
                aria-label="Log in"
              >
                Log in <span className="site-arrow">→</span>
              </a>
            )}
          </nav>
        </div>
      </header>
      <main className={props.wide ? "site-main site-main-wide" : "site-main"} id="main-content">
        {props.children}
      </main>
      <footer className="site-footer">
        <div className="site-wrap site-footer-in">
          <div>
            <span className="site-brand">
              <span className="site-brand-dot" aria-hidden="true" />
              <b>electric forest</b>
            </span>{" "}
            — a code host on durable streams.
          </div>
          <div className="site-footer-links">
            <RouteLink href="/roadmap">Roadmap</RouteLink>
            <RouteLink href="/docs">Docs</RouteLink>
            <a href={GITHUB_URL} target="_blank" rel="noopener" aria-label="Star on GitHub">
              GitHub
            </a>
            <a href="/auth/login" aria-label="Log in">
              Log in
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

export function StatusBadge(props: { readonly status: string }): React.JSX.Element {
  const label =
    props.status === "in-progress"
      ? "in progress"
      : props.status === "implemented"
        ? "awaiting critic"
        : props.status;
  return (
    <span className={`site-status site-status-${props.status}`} data-status={props.status}>
      {label}
    </span>
  );
}
