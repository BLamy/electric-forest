import type { MouseEvent } from "react";

function isActiveRoute(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  if (href.endsWith("/tree/main")) return pathname === href || pathname.startsWith(`${href}/`);
  return pathname === href;
}

export function RouteLink(props: {
  readonly href: string;
  readonly children: React.ReactNode;
  readonly "aria-label"?: string | undefined;
}): React.JSX.Element {
  const active = isActiveRoute(props.href, window.location.pathname);
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
    <a
      href={props.href}
      onClick={navigate}
      className={active ? "route-link route-link-active" : "route-link"}
      aria-current={active ? "page" : undefined}
      aria-label={props["aria-label"]}
    >
      {props.children}
    </a>
  );
}
