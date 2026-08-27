import { useEffect, useRef, useState } from "react";
import type { OnDiffLineClickProps, SelectedLineRange } from "@pierre/diffs";
import { MultiFileDiff } from "@pierre/diffs/react";
import { List, ListRow, ListSection, PillButton, Segmented, Spinner } from "@brett_lamy/ui";
import type { MeadowPrState } from "@eforest/meadow";
import { fileViewStreamId, type FileContentState } from "@eforest/reducers";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  CircleDot,
  Code2,
  GitCommitHorizontal,
  GitPullRequest,
  MessageSquare,
  MoreHorizontal,
  ShieldCheck,
} from "lucide-react";
import type { PrDiffFile } from "@eforest/pr";
import { useStreamReducer, type ApplicationRecord } from "@eforest/web-hooks";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardHeader } from "../components/ui/card.js";
import { Tabs } from "../components/ui/tabs.js";
import { Textarea } from "../components/ui/textarea.js";
import { Markdown } from "../components/markdown/Markdown.js";
import { MobileConversation } from "../components/mobile/MobileConversation.js";
import { MobileCredenza } from "../components/mobile/MobileOverlays.js";
import { MobileProductShell } from "../components/mobile/MobileProductShell.js";
import { PierrePathTree } from "../components/trees/RepositoryTree.js";
import { EvidencePanel } from "../evidence/index.js";
import { RouteLink } from "../navigation.js";
import { RepoHeader, navigate, repoSectionPath } from "./RepoChrome.js";
import { threadPrTimeline, type PrTimelineNode } from "./timeline.js";
import {
  issueIdFromStream,
  branchNameFromStream,
  prActions,
  prTimeline,
  usePrDetail,
  type PrDetailBinding,
} from "./usePrs.js";

export type PrDetailTab = "activity" | "commits" | "checks" | "changes";

const detailTabs = [
  { id: "activity", label: "Activity" },
  { id: "commits", label: "Commits" },
  { id: "checks", label: "Checks" },
  { id: "changes", label: "Changes" },
] as const;

function useCompact(): boolean {
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 899px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 899px)");
    const update = (): void => setCompact(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return compact;
}

function tabPath(org: string, repo: string, prId: string, tab: PrDetailTab): string {
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

function StatusBadge(props: { readonly status: string }): React.JSX.Element {
  return (
    <Badge className={`pr-state-badge pr-state-${props.status}`}>
      <GitPullRequest size={15} />
      {props.status}
    </Badge>
  );
}

function PrTitle(props: {
  readonly prId: string;
  readonly binding: PrDetailBinding;
}): React.JSX.Element {
  const state = props.binding.projection.state;
  return (
    <div className="pr-detail-title">
      <div className="pr-detail-title-line">
        <StatusBadge status={state.status} />
        <span>{state.author || props.binding.actor}</span>
        <span aria-hidden="true">/</span>
        <strong>{branchNameFromStream(state.targetBranch) || "main"}</strong>
        <span aria-hidden="true">←</span>
        <Badge>{branchNameFromStream(state.sourceBranch) || "source"}</Badge>
      </div>
      <h1 data-testid="pr-title">
        {state.title || "Loading pull request…"} <span>#{props.prId}</span>
      </h1>
    </div>
  );
}

export function ConflictPanel(props: { readonly state: MeadowPrState }): React.JSX.Element | null {
  const outcome = props.state.mergeOutcome;
  if (outcome === undefined || !("conflicts" in outcome)) return null;
  return (
    <Card
      className="pr-conflicts"
      data-testid="pr-conflicts"
      data-target-merge-offset={outcome.targetMergeOffset}
    >
      <CardHeader>
        <AlertTriangle size={19} />
        <div>
          <strong>Merge conflicts need attention</strong>
          <p>The target branch is unchanged. Resolve these paths before retrying.</p>
        </div>
      </CardHeader>
      <CardContent>
        <ul>
          {outcome.conflicts.map((conflict) => (
            <li key={`${conflict.path}:${conflict.kind}`} data-testid="pr-conflict">
              <code>{conflict.path}</code>
              <Badge>{conflict.kind}</Badge>
            </li>
          ))}
        </ul>
        <p>
          Target event <code>{outcome.targetMergeOffset}</code>
        </p>
      </CardContent>
    </Card>
  );
}

function Backlinks(props: {
  readonly org: string;
  readonly repo: string;
  readonly binding: PrDetailBinding;
}): React.JSX.Element {
  const state = props.binding.projection.state;
  return (
    <section
      className="pr-backlinks"
      aria-labelledby="pr-backlinks-heading"
      data-testid="pr-backlinks"
    >
      <h3 id="pr-backlinks-heading">Linked issues</h3>
      {state.closes === undefined || state.closes.length === 0 ? (
        <p>No linked issues</p>
      ) : (
        <ul>
          {state.closes.map((ref) => {
            const issueId = issueIdFromStream(ref.stream);
            return (
              <li key={ref.stream}>
                {issueId === undefined ? (
                  <span>{ref.stream}</span>
                ) : (
                  <RouteLink
                    href={`${repoSectionPath(props.org, props.repo, "issues")}/${encodeURIComponent(issueId)}`}
                  >
                    #{issueId}
                  </RouteLink>
                )}
                <span>will close when merged</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

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

function CommentForm(props: {
  readonly binding: PrDetailBinding;
  readonly target?: CommentTarget;
  readonly onDone?: () => void;
}): React.JSX.Element {
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
      className="pr-comment-form selectable-content"
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
      <Textarea
        name="body"
        required
        placeholder="Leave a comment"
        aria-label="Pull request comment"
      />
      {targetLabel === undefined ? null : (
        <p className="pr-comment-target" data-testid="pr-comment-target">
          <MessageSquare size={15} aria-hidden="true" /> {targetLabel}
        </p>
      )}
      {error === undefined ? null : (
        <p className="pr-inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="pr-comment-actions">
        <span>
          <Code2 size={16} /> Markdown via Docstream
        </span>
        <Button type="submit">Comment</Button>
      </div>
    </form>
  );
}

function TimelineNodeView(props: {
  readonly node: PrTimelineNode<ApplicationRecord>;
  readonly onReply: (record: ApplicationRecord) => void;
}): React.JSX.Element {
  const { record } = props.node;
  return (
    <li
      id={`pr-event-${record.offset}`}
      data-testid="pr-timeline-event"
      data-event-offset={record.offset}
      data-reply-to={
        record.type === "pr.review-comment"
          ? String((record.payload as Record<string, unknown>).replyTo ?? "")
          : undefined
      }
    >
      <div className="pr-activity-icon">
        {record.type === "pr.approved" || record.type === "pr.merged" ? (
          <CheckCircle2 size={17} />
        ) : record.type === "pr.merge-conflicted" ? (
          <AlertTriangle size={17} />
        ) : (
          <MessageSquare size={17} />
        )}
      </div>
      <div className="pr-activity-entry">
        <Card>
          <CardHeader>
            <strong>{recordActor(record)}</strong>
            <span>{recordSummary(record)}</span>
            <code>{record.offset}</code>
          </CardHeader>
          {record.type === "pr.review-comment" ? (
            <CardContent>
              <Markdown source={String((record.payload as Record<string, unknown>).body ?? "")} />
              <Button size="sm" variant="ghost" onClick={() => props.onReply(record)}>
                Reply
              </Button>
            </CardContent>
          ) : null}
        </Card>
        {props.node.replies.length === 0 ? null : (
          <ol
            className="pr-activity pr-activity-replies"
            aria-label={`Replies to ${record.offset}`}
          >
            {props.node.replies.map((reply) => (
              <TimelineNodeView key={reply.record.offset} node={reply} onReply={props.onReply} />
            ))}
          </ol>
        )}
      </div>
    </li>
  );
}

function ActivityView(props: {
  readonly org: string;
  readonly repo: string;
  readonly prId: string;
  readonly binding: PrDetailBinding;
}): React.JSX.Element {
  const records = threadPrTimeline(prTimeline(props.binding).slice(1));
  const state = props.binding.projection.state;
  const [error, setError] = useState<string>();
  const [replyTarget, setReplyTarget] = useState<ApplicationRecord>();
  const compact = useCompact();
  const run = (event: ReturnType<typeof prActions.approve>): void => {
    setError(undefined);
    void props.binding
      .dispatch(event)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  };
  return (
    <div className="pr-detail-grid">
      <div className="pr-detail-main">
        <Card className="pr-summary-card">
          <CardHeader>
            <div className="pr-avatar" aria-hidden="true">
              {(state.author || "E").slice(0, 1).toUpperCase()}
            </div>
            <div>
              <strong>{state.author || props.binding.actor}</strong>
              <span> opened this pull request</span>
            </div>
          </CardHeader>
          <CardContent>
            <Markdown source={state.body || "No description was provided."} />
          </CardContent>
        </Card>
        <EvidencePanel org={props.org} repo={props.repo} entityType="pr" entityId={props.prId} />
        <ol className="pr-activity" aria-label="Pull request activity">
          {records.map((node) => (
            <TimelineNodeView key={node.record.offset} node={node} onReply={setReplyTarget} />
          ))}
        </ol>
        <ConflictPanel state={state} />
        <Card className={`pr-merge-panel pr-merge-panel-${state.status}`}>
          <CardHeader>
            {state.status === "approved" || state.status === "merged" ? (
              <CheckCircle2 size={21} />
            ) : (
              <CircleDot size={21} />
            )}
            <div>
              <strong>
                {state.status === "merged"
                  ? "Merged"
                  : state.status === "approved"
                    ? "Ready to merge"
                    : "Review required"}
              </strong>
              <p>
                {state.status === "approved"
                  ? "All approval requirements have been met."
                  : "Approval is required before this branch can merge."}
              </p>
            </div>
          </CardHeader>
          <CardContent>
            <div className="pr-merge-check">
              <Check size={17} />
              <span>Branch projections are live</span>
              <code>{props.binding.source.checkpoint}</code>
            </div>
            <div className="pr-merge-actions">
              <Button disabled={state.status !== "approved"} onClick={() => run(prActions.merge())}>
                Merge
              </Button>
              <Button
                variant="secondary"
                disabled={state.status === "merged" || state.status === "closed"}
                onClick={() => run(prActions.approve(props.binding.actor))}
              >
                Approve
              </Button>
              <Button
                variant="secondary"
                disabled={state.status === "merged" || state.status === "closed"}
                onClick={() =>
                  run(
                    prActions.requestChanges(
                      props.binding.actor,
                      "Changes requested from the review surface",
                    ),
                  )
                }
              >
                Request changes
              </Button>
              <Button
                variant="secondary"
                disabled={state.status === "merged" || state.status === "closed"}
                onClick={() => run(prActions.close(props.binding.actor))}
              >
                Close pull request
              </Button>
            </div>
          </CardContent>
        </Card>
        {error === undefined ? null : (
          <p className="pr-inline-error" role="alert">
            {error}
          </p>
        )}
        <Card>
          <CommentForm binding={props.binding} />
        </Card>
        <MobileCredenza
          open={replyTarget !== undefined}
          onClose={() => setReplyTarget(undefined)}
          label={`Reply to ${replyTarget?.offset ?? "comment"}`}
          title={`Reply to ${replyTarget?.offset ?? "comment"}`}
          compact={compact}
        >
          <CommentForm
            binding={props.binding}
            {...(replyTarget === undefined ? {} : { target: { replyTo: replyTarget.offset } })}
            onDone={() => setReplyTarget(undefined)}
          />
        </MobileCredenza>
      </div>
      <aside className="pr-detail-aside">
        <section>
          <h3>Reviewers</h3>
          <p>{state.approvals.length === 0 ? "No approvals yet" : state.approvals.join(", ")}</p>
        </section>
        <section>
          <h3>Checks</h3>
          <p className="pr-check-ok">
            <Check size={16} /> Projection integrity
          </p>
        </section>
        <section>
          <h3>Assignees</h3>
          <p>{state.author || "No one assigned"}</p>
        </section>
        <section>
          <h3>Labels</h3>
          <p>None set</p>
        </section>
        <Backlinks org={props.org} repo={props.repo} binding={props.binding} />
      </aside>
    </div>
  );
}

function CommitsView(props: { readonly binding: PrDetailBinding }): React.JSX.Element {
  const commits = prTimeline(props.binding).filter((record) => record.type !== "pr.review-comment");
  return (
    <section className="pr-commits" aria-label="Commits">
      <p className="pr-timeline-date">
        <GitCommitHorizontal size={16} /> Stream commits
      </p>
      <Card>
        {commits.map((record) => (
          <div className="pr-commit-row" key={record.offset}>
            <div>
              <strong>{recordSummary(record)}</strong>
              <p>{recordActor(record)} · event stream</p>
            </div>
            <code>{record.offset}</code>
          </div>
        ))}
      </Card>
    </section>
  );
}

function ChecksView(props: { readonly binding: PrDetailBinding }): React.JSX.Element {
  const state = props.binding.projection.state;
  const passed = !props.binding.projection.status.startsWith("error:");
  return (
    <section className="pr-checks-view">
      <div className="pr-checks-list">
        <h2>{passed ? "All checks have passed" : "Checks need attention"}</h2>
        <p>{passed ? "1 successful check" : "Projection unavailable"}</p>
        <button type="button" className="pr-check-selected">
          <Check size={17} /> Stream integrity
        </button>
      </div>
      <Card className="pr-check-detail">
        <CardHeader>
          <ShieldCheck size={20} />
          <h2>Stream integrity</h2>
        </CardHeader>
        <CardContent>
          <p>
            {passed
              ? "PR, branch, and index projections are connected."
              : props.binding.projection.status}
          </p>
          <dl>
            <dt>PR checkpoint</dt>
            <dd>{props.binding.projection.checkpoint}</dd>
            <dt>Diff digest</dt>
            <dd>{props.binding.diffDigest}</dd>
            <dt>Review status</dt>
            <dd>{state.status}</dd>
          </dl>
        </CardContent>
      </Card>
    </section>
  );
}

function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function useDiffContent(
  org: string,
  repo: string,
  branch: string,
  path: string,
  expectedDigest: string | undefined,
  fallback: string,
): {
  readonly text: string;
  readonly ready: boolean;
  readonly diagnostic: string;
} {
  const streamId = fileViewStreamId(org, repo, branch, path);
  const projection = useStreamReducer<FileContentState>({
    apiPath: `/api/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/blob/${encodedPath(path)}`,
    streamId,
    reducerId: "file-content",
    followWaitMs: 500,
    reconnectDelayMs: 100,
    cacheKey: `pr-diff-content:${streamId}:${expectedDigest ?? "absent"}`,
  });
  if (expectedDigest === undefined)
    return {
      text: "",
      ready: true,
      diagnostic: `${projection.status}:${projection.state.status}:absent`,
    };
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

function ChangesView(props: {
  readonly org: string;
  readonly repo: string;
  readonly binding: PrDetailBinding;
}): React.JSX.Element {
  const [selected, setSelected] = useState(props.binding.diff.files[0]?.path ?? "");
  const [commentTarget, setCommentTarget] = useState<CommentTarget>();
  const [diffStyle, setDiffStyle] = useState<"split" | "unified">("split");
  const compact = useCompact();
  useEffect(() => {
    if (!props.binding.diff.files.some((file) => file.path === selected))
      setSelected(props.binding.diff.files[0]?.path ?? "");
  }, [props.binding.diff.files, selected]);
  const files = props.binding.diff.files;
  return (
    <section
      className="pr-changes"
      data-testid="pr-diff"
      data-ef-diff-digest={props.binding.diffDigest}
      data-base-stream={props.binding.baseStreamId}
      data-base-offset={props.binding.base.checkpoint}
      data-source-stream={props.binding.sourceStreamId}
      data-source-offset={props.binding.source.checkpoint}
      data-diff-style={diffStyle}
    >
      <div className="pr-changes-toolbar">
        <span>Diff view</span>
        <Tabs
          label="Diff view"
          items={[
            { id: "split", label: "Split" },
            { id: "unified", label: "Unified" },
          ]}
          selected={diffStyle}
          onSelect={setDiffStyle}
        />
      </div>
      <aside className="pr-files">
        <div className="pr-files-heading">
          <strong>Files changed</strong>
          <span>{files.length}</span>
        </div>
        {files.length === 0 ? (
          <p>No changes from the fork point.</p>
        ) : (
          <PierrePathTree
            paths={files.map((file) => file.path)}
            filePaths={files.map((file) => file.path)}
            density="default"
            selectedPath={selected}
            onOpen={(path) => setSelected(path)}
            className="pr-files-tree"
          />
        )}
      </aside>
      <div className="pr-diff-stack">
        {files
          .filter((file) => selected === "" || file.path === selected)
          .map((file) => (
            <Card className="pr-diff-file" key={file.path}>
              <div className="pr-diff-toolbar">
                <code>{file.path}</code>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setCommentTarget({ path: file.path })}
                >
                  <MessageSquare size={15} /> Comment
                </Button>
              </div>
              <PierreFileDiff
                file={file}
                org={props.org}
                repo={props.repo}
                baseBranch={branchNameFromStream(props.binding.baseStreamId) || "main"}
                sourceBranch={branchNameFromStream(props.binding.sourceStreamId) || "main"}
                oldDigest={props.binding.base.state.files[file.path]?.contentSha256}
                newDigest={props.binding.source.state.files[file.path]?.contentSha256}
                diffStyle={diffStyle}
                onSelectLine={(line) => setCommentTarget({ path: file.path, line })}
              />
            </Card>
          ))}
      </div>
      <MobileCredenza
        open={commentTarget !== undefined}
        onClose={() => setCommentTarget(undefined)}
        label={`Comment on ${commentTargetLabel(commentTarget) ?? "file"}`}
        title={`Comment on ${commentTargetLabel(commentTarget) ?? "file"}`}
        compact={compact}
      >
        <CommentForm
          binding={props.binding}
          {...(commentTarget === undefined ? {} : { target: commentTarget })}
          onDone={() => setCommentTarget(undefined)}
        />
      </MobileCredenza>
    </section>
  );
}

function PierreFileDiff(props: {
  readonly file: PrDiffFile;
  readonly org: string;
  readonly repo: string;
  readonly baseBranch: string;
  readonly sourceBranch: string;
  readonly oldDigest: string | undefined;
  readonly newDigest: string | undefined;
  readonly onSelectLine: (line: number) => void;
  readonly diffStyle: "split" | "unified";
}): React.JSX.Element {
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
  const oldFile =
    props.file.status === "added" ? null : { name: props.file.path, contents: oldContent.text };
  const newFile =
    props.file.status === "removed" ? null : { name: props.file.path, contents: newContent.text };
  const renderedLines = Math.max(
    oldContent.text.split("\n").length,
    newContent.text.split("\n").length,
  );
  const contentKey = `${oldContent.ready ? "old-ready" : "old-loading"}:${props.oldDigest ?? "absent"}:${newContent.ready ? "new-ready" : "new-loading"}:${props.newDigest ?? "absent"}`;
  return (
    <div
      className="pr-pierre-diff"
      data-pierre-diff-style={props.diffStyle}
      data-pierre-content-state={oldContent.ready && newContent.ready ? "hydrated" : "loading"}
      data-pierre-rendered-lines={renderedLines}
      data-pierre-old-content={oldContent.diagnostic}
      data-pierre-new-content={newContent.diagnostic}
    >
      <MultiFileDiff key={contentKey} oldFile={oldFile} newFile={newFile} options={options} />
    </div>
  );
}

function MobileActivity(props: {
  readonly org: string;
  readonly repo: string;
  readonly prId: string;
  readonly binding: PrDetailBinding;
}): React.JSX.Element {
  const state = props.binding.projection.state;
  const records = prTimeline(props.binding);
  const [error, setError] = useState<string>();
  const run = (event: ReturnType<typeof prActions.approve>): void => {
    setError(undefined);
    void props.binding
      .dispatch(event)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  };
  return (
    <div className="mobile-pr-activity">
      <MobileConversation
        title="Activity"
        turns={records.map((record, index) => {
          const payload = record.payload as Record<string, unknown>;
          const body =
            record.type === "pr.opened"
              ? state.body || "No description was provided."
              : record.type === "pr.review-comment" || record.type === "pr.changes-requested"
                ? String(payload.body ?? recordSummary(record))
                : recordSummary(record);
          return {
            id: record.offset,
            author: recordActor(record),
            timestamp: index === 0 ? "opened this pull request" : recordSummary(record),
            summary: recordSummary(record),
            docstreamBody: <Markdown source={body} />,
            metadata: <code>{record.offset}</code>,
          };
        })}
        empty="Waiting for pull-request activity."
        composer={<CommentForm binding={props.binding} />}
      />
      <EvidencePanel org={props.org} repo={props.repo} entityType="pr" entityId={props.prId} />
      <ConflictPanel state={state} />
      <Card className={`pr-merge-panel pr-merge-panel-${state.status}`}>
        <CardHeader>
          {state.status === "approved" || state.status === "merged" ? (
            <CheckCircle2 size={21} />
          ) : (
            <CircleDot size={21} />
          )}
          <div>
            <strong>
              {state.status === "merged"
                ? "Merged"
                : state.status === "approved"
                  ? "Ready to merge"
                  : "Review required"}
            </strong>
            <p>Review state is derived from the durable pull-request stream.</p>
          </div>
        </CardHeader>
        <CardContent className="pr-merge-actions">
          {state.status === "approved" ? (
            <PillButton
              label="Merge pull request"
              onPress={() => run(prActions.merge())}
              className="mobile-pr-pill-action"
            />
          ) : state.status === "merged" || state.status === "closed" ? (
            <p data-mobile-action-state={state.status}>
              No further pull-request action is available.
            </p>
          ) : (
            <PillButton
              label="Approve pull request"
              tone="soft"
              onPress={() => run(prActions.approve(props.binding.actor))}
              className="mobile-pr-pill-action"
            />
          )}
        </CardContent>
      </Card>
      {error === undefined ? null : (
        <p className="pr-inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function MobileDetailContent(props: {
  readonly org: string;
  readonly repo: string;
  readonly prId: string;
  readonly tab: PrDetailTab;
  readonly binding: PrDetailBinding;
}): React.JSX.Element {
  if (props.binding.projection.status === "loading")
    return (
      <p className="pr-empty mobile-loading-state" role="status" data-mobile-spinner="Spinner">
        <Spinner spin size={20} /> Loading pull request…
      </p>
    );
  if (props.binding.projection.status.startsWith("error:"))
    return (
      <p className="pr-inline-error" role="alert">
        Pull-request projection refused: {props.binding.projection.status.slice(6)}
      </p>
    );
  if (props.tab === "activity") return <MobileActivity {...props} />;
  return <DetailContent {...props} />;
}

function DetailContent(props: {
  readonly org: string;
  readonly repo: string;
  readonly prId: string;
  readonly tab: PrDetailTab;
  readonly binding: PrDetailBinding;
}): React.JSX.Element {
  if (props.binding.projection.status === "loading")
    return <p className="pr-empty">Loading pull request…</p>;
  if (props.binding.projection.status.startsWith("error:"))
    return (
      <p className="pr-inline-error" role="alert">
        Pull-request projection refused: {props.binding.projection.status.slice(6)}
      </p>
    );
  if (props.tab === "commits") return <CommitsView binding={props.binding} />;
  if (props.tab === "checks") return <ChecksView binding={props.binding} />;
  if (props.tab === "changes") return <ChangesView {...props} />;
  return (
    <ActivityView org={props.org} repo={props.repo} prId={props.prId} binding={props.binding} />
  );
}

function DesktopDetail(props: {
  readonly org: string;
  readonly repo: string;
  readonly prId: string;
  readonly tab: PrDetailTab;
  readonly binding: PrDetailBinding;
}): React.JSX.Element {
  return (
    <section
      className="pr-app pr-detail-page"
      data-testid="pr-detail"
      data-ef-stream={props.binding.streamId}
      data-ef-offset={props.binding.projection.checkpoint}
      data-ef-digest={props.binding.projection.digest}
      data-ef-reducer="pr"
      data-stream-status={props.binding.projection.status}
    >
      <RepoHeader org={props.org} repo={props.repo} active="pulls" />
      <div className="pr-detail-top">
        <PrTitle prId={props.prId} binding={props.binding} />
        <div className="pr-top-actions">
          <Button variant="secondary">Review</Button>
          <Button
            disabled={props.binding.projection.state.status !== "approved"}
            onClick={() => void props.binding.dispatch(prActions.merge())}
          >
            Merge
          </Button>
          <Button size="icon" variant="ghost" aria-label="More pull request actions">
            <MoreHorizontal />
          </Button>
        </div>
      </div>
      <div className="pr-detail-tabs">
        <Tabs
          label="Pull request"
          items={detailTabs.map((item) => ({
            ...item,
            count:
              item.id === "activity"
                ? prTimeline(props.binding).length
                : item.id === "changes"
                  ? props.binding.diff.files.length
                  : undefined,
          }))}
          selected={props.tab}
          onSelect={(tab) => navigate(tabPath(props.org, props.repo, props.prId, tab))}
        />
      </div>
      <div className="pr-detail-content">
        <DetailContent {...props} />
      </div>
    </section>
  );
}

function MobileDetail(props: {
  readonly org: string;
  readonly repo: string;
  readonly prId: string;
  readonly tab: PrDetailTab;
  readonly binding: PrDetailBinding;
}): React.JSX.Element {
  const parentContent = (
    <List inset>
      <ListSection title={`${props.org} / ${props.repo}`}>
        <ListRow
          title="Pull Requests"
          subtitle="Activity, commits, checks, and changes"
          leading={<GitPullRequest size={20} />}
          accessory="chevron"
          onPress={() => navigate(repoSectionPath(props.org, props.repo, "pulls"))}
        />
      </ListSection>
    </List>
  );
  const parentScreen = {
    key: "pulls",
    title: "Pull Requests",
    largeTitle: true,
    content: parentContent,
    bottomInset: 78,
  };
  const detailScreen = {
    key: props.prId,
    title: `#${props.prId}`,
    trailing: <StatusBadge status={props.binding.projection.state.status} />,
    subheader: (
      <div className="mobile-pr-segmented">
        <Segmented
          aria-label="Pull request view"
          options={detailTabs.map((item) => ({ id: item.id, label: item.label }))}
          value={props.tab}
          onChange={(tab: string) =>
            navigate(tabPath(props.org, props.repo, props.prId, tab as PrDetailTab))
          }
        />
      </div>
    ),
    content: (
      <div
        className="mobile-pr-detail selectable-content"
        data-testid="pr-detail"
        data-ef-stream={props.binding.streamId}
        data-ef-offset={props.binding.projection.checkpoint}
        data-ef-digest={props.binding.projection.digest}
        data-ef-reducer="pr"
        data-stream-status={props.binding.projection.status}
      >
        <PrTitle prId={props.prId} binding={props.binding} />
        <MobileDetailContent {...props} />
      </div>
    ),
    bottomInset: 80,
  };
  return (
    <MobileProductShell
      org={props.org}
      repo={props.repo}
      activeTab="pulls"
      screens={[parentScreen, detailScreen]}
      onPop={() => navigate(repoSectionPath(props.org, props.repo, "pulls"))}
      routeForTab={(tab) => repoSectionPath(props.org, props.repo, tab)}
      sidebar={parentContent}
      regularMaster={parentContent}
      className="mobile-pr-shell"
    />
  );
}

export function PrDetailPage(props: {
  readonly org: string;
  readonly repo: string;
  readonly prId: string;
  readonly tab: PrDetailTab;
}): React.JSX.Element {
  const binding = usePrDetail(props.org, props.repo, props.prId);
  const compact = useCompact();
  return compact ? (
    <MobileDetail {...props} binding={binding} />
  ) : (
    <DesktopDetail {...props} binding={binding} />
  );
}
