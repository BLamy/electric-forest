import { useState } from "react";
import { cn } from "@brett_lamy/ui";
import type { Event } from "@eforest/protocol";
import { Markdown } from "../components/markdown/Markdown.js";
import { EvidencePanel } from "../evidence/index.js";
import { RouteLink, repoSectionPath } from "../navigation.js";
import {
  Oct,
  StatePill,
  ghButton,
  ghField,
  ghTextarea,
  githubMarkdown,
  type Layout,
} from "../blocks/github/parts.js";
import { CommentCard, TimelineEvent } from "../blocks/github/pull-request.js";
import {
  issueActions,
  issueError,
  issueStates,
  issueTimeline,
  useIssue,
  type ApplicationRecord,
  type IssueStateName,
  type RenderedIssueError,
} from "./useIssues.js";
import { prIdFromStream } from "../prs/usePrs.js";

function formValue(form: FormData, name: string): string {
  return String(form.get(name) ?? "");
}

function eventSummary(record: ApplicationRecord): string {
  const payload = record.payload as Record<string, unknown>;
  switch (record.type) {
    case "issue.opened":
      return `Opened: ${String(payload.title ?? "")}`;
    case "issue.commented":
      return `Comment ${String(payload.commentId ?? "")}`;
    case "issue.labeled":
      return `Added label ${String(payload.label ?? "")}`;
    case "issue.unlabeled":
      return `Removed label ${String(payload.label ?? "")}`;
    case "issue.state-changed":
      return `Moved to ${String(payload.to ?? "")}`;
    case "issue.closed":
      return `Closed${typeof payload.reason === "string" ? `: ${payload.reason}` : ""}`;
    case "issue.reopened":
      return "Reopened";
    default:
      return record.type;
  }
}

const OPEN_STATES = new Set(["open", "in-progress"]);

/**
 * One issue (`issue:<org>/<repo>/<id>`) in the github-clone conversation layout. Every control
 * is a dispatch through the door; the page renders the replayed issue stream and the dispatch
 * lifecycle counters (sent / confirmed / reconciled / refused) as evidence attributes.
 */
export function IssueDetailPage(props: {
  readonly ui: Layout;
  readonly org: string;
  readonly repo: string;
  readonly issueId: string;
}): React.JSX.Element {
  const { ui } = props;
  const binding = useIssue(props.org, props.repo, props.issueId);
  const [dispatchError, setDispatchError] = useState<RenderedIssueError>();
  const state = binding.projection.state;
  const records = issueTimeline(binding.projection);
  const board = repoSectionPath(props.org, props.repo, "issues");
  const pulls = repoSectionPath(props.org, props.repo, "pulls");
  const inFlight =
    binding.dispatch.counters.sent >
    binding.dispatch.counters.confirmed + binding.dispatch.counters.refused;

  const submit = async (action: Event): Promise<void> => {
    setDispatchError(undefined);
    try {
      await binding.dispatch(action);
    } catch (error) {
      setDispatchError(issueError(error));
    }
  };
  const details = (
    <>
      <div className="border-b border-border pb-4">
        <div className="mb-2 font-semibold text-muted-foreground">Dispatch lifecycle</div>
        <dl
          className="m-0 grid grid-cols-[1fr_max-content] gap-y-1"
          aria-label="Issue dispatch lifecycle"
        >
          <dt>Sent</dt>
          <dd data-testid="issue-dispatches-sent" className="m-0">
            {binding.dispatch.counters.sent}
          </dd>
          <dt>Confirmed</dt>
          <dd data-testid="issue-dispatches-confirmed" className="m-0">
            {binding.dispatch.counters.confirmed}
          </dd>
          <dt>Reconciled</dt>
          <dd data-testid="issue-dispatches-reconciled" className="m-0">
            {binding.dispatch.counters.reconciled}
          </dd>
          <dt>Refused</dt>
          <dd data-testid="issue-dispatches-refused" className="m-0">
            {binding.dispatch.counters.refused}
          </dd>
        </dl>
      </div>
      <IssueBacklinks pulls={pulls} binding={binding} />
    </>
  );
  const label = "grid gap-1 text-[13px] font-semibold";
  const formBox = "grid content-start gap-2 rounded-md border border-border p-3";

  return (
    <section
      className={cn("grid gap-4", ui.phone && "px-4 py-4")}
      data-testid="issue-detail"
      data-ef-stream={binding.streamId}
      data-ef-offset={binding.projection.checkpoint}
      data-ef-digest={binding.projection.digest}
      data-ef-reducer="issue"
      data-ef-confirmed-offset={binding.dispatch.confirmedOffset}
      data-application-checkpoint={binding.projection.checkpoint}
      data-state-digest={binding.projection.digest}
      data-stream-status={binding.projection.status}
      data-dispatches-sent={binding.dispatch.counters.sent}
      data-dispatches-confirmed={binding.dispatch.counters.confirmed}
      data-dispatches-reconciled={binding.dispatch.counters.reconciled}
      data-dispatches-refused={binding.dispatch.counters.refused}
    >
      {!ui.phone ? (
        <RouteLink href={board} className="flex w-fit items-center gap-1 text-[14px]">
          <Oct name="chevLeft" size={14} />
          Issues
        </RouteLink>
      ) : null}
      <div>
        <h1
          className={cn("m-0 leading-tight font-normal", ui.phone ? "text-[22px]" : "text-[32px]")}
        >
          <span data-testid="issue-title">{state.title || "Unopened issue"}</span>{" "}
          <span className="font-light text-muted-foreground" data-testid="route-issue-detail">
            {props.issueId}
          </span>
        </h1>
        <div className="mt-3 flex flex-wrap items-center gap-2 border-b border-border pb-4 text-muted-foreground">
          <StatePill state={OPEN_STATES.has(state.state) ? "open" : "closed"} />
          <span data-testid="issue-state" className="font-semibold text-foreground">
            {state.state}
          </span>
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" data-testid="issue-labels">
            {state.labels.map((label) => (
              <li
                key={label}
                data-testid="issue-label"
                data-label-id={label}
                className="flex items-center gap-1 rounded-full border border-border px-2 text-[12px]"
              >
                <span>{label}</span>
                <button
                  type="button"
                  disabled={inFlight}
                  onClick={() => void submit(issueActions.unlabel(label))}
                  data-testid="issue-remove-label"
                  aria-label={`Remove label ${label}`}
                  className="cursor-pointer border-0 bg-transparent p-0 text-muted-foreground hover:text-destructive disabled:opacity-50"
                >
                  <Oct name="x" size={12} />
                  <span className="sr-only">Remove</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <dl className="sr-only">
        <dt>Stream</dt>
        <dd data-testid="issue-detail-stream">{binding.streamId}</dd>
        <dt>Replayed offset</dt>
        <dd data-testid="issue-detail-offset">{binding.projection.checkpoint}</dd>
        <dt>Confirmed offset</dt>
        <dd data-testid="issue-detail-confirmed-offset">{binding.dispatch.confirmedOffset}</dd>
        <dt>Digest</dt>
        <dd data-testid="issue-detail-digest">{binding.projection.digest}</dd>
        <dt>Status</dt>
        <dd data-testid="issue-detail-status">{binding.projection.status}</dd>
      </dl>

      {binding.projection.status === "loading" ? (
        <p data-testid="issue-detail-loading" role="status" className="m-0 text-muted-foreground">
          Loading issue…
        </p>
      ) : null}
      {binding.projection.status.startsWith("error:") ? (
        <p className="m-0 text-destructive" role="alert" data-testid="issue-detail-refusal">
          Issue projection refused: {binding.projection.status.slice("error:".length)}
        </p>
      ) : null}

      <div className="flex gap-6">
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              "relative",
              ui.phone ? "before:left-4" : "before:left-[72px]",
              "before:absolute before:inset-y-0 before:w-0.5 before:bg-border",
            )}
          >
            <div className="relative flex gap-4 py-4">
              <div className="relative z-1 min-w-0 flex-1 overflow-hidden rounded-md border border-(--ef-primary-edge-12) bg-background">
                <div className="flex items-center gap-1.5 border-b border-(--ef-primary-edge-12) bg-(--ef-primary-wash-8) px-4 py-2 text-muted-foreground">
                  <b className="font-semibold text-foreground">Description</b>
                </div>
                <Markdown
                  source={state.body}
                  data-testid="issue-body"
                  className={cn(githubMarkdown, "px-4 py-3 text-[14px] leading-[1.5]")}
                />
              </div>
            </div>
            <ol
              data-testid="issue-timeline"
              className="m-0 list-none p-0"
              aria-labelledby="issue-timeline-heading"
            >
              {records.map((record) => {
                const payload = record.payload as Record<string, unknown>;
                return (
                  <li
                    key={record.offset}
                    data-testid="issue-timeline-event"
                    data-offset={record.offset}
                  >
                    {record.type === "issue.commented" ? (
                      <CommentCard
                        ui={ui}
                        author={record.actor ?? "Electric Forest"}
                        when=""
                        body={String(payload.body ?? "")}
                        role={record.offset}
                        footer={
                          <span className="sr-only">
                            <code data-testid="issue-event-offset">{record.offset}</code>
                            <strong data-testid="issue-event-type">{record.type}</strong>
                            <span data-testid="issue-event-summary">{eventSummary(record)}</span>
                          </span>
                        }
                        markdownTestId="issue-comment-markdown"
                      />
                    ) : (
                      <TimelineEvent
                        ui={ui}
                        icon={
                          record.type === "issue.labeled" || record.type === "issue.unlabeled"
                            ? "tag"
                            : "pulse"
                        }
                      >
                        <b className="font-semibold text-foreground">
                          {record.actor ?? "Electric Forest"}
                        </b>{" "}
                        <span data-testid="issue-event-summary">{eventSummary(record)}</span>{" "}
                        <strong
                          data-testid="issue-event-type"
                          className="font-mono text-[12px] font-normal"
                        >
                          {record.type}
                        </strong>{" "}
                        <code data-testid="issue-event-offset" className="text-[12px]">
                          {record.offset}
                        </code>
                      </TimelineEvent>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
          <h2 id="issue-timeline-heading" className="sr-only">
            Timeline
          </h2>
          <p className="m-0 text-[12px] text-muted-foreground">
            <span data-testid="issue-timeline-count">{records.length}</span> events on the issue
            stream
          </p>

          <div className="mt-4">
            <EvidencePanel
              org={props.org}
              repo={props.repo}
              entityType="issue"
              entityId={props.issueId}
            />
          </div>

          {dispatchError === undefined ? null : (
            <p
              className="mt-4 mb-0 text-destructive"
              role="alert"
              data-testid="issue-dispatch-error"
              data-code={dispatchError.code}
            >
              <strong>{dispatchError.code}</strong>: {dispatchError.message}
            </p>
          )}

          <div className="mt-6 grid gap-3 border-t-2 border-border pt-6 md:grid-cols-2">
            <form
              className={cn(formBox, "md:col-span-2")}
              data-testid="issue-comment-form"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                void submit(
                  issueActions.comment(formValue(form, "commentId"), formValue(form, "body")),
                );
              }}
            >
              <h3 className="m-0 text-[14px] font-semibold">Add a comment</h3>
              <label className={label}>
                Comment ID
                <input
                  name="commentId"
                  required
                  data-testid="issue-comment-id"
                  className={ghField}
                />
              </label>
              <label className={label}>
                Comment
                <textarea
                  name="body"
                  required
                  data-testid="issue-comment-body"
                  className={ghTextarea}
                />
              </label>
              <button
                type="submit"
                disabled={inFlight}
                data-testid="issue-comment-submit"
                className={cn(ghButton(true), "justify-self-end")}
              >
                Comment
              </button>
            </form>

            <form
              className={formBox}
              data-testid="issue-add-label-form"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                void submit(issueActions.label(formValue(form, "label")));
              }}
            >
              <h3 className="m-0 text-[14px] font-semibold">Add label</h3>
              <label className={label}>
                Label ID
                <input name="label" required data-testid="issue-add-label-id" className={ghField} />
              </label>
              <button
                type="submit"
                disabled={inFlight}
                data-testid="issue-add-label-submit"
                className={ghButton()}
              >
                Add label
              </button>
            </form>

            <form
              key={`transition:${state.state}`}
              className={formBox}
              data-testid="issue-transition-form"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                void submit(issueActions.transition(formValue(form, "to") as IssueStateName));
              }}
            >
              <h3 className="m-0 text-[14px] font-semibold">Change state</h3>
              <label className={label}>
                Next state
                <select
                  name="to"
                  defaultValue={binding.transitionTargets[0] ?? issueStates[0]}
                  data-testid="issue-transition-to"
                  className={ghField}
                >
                  {issueStates.map((candidate) => (
                    <option
                      key={candidate}
                      value={candidate}
                      disabled={!binding.transitionTargets.includes(candidate)}
                    >
                      {candidate}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                disabled={inFlight || binding.transitionTargets.length === 0}
                data-testid="issue-transition-submit"
                className={ghButton()}
              >
                Change state
              </button>
            </form>

            <form
              className={formBox}
              data-testid="issue-close-form"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                void submit(issueActions.close(formValue(form, "reason")));
              }}
            >
              <h3 className="m-0 text-[14px] font-semibold">Close issue</h3>
              <label className={label}>
                Reason
                <input name="reason" data-testid="issue-close-reason" className={ghField} />
              </label>
              <button
                type="submit"
                disabled={inFlight || !binding.canClose}
                data-testid="issue-close-submit"
                className={ghButton()}
              >
                <Oct name="issueClosed" className="text-(--gh-done)" />
                Close
              </button>
            </form>

            <div className={formBox}>
              <h3 className="m-0 text-[14px] font-semibold">Reopen</h3>
              <button
                type="button"
                disabled={inFlight || !binding.canReopen}
                onClick={() => void submit(issueActions.reopen())}
                data-testid="issue-reopen-submit"
                className={ghButton()}
              >
                Reopen issue
              </button>
            </div>
          </div>
        </div>
        {ui.wide ? (
          <aside className="w-[256px] shrink-0 text-[12px]" aria-label="Issue details">
            {details}
          </aside>
        ) : null}
      </div>
      {ui.wide ? null : (
        <div className="text-[12px]" aria-label="Issue details">
          {details}
        </div>
      )}
    </section>
  );
}

function IssueBacklinks(props: {
  readonly pulls: string;
  readonly binding: ReturnType<typeof useIssue>;
}): React.JSX.Element {
  const { binding } = props;
  const state = binding.projection.state;
  return (
    <section
      className="py-4"
      aria-labelledby="issue-pr-backlinks-heading"
      data-testid="issue-pr-backlinks"
      data-ef-stream={binding.streamId}
      data-ef-offset={binding.projection.checkpoint}
      data-ef-digest={binding.projection.digest}
    >
      <h3
        id="issue-pr-backlinks-heading"
        className="mt-0 mb-2 text-[12px] font-semibold text-muted-foreground"
      >
        Pull requests
      </h3>
      {(state.linkedBy?.length ?? 0) + (state.closedBy?.length ?? 0) === 0 ? (
        <p className="m-0 text-muted-foreground">No pull requests reference this issue.</p>
      ) : (
        <ul className="m-0 grid list-none gap-1 p-0">
          {state.linkedBy?.map((link) => {
            const prId = prIdFromStream(link.prStream);
            return (
              <li key={`linked:${link.prStream}:${link.atOffset}`} className="grid">
                {prId === undefined ? (
                  <code>{link.prStream}</code>
                ) : (
                  <RouteLink href={`${props.pulls}/${encodeURIComponent(prId)}`}>
                    Pull request #{prId}
                  </RouteLink>
                )}
                <span className="text-muted-foreground">linked at {link.atOffset}</span>
              </li>
            );
          })}
          {state.closedBy?.map((link) => {
            const prId = prIdFromStream(link.prStream);
            return (
              <li key={`closed:${link.prStream}:${link.prMergedOffset}`} className="grid">
                {prId === undefined ? (
                  <code>{link.prStream}</code>
                ) : (
                  <RouteLink href={`${props.pulls}/${encodeURIComponent(prId)}`}>
                    Closed by pull request #{prId}
                  </RouteLink>
                )}
                <span className="text-muted-foreground">merge event {link.prMergedOffset}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
