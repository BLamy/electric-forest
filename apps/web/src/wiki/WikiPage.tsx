import { useEffect, useState } from "react";
import { DispatchRefusalError } from "@eforest/web-hooks";
import { Markdown } from "../components/markdown/Markdown.js";
import { cn } from "@brett_lamy/ui";
import { RouteLink, navigate } from "../navigation.js";
import { Box, Oct, ghButton, ghField, githubMarkdown } from "../blocks/github/parts.js";
import {
  deleteWikiPageEvent,
  isWikiSlug,
  renameWikiPageEvent,
  useWikiPage,
  wikiEditorRoute,
  wikiIndexPath,
  wikiPageRoute,
} from "./useWiki.js";

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
      className="grid gap-4"
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
      <nav aria-label="Wiki breadcrumb" className="flex items-center gap-1 text-[14px]">
        <RouteLink href={wikiIndexPath(props.org, props.repo)}>Wiki</RouteLink>
        <span aria-hidden="true" className="text-tertiary-foreground">
          /
        </span>
        <span>{props.slug}</span>
      </nav>

      {error === undefined ? null : (
        <p role="alert" data-testid="wiki-action-error" className="m-0 text-destructive">
          {error}
        </p>
      )}
      {missing ? (
        <Box
          data-testid="wiki-page-missing"
          className="grid place-items-center px-6 py-12 text-center"
        >
          <Oct name="wiki" size={24} className="text-muted-foreground" />
          <h2 className="mt-3 mb-1 text-[20px] font-semibold">Page not found</h2>
          <p className="m-0 text-muted-foreground">
            This page is not present on the live wiki branch.
          </p>
        </Box>
      ) : (
        <Box
          header={
            <>
              <Oct name="wiki" className="text-muted-foreground" />
              <h1 className="m-0 min-w-0 flex-1 truncate text-[14px] font-semibold">
                {props.slug}
              </h1>
              <RouteLink
                href={wikiEditorRoute(props.org, props.repo, props.slug)}
                className={cn(
                  ghButton(),
                  "h-7 px-2.5 text-[12px] text-foreground hover:no-underline",
                )}
              >
                Edit source
              </RouteLink>
            </>
          }
        >
          {source === null ? (
            <p
              data-testid="wiki-page-loading"
              role="status"
              className="m-0 px-4 py-3 text-muted-foreground"
            >
              Loading page content…
            </p>
          ) : (
            <Markdown
              source={source}
              data-testid="wiki-markdown"
              className={cn(githubMarkdown, "px-8 py-6 text-[16px] leading-[1.5]")}
            />
          )}
        </Box>
      )}

      {missing ? null : (
        <div className="flex flex-wrap items-end gap-3 rounded-md border border-border p-4">
          <form className="grid gap-1" onSubmit={(event) => void rename(event)}>
            <label htmlFor="wiki-rename-slug" className="text-[13px] font-semibold">
              Rename page
            </label>
            <div className="flex items-center gap-2">
              <input
                id="wiki-rename-slug"
                data-testid="wiki-rename-slug"
                className={ghField}
                value={renameTo}
                onChange={(event) => setRenameTo(event.currentTarget.value)}
              />
              <span aria-hidden="true" className="text-muted-foreground">
                .md
              </span>
              <button
                type="submit"
                disabled={pendingRename !== undefined || deleting}
                className={ghButton()}
              >
                {pendingRename === undefined ? "Rename" : "Renaming…"}
              </button>
            </div>
          </form>
          <button
            type="button"
            className={cn(ghButton(), "ml-auto text-destructive")}
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
