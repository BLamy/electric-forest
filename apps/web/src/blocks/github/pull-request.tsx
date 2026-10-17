/* Provenance: registry/blocks/github-clone/pull-request.tsx — @brett_lamy/ui 2.0.0 registry block
   "github-clone" (https://blamy.github.io/ui/r/github-clone.json), installed as owned source.
   Every divergence from the upstream file carries an `ef:` marker. */
/* A pull request: title and state, then Conversation (timeline, merge box, comment composer), Commits, Checks and
   Files changed. */
// ef: every section reads the live PR stream (pr:<org>/<repo>/<id>, `pr` reducer), its base/source StreamFS
// branches and the since-fork diff. Comments, reviews, merges and closes are dispatches through the
// door (useDispatch); nothing is appended to local state. The block's mock
// pulls, timeline, files and users are not installed.
// ef:begin PR stream, since-fork diff, Pierre diffs/trees, Docstream adapter, evidence
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  DEFAULT_THEMES,
  preloadHighlighter,
  type OnDiffLineClickProps,
  type SelectedLineRange,
} from "@pierre/diffs";
import { MultiFileDiff } from "@pierre/diffs/react";
import {
  Avatar,
  Button,
  Segmented,
  TabView,
  TabViewBar,
  TabViewFooter,
  TabViewList,
  TabViewPanels,
  cn,
} from "@brett_lamy/ui";
import type { MeadowPrState } from "@eforest/meadow";
import type { PrDiffFile } from "@eforest/pr";
import { fileViewStreamId, type FileContentState } from "@eforest/reducers";
import { useStreamReducer, type ApplicationRecord } from "@eforest/web-hooks";
import { Markdown } from "../../components/markdown/Markdown.js";
import { AppSheet } from "../../components/overlay.js";
import { PierrePathTree } from "../../components/trees/RepositoryTree.js";
import { EvidencePanel } from "../../evidence/index.js";
import { RouteLink, navigate, repoSectionPath } from "../../navigation.js";
import { threadPrTimeline, type PrTimelineNode } from "../../prs/timeline.js";
import {
  branchNameFromStream,
  issueIdFromStream,
  prActions,
  prTimeline,
  usePrDetail,
  type PrDetailBinding,
} from "../../prs/usePrs.js";
import {
  Box,
  Branch,
  FlowPanel,
  Oct,
  PR_STATE,
  StatePill,
  UnderlineTab,
  ghButton,
  ghTextarea,
  githubMarkdown,
  userOf,
  type Layout,
  type OctName,
} from "./parts.js";
import { LIVE_FOLLOW } from "../../live.js"; // ef: the app-wide bounded long-poll hold
// ef:end

// ef: the forest's tab ids (activity/commits/checks/changes) are route segments.
export type PullRequestTab = "activity" | "commits" | "checks" | "changes";

function tabPath(org: string, repo: string, prId: string, tab: PullRequestTab): string {
  const root = `${repoSectionPath(org, repo, "pulls")}/${encodeURIComponent(prId)}`;
  return tab === "activity" ? root : `${root}/${tab}`;
}

function recordSummary(record: ApplicationRecord): string {
  const payload = record.payload as Record<string, unknown>;
  if (record.type === "pr.opened")
    return `opened this pull request: ${String(payload.title ?? "")}`;
  if (record.type === "pr.review-comment") return "left a review comment";
  if (record.type === "pr.approved")
    return `approved these changes as ${String(payload.reviewer ?? "reviewer")}`;
  if (record.type === "pr.changes-requested") return "requested changes";
  if (record.type === "pr.merged") return "merged this pull request";
  if (record.type === "pr.merge-conflicted") return "encountered merge conflicts";
  if (record.type === "pr.closed") return "closed this pull request";
  return record.type;
}

function recordActor(record: ApplicationRecord): string {
  const payload = record.payload as Record<string, unknown>;
  for (const key of ["author", "reviewer", "mergedBy", "closedBy"]) {
    if (typeof payload[key] === "string") return payload[key] as string;
  }
  return record.actor ?? "electric-forest";
}

// ef:begin live PR stream; tabs are routes; evidence attributes on pr-detail
export function PullRequestView({
  ui,
  org,
  repo,
  prId,
  tab,
}: {
  ui: Layout;
  org: string;
  repo: string;
  prId: string;
  tab: PullRequestTab;
}) {
  const binding = usePrDetail(org, repo, prId);
  const p = binding.projection.state;
  const records = prTimeline(binding);
  const status = binding.projection.status;
  return (
    <section
      className={cn(ui.phone && "px-4 py-4")}
      data-testid="pr-detail"
      data-ef-stream={binding.streamId}
      data-ef-offset={binding.projection.checkpoint}
      data-ef-digest={binding.projection.digest}
      data-ef-reducer="pr"
      data-stream-status={status}
    >
      {!ui.phone ? (
        <RouteLink
          href={repoSectionPath(org, repo, "pulls")}
          className="mb-3 flex w-fit items-center gap-1 text-[14px]"
        >
          <Oct name="chevLeft" size={14} />
          Pull requests
        </RouteLink>
      ) : null}
      <div className="flex items-start gap-4">
        <h1
          className={cn(
            "m-0 min-w-0 flex-1 leading-tight font-normal",
            ui.phone ? "text-[22px]" : "text-[32px]",
          )}
          data-testid="pr-title"
        >
          {p.title || "Loading pull request…"}{" "}
          <span className="font-light text-muted-foreground">#{prId}</span>
        </h1>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 border-b border-border pb-4 text-muted-foreground">
        <StatePill state={PR_STATE[p.status] ?? "prOpen"} />
        <span className="leading-6">
          <b className="font-semibold text-foreground">{p.author || binding.actor}</b> wants to
          merge into <Branch>{branchNameFromStream(p.targetBranch) || "main"}</Branch> from{" "}
          <Branch>{branchNameFromStream(p.sourceBranch) || "source"}</Branch>
        </span>
      </div>
      <TabView
        placement="top"
        selectedKey={tab}
        onSelectionChange={(k) => navigate(tabPath(org, repo, prId, String(k) as PullRequestTab))}
        className="mt-2"
      >
        <TabViewBar
          variant="plain"
          className="overflow-x-auto border-b border-border [scrollbar-width:none]"
        >
          <TabViewList aria-label="Pull request" className="flex gap-1">
            <UnderlineTab id="activity" icon="comment" label="Activity" count={records.length} />
            <UnderlineTab id="commits" icon="commit" label="Commits" />
            <UnderlineTab id="checks" icon="checkFill" label="Checks" />
            <UnderlineTab
              id="changes"
              icon="file"
              label="Changes"
              count={binding.diff.files.length}
            />
          </TabViewList>
          {!ui.phone ? (
            <TabViewFooter className="pl-4">
              {/* ef: the since-fork diff's file count; exact +/− stats come from Pierre's digest-admitted
                  bytes per file (the tree projection carries no content, so hunk counts would lie). */}
              <span className="text-[12px] text-muted-foreground">
                {binding.diff.files.length} {binding.diff.files.length === 1 ? "file" : "files"}{" "}
                changed
              </span>
            </TabViewFooter>
          ) : null}
        </TabViewBar>
        <TabViewPanels className="pt-6">
          {(["activity", "commits", "checks", "changes"] as const).map((id) => (
            <FlowPanel key={id} id={id}>
              <DetailContent ui={ui} org={org} repo={repo} prId={prId} tab={id} binding={binding} />
            </FlowPanel>
          ))}
        </TabViewPanels>
      </TabView>
    </section>
  );
}
// ef:end

// ef:begin typed loading / refusal states of the PR projection
function DetailContent(props: {
  ui: Layout;
  org: string;
  repo: string;
  prId: string;
  tab: PullRequestTab;
  binding: PrDetailBinding;
}) {
  const status = props.binding.projection.status;
  if (status === "loading")
    return (
      <p className="text-muted-foreground" role="status">
        Loading pull request…
      </p>
    );
  if (status.startsWith("error:"))
    return (
      <p className="text-destructive" role="alert">
        Pull-request projection refused: {status.slice(6)}
      </p>
    );
  if (props.tab === "commits") return <CommitList ui={props.ui} binding={props.binding} />;
  if (props.tab === "checks") return <Checks binding={props.binding} />;
  if (props.tab === "changes") return <FilesChanged {...props} />;
  return <Conversation {...props} />;
}
// ef:end

/* ── Conversation ── */

// ef:begin threaded stream records, evidence panel and dispatching composer
export function Conversation({
  ui,
  org,
  repo,
  prId,
  binding,
}: {
  ui: Layout;
  org: string;
  repo: string;
  prId: string;
  binding: PrDetailBinding;
}) {
  const pr = binding.projection.state;
  const records = threadPrTimeline(prTimeline(binding).slice(1));
  const [replyTarget, setReplyTarget] = useState<ApplicationRecord>();
  const side = "border-b border-border py-4 text-[12px] first:pt-0";
  const sideTitle = "mb-2 flex items-center justify-between font-semibold text-muted-foreground";
  return (
    <div className="flex gap-6">
      <div className="min-w-0 flex-1">
        {/* The timeline rail runs behind the event badges. */}
        <div
          className={cn(
            "relative",
            ui.phone ? "before:left-4" : "before:left-[72px]",
            "before:absolute before:inset-y-0 before:w-0.5 before:bg-border",
          )}
        >
          <CommentCard
            ui={ui}
            author={pr.author || binding.actor}
            when=""
            verb="opened this pull request"
            body={pr.body || "No description was provided."}
            tone="author"
          />
          <div className="relative z-1 bg-background py-2">
            <EvidencePanel org={org} repo={repo} entityType="pr" entityId={prId} />
          </div>
          <ol className="m-0 list-none p-0" aria-label="Pull request activity">
            {records.map((node) => (
              <TimelineEntry
                key={node.record.offset}
                ui={ui}
                node={node}
                onReply={setReplyTarget}
              />
            ))}
          </ol>
        </div>
        <ConflictPanel state={pr} />
        <MergeBox ui={ui} binding={binding} />
        <div className="mt-6 flex gap-4 border-t-2 border-border pt-6">
          {!ui.phone ? <Avatar c={userOf(binding.actor)} size={40} /> : null}
          <div className="min-w-0 flex-1">
            <h3 className="mt-0 mb-2 text-[14px] font-semibold">Add a comment</h3>
            <CommentForm binding={binding} />
          </div>
        </div>
        <AppSheet
          open={replyTarget !== undefined}
          onClose={() => setReplyTarget(undefined)}
          title={`Reply to ${replyTarget?.offset ?? "comment"}`}
        >
          <CommentForm
            binding={binding}
            {...(replyTarget === undefined ? {} : { target: { replyTo: replyTarget.offset } })}
            onDone={() => setReplyTarget(undefined)}
          />
        </AppSheet>
      </div>
      {ui.wide ? (
        // ef: the sidebar shows the stream's reviewers, author, checks and linked issues.
        <aside className="w-[256px] shrink-0" aria-label="Pull request details">
          <div className={side}>
            <div className={sideTitle}>Reviewers</div>
            {pr.approvals.length === 0 ? (
              <p className="m-0 text-muted-foreground">No approvals yet</p>
            ) : (
              pr.approvals.map((reviewer) => (
                <div key={reviewer} className="flex items-center gap-2">
                  <Avatar c={userOf(reviewer)} size={20} />
                  <b className="flex-1 truncate font-semibold">{reviewer}</b>
                  <Oct name="check" className="text-[var(--gh-open)]" />
                </div>
              ))
            )}
          </div>
          <div className={side}>
            <div className={sideTitle}>Assignees</div>
            <div className="flex items-center gap-2">
              <Avatar c={userOf(pr.author || binding.actor)} size={20} />
              <b className="truncate font-semibold">{pr.author || "No one assigned"}</b>
            </div>
          </div>
          <div className={side}>
            <div className={sideTitle}>Checks</div>
            <p className="m-0 flex items-center gap-1.5">
              <Oct name="check" size={14} className="text-[var(--gh-open)]" />
              Projection integrity
            </p>
          </div>
          <div className={side}>
            <Backlinks org={org} repo={repo} binding={binding} />
          </div>
        </aside>
      ) : null}
    </div>
  );
}
// ef:end

/** ef: the PR's `closes` refs, linked to their live issue routes. */
function Backlinks(props: { org: string; repo: string; binding: PrDetailBinding }) {
  const state = props.binding.projection.state;
  return (
    <section aria-labelledby="pr-backlinks-heading" data-testid="pr-backlinks">
      <h3
        id="pr-backlinks-heading"
        className="mt-0 mb-2 text-[12px] font-semibold text-muted-foreground"
      >
        Linked issues
      </h3>
      {state.closes === undefined || state.closes.length === 0 ? (
        <p className="m-0 text-muted-foreground">No linked issues</p>
      ) : (
        <ul className="m-0 list-none space-y-1 p-0">
          {state.closes.map((ref) => {
            const issueId = issueIdFromStream(ref.stream);
            return (
              <li key={ref.stream} className="flex flex-wrap items-center gap-1.5">
                <Oct name="issue" size={14} className="text-[var(--gh-open)]" />
                {issueId === undefined ? (
                  <span>{ref.stream}</span>
                ) : (
                  <RouteLink
                    href={`${repoSectionPath(props.org, props.repo, "issues")}/${encodeURIComponent(issueId)}`}
                  >
                    #{issueId}
                  </RouteLink>
                )}
                <span className="text-muted-foreground">will close when merged</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ef:begin bodies through the Docstream adapter; offset badge; reply footer
export function CommentCard({
  ui,
  author,
  when,
  body,
  role,
  verb = "commented",
  tone,
  footer,
  markdownTestId,
}: {
  ui: Layout;
  author: string;
  when: string;
  body: string;
  role?: string;
  verb?: string;
  tone?: "author";
  // ef: an optional footer (reply control) and evidence id for the rendered Markdown.
  footer?: ReactNode;
  markdownTestId?: string;
}) {
  const user = userOf(author);
  return (
    <div className="relative flex gap-4 py-4">
      {!ui.phone ? <Avatar c={user} size={40} /> : null}
      <div
        className={cn(
          "relative z-1 min-w-0 flex-1 overflow-hidden rounded-md border bg-background",
          // ef: rgba tokens instead of `/40`, `/8` alpha utilities (color-mix() has no faithful
          // fallback in the Chromium 108 that records the evidence).
          tone === "author" ? "border-(--ef-primary-edge-12)" : "border-border",
        )}
      >
        <div
          className={cn(
            "flex items-center gap-1.5 border-b px-4 py-2 text-muted-foreground",
            tone === "author"
              ? "border-(--ef-primary-edge-12) bg-(--ef-primary-wash-8)"
              : "border-border bg-muted",
          )}
        >
          {ui.phone ? <Avatar c={user} size={20} /> : null}
          <b className="shrink-0 font-semibold whitespace-nowrap text-foreground">{author}</b>
          <span className="min-w-0 truncate">
            {verb} {when}
          </span>
          <span className="flex-1" />
          {role && !ui.phone ? (
            <code className="rounded-full border border-border px-2 text-[12px] leading-[18px] font-medium">
              {role}
            </code>
          ) : null}
        </div>
        {/* ef: comment bodies enter the Docstream adapter (URL policy), never the package renderer. */}
        <Markdown
          source={body}
          {...(markdownTestId === undefined ? {} : { "data-testid": markdownTestId })}
          className={cn(githubMarkdown, "bg-background px-4 py-3 text-[14px] leading-[1.5]")}
        />
        {footer === undefined ? null : <div className="px-4 pb-3">{footer}</div>}
      </div>
    </div>
  );
}
// ef:end

export function TimelineEvent({
  ui,
  icon,
  badge,
  children,
}: {
  ui: Layout;
  icon: OctName;
  badge?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("relative flex items-start gap-2 py-3", ui.phone ? "pl-0" : "pl-14")}>
      <span
        className={cn(
          "z-1 grid size-8 shrink-0 place-items-center rounded-full border-2 border-background",
          badge ?? "bg-muted text-muted-foreground",
        )}
      >
        <Oct name={icon} size={16} />
      </span>
      <div className="min-w-0 flex-1 pt-1.5 text-muted-foreground">{children}</div>
    </div>
  );
}

// ef:begin one stream record, replies nested by replyTo
// ef: one threaded stream record (review comments nest under their `replyTo` offset).
export function TimelineEntry({
  ui,
  node,
  onReply,
}: {
  ui: Layout;
  node: PrTimelineNode<ApplicationRecord>;
  onReply: (record: ApplicationRecord) => void;
}) {
  const { record } = node;
  const payload = record.payload as Record<string, unknown>;
  const actor = recordActor(record);
  const icon: OctName =
    record.type === "pr.approved"
      ? "check"
      : record.type === "pr.merged"
        ? "merged"
        : record.type === "pr.merge-conflicted" || record.type === "pr.closed"
          ? "prClosed"
          : record.type === "pr.changes-requested"
            ? "eye"
            : "pulse";
  const badge =
    record.type === "pr.approved"
      ? "bg-(--gh-merge) text-(--gh-ink)"
      : record.type === "pr.merged"
        ? "bg-(--gh-done) text-(--gh-ink)"
        : undefined;
  return (
    <li
      id={`pr-event-${record.offset}`}
      data-testid="pr-timeline-event"
      data-event-offset={record.offset}
      data-reply-to={
        record.type === "pr.review-comment" ? String(payload.replyTo ?? "") : undefined
      }
    >
      {record.type === "pr.review-comment" ? (
        <CommentCard
          ui={ui}
          author={actor}
          when=""
          body={String(payload.body ?? "")}
          role={record.offset}
          footer={
            <button
              type="button"
              className={cn(ghButton(), "h-7 px-2.5 text-[12px]")}
              onClick={() => onReply(record)}
            >
              Reply
            </button>
          }
        />
      ) : (
        <TimelineEvent ui={ui} icon={icon} {...(badge === undefined ? {} : { badge })}>
          <Avatar c={userOf(actor)} size={20} className="mr-1.5 inline-grid align-[-5px]" />
          <b className="font-semibold text-foreground">{actor}</b>{" "}
          <span>{recordSummary(record)}</span> <code className="text-[12px]">{record.offset}</code>
          {record.type === "pr.changes-requested" && typeof payload.body === "string" ? (
            <Markdown source={payload.body} className={cn(githubMarkdown, "mt-2 text-[14px]")} />
          ) : null}
        </TimelineEvent>
      )}
      {node.replies.length === 0 ? null : (
        <ol
          className={cn("m-0 list-none p-0", ui.phone ? "pl-4" : "pl-14")}
          aria-label={`Replies to ${record.offset}`}
        >
          {node.replies.map((reply) => (
            <TimelineEntry key={reply.record.offset} ui={ui} node={reply} onReply={onReply} />
          ))}
        </ol>
      )}
    </li>
  );
}
// ef:end

// ef:begin merge-executor conflicts from the PR stream
/** ef: merge conflicts reported by the merge executor (target branch untouched). */
export function ConflictPanel(props: { state: MeadowPrState }) {
  const outcome = props.state.mergeOutcome;
  if (outcome === undefined || !("conflicts" in outcome)) return null;
  return (
    <Box
      className="mt-4 border-(--gh-closed)/60"
      data-testid="pr-conflicts"
      data-target-merge-offset={outcome.targetMergeOffset}
      header={
        <>
          <Oct name="xFill" className="text-[var(--gh-closed)]" />
          <b className="font-semibold">Merge conflicts need attention</b>
        </>
      }
    >
      <p className="m-0 px-4 pt-3 text-muted-foreground">
        The target branch is unchanged. Resolve these paths before retrying.
      </p>
      <ul className="m-0 list-none p-0">
        {outcome.conflicts.map((conflict) => (
          <li
            key={`${conflict.path}:${conflict.kind}`}
            data-testid="pr-conflict"
            className="flex items-center gap-2 border-b border-border px-4 py-2 last:border-b-0"
          >
            <code className="font-mono text-[12px]">{conflict.path}</code>
            <span className="text-muted-foreground">{conflict.kind}</span>
          </li>
        ))}
      </ul>
      <p className="m-0 px-4 pb-3 text-[12px] text-muted-foreground">
        Target event <code>{outcome.targetMergeOffset}</code>
      </p>
    </Box>
  );
}
// ef:end

// ef:begin merge / approve / request changes / close are dispatches
// ef: the merge box is wired to the PR stream: its rows reflect status/approvals, and Merge / Approve /
// Request changes / Close dispatch pr.merge, pr.approved, pr.changes-requested and pr.closed.
export function MergeBox({ ui, binding }: { ui: Layout; binding: PrDetailBinding }) {
  const state = binding.projection.state;
  const [error, setError] = useState<string>();
  const run = (event: ReturnType<typeof prActions.approve>): void => {
    setError(undefined);
    void binding
      .dispatch(event)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  };
  const done = state.status === "merged" || state.status === "closed";
  const row = (icon: ReactNode, title: string, text: ReactNode) => (
    <div className="flex items-start gap-3 border-b border-border px-4 py-3">
      {icon}
      <div className="min-w-0">
        <div className="font-semibold">{title}</div>
        <div className="text-[12px] text-muted-foreground">{text}</div>
      </div>
    </div>
  );
  const ok = (
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-(--gh-merge) text-(--gh-ink)">
      <Oct name="check" />
    </span>
  );
  const pending = (
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground">
      <Oct name="dotFill" />
    </span>
  );
  return (
    <div className="relative flex gap-4 pt-4">
      {!ui.phone ? (
        <span className="grid size-10 shrink-0 place-items-center rounded-md bg-(--gh-merge) text-(--gh-ink)">
          <Oct name={state.status === "merged" ? "merged" : "pr"} size={20} />
        </span>
      ) : null}
      <div
        className={`pr-merge-panel pr-merge-panel-${state.status} relative z-1 min-w-0 flex-1 overflow-hidden rounded-md border border-(--gh-merge)/60 bg-background`}
      >
        {row(
          state.status === "approved" || state.status === "merged" ? ok : pending,
          state.status === "merged"
            ? "Merged"
            : state.status === "approved"
              ? "Ready to merge"
              : state.status === "closed"
                ? "Closed"
                : "Review required",
          state.status === "approved"
            ? "All approval requirements have been met."
            : state.status === "merged"
              ? "The source branch was merged through the StreamFS merge executor."
              : "Approval is required before this branch can merge.",
        )}
        {row(ok, "Branch projections are live", <code>{binding.source.checkpoint}</code>)}
        <div className="flex flex-wrap items-center gap-3 bg-background px-4 py-3">
          <Button
            className={ghButton(true)}
            isDisabled={state.status !== "approved"}
            onPress={() => run(prActions.merge())}
          >
            Merge
          </Button>
          <Button
            className={ghButton()}
            isDisabled={done}
            onPress={() => run(prActions.approve(binding.actor))}
          >
            Approve
          </Button>
          <Button
            className={ghButton()}
            isDisabled={done}
            onPress={() =>
              run(
                prActions.requestChanges(
                  binding.actor,
                  "Changes requested from the review surface",
                ),
              )
            }
          >
            Request changes
          </Button>
          <Button
            className={ghButton()}
            isDisabled={done}
            onPress={() => run(prActions.close(binding.actor))}
          >
            <Oct name="prClosed" className="text-[var(--gh-closed)]" />
            Close pull request
          </Button>
        </div>
        {error === undefined ? null : (
          <p className="m-0 px-4 pb-3 text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
// ef:end

interface CommentTarget {
  readonly path?: string;
  readonly line?: number;
  readonly replyTo?: string;
}

function commentTargetLabel(target: CommentTarget | undefined): string | undefined {
  if (target?.replyTo !== undefined) return `Replying to ${target.replyTo}`;
  if (target?.path !== undefined && target.line !== undefined)
    return `${target.path}:${String(target.line)}`;
  return target?.path;
}

// ef: the composer is a plain Markdown textarea whose exact bytes become `pr.review-comment` (the
// block's WYSIWYG Composer would re-serialize the source).
function CommentForm(props: {
  binding: PrDetailBinding;
  target?: CommentTarget;
  onDone?: () => void;
}) {
  const [error, setError] = useState<string>();
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (props.target !== undefined)
      formRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }, [props.target]);
  const targetLabel = commentTargetLabel(props.target);
  return (
    <form
      ref={formRef}
      className="pr-comment-form overflow-hidden rounded-md border border-border bg-card"
      onSubmit={(event) => {
        event.preventDefault();
        setError(undefined);
        const form = event.currentTarget;
        const data = new FormData(form);
        void props.binding
          .dispatch(
            prActions.comment(
              props.binding.actor,
              String(data.get("body") ?? ""),
              props.target?.path,
              props.target?.line,
              props.target?.replyTo,
            ),
          )
          .then(
            () => {
              form.reset();
              props.onDone?.();
            },
            (reason: unknown) =>
              setError(reason instanceof Error ? reason.message : String(reason)),
          );
      }}
    >
      <textarea
        name="body"
        required
        placeholder="Use Markdown to format your comment"
        aria-label="Pull request comment"
        className={cn(ghTextarea, "rounded-none border-0 bg-card")}
      />
      {targetLabel === undefined ? null : (
        <p
          className="m-0 flex items-center gap-1.5 px-3 text-[12px] text-muted-foreground"
          data-testid="pr-comment-target"
        >
          <Oct name="comment" size={14} /> {targetLabel}
        </p>
      )}
      {error === undefined ? null : (
        <p className="m-0 px-3 text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-[12px] text-muted-foreground">
        <Oct name="book" size={14} />
        Markdown via Docstream
        <span className="flex-1" />
        <button type="submit" className={ghButton(true)}>
          Comment
        </button>
      </div>
    </form>
  );
}

/* ── Commits / Checks / Files changed ── */

// ef:begin the PR stream's own events as commits
// ef: "commits" are the PR stream's own events (the forest has no git commits).
export function CommitList({ ui, binding }: { ui: Layout; binding: PrDetailBinding }) {
  const commits = prTimeline(binding).filter((record) => record.type !== "pr.review-comment");
  return (
    <section className={cn("relative", !ui.phone && "pl-8")} aria-label="Commits">
      <div className="mb-2 flex items-center gap-2 text-muted-foreground">
        <Oct name="commit" />
        Stream commits
      </div>
      <Box>
        {commits.map((record) => (
          <div
            key={record.offset}
            className="flex items-center gap-3 border-t border-border px-4 py-3 first:border-t-0 hover:bg-muted"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{recordSummary(record)}</div>
              <div className="mt-1 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <Avatar c={userOf(recordActor(record))} size={16} />
                <b className="font-semibold text-foreground">{recordActor(record)}</b> · event
                stream
              </div>
            </div>
            <code className={cn(ghButton(), "h-7 px-2 font-mono text-[12px]")}>
              {record.offset}
            </code>
          </div>
        ))}
      </Box>
    </section>
  );
}
// ef:end

// ef:begin the stream-integrity check over live projections
// ef: the one real check is the stream-integrity check over the PR, branch and diff projections.
export function Checks({ binding }: { binding: PrDetailBinding }) {
  const passed = !binding.projection.status.startsWith("error:");
  return (
    <Box
      header={
        <>
          <Oct
            name={passed ? "checkFill" : "xFill"}
            className={passed ? "text-[var(--gh-open)]" : "text-[var(--gh-closed)]"}
          />
          <b className="font-semibold">
            {passed ? "All checks have passed" : "Checks need attention"}
          </b>
          <span className="text-muted-foreground">
            · {passed ? "1 successful check" : "Projection unavailable"}
          </span>
        </>
      }
    >
      <div className="flex items-center gap-3 border-t border-border px-4 py-2.5 first:border-t-0">
        <Oct name="shield" className="text-[var(--gh-open)]" />
        <span className="min-w-0 flex-1 truncate font-semibold">Stream integrity</span>
        <span className="shrink-0 text-[12px] text-muted-foreground">
          {passed ? "PR, branch, and index projections are connected." : binding.projection.status}
        </span>
      </div>
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 px-4 py-3 text-[12px]">
        <dt className="text-muted-foreground">PR checkpoint</dt>
        <dd className="m-0 break-all font-mono">{binding.projection.checkpoint}</dd>
        <dt className="text-muted-foreground">Diff digest</dt>
        <dd className="m-0 break-all font-mono">{binding.diffDigest}</dd>
        <dt className="text-muted-foreground">Review status</dt>
        <dd className="m-0">{binding.projection.state.status}</dd>
      </dl>
    </Box>
  );
}
// ef:end

// ef:begin Pierre MultiFileDiff over digest-admitted file-content projections
function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
// ef:end

// ef:begin Files changed renders @pierre/trees + @pierre/diffs over the live since-fork diff with
// exact content-digest admission (the block's parts.FileTree / DiffView are not installed).
function useDiffContent(
  org: string,
  repo: string,
  branch: string,
  path: string,
  expectedDigest: string | undefined,
  fallback: string,
): { readonly text: string; readonly ready: boolean; readonly diagnostic: string } {
  const streamId = fileViewStreamId(org, repo, branch, path);
  const projection = useStreamReducer<FileContentState>({
    apiPath: `/api/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/blob/${encodedPath(path)}`,
    streamId,
    reducerId: "file-content",
    ...LIVE_FOLLOW,
    reconnectDelayMs: 100,
    cacheKey: `pr-diff-content:${streamId}:${expectedDigest ?? "absent"}`,
  });
  if (expectedDigest === undefined)
    return {
      text: "",
      ready: true,
      diagnostic: `${projection.status}:${projection.state.status}:absent`,
    };
  // Exact content-digest admission: the diff only ever shows bytes whose digest the tree names.
  const exact = projection.state.contentDigest === expectedDigest;
  return {
    text:
      exact && projection.state.status === "text" && projection.state.text !== null
        ? projection.state.text
        : fallback,
    ready: projection.status === "live" && exact,
    diagnostic: `${projection.status}:${projection.state.status}:${projection.state.contentDigest}:${expectedDigest}`,
  };
}

// ef: Files changed renders the live since-fork diff: @pierre/trees for the changed-file tree and
// @pierre/diffs MultiFileDiff per file (the block's parts.FileTree / DiffView are not installed).
export function FilesChanged(props: {
  ui: Layout;
  org: string;
  repo: string;
  binding: PrDetailBinding;
}) {
  const { ui, binding } = props;
  const files = binding.diff.files;
  const [selected, setSelected] = useState(files[0]?.path ?? "");
  const [commentTarget, setCommentTarget] = useState<CommentTarget>();
  const [diffStyle, setDiffStyle] = useState<"split" | "unified">(ui.phone ? "unified" : "split");
  useEffect(() => {
    if (!files.some((file) => file.path === selected)) setSelected(files[0]?.path ?? "");
  }, [files, selected]);
  return (
    <section
      data-testid="pr-diff"
      data-ef-diff-digest={binding.diffDigest}
      data-base-stream={binding.baseStreamId}
      data-base-offset={binding.base.checkpoint}
      data-source-stream={binding.sourceStreamId}
      data-source-offset={binding.source.checkpoint}
      data-diff-style={diffStyle}
      className="min-w-0"
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-2 text-muted-foreground">
          {files.length} {files.length === 1 ? "file" : "files"} changed since the fork point
        </span>
        <span className="flex-1" />
        <Segmented
          aria-label="Diff view"
          value={diffStyle}
          onChange={(id) => setDiffStyle(id === "unified" ? "unified" : "split")}
          className="w-[180px] rounded-md"
          options={[
            { id: "split", label: "Split" },
            { id: "unified", label: "Unified" },
          ]}
        />
      </div>
      <div className="flex gap-4">
        {!ui.phone ? (
          <aside className="w-[260px] shrink-0" aria-label="Files changed">
            <div className="sticky top-0">
              <div className="mb-2 flex items-center gap-2 font-semibold">
                Files changed <span className="text-muted-foreground">{files.length}</span>
              </div>
              {files.length === 0 ? (
                <p className="m-0 text-muted-foreground">No changes from the fork point.</p>
              ) : (
                <PierrePathTree
                  paths={files.map((file) => file.path)}
                  filePaths={files.map((file) => file.path)}
                  density="default"
                  selectedPath={selected}
                  onOpen={(path) => setSelected(path)}
                />
              )}
            </div>
          </aside>
        ) : null}
        <div className="min-w-0 flex-1 space-y-4">
          {files
            .filter((file) => ui.phone || selected === "" || file.path === selected)
            .map((file) => (
              <Box
                key={file.path}
                header={
                  <>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-semibold text-foreground">
                      {file.path}
                    </span>
                    <button
                      type="button"
                      className={cn(ghButton(), "h-7 px-2.5 text-[12px]")}
                      onClick={() => setCommentTarget({ path: file.path })}
                    >
                      <Oct name="comment" size={14} /> Comment
                    </button>
                  </>
                }
              >
                <PierreFileDiff
                  file={file}
                  org={props.org}
                  repo={props.repo}
                  baseBranch={branchNameFromStream(binding.baseStreamId) || "main"}
                  sourceBranch={branchNameFromStream(binding.sourceStreamId) || "main"}
                  oldDigest={binding.base.state.files[file.path]?.contentSha256}
                  newDigest={binding.source.state.files[file.path]?.contentSha256}
                  diffStyle={diffStyle}
                  onSelectLine={(line) => setCommentTarget({ path: file.path, line })}
                />
              </Box>
            ))}
        </div>
      </div>
      <AppSheet
        open={commentTarget !== undefined}
        onClose={() => setCommentTarget(undefined)}
        title={`Comment on ${commentTargetLabel(commentTarget) ?? "file"}`}
      >
        <CommentForm
          binding={binding}
          {...(commentTarget === undefined ? {} : { target: commentTarget })}
          onDone={() => setCommentTarget(undefined)}
        />
      </AppSheet>
    </section>
  );
}

/**
 * Warm @pierre/diffs' shared Shiki highlighter (engine + the default themes + the grammars our
 * repositories mostly diff) so the first MultiFileDiff paints without waiting on it. Called by
 * the optimistic preload in prs/preload.ts once this chunk has loaded; failures are harmless.
 */
export function warmDiffHighlighter(): Promise<void> {
  return preloadHighlighter({
    themes: [DEFAULT_THEMES.dark, DEFAULT_THEMES.light],
    langs: ["typescript", "tsx", "markdown", "json"],
  });
}

function PierreFileDiff(props: {
  file: PrDiffFile;
  org: string;
  repo: string;
  baseBranch: string;
  sourceBranch: string;
  oldDigest: string | undefined;
  newDigest: string | undefined;
  onSelectLine: (line: number) => void;
  diffStyle: "split" | "unified";
}) {
  const oldContent = useDiffContent(
    props.org,
    props.repo,
    props.baseBranch,
    props.file.path,
    props.oldDigest,
    props.file.oldContent,
  );
  const newContent = useDiffContent(
    props.org,
    props.repo,
    props.sourceBranch,
    props.file.path,
    props.newDigest,
    props.file.newContent,
  );
  const options = {
    themeType: "dark" as const,
    diffStyle: props.diffStyle,
    lineHoverHighlight: "number" as const,
    enableGutterUtility: true,
    onGutterUtilityClick: (range: SelectedLineRange): void => props.onSelectLine(range.start),
    onLineNumberClick: (line: OnDiffLineClickProps): void => props.onSelectLine(line.lineNumber),
  };
  const oldFile = { name: props.file.path, contents: oldContent.text };
  const newFile = { name: props.file.path, contents: newContent.text };
  // Added / removed files render against an absent side (MultiFileDiff's discriminated props).
  const sides =
    props.file.status === "added"
      ? ({ oldFile: null, newFile } as const)
      : props.file.status === "removed"
        ? ({ oldFile, newFile: null } as const)
        : ({ oldFile, newFile } as const);
  const renderedLines = Math.max(
    oldContent.text.split("\n").length,
    newContent.text.split("\n").length,
  );
  const contentKey = `${oldContent.ready ? "old-ready" : "old-loading"}:${props.oldDigest ?? "absent"}:${newContent.ready ? "new-ready" : "new-loading"}:${props.newDigest ?? "absent"}`;
  return (
    <div
      className="overflow-x-auto [--diffs-bg:var(--background)] [color-scheme:dark]"
      data-pierre-diff-style={props.diffStyle}
      data-pierre-content-state={oldContent.ready && newContent.ready ? "hydrated" : "loading"}
      data-pierre-rendered-lines={renderedLines}
      data-pierre-old-content={oldContent.diagnostic}
      data-pierre-new-content={newContent.diagnostic}
    >
      <MultiFileDiff key={contentKey} {...sides} options={options} />
    </div>
  );
}
// ef:end
