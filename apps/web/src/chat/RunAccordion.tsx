import { useEffect, useMemo, useState } from "react";
import { useStreamReducer } from "@eforest/web-hooks";
import { AGENT_RUN_REDUCER, type AgentRunState } from "@eforest/reducers";
import { diffLines, formatDuration, parseRun, type RunStep } from "./runSteps.js";
import { cn } from "@brett_lamy/ui";
import { LIVE_FOLLOW } from "../live.js";

const HEADER =
  "inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent py-0.5 pr-1.5 pl-0.5 text-left text-inherit hover:bg-secondary hover:text-foreground";
const SHIMMER =
  "bg-[linear-gradient(90deg,#8f9391_0%,#e8eae9_50%,#8f9391_100%)] bg-[length:200%_100%] bg-clip-text text-transparent animate-[run-shimmer_1.6s_linear_infinite] motion-reduce:animate-none";
const DETAIL =
  "m-0 mb-1.5 ml-4 max-h-[280px] overflow-auto rounded-lg border border-border bg-[#0c0d0d] px-3 py-2 font-mono text-[12px] leading-normal text-muted-foreground [overflow-wrap:anywhere] whitespace-pre-wrap";

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
    ...LIVE_FOLLOW,
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
    <div
      className="mt-1.5 max-w-full min-w-0 text-[13px] text-muted-foreground"
      data-testid="run-accordion"
      data-status={view.status}
    >
      <button
        type="button"
        className={HEADER}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Chevron open={open} />
        <span className={cn("truncate", running && SHIMMER)}>{label}</span>
        {tools > 0 ? (
          <span className="text-[12px] text-tertiary-foreground">
            {tools} {tools === 1 ? "step" : "steps"}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="mt-1 mb-1.5 ml-2 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-0.5 border-l border-border pl-2.5 [&>*]:min-w-0">
          {view.steps.length === 0 ? (
            <p className="my-1">{running ? "Starting…" : "No steps recorded."}</p>
          ) : (
            view.steps.map((step) => <Step key={step.key} step={step} />)
          )}
          {view.error !== null ? <p className="my-1 text-destructive">{view.error}</p> : null}
          <p className="mt-1.5 mb-0 flex flex-wrap gap-2 text-[11px] text-tertiary-foreground">
            {[
              view.model,
              view.costUsd === null ? null : `$${view.costUsd.toFixed(3)}`,
              `${String(projection.records.length)} events`,
            ]
              .filter(Boolean)
              .join(" · ")}
            <code className="text-[11px] break-all">{props.runStreamId}</code>
          </p>
        </div>
      ) : null}
    </div>
  );
}

function Chevron(props: { readonly open: boolean }): React.JSX.Element {
  return (
    <svg
      className={cn(
        "shrink-0 transition-transform duration-150 motion-reduce:transition-none",
        props.open && "rotate-90",
      )}
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
    return (
      <p className="mx-1 my-1 text-foreground [overflow-wrap:anywhere] whitespace-pre-wrap">
        {step.text}
      </p>
    );
  }
  const title =
    step.kind === "tool" ? step.title : step.kind === "thinking" ? "Thought" : `${step.channel}`;
  const pending = step.kind === "tool" && step.result === null;
  return (
    <div
      className="grid min-w-0 gap-1"
      data-step-kind={step.kind}
      data-error={step.kind === "tool" && step.isError ? "true" : undefined}
    >
      <button
        type="button"
        className={HEADER}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Chevron open={open} />
        <span
          className={cn(
            "truncate",
            pending && SHIMMER,
            step.kind === "tool" && step.isError && "text-destructive",
          )}
        >
          {title}
        </span>
        {step.kind === "tool" && step.isError ? (
          <span className="rounded bg-(--ef-destructive-wash-12) px-1 text-[11px] text-destructive">
            failed
          </span>
        ) : null}
      </button>
      {open ? <StepDetail step={step} /> : null}
    </div>
  );
}

function StepDetail(props: { readonly step: RunStep }): React.JSX.Element | null {
  const { step } = props;
  if (step.kind === "thinking" || step.kind === "raw") {
    return <pre className={DETAIL}>{step.text}</pre>;
  }
  if (step.kind !== "tool") return null;
  return (
    <div className="grid gap-1.5 [&>*]:min-w-0">
      {step.diff !== null ? (
        <pre className={DETAIL}>
          {diffLines(step.diff.before, step.diff.after).map((line, index) => (
            <span
              key={String(index)}
              className={
                line.kind === "del"
                  ? "text-destructive"
                  : line.kind === "add"
                    ? "text-success"
                    : "text-tertiary-foreground"
              }
            >
              {line.kind === "del" ? "- " : line.kind === "add" ? "+ " : "  "}
              {line.text}
              {"\n"}
            </span>
          ))}
        </pre>
      ) : (
        <pre className={DETAIL}>{step.input}</pre>
      )}
      {step.result !== null && step.result !== "" ? (
        <pre className={cn(DETAIL, "text-muted-foreground")}>{step.result}</pre>
      ) : null}
    </div>
  );
}
