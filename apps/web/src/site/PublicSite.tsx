import { DocsPage } from "./DocsPage.js";
import { Landing } from "./Landing.js";
import { RoadmapDocumentPage, RoadmapPage, TaskPage } from "./RoadmapPage.js";
import type { PublicSitePage } from "./session.js";
import "../styles/site.css";

export function PublicSite(props: {
  readonly page: PublicSitePage;
  readonly session: boolean;
}): React.JSX.Element {
  switch (props.page.kind) {
    case "landing":
      return <Landing session={props.session} />;
    case "roadmap":
      return <RoadmapPage session={props.session} />;
    case "roadmap-document":
      return <RoadmapDocumentPage session={props.session} />;
    case "task":
      return <TaskPage key={props.page.id} session={props.session} id={props.page.id} />;
    case "docs":
      return <DocsPage session={props.session} slug={props.page.slug} />;
  }
}
