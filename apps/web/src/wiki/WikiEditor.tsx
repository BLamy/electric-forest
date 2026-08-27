import { useEffect, useState } from "react";
import { DispatchRefusalError } from "@eforest/web-hooks";
import { RouteLink } from "../navigation.js";
import { chooseWikiSaveEvent, useWikiPage, wikiIndexPath, wikiPageRoute } from "./useWiki.js";

interface LoadedSource {
  readonly revision: string;
  readonly text: string;
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
    if (loaded === undefined || (!dirty && savingOffset === undefined)) {
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
      const receipt = await wiki.dispatch(
        chooseWikiSaveEvent(loaded.text, draft, wiki.path, loaded.revision),
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
              {savingOffset === undefined ? "Save patch" : "Waiting for live replay…"}
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
