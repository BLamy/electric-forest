import type { MouseEvent, ReactNode } from "react";
import { cn } from "@brett_lamy/ui";

export type RepoSection = "code" | "pulls" | "issues" | "wiki" | "settings";

/** Client-side navigation: every route is a pure function of `location.pathname`. */
export function navigate(href: string): void {
  if (`${window.location.pathname}${window.location.search}` === href) return;
  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function repoBase(org: string, repo: string): string {
  return `/orgs/${encodeURIComponent(org)}/repos/${encodeURIComponent(repo)}`;
}

export function repoSectionPath(org: string, repo: string, section: RepoSection): string {
  if (section === "code") return `/${encodeURIComponent(org)}/${encodeURIComponent(repo)}`;
  return `${repoBase(org, repo)}/${section}`;
}

export function repoLabelsPath(org: string, repo: string): string {
  return `${repoBase(org, repo)}/labels`;
}

function isActiveRoute(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  if (href.endsWith("/tree/main")) return pathname === href || pathname.startsWith(`${href}/`);
  return pathname === href;
}

export function RouteLink(props: {
  readonly href: string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly "aria-label"?: string | undefined;
  readonly "data-testid"?: string;
  readonly onNavigate?: () => void;
}): React.JSX.Element {
  const active = isActiveRoute(props.href, window.location.pathname);
  const follow = (event: MouseEvent<HTMLAnchorElement>): void => {
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
    props.onNavigate?.();
    navigate(props.href);
  };
  return (
    <a
      href={props.href}
      onClick={follow}
      className={cn("text-link hover:underline", props.className)}
      aria-current={active ? "page" : undefined}
      aria-label={props["aria-label"]}
      data-testid={props["data-testid"]}
    >
      {props.children}
    </a>
  );
}
