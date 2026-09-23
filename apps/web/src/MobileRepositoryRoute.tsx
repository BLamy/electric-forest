import type { ReactNode } from "react";
import { Icon, List, ListRow, ListSection } from "@brett_lamy/ui";
import { MobileProductShell } from "./components/mobile/MobileProductShell.js";
import { navigate, repoSectionPath, type RepoSection } from "./prs/RepoChrome.js";

const repositorySections: readonly {
  id: RepoSection;
  title: string;
  subtitle: string;
  icon: string;
}[] = [
  { id: "code", title: "Code", subtitle: "Browse branches and files", icon: "layers" },
  { id: "pulls", title: "Pull Requests", subtitle: "Review activity and changes", icon: "message" },
  { id: "issues", title: "Issues", subtitle: "Plan and track work", icon: "info" },
  { id: "wiki", title: "Wiki", subtitle: "Read repository documentation", icon: "star" },
  { id: "settings", title: "Settings", subtitle: "Configure this repository", icon: "sliders" },
];

export function MobileRepositoryRoute(props: {
  readonly pathname: string;
  readonly org: string;
  readonly repo: string;
  readonly active: RepoSection;
  readonly detail: ReactNode;
}): React.JSX.Element {
  const section = repositorySections.find((item) => item.id === props.active);
  const rootContent = (
    <List inset>
      <ListSection
        title={`${props.org} / ${props.repo}`}
        footer="Every mutation is backed by a durable stream."
      >
        {repositorySections.map((item) => (
          <ListRow
            key={item.id}
            title={item.title}
            subtitle={item.subtitle}
            leading={<Icon name={item.icon} />}
            accessory="chevron"
            selected={item.id === props.active}
            onPress={() => navigate(repoSectionPath(props.org, props.repo, item.id))}
          />
        ))}
      </ListSection>
    </List>
  );
  const rootScreen = {
    key: "repository",
    title: props.repo,
    largeTitle: true,
    content: rootContent,
    bottomInset: 78,
  };
  const detailScreen = {
    key: props.pathname,
    title: section?.title ?? "Repository",
    content: (
      <article id="main-content" className="mobile-repository-content" tabIndex={-1}>
        {props.detail}
      </article>
    ),
    bottomInset: 78,
  };
  return (
    <MobileProductShell
      org={props.org}
      repo={props.repo}
      activeTab={props.active}
      screens={[rootScreen, detailScreen]}
      onPop={() => navigate(`/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}`)}
      routeForTab={(tab) => repoSectionPath(props.org, props.repo, tab)}
      sidebar={rootContent}
      regularMaster={rootContent}
      className="mobile-repository-shell"
    />
  );
}
