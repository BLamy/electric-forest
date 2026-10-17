import { useEffect, useState } from "react";
import { DispatchRefusalError } from "@eforest/web-hooks";
import { cn } from "@brett_lamy/ui";
import { RouteLink } from "../navigation.js";
import { Box, ghButton, ghTextarea } from "../blocks/github/parts.js";
import { chooseWikiSaveRequest, useWikiPage, wikiIndexPath, wikiPageRoute } from "./useWiki.js";

export interface LoadedSource {
  readonly revision: string;
  readonly text: string;
}

export function shouldAdoptWikiSource(
  loaded: LoadedSource | undefined,
  latestRevision: string,
  latestText: string,
  dirty: boolean,
  savingOffset: string | undefined,
): boolean {
  if (loaded === undefined) return true;
  const changedSinceLoad = loaded.revision !== latestRevision || loaded.text !== latestText;
  return !dirty && savingOffset === undefined && changedSinceLoad;
}

export function WikiEditor(props: {
  readonly org: string;
  readonly repo: string;
  readonly slug: string;
}): React.JSX.Element {
  const wiki = useWikiPage(props.org, props.repo, props.slug);
  const [loaded, setLoaded] = useState<LoadedSource>();
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [savingOffset, setSavingOffset] = useState<string>();
  const [refusal, setRefusal] = useState<string>();

  const latestText = wiki.content.state.text;
  const latestRevision = wiki.page?.revision;
  useEffect(() => {
    if (latestText === null || latestRevision === undefined) return;
    if (shouldAdoptWikiSource(loaded, latestRevision, latestText, dirty, savingOffset)) {
      setLoaded({ revision: latestRevision, text: latestText });
      setDraft(latestText);
    }
  }, [dirty, latestRevision, latestText, loaded, savingOffset]);

  useEffect(() => {
    if (
      savingOffset !== undefined &&
      latestRevision === savingOffset &&
      latestText !== null &&
      latestText === draft
    ) {
      setLoaded({ revision: latestRevision, text: latestText });
      setDirty(false);
      setSavingOffset(undefined);
    }
  }, [draft, latestRevision, latestText, savingOffset]);

  const save = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (loaded === undefined || draft === loaded.text) return;
    setRefusal(undefined);
    try {
      if (wiki.page === undefined) return;
      const request = chooseWikiSaveRequest(
        loaded.text,
        draft,
        wiki.path,
        wiki.page.contentStreamId,
        loaded.revision,
      );
      const receipt = await wiki.dispatch(
        request.event,
        request.contentEvent === undefined ? {} : { contentEvent: request.contentEvent },
      );
      setSavingOffset(receipt.offset);
    } catch (cause) {
      setSavingOffset(undefined);
      setRefusal(cause instanceof DispatchRefusalError ? cause.code : "dispatch-failed");
    }
  };

  const loadLatest = (): void => {
    if (latestText === null || latestRevision === undefined) return;
    setLoaded({ revision: latestRevision, text: latestText });
    setDraft(latestText);
    setDirty(false);
    setRefusal(undefined);
  };

  const missing = wiki.tree.status === "live" && wiki.page === undefined;
  return (
    <section
      className="grid gap-4"
      data-testid="wiki-editor"
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
      data-page-revision={latestRevision ?? ""}
      data-editor-base={loaded?.revision ?? ""}
      data-saving-offset={savingOffset ?? ""}
      data-stream-status={wiki.tree.status}
    >
      <nav aria-label="Wiki editor breadcrumb" className="flex items-center gap-1 text-[14px]">
        <RouteLink href={wikiIndexPath(props.org, props.repo)}>Wiki</RouteLink>
        <span aria-hidden="true" className="text-tertiary-foreground">
          /
        </span>
        <RouteLink href={wikiPageRoute(props.org, props.repo, props.slug)}>{props.slug}</RouteLink>
        <span aria-hidden="true" className="text-tertiary-foreground">
          / edit
        </span>
      </nav>

      {missing ? (
        <p role="alert" data-testid="wiki-editor-missing" className="m-0 text-destructive">
          This page no longer exists.
        </p>
      ) : loaded === undefined ? (
        <p data-testid="wiki-editor-loading" role="status" className="m-0 text-muted-foreground">
          Loading source and base revision…
        </p>
      ) : (
        <Box
          header={
            <>
              <h1 className="m-0 min-w-0 flex-1 truncate text-[14px] font-semibold">
                Edit {props.slug}.md
              </h1>
              <code data-testid="wiki-editor-base" className="text-[12px] text-muted-foreground">
                {loaded.revision}
              </code>
            </>
          }
        >
          <form className="grid gap-3 p-4" onSubmit={(event) => void save(event)}>
            <label htmlFor="wiki-source" className="text-[13px] font-semibold">
              Markdown source
            </label>
            <textarea
              id="wiki-source"
              data-testid="wiki-source"
              className={cn(ghTextarea, "font-mono text-[13px]")}
              value={draft}
              rows={22}
              spellCheck={false}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
                setDirty(event.currentTarget.value !== loaded.text);
              }}
            />
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={!dirty || savingOffset !== undefined}
                className={ghButton(true)}
              >
                {savingOffset === undefined ? "Save changes" : "Waiting for live replay…"}
              </button>
              <span data-testid="wiki-save-status" className="text-[12px] text-muted-foreground">
                {savingOffset === undefined
                  ? dirty
                    ? "Unsaved changes"
                    : "Up to date"
                  : savingOffset}
              </span>
            </div>
          </form>
        </Box>
      )}

      {loaded === undefined && !missing ? (
        <code data-testid="wiki-editor-base" className="sr-only">
          loading
        </code>
      ) : null}

      {refusal === undefined ? null : (
        <div
          className="grid gap-2 rounded-md border border-destructive/60 p-4"
          role="alert"
          data-testid="wiki-stale-refusal"
        >
          <strong>
            {refusal === "stale-base" ? "This page changed while you were editing." : refusal}
          </strong>
          <p className="m-0 text-muted-foreground">
            Your draft was not applied and the branch was not changed.
          </p>
          <button
            type="button"
            onClick={loadLatest}
            className={cn(ghButton(), "justify-self-start")}
          >
            Load latest
          </button>
        </div>
      )}
    </section>
  );
}
