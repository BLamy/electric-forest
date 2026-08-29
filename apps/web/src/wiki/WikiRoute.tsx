import { useEffect, useState } from "react";
import { WikiEditor } from "./WikiEditor.js";
import { WikiIndex } from "./WikiIndex.js";
import { WikiPage } from "./WikiPage.js";
import { ensureProductionWikiBranch } from "./provisionWiki.js";

type ProvisioningState = "loading" | "ready" | `error:${string}`;

export function WikiRoute(props: {
  readonly org: string;
  readonly repo: string;
  readonly slug?: string;
  readonly editor?: boolean;
}): React.JSX.Element {
  const [state, setState] = useState<ProvisioningState>("loading");

  useEffect(() => {
    let active = true;
    setState("loading");
    void ensureProductionWikiBranch(props.org, props.repo).then(
      () => {
        if (active) setState("ready");
      },
      (error: unknown) => {
        if (active) setState(`error:${error instanceof Error ? error.message : String(error)}`);
      },
    );
    return () => {
      active = false;
    };
  }, [props.org, props.repo]);

  if (state === "loading") {
    return <p data-testid="wiki-provisioning">Provisioning the wiki branch…</p>;
  }
  if (state.startsWith("error:")) {
    return (
      <p role="alert" data-testid="wiki-provisioning-error">
        Wiki branch provisioning failed: {state.slice("error:".length)}
      </p>
    );
  }
  if (props.slug === undefined) return <WikiIndex org={props.org} repo={props.repo} />;
  return props.editor === true ? (
    <WikiEditor org={props.org} repo={props.repo} slug={props.slug} />
  ) : (
    <WikiPage org={props.org} repo={props.repo} slug={props.slug} />
  );
}
