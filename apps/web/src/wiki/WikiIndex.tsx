import { useEffect, useState } from "react";
import { DispatchRefusalError } from "@eforest/web-hooks";
import { cn } from "@brett_lamy/ui";
import { RouteLink, navigate } from "../navigation.js";
import { Box, Counter, Oct, ghButton, ghField } from "../blocks/github/parts.js";
import {
  createWikiPageEvent,
  isWikiSlug,
  useWiki,
  wikiEditorRoute,
  wikiPageRoute,
} from "./useWiki.js";

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
      className="grid gap-4"
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
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 mr-auto text-[20px] font-semibold">Wiki</h1>
        <code
          data-testid="wiki-tree-digest"
          className="max-w-full truncate text-[12px] text-muted-foreground"
        >
          {wiki.tree.digest}
        </code>
      </div>

      <form
        className="grid gap-1 rounded-md border border-border p-4"
        onSubmit={(event) => void create(event)}
      >
        <label htmlFor="wiki-new-slug" className="text-[13px] font-semibold">
          New page
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="wiki-new-slug"
            data-testid="wiki-new-slug"
            className={cn(ghField, "min-w-[200px] flex-1")}
            value={slug}
            onChange={(event) => setSlug(event.currentTarget.value)}
            placeholder="getting-started"
            autoComplete="off"
            aria-describedby="wiki-slug-help"
          />
          <span aria-hidden="true" className="text-muted-foreground">
            .md
          </span>
          <button type="submit" disabled={pendingSlug !== undefined} className={ghButton(true)}>
            {pendingSlug === undefined ? "Create page" : "Creating…"}
          </button>
        </div>
        <small id="wiki-slug-help" className="text-muted-foreground">
          Lowercase letters, numbers, and hyphens.
        </small>
      </form>

      {error === undefined ? null : (
        <p role="alert" data-testid="wiki-create-error" className="m-0 text-destructive">
          {error}
        </p>
      )}
      {wiki.tree.status === "loading" ? (
        <p data-testid="wiki-loading" role="status" className="m-0 text-muted-foreground">
          Loading wiki…
        </p>
      ) : null}
      {wiki.tree.status.startsWith("error:") ? (
        <p role="alert" data-testid="wiki-refusal" className="m-0 text-destructive">
          Wiki projection refused: {wiki.tree.status.slice("error:".length)}
        </p>
      ) : null}
      {wiki.tree.status !== "loading" && !wiki.tree.status.startsWith("error:") ? (
        wiki.pages.length === 0 ? (
          <Box className="grid place-items-center px-6 py-12 text-center">
            <Oct name="wiki" size={24} className="text-muted-foreground" />
            <p data-testid="wiki-empty" className="mt-3 mb-0 text-muted-foreground">
              This wiki has no pages yet.
            </p>
          </Box>
        ) : (
          <Box
            header={
              <>
                <Oct name="wiki" className="text-muted-foreground" />
                <b className="font-semibold">Pages</b>
                <Counter>{wiki.pages.length}</Counter>
              </>
            }
          >
            <ul className="m-0 list-none p-0" data-testid="wiki-page-list">
              {wiki.pages.map((page) => (
                <li
                  key={page.path}
                  data-testid="wiki-page-row"
                  data-page-path={page.path}
                  data-page-revision={page.revision}
                  className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3 first:border-t-0 hover:bg-muted"
                >
                  <Oct name="file" className="text-muted-foreground" />
                  <RouteLink
                    href={wikiPageRoute(props.org, props.repo, page.slug)}
                    className="font-semibold"
                  >
                    {page.slug}
                  </RouteLink>
                  <span className="ml-auto text-[12px] text-muted-foreground">
                    {page.size} bytes
                  </span>
                  <code className="text-[12px] text-muted-foreground">
                    {page.contentDigest.slice(0, 12)}
                  </code>
                </li>
              ))}
            </ul>
          </Box>
        )
      ) : null}
    </section>
  );
}
