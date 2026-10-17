import { randomBytes } from "node:crypto";
import {
  AGENT_RUN_BATCH_MAX_LINES,
  AGENT_RUN_LINE_MAX_CODE_UNITS,
  agentRunStreamId,
  type AgentRunChannel,
  type AgentRunCodebase,
} from "@eforest/reducers";

/**
 * Records an agent run, verbatim, on its own `agent-run:<org>/<runId>` stream through
 * the dispatch door: `agent.run.started`, every raw output line in order (batched, never
 * dropped; over-long lines are split, not truncated), then `agent.run.finished`.
 */

export interface RunLogPort {
  dispatchAsAgent(
    org: string,
    handle: string,
    streamId: string,
    event: { readonly type: string; readonly payload: unknown; readonly ts: number },
  ): Promise<Response>;
}

export interface RunStart {
  readonly harness: string;
  readonly model: string;
  readonly trigger: { readonly streamId: string; readonly messageId: string };
  readonly codebase?: AgentRunCodebase;
}

export interface RunFinish {
  readonly status: "succeeded" | "failed";
  readonly exitCode?: number | null;
  readonly summary?: string;
  readonly error?: string;
  readonly pullRequest?: string;
}

const FLUSH_MS = 250;

function chunks(line: string): string[] {
  if (line.length <= AGENT_RUN_LINE_MAX_CODE_UNITS) return [line];
  const parts: string[] = [];
  for (let at = 0; at < line.length; at += AGENT_RUN_LINE_MAX_CODE_UNITS) {
    parts.push(line.slice(at, at + AGENT_RUN_LINE_MAX_CODE_UNITS));
  }
  return parts;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export class AgentRunLog {
  readonly runId: string;
  readonly streamId: string;
  private seq = 0;
  private pending: { channel: AgentRunChannel; lines: string[] } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private partial: Record<AgentRunChannel, string> = { stdout: "", stderr: "" };

  constructor(
    private readonly port: RunLogPort,
    private readonly org: string,
    private readonly handle: string,
    private readonly now: () => number = Date.now,
    private readonly log: (line: string) => void = () => {},
  ) {
    this.runId = `${handle}-${now().toString(36)}-${randomBytes(4).toString("hex")}`;
    this.streamId = agentRunStreamId(org, this.runId);
  }

  private send(type: string, payload: Record<string, unknown>): Promise<void> {
    this.chain = this.chain.then(async () => {
      const response = await this.port.dispatchAsAgent(this.org, this.handle, this.streamId, {
        type,
        payload: { v: 1, ...payload },
        ts: this.now(),
      });
      if (!response.ok) {
        this.log(
          `agent-run ${this.streamId}: ${type} refused ${String(response.status)} ${await response.text()}`,
        );
      }
    });
    return this.chain;
  }

  start(meta: RunStart): Promise<void> {
    return this.send("agent.run.started", {
      handle: this.handle,
      harness: meta.harness,
      model: meta.model,
      trigger: meta.trigger,
      ...(meta.codebase === undefined ? {} : { codebase: meta.codebase }),
    });
  }

  /** Feed raw process output; complete lines are recorded, a trailing partial waits. */
  write(channel: AgentRunChannel, text: string): void {
    const buffered = this.partial[channel] + text;
    const lines = buffered.split("\n");
    this.partial[channel] = lines.pop() ?? "";
    for (const line of lines) this.line(channel, line);
  }

  line(channel: AgentRunChannel, line: string): void {
    for (const part of chunks(line)) {
      if (this.pending !== undefined && this.pending.channel !== channel) this.flush();
      this.pending ??= { channel, lines: [] };
      this.pending.lines.push(part);
      if (this.pending.lines.length >= AGENT_RUN_BATCH_MAX_LINES) this.flush();
    }
    if (this.pending !== undefined && this.timer === undefined) {
      this.timer = setTimeout(() => this.flush(), FLUSH_MS);
    }
  }

  flush(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.pending;
    this.pending = undefined;
    if (batch === undefined || batch.lines.length === 0) return this.chain;
    const seq = this.seq;
    this.seq += batch.lines.length;
    return this.send("agent.run.output", { seq, channel: batch.channel, lines: batch.lines });
  }

  async finish(result: RunFinish): Promise<void> {
    for (const channel of ["stdout", "stderr"] as const) {
      if (this.partial[channel].length > 0) this.line(channel, this.partial[channel]);
      this.partial[channel] = "";
    }
    await this.flush();
    await this.send("agent.run.finished", {
      status: result.status,
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(result.summary ? { summary: clip(result.summary, 64 * 1024) } : {}),
      ...(result.error ? { error: clip(result.error, 8 * 1024) } : {}),
      ...(result.pullRequest ? { pullRequest: result.pullRequest } : {}),
    });
  }
}
