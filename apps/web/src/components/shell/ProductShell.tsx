import { useEffect, type ReactNode } from "react";
import { RepoHeader } from "../../prs/RepoChrome.js";
import { preloadPrDetail, preloadPrDetailWhenIdle } from "../../prs/preload.js";
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
  const inRepository = repository !== undefined;
  // Optimistically load the PR detail chunk (@pierre/diffs + Shiki): right away inside a
  // repository, where a PR is one click off, otherwise once the app goes idle.
  useEffect(() => {
    if (inRepository) {
      preloadPrDetail();
      return undefined;
    }
    return preloadPrDetailWhenIdle();
  }, [inRepository]);
  return (
    <ForestShell
      pathname={props.pathname}
      header={
        repository === undefined ? undefined : (
          <RepoHeader org={repository.org} repo={repository.repo} active={repository.active} />
        )
      }
      {...(props.diagnostics === undefined ? {} : { diagnostics: props.diagnostics })}
    >
      {props.children}
    </ForestShell>
  );
}
