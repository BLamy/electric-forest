import { useEffect, useMemo, useState } from "react";
import { useStreamReducer } from "@eforest/web-hooks";
import { AGENT_RUN_REDUCER, type AgentRunState } from "@eforest/reducers";
import { diffLines, formatDuration, parseRun, type RunStep } from "./runSteps.js";
import "./run-accordion.css";

/**
 * The Codex-style "Worked for 12s" dropdown under an agent's message: the run's whole
 * log (`agent-run:<org>/<runId>`), replayed into steps — thoughts, messages, and tool
 * calls you can open for their input, diff, and result. A finished run is loaded once;
 * a running one follows its stream live.
 */
export function RunAccordion(props: {
  readonly org: string;
  readonly runStreamId: string;
}): React.JSX.Element | null {
  const runId = props.runStreamId.slice(props.runStreamId.indexOf("/") + 1);
  const [open, setOpen] = useState(false);
  const [live, setLive] = useState(false);
  const projection = useStreamReducer<AgentRunState>({
    apiPath: `/api/agent-runs/${encodeURIComponent(props.org)}/${encodeURIComponent(runId)}`,
    streamId: props.runStreamId,
    reducerId: AGENT_RUN_REDUCER,
    follow: live,
    followWaitMs: 10_000,
    reconnectDelayMs: 1_000,
  });
  const view = useMemo(() => parseRun(projection.records), [projection.records]);
  const running = view.status === "running";
  useEffect(() => setLive(running), [running]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running]);

  if (projection.status.startsWith("error:") || view.status === "unknown") return null;
  const elapsed =
    view.durationMs ?? (view.startedAt === null ? 0 : Math.max(0, now - view.startedAt));
  const label = running
    ? `Working for ${formatDuration(elapsed)}`
    : view.status === "failed"
      ? `Failed after ${formatDuration(elapsed)}`
      : `Worked for ${formatDuration(elapsed)}`;
  const tools = view.steps.filter((step) => step.kind === "tool").length;

  return (
    <div className="run-accordion" data-testid="run-accordion" data-status={view.status}>
      <button
        type="button"
        className="run-accordion-header"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Chevron open={open} />
        <span
          className={running ? "run-accordion-label run-accordion-shimmer" : "run-accordion-label"}
        >
          {label}
        </span>
        {tools > 0 ? (
          <span className="run-accordion-meta">
            {tools} {tools === 1 ? "step" : "steps"}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="run-accordion-body">
          {view.steps.length === 0 ? (
            <p className="run-step-empty">{running ? "Starting…" : "No steps recorded."}</p>
          ) : (
            view.steps.map((step) => <Step key={step.key} step={step} />)
          )}
          {view.error !== null ? <p className="run-step-error">{view.error}</p> : null}
          <p className="run-accordion-footer">
            {[
              view.model,
              view.costUsd === null ? null : `$${view.costUsd.toFixed(3)}`,
              `${String(projection.records.length)} events`,
            ]
              .filter(Boolean)
              .join(" · ")}
            <code>{props.runStreamId}</code>
          </p>
        </div>
      ) : null}
    </div>
  );
}

function Chevron(props: { readonly open: boolean }): React.JSX.Element {
  return (
    <svg
      className={props.open ? "run-chevron run-chevron-open" : "run-chevron"}
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function Step(props: { readonly step: RunStep }): React.JSX.Element {
  const { step } = props;
  const [open, setOpen] = useState(false);
  if (step.kind === "message") {
    return <p className="run-step-message">{step.text}</p>;
  }
  const title =
    step.kind === "tool" ? step.title : step.kind === "thinking" ? "Thought" : `${step.channel}`;
  const pending = step.kind === "tool" && step.result === null;
  return (
    <div
      className={`run-step run-step-${step.kind}`}
      data-error={step.kind === "tool" && step.isError ? "true" : undefined}
    >
      <button
        type="button"
        className="run-step-header"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Chevron open={open} />
        <span className={pending ? "run-step-title run-accordion-shimmer" : "run-step-title"}>
          {title}
        </span>
        {step.kind === "tool" && step.isError ? (
          <span className="run-step-flag">failed</span>
        ) : null}
      </button>
      {open ? <StepDetail step={step} /> : null}
    </div>
  );
}

function StepDetail(props: { readonly step: RunStep }): React.JSX.Element | null {
  const { step } = props;
  if (step.kind === "thinking" || step.kind === "raw") {
    return <pre className="run-step-detail">{step.text}</pre>;
  }
  if (step.kind !== "tool") return null;
  return (
    <div className="run-step-detail-group">
      {step.diff !== null ? (
        <pre className="run-step-detail run-step-diff">
          {diffLines(step.diff.before, step.diff.after).map((line, index) => (
            <span key={String(index)} className={`run-diff-${line.kind}`}>
              {line.kind === "del" ? "- " : line.kind === "add" ? "+ " : "  "}
              {line.text}
              {"\n"}
            </span>
          ))}
        </pre>
      ) : (
        <pre className="run-step-detail">{step.input}</pre>
      )}
      {step.result !== null && step.result !== "" ? (
        <pre className="run-step-detail run-step-result">{step.result}</pre>
      ) : null}
    </div>
  );
}
