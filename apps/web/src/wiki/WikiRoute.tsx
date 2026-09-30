import { useEffect, useState } from "react";
import { WikiEditor } from "./WikiEditor.js";
import { WikiIndex } from "./WikiIndex.js";
import { WikiPage } from "./WikiPage.js";
import { ensureProductionWikiBranch } from "./provisionWiki.js";
import type { Layout } from "../blocks/github/parts.js";

type ProvisioningState = "loading" | "ready" | `error:${string}`;

export function WikiRoute(props: {
  readonly ui: Layout;
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
    return (
      <p data-testid="wiki-provisioning" role="status" className="m-0 text-muted-foreground">
        Provisioning the wiki branch…
      </p>
    );
  }
  if (state.startsWith("error:")) {
    return (
      <p role="alert" data-testid="wiki-provisioning-error" className="m-0 text-destructive">
        Wiki branch provisioning failed: {state.slice("error:".length)}
      </p>
    );
  }
  const frame = props.ui.phone ? "px-4 py-4" : "";
  if (props.slug === undefined)
    return (
      <div className={frame}>
        <WikiIndex org={props.org} repo={props.repo} />
      </div>
    );
  return (
    <div className={frame}>
      {props.editor === true ? (
        <WikiEditor org={props.org} repo={props.repo} slug={props.slug} />
      ) : (
        <WikiPage org={props.org} repo={props.repo} slug={props.slug} />
      )}
    </div>
  );
}
