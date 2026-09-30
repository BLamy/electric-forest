/* Provenance: registry/blocks/github-clone/issues-tab.tsx — @brett_lamy/ui 2.0.0 registry block
   "github-clone" (https://blamy.github.io/ui/r/github-clone.json), installed as owned source.
   Every divergence from the upstream file carries an `ef:` marker. */
/* Issues tab: search, label filter, Open/Closed and the issue rows. */
// ef: the list is the live issue-board projection (repo-issue-board stream, issue-board@1 reducer); its
// five workflow columns render as bordered Boxes, and filing an issue dispatches `issue.opened`.
import { useState } from "react";
import { repoLabelsPath, repoSectionPath } from "../../navigation.js";
import {
  issueActions,
  issueBoardForLabel,
  issueError,
  issueStates,
  useIssueBoard,
  useIssueCreator,
  type IssueStateName,
  type RenderedIssueError,
} from "../../issues/useIssues.js";
import {
  Box,
  Counter,
  Oct,
  ghButton,
  ghField,
  ghTextarea,
  type ChipLabel,
  type Layout,
  type StateKind,
} from "./parts.js";
import { ItemRow, ListToolbar } from "./lists.js";

// ef:begin helpers for the issue.opened dispatch form
function formValue(form: FormData, name: string): string {
  return String(form.get(name) ?? "");
}
// ef:end

function validIssueId(value: string): boolean {
  return /^[A-Za-z0-9._~-]+$/.test(value);
}

const STATE_TITLE: Record<IssueStateName, string> = {
  open: "Open",
  "in-progress": "In progress",
  done: "Done",
  closed: "Closed",
  "wont-do": "Won't do",
};

const STATE_KIND: Record<IssueStateName, StateKind> = {
  open: "open",
  "in-progress": "open",
  done: "closed",
  closed: "closed",
  "wont-do": "closed",
};

// ef:begin live issue-board projection rendered as five workflow Boxes
export function IssueList({ ui, org, repo }: { ui: Layout; org: string; repo: string }) {
  const binding = useIssueBoard(org, repo);
  const [q, setQ] = useState("");
  const [labelFilter, setLabelFilter] = useState("");
  const board = issueBoardForLabel(binding.projection.state, labelFilter);
  const labels = binding.projection.state.labels;
  const labelsOf = (issueId: string): ChipLabel[] =>
    Object.values(labels).filter((label) => label.issues.includes(issueId));
  const status = binding.projection.status;
  const issuesBase = repoSectionPath(org, repo, "issues");
  return (
    <section
      data-testid="issue-board"
      data-ef-stream={binding.streamId}
      data-ef-offset={binding.projection.checkpoint}
      data-ef-digest={binding.projection.digest}
      data-ef-reducer={binding.reducerId}
      data-application-checkpoint={binding.projection.checkpoint}
      data-state-digest={binding.projection.digest}
      data-stream-status={status}
      className={ui.phone ? "px-4 py-4" : undefined}
    >
      <h2 data-testid="route-issues" className="sr-only">
        {org} / {repo} / issues
      </h2>
      <dl className="sr-only">
        <dt>Derived stream</dt>
        <dd data-testid="issue-board-stream">{binding.streamId}</dd>
        <dt>Reducer</dt>
        <dd data-testid="issue-board-reducer">{binding.reducerId}</dd>
        <dt>Replayed offset</dt>
        <dd data-testid="issue-board-offset">{binding.projection.checkpoint}</dd>
        <dt>Digest</dt>
        <dd data-testid="issue-board-digest">{binding.projection.digest}</dd>
        <dt>Status</dt>
        <dd data-testid="issue-board-status">{status}</dd>
      </dl>
      <ListToolbar
        ui={ui}
        q={q}
        setQ={setQ}
        placeholder="is:issue"
        searchLabel="Find issue"
        newLabel="New issue"
        // ef: New issue moves focus to the always-present dispatch form below the board.
        onNew={() => document.getElementById("issue-create-id")?.focus()}
        labelsHref={repoLabelsPath(org, repo)}
        labelCount={Object.keys(labels).length}
      />
      {/* ef: a native select over the live label catalog filters the board (LabelFilter credenza not installed). */}
      <label className="mb-3 flex items-center gap-2 text-[14px] text-muted-foreground">
        <Oct name="tag" />
        Filter by label
        <select
          value={labelFilter}
          onChange={(event) => setLabelFilter(event.currentTarget.value)}
          data-testid="issue-label-filter"
          className={ghField}
        >
          <option value="">All labels</option>
          {Object.entries(labels).map(([labelId, label]) => (
            <option key={labelId} value={labelId}>
              {label.name}
            </option>
          ))}
        </select>
      </label>
      {status === "loading" ? (
        <p data-testid="issue-board-loading" className="text-muted-foreground" role="status">
          Loading issue board…
        </p>
      ) : null}
      {status.startsWith("error:") ? (
        <p className="text-destructive" role="alert" data-testid="issue-board-refusal">
          Board projection refused: {status.slice("error:".length)}
        </p>
      ) : null}
      <div className="grid gap-4" data-testid="issue-columns">
        {issueStates.map((state) => {
          const column = board.columns[state];
          const rows = column.issues.filter(
            (issueId) => !q || issueId.toLowerCase().includes(q.toLowerCase()),
          );
          return (
            <Box
              key={state}
              data-testid={`issue-column-${state}`}
              aria-label={`${STATE_TITLE[state]} issues`}
              header={
                <h3 className="m-0 flex items-center gap-2 text-[14px] font-semibold">
                  <Oct
                    name={STATE_KIND[state] === "open" ? "issue" : "issueClosed"}
                    className={
                      STATE_KIND[state] === "open" ? "text-(--gh-open)" : "text-(--gh-done)"
                    }
                  />
                  {STATE_TITLE[state]}
                  <Counter>
                    <span data-testid={`issue-count-${state}`}>{column.count}</span>
                  </Counter>
                </h3>
              }
            >
              <ul className="m-0 list-none p-0">
                {rows.map((issueId) => (
                  <ItemRow
                    key={issueId}
                    ui={ui}
                    state={STATE_KIND[state]}
                    title={issueId}
                    href={`${issuesBase}/${encodeURIComponent(issueId)}`}
                    labels={labelsOf(issueId)}
                    meta={<>{STATE_TITLE[state]} on the live board</>}
                    assignees={[]}
                    comments={0}
                    rowProps={{
                      "data-testid": "issue-card",
                      "data-issue-id": issueId,
                      "data-issue-state": state,
                    }}
                  />
                ))}
              </ul>
              {rows.length === 0 ? (
                <div className="px-4 py-6 text-center text-muted-foreground">
                  {column.count === 0 ? "No issues." : "No results matched your search."}
                </div>
              ) : null}
            </Box>
          );
        })}
      </div>
      <CreateIssueForm org={org} repo={repo} />
    </section>
  );
}
// ef:end

// ef: filing dispatches `issue.opened` to issue:<org>/<repo>/<id>; the board converges by replay.
function CreateIssueForm({ org, repo }: { org: string; repo: string }) {
  const [draftIssueId, setDraftIssueId] = useState("new-issue");
  const [dispatchError, setDispatchError] = useState<RenderedIssueError>();
  const creator = useIssueCreator(
    org,
    repo,
    validIssueId(draftIssueId) ? draftIssueId : "invalid-draft",
  );
  const inFlight = creator.counters.sent > creator.counters.confirmed + creator.counters.refused;
  const label = "grid gap-1 text-[13px] font-semibold";
  return (
    <form
      className="mt-6 grid gap-3 rounded-md border border-border p-4 md:grid-cols-2"
      data-testid="issue-create-form"
      aria-label="File an issue"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setDispatchError(undefined);
        void creator(issueActions.open(formValue(form, "title"), formValue(form, "body"))).catch(
          (error: unknown) => setDispatchError(issueError(error)),
        );
      }}
    >
      <h3 className="m-0 text-[16px] font-semibold md:col-span-2">File an issue</h3>
      <label className={label}>
        ID
        <input
          id="issue-create-id"
          name="issueId"
          required
          pattern="[A-Za-z0-9._~-]+"
          value={draftIssueId}
          onChange={(event) => setDraftIssueId(event.currentTarget.value)}
          data-testid="issue-create-id"
          className={ghField}
        />
      </label>
      <label className={label}>
        Title
        <input name="title" required data-testid="issue-create-title" className={ghField} />
      </label>
      <label className={`${label} md:col-span-2`}>
        Body
        <textarea name="body" required data-testid="issue-create-body" className={ghTextarea} />
      </label>
      <div className="flex flex-wrap items-center gap-3 md:col-span-2">
        <button
          type="submit"
          disabled={inFlight || !validIssueId(draftIssueId)}
          data-testid="issue-create-submit"
          className={ghButton(true)}
        >
          File issue
        </button>
        <span
          className="text-[12px] text-muted-foreground"
          data-testid="issue-create-dispatch-summary"
        >
          sent {creator.counters.sent} · confirmed {creator.counters.confirmed} · refused{" "}
          {creator.counters.refused}
        </span>
      </div>
      {dispatchError === undefined ? null : (
        <p
          className="m-0 text-destructive md:col-span-2"
          role="alert"
          data-testid="issue-board-dispatch-error"
          data-code={dispatchError.code}
        >
          <strong>{dispatchError.code}</strong>: {dispatchError.message}
        </p>
      )}
    </form>
  );
}
