import { useEffect, useState } from "react";
import { DispatchRefusalError } from "@eforest/web-hooks";
import { RouteLink } from "../navigation.js";
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
      className="wiki-view wiki-editor"
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
      <nav aria-label="Wiki editor breadcrumb">
        <RouteLink href={wikiIndexPath(props.org, props.repo)}>Wiki</RouteLink>
        <span aria-hidden="true"> / </span>
        <RouteLink href={wikiPageRoute(props.org, props.repo, props.slug)}>{props.slug}</RouteLink>
        <span aria-hidden="true"> / edit</span>
      </nav>
      <div className="wiki-heading">
        <div>
          <p className="eyebrow">Patch editor</p>
          <h2>Edit {props.slug}.md</h2>
        </div>
        <code data-testid="wiki-editor-base">{loaded?.revision ?? "loading"}</code>
      </div>

      {missing ? (
        <p role="alert" data-testid="wiki-editor-missing">
          This page no longer exists.
        </p>
      ) : loaded === undefined ? (
        <p data-testid="wiki-editor-loading">Loading source and base revision…</p>
      ) : (
        <form onSubmit={(event) => void save(event)}>
          <label htmlFor="wiki-source">Markdown source</label>
          <textarea
            id="wiki-source"
            data-testid="wiki-source"
            value={draft}
            rows={22}
            spellCheck={false}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setDirty(event.currentTarget.value !== loaded.text);
            }}
          />
          <div className="wiki-editor-actions">
            <button type="submit" disabled={!dirty || savingOffset !== undefined}>
              {savingOffset === undefined ? "Save changes" : "Waiting for live replay…"}
            </button>
            <span data-testid="wiki-save-status">
              {savingOffset === undefined
                ? dirty
                  ? "Unsaved changes"
                  : "Up to date"
                : savingOffset}
            </span>
          </div>
        </form>
      )}

      {refusal === undefined ? null : (
        <div className="wiki-stale-refusal" role="alert" data-testid="wiki-stale-refusal">
          <strong>
            {refusal === "stale-base" ? "This page changed while you were editing." : refusal}
          </strong>
          <p>Your draft was not applied and the branch was not changed.</p>
          <button type="button" onClick={loadLatest}>
            Load latest
          </button>
        </div>
      )}
    </section>
  );
}
