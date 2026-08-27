import { useState } from "react";
import type { Event } from "@eforest/protocol";
import { Markdown } from "../components/markdown/Markdown.js";
import { MobileConversation } from "../components/mobile/MobileConversation.js";
import { EvidencePanel } from "../evidence/index.js";
import { RouteLink } from "../navigation.js";
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

export function IssueDetailPage(props: {
  readonly org: string;
  readonly repo: string;
  readonly issueId: string;
}): React.JSX.Element {
  const binding = useIssue(props.org, props.repo, props.issueId);
  const [dispatchError, setDispatchError] = useState<RenderedIssueError>();
  const state = binding.projection.state;
  const records = issueTimeline(binding.projection);
  const encodedBoard = `/orgs/${encodeURIComponent(props.org)}/repos/${encodeURIComponent(props.repo)}/issues`;
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

  return (
    <section
      className="issue-detail"
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
      <div className="issue-heading">
        <div>
          <p className="eyebrow">Per-issue event stream</p>
          <h2 data-testid="route-issue-detail">{props.issueId}</h2>
        </div>
        <RouteLink href={encodedBoard}>Issue board</RouteLink>
      </div>

      <dl className="issue-facts">
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
        <p data-testid="issue-detail-loading">Loading issue…</p>
      ) : null}
      {binding.projection.status.startsWith("error:") ? (
        <p className="projection-refusal" role="alert" data-testid="issue-detail-refusal">
          Issue projection refused: {binding.projection.status.slice("error:".length)}
        </p>
      ) : null}

      <section className="issue-summary" aria-label="Issue summary">
        <div>
          <p className="eyebrow">Title</p>
          <h3 data-testid="issue-title">{state.title || "Unopened issue"}</h3>
        </div>
        <Markdown source={state.body} data-testid="issue-body" />
        <span className={`issue-state issue-state-${state.state}`} data-testid="issue-state">
          {state.state}
        </span>
        <ul className="issue-labels" data-testid="issue-labels">
          {state.labels.map((label) => (
            <li key={label} data-testid="issue-label" data-label-id={label}>
              <span>{label}</span>
              <button
                type="button"
                disabled={inFlight}
                onClick={() => void submit(issueActions.unlabel(label))}
                data-testid="issue-remove-label"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section
        className="issue-pr-backlinks"
        aria-labelledby="issue-pr-backlinks-heading"
        data-testid="issue-pr-backlinks"
        data-ef-stream={binding.streamId}
        data-ef-offset={binding.projection.checkpoint}
        data-ef-digest={binding.projection.digest}
      >
        <h3 id="issue-pr-backlinks-heading">Pull requests</h3>
        {(state.linkedBy?.length ?? 0) + (state.closedBy?.length ?? 0) === 0 ? (
          <p>No pull requests reference this issue.</p>
        ) : (
          <ul>
            {state.linkedBy?.map((link) => {
              const prId = prIdFromStream(link.prStream);
              return (
                <li key={`linked:${link.prStream}:${link.atOffset}`}>
                  {prId === undefined ? (
                    <code>{link.prStream}</code>
                  ) : (
                    <RouteLink
                      href={`${encodedBoard.replace(/\/issues$/, "/pulls")}/${encodeURIComponent(prId)}`}
                    >
                      Pull request #{prId}
                    </RouteLink>
                  )}
                  <span>linked at {link.atOffset}</span>
                </li>
              );
            })}
            {state.closedBy?.map((link) => {
              const prId = prIdFromStream(link.prStream);
              return (
                <li key={`closed:${link.prStream}:${link.prMergedOffset}`}>
                  {prId === undefined ? (
                    <code>{link.prStream}</code>
                  ) : (
                    <RouteLink
                      href={`${encodedBoard.replace(/\/issues$/, "/pulls")}/${encodeURIComponent(prId)}`}
                    >
                      Closed by pull request #{prId}
                    </RouteLink>
                  )}
                  <span>merge event {link.prMergedOffset}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <EvidencePanel
        org={props.org}
        repo={props.repo}
        entityType="issue"
        entityId={props.issueId}
      />

      {dispatchError === undefined ? null : (
        <p
          className="dispatch-error"
          role="alert"
          data-testid="issue-dispatch-error"
          data-code={dispatchError.code}
        >
          <strong>{dispatchError.code}</strong>: {dispatchError.message}
        </p>
      )}

      <dl className="dispatch-counters" aria-label="Issue dispatch lifecycle">
        <dt>Sent</dt>
        <dd data-testid="issue-dispatches-sent">{binding.dispatch.counters.sent}</dd>
        <dt>Confirmed</dt>
        <dd data-testid="issue-dispatches-confirmed">{binding.dispatch.counters.confirmed}</dd>
        <dt>Reconciled</dt>
        <dd data-testid="issue-dispatches-reconciled">{binding.dispatch.counters.reconciled}</dd>
        <dt>Refused</dt>
        <dd data-testid="issue-dispatches-refused">{binding.dispatch.counters.refused}</dd>
      </dl>

      <div className="issue-actions">
        <form
          data-testid="issue-comment-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void submit(
              issueActions.comment(formValue(form, "commentId"), formValue(form, "body")),
            );
          }}
        >
          <h3>Add comment</h3>
          <label>
            Comment ID
            <input name="commentId" required data-testid="issue-comment-id" />
          </label>
          <label className="issue-wide-field">
            Comment
            <textarea name="body" required data-testid="issue-comment-body" />
          </label>
          <button type="submit" disabled={inFlight} data-testid="issue-comment-submit">
            Comment
          </button>
        </form>

        <form
          data-testid="issue-add-label-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void submit(issueActions.label(formValue(form, "label")));
          }}
        >
          <h3>Add label</h3>
          <label>
            Label ID
            <input name="label" required data-testid="issue-add-label-id" />
          </label>
          <button type="submit" disabled={inFlight} data-testid="issue-add-label-submit">
            Add label
          </button>
        </form>

        <form
          key={`transition:${state.state}`}
          data-testid="issue-transition-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void submit(issueActions.transition(formValue(form, "to") as IssueStateName));
          }}
        >
          <h3>Change state</h3>
          <label>
            Next state
            <select
              name="to"
              defaultValue={binding.transitionTargets[0] ?? issueStates[0]}
              data-testid="issue-transition-to"
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
          >
            Change state
          </button>
        </form>

        <form
          data-testid="issue-close-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void submit(issueActions.close(formValue(form, "reason")));
          }}
        >
          <h3>Close issue</h3>
          <label>
            Reason
            <input name="reason" data-testid="issue-close-reason" />
          </label>
          <button
            type="submit"
            disabled={inFlight || !binding.canClose}
            data-testid="issue-close-submit"
          >
            Close
          </button>
        </form>

        <button
          type="button"
          disabled={inFlight || !binding.canReopen}
          onClick={() => void submit(issueActions.reopen())}
          data-testid="issue-reopen-submit"
        >
          Reopen issue
        </button>
      </div>

      <MobileConversation
        className="issue-mobile-conversation"
        title="Issue conversation"
        turns={records.map((record) => {
          const payload = record.payload as Record<string, unknown>;
          const body =
            record.type === "issue.opened"
              ? state.body || eventSummary(record)
              : record.type === "issue.commented"
                ? String(payload.body ?? "")
                : eventSummary(record);
          return {
            id: record.offset,
            author: record.actor ?? "Electric Forest",
            timestamp: eventSummary(record),
            summary: eventSummary(record),
            docstreamBody: <Markdown source={body} />,
            metadata: <code>{record.offset}</code>,
          };
        })}
        empty="Waiting for issue activity."
      />

      <section
        className="issue-timeline issue-desktop-timeline"
        aria-labelledby="issue-timeline-heading"
      >
        <div className="issue-column-heading">
          <h3 id="issue-timeline-heading">Timeline</h3>
          <span data-testid="issue-timeline-count">{records.length}</span>
        </div>
        <ol data-testid="issue-timeline">
          {records.map((record) => {
            const payload = record.payload as Record<string, unknown>;
            return (
              <li
                key={record.offset}
                data-testid="issue-timeline-event"
                data-offset={record.offset}
              >
                <code data-testid="issue-event-offset">{record.offset}</code>
                <strong data-testid="issue-event-type">{record.type}</strong>
                <span data-testid="issue-event-summary">{eventSummary(record)}</span>
                {record.type === "issue.commented" ? (
                  <Markdown
                    source={String(payload.body ?? "")}
                    data-testid="issue-comment-markdown"
                  />
                ) : null}
              </li>
            );
          })}
        </ol>
      </section>
    </section>
  );
}
