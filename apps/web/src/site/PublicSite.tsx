import { lazy, Suspense } from "react";
import type { PublicSitePage } from "./session.js";
import "../styles/site.css";

const Landing = lazy(async () => {
  const module = await import("./Landing.js");
  return { default: module.Landing };
});
const RoadmapPage = lazy(async () => {
  const module = await import("./RoadmapPage.js");
  return { default: module.RoadmapPage };
});
const RoadmapDocumentPage = lazy(async () => {
  const module = await import("./RoadmapPage.js");
  return { default: module.RoadmapDocumentPage };
});
const TaskPage = lazy(async () => {
  const module = await import("./RoadmapPage.js");
  return { default: module.TaskPage };
});
const DocsPage = lazy(async () => {
  const module = await import("./DocsPage.js");
  return { default: module.DocsPage };
});

function PublicRouteFallback(): React.JSX.Element {
  return <p data-testid="route-loading">Loading page…</p>;
}

export function PublicSite(props: {
  readonly page: PublicSitePage;
  readonly session: boolean;
}): React.JSX.Element {
  let page: React.JSX.Element;
  switch (props.page.kind) {
    case "landing":
      page = <Landing session={props.session} />;
      break;
    case "roadmap":
      page = <RoadmapPage session={props.session} />;
      break;
    case "roadmap-document":
      page = <RoadmapDocumentPage session={props.session} />;
      break;
    case "task":
      page = <TaskPage key={props.page.id} session={props.session} id={props.page.id} />;
      break;
    case "docs":
      page = <DocsPage session={props.session} slug={props.page.slug} />;
      break;
  }
  return <Suspense fallback={<PublicRouteFallback />}>{page}</Suspense>;
}
