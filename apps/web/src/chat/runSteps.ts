/**
 * Turns an agent run log (`agent-run:` stream records) into the steps a person reads:
 * thoughts, messages, and tool calls with their inputs and results — the Codex-style
 * "Worked for 12s" accordion. Understands Claude Code `stream-json` and Codex
 * `exec --json`; anything else is kept as a raw line, never dropped.
 */

export type RunStep =
  | { readonly kind: "message"; readonly key: string; readonly text: string }
  | { readonly kind: "thinking"; readonly key: string; readonly text: string }
  | {
      readonly kind: "tool";
      readonly key: string;
      readonly name: string;
      readonly title: string;
      readonly input: string;
      readonly diff: { readonly before: string; readonly after: string } | null;
      readonly result: string | null;
      readonly isError: boolean;
    }
  | { readonly kind: "raw"; readonly key: string; readonly channel: string; readonly text: string };

export interface RunView {
  readonly status: "running" | "succeeded" | "failed" | "unknown";
  readonly steps: readonly RunStep[];
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  /** Harness-reported wall time when available, else finished − started. */
  readonly durationMs: number | null;
  readonly model: string | null;
  readonly costUsd: number | null;
  readonly error: string | null;
}

interface RunRecord {
  readonly type: string;
  readonly payload: unknown;
  readonly ts?: number;
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        const block = asObject(part);
        return typeof block?.text === "string" ? block.text : JSON.stringify(part);
      })
      .join("\n");
  }
  return value === undefined || value === null ? "" : JSON.stringify(value, null, 2);
}

/** Checkout-relative path; outside the checkout, just the last two segments. */
export function relative(path: unknown, cwd: string | null): string {
  if (typeof path !== "string") return "";
  if (cwd !== null && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

/** Tool output with the checkout's absolute prefix removed. */
function withinCheckout(value: string, cwd: string | null): string {
  return cwd === null ? value : value.split(`${cwd}/`).join("").split(cwd).join(".");
}

export type DiffLine = { readonly kind: "context" | "del" | "add" | "gap"; readonly text: string };

/**
 * A compact line diff for an edit: common leading/trailing lines collapse to two lines
 * of context, so a whole-file rewrite still shows only what changed.
 */
export function diffLines(before: string, after: string, context = 2): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const lines: DiffLine[] = [];
  // Collapse unchanged runs only when that hides at least two lines.
  const from = start - context > 1 ? start - context : 0;
  const to = a.length - (endA + context) > 1 ? endA + context : a.length;
  if (from > 0) lines.push({ kind: "gap", text: "…" });
  for (const text of a.slice(from, start)) lines.push({ kind: "context", text });
  for (const text of a.slice(start, endA)) lines.push({ kind: "del", text });
  for (const text of b.slice(start, endB)) lines.push({ kind: "add", text });
  for (const text of a.slice(endA, to)) lines.push({ kind: "context", text });
  if (to < a.length) lines.push({ kind: "gap", text: "…" });
  return lines;
}

function oneLine(value: string, max = 80): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Title for a Claude Code tool call, e.g. "Read README.md", "Edited src/app.ts". */
export function claudeToolTitle(name: string, input: Json, cwd: string | null): string {
  switch (name) {
    case "Read":
      return `Read ${relative(input.file_path, cwd)}`;
    case "Edit":
    case "MultiEdit":
      return `Edited ${relative(input.file_path, cwd)}`;
    case "Write":
      return `Wrote ${relative(input.file_path, cwd)}`;
    case "Glob":
      return `Searched files ${oneLine(String(input.pattern ?? ""))}`;
    case "Grep":
      return `Searched for ${oneLine(String(input.pattern ?? ""))}`;
    case "Bash":
      return `Ran ${oneLine(String(input.command ?? ""))}`;
    case "WebSearch":
      return `Searched the web for ${oneLine(String(input.query ?? ""))}`;
    case "WebFetch":
      return `Fetched ${oneLine(String(input.url ?? ""))}`;
    default:
      return name;
  }
}

export function parseRun(records: readonly RunRecord[]): RunView {
  const steps: RunStep[] = [];
  const tools = new Map<string, number>();
  let cwd: string | null = null;
  let status: RunView["status"] = "unknown";
  let startedAt: number | null = null;
  let finishedAt: number | null = null;
  let durationMs: number | null = null;
  let model: string | null = null;
  let costUsd: number | null = null;
  let error: string | null = null;
  let counter = 0;
  const key = (): string => `s${String(counter++)}`;

  const setTool = (id: string, step: Extract<RunStep, { kind: "tool" }>): void => {
    const at = tools.get(id);
    if (at === undefined) {
      tools.set(id, steps.length);
      steps.push(step);
    } else {
      steps[at] = { ...step, key: steps[at]!.key };
    }
  };
  const completeTool = (id: string, result: string, isError: boolean): void => {
    const at = tools.get(id);
    const step = at === undefined ? undefined : steps[at];
    if (step?.kind === "tool") steps[at!] = { ...step, result, isError };
  };

  const claude = (event: Json): boolean => {
    const type = event.type;
    if (type === "system") {
      if (event.subtype === "init") {
        if (typeof event.cwd === "string") cwd = event.cwd;
        if (typeof event.model === "string") model = event.model;
      }
      return true; // init, thinking_tokens, … are bookkeeping
    }
    if (type === "rate_limit_event") return true;
    if (type === "result") {
      if (typeof event.duration_ms === "number") durationMs = event.duration_ms;
      if (typeof event.total_cost_usd === "number") costUsd = event.total_cost_usd;
      if (event.is_error === true && typeof event.result === "string") error = event.result;
      return true;
    }
    const message = asObject(event.message);
    if ((type !== "assistant" && type !== "user") || message === undefined) return false;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const part of content) {
      const block = asObject(part);
      if (block === undefined) continue;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        steps.push({ kind: "message", key: key(), text: block.text });
      } else if (block.type === "thinking") {
        const thought = typeof block.thinking === "string" ? block.thinking.trim() : "";
        if (thought) steps.push({ kind: "thinking", key: key(), text: thought });
      } else if (block.type === "tool_use" && typeof block.id === "string") {
        const name = typeof block.name === "string" ? block.name : "tool";
        const input = asObject(block.input) ?? {};
        const edit =
          typeof input.old_string === "string" && typeof input.new_string === "string"
            ? { before: input.old_string, after: input.new_string }
            : name === "Write" && typeof input.content === "string"
              ? { before: "", after: input.content }
              : null;
        setTool(block.id, {
          kind: "tool",
          key: key(),
          name,
          title: claudeToolTitle(name, input, cwd),
          input: withinCheckout(JSON.stringify(input, null, 2), cwd),
          diff: edit,
          result: null,
          isError: false,
        });
      } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        completeTool(
          block.tool_use_id,
          withinCheckout(text(block.content), cwd),
          block.is_error === true,
        );
      }
    }
    return true;
  };

  const codex = (event: Json): boolean => {
    const type = event.type;
    if (typeof type !== "string") return false;
    if (type === "thread.started" || type.startsWith("turn.")) {
      if (type === "turn.failed") error = text(asObject(event.error)?.message ?? event.error);
      return true;
    }
    if (type === "error") {
      error = text(event.message);
      return true;
    }
    if (type !== "item.started" && type !== "item.updated" && type !== "item.completed") {
      return false;
    }
    const item = asObject(event.item);
    if (item === undefined) return false;
    const id = typeof item.id === "string" ? item.id : key();
    const done = type === "item.completed";
    switch (item.type) {
      case "agent_message":
        if (done && typeof item.text === "string")
          steps.push({ kind: "message", key: key(), text: item.text });
        return true;
      case "reasoning":
        if (done && typeof item.text === "string" && item.text.trim())
          steps.push({ kind: "thinking", key: key(), text: item.text });
        return true;
      case "command_execution": {
        const command = String(item.command ?? "");
        setTool(id, {
          kind: "tool",
          key: key(),
          name: "command",
          title: `Ran ${oneLine(command)}`,
          input: command,
          diff: null,
          result: done ? text(item.aggregated_output) : null,
          isError: done && typeof item.exit_code === "number" && item.exit_code !== 0,
        });
        return true;
      }
      case "file_change": {
        const changes = Array.isArray(item.changes) ? item.changes.map(asObject) : [];
        const paths = changes.map((change) => relative(change?.path, cwd)).filter(Boolean);
        setTool(id, {
          kind: "tool",
          key: key(),
          name: "file_change",
          title: `Edited ${paths.join(", ") || "files"}`,
          input: JSON.stringify(item.changes ?? [], null, 2),
          diff: null,
          result: done ? String(item.status ?? "") : null,
          isError: item.status === "failed",
        });
        return true;
      }
      default:
        setTool(id, {
          kind: "tool",
          key: key(),
          name: String(item.type ?? "item"),
          title: String(item.type ?? "item").replace(/_/g, " "),
          input: JSON.stringify(item, null, 2),
          diff: null,
          result: null,
          isError: false,
        });
        return true;
    }
  };

  for (const record of records) {
    const payload = asObject(record.payload) ?? {};
    if (record.type === "agent.run.started") {
      status = "running";
      startedAt = record.ts ?? null;
      if (typeof payload.model === "string" && payload.model !== "harness-default") {
        model = payload.model;
      }
      continue;
    }
    if (record.type === "agent.run.finished") {
      status = payload.status === "failed" ? "failed" : "succeeded";
      finishedAt = record.ts ?? null;
      if (typeof payload.error === "string") error = payload.error;
      continue;
    }
    if (record.type !== "agent.run.output") continue;
    const channel = typeof payload.channel === "string" ? payload.channel : "stdout";
    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    for (const line of lines) {
      if (typeof line !== "string" || line.trim() === "") continue;
      let event: Json | undefined;
      try {
        event = asObject(JSON.parse(line));
      } catch {
        event = undefined;
      }
      const handled = event !== undefined && (claude(event) || codex(event));
      if (!handled) steps.push({ kind: "raw", key: key(), channel, text: line });
    }
  }
  if (durationMs === null && startedAt !== null && finishedAt !== null) {
    durationMs = finishedAt - startedAt;
  }
  return { status, steps, startedAt, finishedAt, durationMs, model, costUsd, error };
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${String(minutes)}m` : `${String(minutes)}m ${String(rest)}s`;
}
