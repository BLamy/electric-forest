import { useEffect, useState } from "react";
import { DispatchRefusalError } from "@eforest/web-hooks";
import { Markdown } from "../components/markdown/Markdown.js";
import { RouteLink } from "../navigation.js";
import {
  deleteWikiPageEvent,
  isWikiSlug,
  renameWikiPageEvent,
  useWikiPage,
  wikiEditorRoute,
  wikiIndexPath,
  wikiPageRoute,
} from "./useWiki.js";

function navigate(href: string): void {
  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function WikiPage(props: {
  readonly org: string;
  readonly repo: string;
  readonly slug: string;
}): React.JSX.Element {
  const wiki = useWikiPage(props.org, props.repo, props.slug);
  const [renameTo, setRenameTo] = useState(props.slug);
  const [pendingRename, setPendingRename] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (pendingRename !== undefined && wiki.pages.some((page) => page.slug === pendingRename)) {
      navigate(wikiPageRoute(props.org, props.repo, pendingRename));
    } else if (deleting && wiki.page === undefined && wiki.tree.status === "live") {
      navigate(wikiIndexPath(props.org, props.repo));
    }
  }, [deleting, pendingRename, props.org, props.repo, wiki.page, wiki.pages, wiki.tree.status]);

  const rename = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const normalized = renameTo.trim();
    if (!isWikiSlug(normalized)) {
      setError("The new slug must use lowercase letters, numbers, and hyphens.");
      return;
    }
    if (normalized === props.slug) return;
    setError(undefined);
    setPendingRename(normalized);
    try {
      await wiki.dispatch(renameWikiPageEvent(props.slug, normalized));
    } catch (cause) {
      setPendingRename(undefined);
      setError(cause instanceof DispatchRefusalError ? cause.message : "The page was not renamed.");
    }
  };

  const remove = async (): Promise<void> => {
    setError(undefined);
    setDeleting(true);
    try {
      await wiki.dispatch(deleteWikiPageEvent(props.slug));
    } catch (cause) {
      setDeleting(false);
      setError(cause instanceof DispatchRefusalError ? cause.message : "The page was not deleted.");
    }
  };

  const missing = wiki.tree.status === "live" && wiki.page === undefined;
  const source = wiki.content.state.text;
  return (
    <section
      className="wiki-view wiki-page"
      data-testid="wiki-page"
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
      data-page-revision={wiki.page?.revision ?? ""}
      data-content-digest={wiki.content.state.contentDigest}
      data-stream-status={wiki.tree.status}
    >
      <nav aria-label="Wiki breadcrumb">
        <RouteLink href={wikiIndexPath(props.org, props.repo)}>Wiki</RouteLink>
        <span aria-hidden="true"> / </span>
        <span>{props.slug}</span>
      </nav>
      <div className="wiki-heading">
        <div>
          <p className="eyebrow">Docstream page</p>
          <h2>{props.slug}</h2>
        </div>
        {missing ? null : (
          <RouteLink href={wikiEditorRoute(props.org, props.repo, props.slug)}>
            Edit source
          </RouteLink>
        )}
      </div>

      {error === undefined ? null : (
        <p role="alert" data-testid="wiki-action-error">
          {error}
        </p>
      )}
      {missing ? (
        <div data-testid="wiki-page-missing">
          <h3>Page not found</h3>
          <p>This page is not present on the live wiki branch.</p>
        </div>
      ) : source === null ? (
        <p data-testid="wiki-page-loading">Loading page content…</p>
      ) : (
        <Markdown source={source} data-testid="wiki-markdown" />
      )}

      {missing ? null : (
        <div className="wiki-page-actions">
          <form onSubmit={(event) => void rename(event)}>
            <label htmlFor="wiki-rename-slug">Rename page</label>
            <div>
              <input
                id="wiki-rename-slug"
                data-testid="wiki-rename-slug"
                value={renameTo}
                onChange={(event) => setRenameTo(event.currentTarget.value)}
              />
              <span aria-hidden="true">.md</span>
              <button type="submit" disabled={pendingRename !== undefined || deleting}>
                {pendingRename === undefined ? "Rename" : "Renaming…"}
              </button>
            </div>
          </form>
          <button
            type="button"
            className="danger-button"
            data-testid="wiki-delete"
            disabled={deleting || pendingRename !== undefined}
            onClick={() => void remove()}
          >
            {deleting ? "Deleting…" : "Delete page"}
          </button>
        </div>
      )}
    </section>
  );
}
