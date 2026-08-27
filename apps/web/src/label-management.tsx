import { useState } from "react";
import { DispatchRefusalError, useDispatch, useStreamReducer } from "@eforest/web-hooks";
import { repoLabelsStreamId, type LabelState, type RepoLabel } from "@eforest/reducers";
import type { Event } from "@eforest/protocol";
import { RouteLink } from "./navigation.js";

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

export function LabelManagement(props: {
  readonly org: string;
  readonly repo: string;
}): React.JSX.Element {
  const streamId = repoLabelsStreamId(props.org, props.repo);
  const apiPath = `/api/repos/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}/main/events?stream=repo-labels`;
  const projection = useStreamReducer<LabelState>({
    apiPath,
    streamId,
    reducerId: "repo-labels",
    followWaitMs: 500,
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

  return (
    <section
      className="label-management"
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
      <div className="label-heading">
        <div>
          <p className="eyebrow">Replay-backed catalog</p>
          <h2 data-testid="route-labels">
            {props.org} / {props.repo} / labels
          </h2>
        </div>
        <RouteLink href={`/${encodeURIComponent(props.org)}/${encodeURIComponent(props.repo)}`}>
          Repository
        </RouteLink>
      </div>

      <dl className="label-facts">
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

      <dl className="dispatch-counters" aria-label="Dispatch lifecycle">
        <dt>Sent</dt>
        <dd data-testid="dispatches-sent">{dispatch.counters.sent}</dd>
        <dt>Confirmed</dt>
        <dd data-testid="dispatches-confirmed">{dispatch.counters.confirmed}</dd>
        <dt>Reconciled</dt>
        <dd data-testid="dispatches-reconciled">{dispatch.counters.reconciled}</dd>
        <dt>Refused</dt>
        <dd data-testid="dispatches-refused">{dispatch.counters.refused}</dd>
      </dl>

      {dispatchError === undefined ? null : (
        <p
          className="dispatch-error"
          role="alert"
          data-testid="dispatch-error"
          data-code={dispatchError.code}
        >
          <strong>{dispatchError.code}</strong>: {dispatchError.message}
        </p>
      )}

      <form
        className="label-create-form"
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
        <h3>Create label</h3>
        <label>
          ID
          <input name="labelId" required data-testid="label-create-id" />
        </label>
        <label>
          Name
          <input name="name" required data-testid="label-create-name" />
        </label>
        <label>
          Color
          <input name="color" required defaultValue="#0969da" data-testid="label-create-color" />
        </label>
        <button type="submit" disabled={inFlight} data-testid="label-create-submit">
          Create label
        </button>
      </form>

      {projection.status === "loading" ? (
        <p data-testid="labels-loading">Loading labels…</p>
      ) : rows.length === 0 ? (
        <p data-testid="labels-empty">No labels yet.</p>
      ) : (
        <ul className="label-list" data-testid="label-list">
          {rows.map((label) => (
            <li key={label.labelId} data-testid="label-row" data-label-id={label.labelId}>
              <div className="label-identity">
                <span
                  className="label-swatch"
                  aria-label={`Color ${label.color}`}
                  style={{ backgroundColor: label.color }}
                />
                <strong data-testid="label-name">{label.name}</strong>
                <code data-testid="label-id">{label.labelId}</code>
              </div>
              <form
                data-testid="label-rename-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  void submit({
                    type: "label.renamed",
                    payload: {
                      v: 1,
                      labelId: label.labelId,
                      name: formValue(form, "name"),
                    },
                    ts: Date.now(),
                  });
                }}
              >
                <label>
                  Rename
                  <input
                    key={`${label.labelId}:${label.name}`}
                    name="name"
                    required
                    defaultValue={label.name}
                    data-testid="label-rename-name"
                  />
                </label>
                <button type="submit" disabled={inFlight}>
                  Rename
                </button>
              </form>
              <form
                data-testid="label-recolor-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  void submit({
                    type: "label.recolored",
                    payload: {
                      v: 1,
                      labelId: label.labelId,
                      color: formValue(form, "color"),
                    },
                    ts: Date.now(),
                  });
                }}
              >
                <label>
                  Recolor
                  <input
                    key={`${label.labelId}:${label.color}`}
                    name="color"
                    required
                    defaultValue={label.color}
                    data-testid="label-recolor-color"
                  />
                </label>
                <button type="submit" disabled={inFlight}>
                  Recolor
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
