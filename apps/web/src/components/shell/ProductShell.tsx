import type { ReactNode } from "react";
import { RepoHeader } from "../../prs/RepoChrome.js";
import { ForestShell } from "./ForestShell.js";
import { repositoryRoute } from "./repository-route.js";

export { repositoryRoute } from "./repository-route.js";

/** Desktop frame: TouchKit chatkit's Discord-style shell (see ForestShell). */
export function DesktopProductShell(props: {
  readonly pathname: string;
  readonly diagnostics?: ReactNode;
  readonly children: ReactNode;
}): React.JSX.Element {
  const repository = repositoryRoute(props.pathname);
  return (
    <ForestShell
      pathname={props.pathname}
      header={
        repository === undefined || repository.ownsHeader ? undefined : (
          <RepoHeader org={repository.org} repo={repository.repo} active={repository.active} />
        )
      }
      {...(props.diagnostics === undefined ? {} : { diagnostics: props.diagnostics })}
    >
      {props.children}
    </ForestShell>
  );
}
