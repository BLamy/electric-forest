import {
  BookOpen,
  CircleDot,
  Code2,
  GitPullRequest,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";
import { RouteLink } from "../navigation.js";

export type RepoSection = "code" | "pulls" | "issues" | "wiki" | "settings";

function repoBase(org: string, repo: string): string {
  return `/orgs/${encodeURIComponent(org)}/repos/${encodeURIComponent(repo)}`;
}

export function navigate(href: string): void {
  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function repoSectionPath(org: string, repo: string, section: RepoSection): string {
  const base = repoBase(org, repo);
  if (section === "code") {
    return `/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/tree/main`;
  }
  return `${base}/${section === "pulls" ? "pulls" : section}`;
}

const sections = [
  { id: "code", label: "Code", icon: Code2 },
  { id: "pulls", label: "Pull Requests", icon: GitPullRequest },
  { id: "issues", label: "Issues", icon: CircleDot },
  { id: "wiki", label: "Wiki", icon: BookOpen },
  { id: "settings", label: "Settings", icon: Settings2 },
] as const;

export function RepoHeader(props: {
  readonly org: string;
  readonly repo: string;
  readonly active: RepoSection;
}): React.JSX.Element {
  return (
    <div className="repo-chrome" data-testid="repo-chrome">
      <div className="repo-identity-line">
        <span className="repo-mark" aria-hidden="true">
          <GitPullRequest size={17} strokeWidth={1.8} />
        </span>
        <span>{props.org}</span>
        <span aria-hidden="true">/</span>
        <strong>{props.repo}</strong>
        <span className="repo-visibility">Private</span>
      </div>
      <nav className="repo-tabs" aria-label="Repository">
        {sections.map((section) => {
          const Icon = section.icon;
          const active = section.id === props.active;
          return (
            <RouteLink
              key={section.id}
              href={repoSectionPath(props.org, props.repo, section.id)}
              aria-label={section.label}
            >
              <span className={active ? "repo-tab-inner repo-tab-inner-active" : "repo-tab-inner"}>
                <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
                <span>{section.label}</span>
              </span>
            </RouteLink>
          );
        })}
      </nav>
      <button
        className="repo-settings-quick"
        type="button"
        aria-label="Repository display settings"
      >
        <SlidersHorizontal size={16} />
      </button>
    </div>
  );
}

export function RepoCrumbs(props: {
  readonly org: string;
  readonly repo: string;
  readonly children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="repo-crumbs">
      <RouteLink href={repoSectionPath(props.org, props.repo, "pulls")}>{props.org}</RouteLink>
      <span aria-hidden="true">/</span>
      <strong>{props.repo}</strong>
      {props.children}
    </div>
  );
}
