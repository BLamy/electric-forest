import { useEffect, useState } from "react";
import { DispatchRefusalError } from "@eforest/web-hooks";
import { RouteLink } from "../navigation.js";
import {
  createWikiPageEvent,
  isWikiSlug,
  useWiki,
  wikiEditorRoute,
  wikiPageRoute,
} from "./useWiki.js";

function navigate(href: string): void {
  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function WikiIndex(props: {
  readonly org: string;
  readonly repo: string;
}): React.JSX.Element {
  const wiki = useWiki(props.org, props.repo);
  const [slug, setSlug] = useState("");
  const [pendingSlug, setPendingSlug] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (pendingSlug === undefined) return;
    if (!wiki.pages.some((page) => page.slug === pendingSlug)) return;
    navigate(wikiEditorRoute(props.org, props.repo, pendingSlug));
  }, [pendingSlug, props.org, props.repo, wiki.pages]);

  const create = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const normalized = slug.trim();
    if (!isWikiSlug(normalized)) {
      setError("Use lowercase letters, numbers, and hyphens; begin with a letter or number.");
      return;
    }
    if (wiki.pages.some((page) => page.slug === normalized)) {
      setError("That wiki page already exists.");
      return;
    }
    setError(undefined);
    setPendingSlug(normalized);
    try {
      await wiki.dispatch(createWikiPageEvent(props.org, props.repo, normalized));
    } catch (cause) {
      setPendingSlug(undefined);
      setError(cause instanceof DispatchRefusalError ? cause.message : "The page was not created.");
    }
  };

  return (
    <section
      className="wiki-view wiki-index"
      data-testid="wiki-index"
      data-ef-stream={wiki.streamId}
      data-ef-offset={wiki.tree.checkpoint}
      data-tree-digest={wiki.tree.digest}
      data-state-digest={wiki.tree.digest}
      data-ef-reducer="streamfs@2"
      data-ef-confirmed-offset={wiki.dispatch.confirmedOffset}
      data-dispatches-sent={wiki.dispatch.counters.sent}
      data-dispatches-confirmed={wiki.dispatch.counters.confirmed}
      data-dispatches-reconciled={wiki.dispatch.counters.reconciled}
      data-dispatches-refused={wiki.dispatch.counters.refused}
      data-stream-status={wiki.tree.status}
    >
      <div className="wiki-heading">
        <div>
          <p className="eyebrow">Live StreamFS branch</p>
          <h2>Wiki</h2>
          <p>
            {props.org} / {props.repo}
          </p>
        </div>
        <code data-testid="wiki-tree-digest">{wiki.tree.digest}</code>
      </div>

      <form className="wiki-new-page" onSubmit={(event) => void create(event)}>
        <label htmlFor="wiki-new-slug">New page</label>
        <div>
          <input
            id="wiki-new-slug"
            data-testid="wiki-new-slug"
            value={slug}
            onChange={(event) => setSlug(event.currentTarget.value)}
            placeholder="getting-started"
            autoComplete="off"
            aria-describedby="wiki-slug-help"
          />
          <span aria-hidden="true">.md</span>
          <button type="submit" disabled={pendingSlug !== undefined}>
            {pendingSlug === undefined ? "Create page" : "Creating…"}
          </button>
        </div>
        <small id="wiki-slug-help">Lowercase letters, numbers, and hyphens.</small>
      </form>

      {error === undefined ? null : (
        <p role="alert" data-testid="wiki-create-error">
          {error}
        </p>
      )}
      {wiki.tree.status === "loading" ? <p data-testid="wiki-loading">Loading wiki…</p> : null}
      {wiki.tree.status.startsWith("error:") ? (
        <p role="alert" data-testid="wiki-refusal">
          Wiki projection refused: {wiki.tree.status.slice("error:".length)}
        </p>
      ) : null}
      {wiki.tree.status !== "loading" && !wiki.tree.status.startsWith("error:") ? (
        wiki.pages.length === 0 ? (
          <p data-testid="wiki-empty">This wiki has no pages yet.</p>
        ) : (
          <ul className="wiki-page-list" data-testid="wiki-page-list">
            {wiki.pages.map((page) => (
              <li
                key={page.path}
                data-testid="wiki-page-row"
                data-page-path={page.path}
                data-page-revision={page.revision}
              >
                <RouteLink href={wikiPageRoute(props.org, props.repo, page.slug)}>
                  {page.slug}
                </RouteLink>
                <span>{page.size} bytes</span>
                <code>{page.contentDigest.slice(0, 12)}</code>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
