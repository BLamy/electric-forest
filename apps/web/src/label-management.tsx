import { useState } from "react";
import { DispatchRefusalError, useDispatch, useStreamReducer } from "@eforest/web-hooks";
import { repoLabelsStreamId, type LabelState, type RepoLabel } from "@eforest/reducers";
import type { Event } from "@eforest/protocol";
import { cn } from "@brett_lamy/ui";
import { RouteLink, repoSectionPath } from "./navigation.js";
import {
  Box,
  Counter,
  LabelChip,
  Oct,
  ghButton,
  ghField,
  type Layout,
} from "./blocks/github/parts.js";
import { LIVE_FOLLOW } from "./live.js";

interface RenderedDispatchError {
  readonly code: string;
  readonly message: string;
}

function labelRows(labels: LabelState["labels"]): readonly (RepoLabel & { labelId: string })[] {
  return Object.entries(labels)
    .map(([labelId, label]) => ({ labelId, ...label }))
    .sort((left, right) => left.labelId.localeCompare(right.labelId));
}

function formValue(form: FormData, name: string): string {
  return String(form.get(name) ?? "");
}

/** The repository label catalog (`repo-labels:<org>/<repo>`); every edit is a dispatch. */
export function LabelManagement(props: {
  readonly ui: Layout;
  readonly org: string;
  readonly repo: string;
}): React.JSX.Element {
  const streamId = repoLabelsStreamId(props.org, props.repo);
  const apiPath = `/api/repos/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}/main/events?stream=repo-labels`;
  const projection = useStreamReducer<LabelState>({
    apiPath,
    streamId,
    reducerId: "repo-labels",
    ...LIVE_FOLLOW,
    reconnectDelayMs: 100,
  });
  const dispatch = useDispatch(streamId, { replayedOffset: projection.checkpoint });
  const [dispatchError, setDispatchError] = useState<RenderedDispatchError>();
  const rows = labelRows(projection.state.labels);

  const submit = async (action: Event): Promise<void> => {
    setDispatchError(undefined);
    try {
      await dispatch(action);
    } catch (error) {
      setDispatchError(
        error instanceof DispatchRefusalError
          ? { code: error.code, message: error.message }
          : {
              code: "dispatch-failed",
              message: error instanceof Error ? error.message : String(error),
            },
      );
    }
  };

  const inFlight = dispatch.counters.sent > dispatch.counters.confirmed + dispatch.counters.refused;

  const label = "grid gap-1 text-[13px] font-semibold";
  return (
    <section
      className={cn("grid gap-4", props.ui.phone && "px-4 py-4")}
      data-testid="label-management"
      data-ef-stream={streamId}
      data-ef-offset={projection.checkpoint}
      data-ef-digest={projection.digest}
      data-ef-reducer="repo-labels"
      data-ef-confirmed-offset={dispatch.confirmedOffset}
      data-application-checkpoint={projection.checkpoint}
      data-state-digest={projection.digest}
      data-stream-status={projection.status}
      data-dispatches-sent={dispatch.counters.sent}
      data-dispatches-confirmed={dispatch.counters.confirmed}
      data-dispatches-reconciled={dispatch.counters.reconciled}
      data-dispatches-refused={dispatch.counters.refused}
      aria-busy={inFlight}
    >
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 mr-auto text-[20px] font-semibold" data-testid="route-labels">
          <span className="sr-only">
            {props.org} / {props.repo} /{" "}
          </span>
          Labels
        </h1>
        <RouteLink
          href={repoSectionPath(props.org, props.repo, "issues")}
          className={cn(ghButton(), "text-foreground hover:no-underline")}
        >
          <Oct name="issue" className="text-muted-foreground" />
          Issues
        </RouteLink>
      </div>

      <dl className="sr-only">
        <dt>Reducer</dt>
        <dd data-testid="labels-reducer">repo-labels</dd>
        <dt>Replayed offset</dt>
        <dd data-testid="labels-offset">{projection.checkpoint}</dd>
        <dt>Confirmed offset</dt>
        <dd data-testid="labels-confirmed-offset">{dispatch.confirmedOffset}</dd>
        <dt>Digest</dt>
        <dd data-testid="labels-digest">{projection.digest}</dd>
        <dt>Status</dt>
        <dd data-testid="labels-status">{projection.status}</dd>
      </dl>

      <dl
        className="m-0 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground"
        aria-label="Dispatch lifecycle"
      >
        <div className="flex gap-1">
          <dt>Sent</dt>
          <dd data-testid="dispatches-sent" className="m-0 text-foreground">
            {dispatch.counters.sent}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>Confirmed</dt>
          <dd data-testid="dispatches-confirmed" className="m-0 text-foreground">
            {dispatch.counters.confirmed}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>Reconciled</dt>
          <dd data-testid="dispatches-reconciled" className="m-0 text-foreground">
            {dispatch.counters.reconciled}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>Refused</dt>
          <dd data-testid="dispatches-refused" className="m-0 text-foreground">
            {dispatch.counters.refused}
          </dd>
        </div>
      </dl>

      {dispatchError === undefined ? null : (
        <p
          className="m-0 text-destructive"
          role="alert"
          data-testid="dispatch-error"
          data-code={dispatchError.code}
        >
          <strong>{dispatchError.code}</strong>: {dispatchError.message}
        </p>
      )}

      <form
        className="grid gap-3 rounded-md border border-border p-4 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end"
        data-testid="label-create-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          void submit({
            type: "label.created",
            payload: {
              v: 1,
              labelId: formValue(form, "labelId"),
              name: formValue(form, "name"),
              color: formValue(form, "color"),
            },
            ts: Date.now(),
          });
        }}
      >
        <h2 className="m-0 text-[14px] font-semibold sm:col-span-4">Create label</h2>
        <label className={label}>
          ID
          <input name="labelId" required data-testid="label-create-id" className={ghField} />
        </label>
        <label className={label}>
          Name
          <input name="name" required data-testid="label-create-name" className={ghField} />
        </label>
        <label className={label}>
          Color
          <input
            name="color"
            required
            defaultValue="#0969da"
            data-testid="label-create-color"
            className={ghField}
          />
        </label>
        <button
          type="submit"
          disabled={inFlight}
          data-testid="label-create-submit"
          className={ghButton(true)}
        >
          Create label
        </button>
      </form>

      {projection.status === "loading" ? (
        <p data-testid="labels-loading" role="status" className="m-0 text-muted-foreground">
          Loading labels…
        </p>
      ) : rows.length === 0 ? (
        <Box className="px-4 py-8 text-center">
          <p data-testid="labels-empty" className="m-0 text-muted-foreground">
            No labels yet.
          </p>
        </Box>
      ) : (
        <Box
          header={
            <>
              <b className="font-semibold">Labels</b>
              <Counter>{rows.length}</Counter>
            </>
          }
        >
          <ul className="m-0 list-none p-0" data-testid="label-list">
            {rows.map((row) => (
              <li
                key={row.labelId}
                data-testid="label-row"
                data-label-id={row.labelId}
                className="grid gap-2 border-t border-border px-4 py-3 first:border-t-0 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span
                    className="size-3.5 shrink-0 rounded-full"
                    role="img"
                    aria-label={`Color ${row.color}`}
                    style={{ backgroundColor: row.color }}
                  />
                  <strong data-testid="label-name" className="font-normal">
                    <LabelChip label={row} />
                  </strong>
                  <code data-testid="label-id" className="text-[12px] text-muted-foreground">
                    {row.labelId}
                  </code>
                </div>
                <form
                  data-testid="label-rename-form"
                  className="flex items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    void submit({
                      type: "label.renamed",
                      payload: { v: 1, labelId: row.labelId, name: formValue(form, "name") },
                      ts: Date.now(),
                    });
                  }}
                >
                  <label className={label}>
                    Rename
                    <input
                      key={`${row.labelId}:${row.name}`}
                      name="name"
                      required
                      defaultValue={row.name}
                      data-testid="label-rename-name"
                      className={ghField}
                    />
                  </label>
                  <button type="submit" disabled={inFlight} className={ghButton()}>
                    Rename
                  </button>
                </form>
                <form
                  data-testid="label-recolor-form"
                  className="flex items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    void submit({
                      type: "label.recolored",
                      payload: { v: 1, labelId: row.labelId, color: formValue(form, "color") },
                      ts: Date.now(),
                    });
                  }}
                >
                  <label className={label}>
                    Recolor
                    <input
                      key={`${row.labelId}:${row.color}`}
                      name="color"
                      required
                      defaultValue={row.color}
                      data-testid="label-recolor-color"
                      className={ghField}
                    />
                  </label>
                  <button type="submit" disabled={inFlight} className={ghButton()}>
                    Recolor
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </Box>
      )}
    </section>
  );
}
