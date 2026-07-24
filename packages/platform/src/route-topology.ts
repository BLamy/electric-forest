export type PlatformRouteId =
  | "home"
  | "dispatch"
  | "namespaces"
  | "repos"
  | "registry"
  | "device-grants"
  | "cli-tokens"
  | "cli-token-item"
  | "auth-login"
  | "auth-callback"
  | "auth-logout"
  | "cli-tokens-page";

export interface PlatformRouteDefinition {
  readonly id: PlatformRouteId;
  readonly match: "exact" | "prefix";
  readonly path: string;
  readonly operation:
    | "page"
    | "dispatch"
    | "namespace.lookup"
    | "application.read-follow"
    | "registry.query"
    | "cli-token.issue";
}

/**
 * The sole production HTTP topology. Both outer web routing and the platform
 * gateway dispatch from these definitions; route handlers never compare a
 * pathname themselves. This makes an added route an explicit conformance
 * change instead of source text a verifier has to guess how to discover.
 */
export const PLATFORM_ROUTES: readonly PlatformRouteDefinition[] = [
  { id: "home", match: "exact", path: "/", operation: "page" },
  { id: "cli-tokens", match: "exact", path: "/api/cli-tokens", operation: "cli-token.issue" },
  { id: "cli-token-item", match: "prefix", path: "/api/cli-tokens/", operation: "cli-token.issue" },
  { id: "device-grants", match: "exact", path: "/api/device-grants", operation: "cli-token.issue" },
  { id: "dispatch", match: "exact", path: "/api/dispatch", operation: "dispatch" },
  {
    id: "namespaces",
    match: "prefix",
    path: "/api/namespaces/",
    operation: "namespace.lookup",
  },
  { id: "repos", match: "exact", path: "/api/repos", operation: "application.read-follow" },
  { id: "repos", match: "prefix", path: "/api/repos/", operation: "application.read-follow" },
  { id: "auth-callback", match: "exact", path: "/auth/callback", operation: "page" },
  { id: "auth-login", match: "exact", path: "/auth/login", operation: "page" },
  { id: "auth-logout", match: "exact", path: "/auth/logout", operation: "page" },
  { id: "registry", match: "exact", path: "/registry", operation: "registry.query" },
  { id: "registry", match: "prefix", path: "/registry/", operation: "registry.query" },
  { id: "cli-tokens-page", match: "exact", path: "/settings/cli-tokens", operation: "page" },
] as const;

export function classifyPlatformRoute(pathname: string): PlatformRouteId | undefined {
  return PLATFORM_ROUTES.find((route) =>
    route.match === "exact" ? pathname === route.path : pathname.startsWith(route.path),
  )?.id;
}
