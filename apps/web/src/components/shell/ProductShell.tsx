import {
  Box,
  Bot,
  ChevronsLeft,
  Cuboid,
  Home,
  MessageSquarePlus,
  Search,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";
import type { ReactNode } from "react";
import { RouteLink } from "../../navigation.js";
import { RepoHeader, type RepoSection } from "../../prs/RepoChrome.js";
import { Button } from "../ui/button.js";

interface RepositoryRoute {
  readonly org: string;
  readonly repo: string;
  readonly active: RepoSection;
  readonly ownsHeader: boolean;
}

function decoded(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function repositoryRoute(pathname: string): RepositoryRoute | undefined {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] === "orgs" && segments[2] === "repos") {
    const org = decoded(segments[1]);
    const repo = decoded(segments[3]);
    if (org === undefined || repo === undefined) return undefined;
    const section = segments[4];
    const active: RepoSection =
      section === "pulls"
        ? "pulls"
        : section === "issues"
          ? "issues"
          : section === "wiki"
            ? "wiki"
            : section === "settings"
              ? "settings"
              : "code";
    return { org, repo, active, ownsHeader: section === "pulls" };
  }
  if (segments.length >= 2 && ["tree", "blob", "history"].includes(segments[2] ?? "")) {
    const org = decoded(segments[0]);
    const repo = decoded(segments[1]);
    if (org !== undefined && repo !== undefined)
      return { org, repo, active: "code", ownsHeader: false };
  }
  if (segments.length === 2 && segments[0] !== "organizations") {
    const org = decoded(segments[0]);
    const repo = decoded(segments[1]);
    if (org !== undefined && repo !== undefined)
      return { org, repo, active: "code", ownsHeader: false };
  }
  return undefined;
}

function ProductRail(): React.JSX.Element {
  return (
    <aside className="product-rail" aria-label="Electric Forest">
      <div className="product-rail-brand">
        <span className="product-rail-logo" aria-hidden="true">
          <Cuboid size={21} strokeWidth={1.8} />
        </span>
        <Button variant="ghost" size="icon" aria-label="Collapse navigation">
          <ChevronsLeft size={17} />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Search repositories">
          <Search size={18} />
        </Button>
      </div>
      <nav className="product-rail-nav" aria-label="Product">
        <RouteLink href="/">
          <MessageSquarePlus size={18} />
          <span>New workspace</span>
        </RouteLink>
        <RouteLink href="/repositories">
          <Bot size={18} />
          <span>Automations</span>
        </RouteLink>
        <RouteLink href="/repositories">
          <Box size={18} />
          <span>Codebase</span>
          <small>Beta</small>
        </RouteLink>
        <RouteLink href="/">
          <Home size={18} />
          <span>Dashboard</span>
        </RouteLink>
      </nav>
      <div className="product-rail-agents">
        <div>
          <span>Agents</span>
          <SlidersHorizontal size={15} />
        </div>
        <p>No agents yet</p>
      </div>
      <div className="product-account">
        <span aria-hidden="true">E</span>
        <div>
          <strong>Electric Forest</strong>
          <small>Stream native</small>
        </div>
        <Settings2 size={16} aria-hidden="true" />
      </div>
    </aside>
  );
}

export function DesktopProductShell(props: {
  readonly pathname: string;
  readonly diagnostics?: ReactNode;
  readonly children: ReactNode;
}): React.JSX.Element {
  const repository = repositoryRoute(props.pathname);
  return (
    <div className="product-shell" data-product-shell="desktop">
      <ProductRail />
      <div className="product-stage">
        {repository === undefined || repository.ownsHeader ? null : (
          <RepoHeader org={repository.org} repo={repository.repo} active={repository.active} />
        )}
        <div className="product-content">{props.children}</div>
        {props.diagnostics === undefined ? null : (
          <details className="product-diagnostics">
            <summary>Stream diagnostics</summary>
            {props.diagnostics}
          </details>
        )}
      </div>
    </div>
  );
}
