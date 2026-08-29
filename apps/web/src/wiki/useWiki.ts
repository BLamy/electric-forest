import {
  WIKI_BRANCH_NAME,
  WIKI_SLUG_PATTERN,
  isWikiSlug,
  wikiBranchStreamId,
  wikiEditRoute,
  wikiIndexRoute,
  wikiPagePath,
  wikiPageRoute as meadowWikiPageRoute,
} from "@eforest/meadow";
import {
  BASE_NONE,
  branchContentStreamPrefix,
  chooseFileWriteEvent,
  fileContentEvent,
  fileCreateEvent,
  fileDeleteEvent,
  fileRenameEvent,
  type FsFileCreateEvent,
  type FsFileContentEvent,
  type FsFileDeleteEvent,
  type FsFilePatchEvent,
  type FsFileWriteEvent,
  type FsRenameEvent,
  type FsTree,
} from "@eforest/streamfs";
import { fileViewStreamId, type FileContentState } from "@eforest/reducers";
import {
  useDispatch,
  useStreamReducer,
  type DispatchFunction,
  type StreamReducerResult,
} from "@eforest/web-hooks";

export const WIKI_BRANCH = WIKI_BRANCH_NAME;
export const WIKI_REDUCER = "streamfs" as const;
export { WIKI_SLUG_PATTERN, isWikiSlug };

export interface WikiPageSummary {
  readonly slug: string;
  readonly path: string;
  readonly contentStreamId: string;
  readonly contentDigest: string;
  readonly size: number;
  readonly revision: string;
}

export interface WikiBinding {
  readonly streamId: string;
  readonly tree: StreamReducerResult<FsTree>;
  readonly dispatch: DispatchFunction;
  readonly pages: readonly WikiPageSummary[];
}

export interface WikiPageBinding extends WikiBinding {
  readonly slug: string;
  readonly path: string;
  readonly page: WikiPageSummary | undefined;
  readonly content: StreamReducerResult<FileContentState>;
}

export function wikiStreamId(org: string, repo: string): string {
  return wikiBranchStreamId(org, repo);
}

export function wikiIndexPath(org: string, repo: string): string {
  return wikiIndexRoute(org, repo);
}

export function wikiPageRoute(org: string, repo: string, slug: string): string {
  return meadowWikiPageRoute(org, repo, slug);
}

export function wikiEditorRoute(org: string, repo: string, slug: string): string {
  return wikiEditRoute(org, repo, slug);
}

function wikiEventsPath(org: string, repo: string): string {
  return `/api/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/${WIKI_BRANCH}/events`;
}

function wikiBlobPath(org: string, repo: string, path: string): string {
  return `/api/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/${WIKI_BRANCH}/blob/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

export function wikiPages(tree: FsTree): readonly WikiPageSummary[] {
  return Object.entries(tree.files)
    .flatMap(([path, file]) => {
      if (path.includes("/") || !path.endsWith(".md")) return [];
      const slug = path.slice(0, -3);
      if (!isWikiSlug(slug)) return [];
      return [
        {
          slug,
          path,
          contentStreamId: file.contentStreamId,
          contentDigest: file.contentSha256,
          size: file.size,
          revision: file.lastContentOffset,
        },
      ];
    })
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

export function useWiki(org: string, repo: string): WikiBinding {
  const streamId = wikiStreamId(org, repo);
  const tree = useStreamReducer<FsTree>({
    apiPath: wikiEventsPath(org, repo),
    streamId,
    reducerId: WIKI_REDUCER,
    followWaitMs: 1_000,
    reconnectDelayMs: 1_000,
  });
  const dispatch = useDispatch(streamId, { replayedOffset: tree.checkpoint });
  return { streamId, tree, dispatch, pages: wikiPages(tree.state) };
}

export function useWikiPage(org: string, repo: string, slug: string): WikiPageBinding {
  const wiki = useWiki(org, repo);
  const path = wikiPagePath(slug);
  const content = useStreamReducer<FileContentState>({
    apiPath: wikiBlobPath(org, repo, path),
    streamId: fileViewStreamId(org, repo, WIKI_BRANCH, path),
    reducerId: "file-content",
    followWaitMs: 1_000,
    reconnectDelayMs: 1_000,
  });
  return {
    ...wiki,
    slug,
    path,
    page: wiki.pages.find((candidate) => candidate.slug === slug),
    content,
  };
}

function now(): number {
  return Date.now();
}

export function createWikiPageEvent(org: string, repo: string, slug: string): FsFileCreateEvent {
  const suffix = crypto.randomUUID();
  return fileCreateEvent(
    wikiPagePath(slug),
    `${branchContentStreamPrefix(`${org}/${repo}`, WIKI_BRANCH)}${suffix}`,
    now(),
  );
}

export function deleteWikiPageEvent(slug: string): FsFileDeleteEvent {
  return fileDeleteEvent(wikiPagePath(slug), now());
}

export function renameWikiPageEvent(from: string, to: string): FsRenameEvent {
  return fileRenameEvent(wikiPagePath(from), wikiPagePath(to), now());
}

/** Preserve the canonical E1-T03 chooser result; full writes remain full writes. */
export function chooseWikiSaveEvent(
  baseText: string,
  targetText: string,
  path: string,
  base: string = BASE_NONE,
): FsFilePatchEvent | FsFileWriteEvent {
  const encoder = new TextEncoder();
  return chooseFileWriteEvent(
    encoder.encode(baseText),
    encoder.encode(targetText),
    path,
    base,
    now(),
  );
}

export interface WikiSaveRequest {
  readonly event: FsFilePatchEvent | FsFileWriteEvent;
  readonly contentEvent?: FsFileContentEvent;
}

/** One dispatch action; full-write bytes ride as the canonical content generation. */
export function chooseWikiSaveRequest(
  baseText: string,
  targetText: string,
  path: string,
  contentStreamId: string,
  base: string = BASE_NONE,
): WikiSaveRequest {
  const event = chooseWikiSaveEvent(baseText, targetText, path, base);
  return event.type === "fs.file.write"
    ? {
        event,
        contentEvent: fileContentEvent(
          contentStreamId,
          new TextEncoder().encode(targetText),
          event.ts,
        ),
      }
    : { event };
}
