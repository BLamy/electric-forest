import { useState } from "react";
import { RouteLink } from "../navigation.js";
import {
  issueActions,
  issueBoardForLabel,
  issueError,
  issueStates,
  useIssueBoard,
  useIssueCreator,
  type RenderedIssueError,
} from "./useIssues.js";

function formValue(form: FormData, name: string): string {
  return String(form.get(name) ?? "");
}

function validIssueId(value: string): boolean {
  return /^[A-Za-z0-9._~-]+$/.test(value);
}

export function IssueBoardPage(props: {
  readonly org: string;
  readonly repo: string;
}): React.JSX.Element {
  const binding = useIssueBoard(props.org, props.repo);
  const [filter, setFilter] = useState("");
  const [draftIssueId, setDraftIssueId] = useState("new-issue");
  const [dispatchError, setDispatchError] = useState<RenderedIssueError>();
  const creator = useIssueCreator(
    props.org,
    props.repo,
    validIssueId(draftIssueId) ? draftIssueId : "invalid-draft",
  );
  const board = issueBoardForLabel(binding.projection.state, filter);
  const encodedBase = `/orgs/${encodeURIComponent(props.org)}/repos/${encodeURIComponent(props.repo)}`;
  const inFlight = creator.counters.sent > creator.counters.confirmed + creator.counters.refused;

  return (
    <section
      className="issue-board"
      data-testid="issue-board"
      data-ef-stream={binding.streamId}
      data-ef-offset={binding.projection.checkpoint}
      data-ef-digest={binding.projection.digest}
      data-ef-reducer={binding.reducerId}
      data-application-checkpoint={binding.projection.checkpoint}
      data-state-digest={binding.projection.digest}
      data-stream-status={binding.projection.status}
    >
      <div className="issue-heading">
        <div>
          <p className="eyebrow">Derived live view</p>
          <h2 data-testid="route-issues">
            {props.org} / {props.repo} / issues
          </h2>
        </div>
        <RouteLink href={`${encodedBase}/labels`}>Labels</RouteLink>
      </div>

      <dl className="issue-facts">
        <dt>Derived stream</dt>
        <dd data-testid="issue-board-stream">{binding.streamId}</dd>
        <dt>Reducer</dt>
        <dd data-testid="issue-board-reducer">{binding.reducerId}</dd>
        <dt>Replayed offset</dt>
        <dd data-testid="issue-board-offset">{binding.projection.checkpoint}</dd>
        <dt>Digest</dt>
        <dd data-testid="issue-board-digest">{binding.projection.digest}</dd>
        <dt>Status</dt>
        <dd data-testid="issue-board-status">{binding.projection.status}</dd>
      </dl>

      <form
        className="issue-create-form"
        data-testid="issue-create-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          setDispatchError(undefined);
          void creator(issueActions.open(formValue(form, "title"), formValue(form, "body"))).catch(
            (error: unknown) => setDispatchError(issueError(error)),
          );
        }}
      >
        <h3>File an issue</h3>
        <label>
          ID
          <input
            name="issueId"
            required
            pattern="[A-Za-z0-9._~-]+"
            value={draftIssueId}
            onChange={(event) => setDraftIssueId(event.currentTarget.value)}
            data-testid="issue-create-id"
          />
        </label>
        <label>
          Title
          <input name="title" required data-testid="issue-create-title" />
        </label>
        <label className="issue-wide-field">
          Body
          <textarea name="body" required data-testid="issue-create-body" />
        </label>
        <button
          type="submit"
          disabled={inFlight || !validIssueId(draftIssueId)}
          data-testid="issue-create-submit"
        >
          File issue
        </button>
        <span className="dispatch-summary" data-testid="issue-create-dispatch-summary">
          sent {creator.counters.sent} · confirmed {creator.counters.confirmed} · refused{" "}
          {creator.counters.refused}
        </span>
      </form>

      {dispatchError === undefined ? null : (
        <p
          className="dispatch-error"
          role="alert"
          data-testid="issue-board-dispatch-error"
          data-code={dispatchError.code}
        >
          <strong>{dispatchError.code}</strong>: {dispatchError.message}
        </p>
      )}

      <label className="issue-filter">
        Filter by label
        <select
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
          data-testid="issue-label-filter"
        >
          <option value="">All labels</option>
          {Object.entries(binding.projection.state.labels).map(([labelId, label]) => (
            <option key={labelId} value={labelId}>
              {label.name}
            </option>
          ))}
        </select>
      </label>

      {binding.projection.status === "loading" ? (
        <p data-testid="issue-board-loading">Loading issue board…</p>
      ) : null}
      {binding.projection.status.startsWith("error:") ? (
        <p className="projection-refusal" role="alert" data-testid="issue-board-refusal">
          Board projection refused: {binding.projection.status.slice("error:".length)}
        </p>
      ) : null}

      <div className="issue-columns" data-testid="issue-columns">
        {issueStates.map((state) => {
          const column = board.columns[state];
          return (
            <section className="issue-column" key={state} data-testid={`issue-column-${state}`}>
              <div className="issue-column-heading">
                <h3>{state}</h3>
                <span data-testid={`issue-count-${state}`}>{column.count}</span>
              </div>
              <ul>
                {column.issues.map((issueId) => (
                  <li
                    key={issueId}
                    data-testid="issue-card"
                    data-issue-id={issueId}
                    data-issue-state={state}
                  >
                    <RouteLink href={`${encodedBase}/issues/${encodeURIComponent(issueId)}`}>
                      {issueId}
                    </RouteLink>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </section>
  );
}
