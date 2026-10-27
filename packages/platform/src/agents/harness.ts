import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentReplyGenerator, AgentReplyRequest } from "./responder.js";
import type { AgentRunLog } from "./run-log.js";
import {
  agentBranchName,
  referencedCodebases,
  withAgentWorkspace,
  type AgentWorkspace,
  type AgentWorkspaceOptions,
} from "./workspace.js";

/**
 * Agents run through their harness CLI, never the model API directly: `claude-code`
 * through `claude -p` (auth: the local Claude Code login, or `CLAUDE_CODE_OAUTH_TOKEN`
 * from `claude setup-token`) and `codex` through `codex exec` (auth: the local Codex
 * login). Roster placeholders (sol, terra, luna, custom) run on Claude Code.
 *
 * When the thread references a `$codebase`, the run gets a live workspace (see
 * workspace.ts): the repo checked out on an agent branch with file-editing tools, every
 * save synced to the branch as it happens. Otherwise the agent answers chat-only: no
 * tools, an empty scratch directory.
 */

const RUN_TIMEOUT_MS = 15 * 60_000;

export type HarnessRunner = "claude-code" | "codex";

export function harnessRunner(harness: string): HarnessRunner | undefined {
  if (harness === "codex") return "codex";
  if (harness === "gemini-cli" || harness === "opencode") return undefined;
  return "claude-code";
}

function speaker(actor: string): string {
  return actor.startsWith("agent:")
    ? `@${actor.slice("agent:".length)}`
    : actor.replace(/^auth0\|/, "");
}

const REFERENCE_LEGEND = [
  "How to read this chat: `@name` mentions a person or agent, `#name` is a channel, and",
  "`$name` (or `$org/name`) is a codebase — a repository in this workspace, never a",
  "person being addressed. A message that only mentions you (e.g. just `@you`) asks you",
  "to act on the earlier messages in the thread.",
].join(" ");

export function agentPrompt(
  request: AgentReplyRequest,
  workspace?: AgentWorkspace,
): { system: string; user: string } {
  const where = `You are @${request.agent.handle} (${request.agent.name}), a member of the "${request.org}" workspace in Electric Forest, a stream-backed GitHub-style product. You are replying in a thread in #${request.channel}; your final message is posted verbatim as the chat reply, rendered as Markdown.`;
  const task =
    workspace === undefined
      ? "Answer the latest message that mentions you directly and concisely. You have no access to the workspace's repositories in this reply (none was referenced with `$name`), so do not claim to have read or changed files; if the request needs a codebase, ask which one."
      : `Your working directory is a live checkout of the codebase $${workspace.codebase.repo} on branch \`${workspace.branch}\`. Do the requested work by reading and editing files there with your tools — every save syncs to that branch live, so people watching see your edits as you make them. Never touch the \`.ef/\` directory. Keep changes focused on the request. When done, reply with a short summary of what you changed (files and why); do not paste whole files.`;
  const system = [request.agent.systemPrompt, where, REFERENCE_LEGEND, task].join("\n\n");
  const transcript = request.thread
    .map((message) => `${speaker(message.actor)} (message ${message.id}):\n${message.body}`)
    .join("\n\n---\n\n");
  const user = `Thread so far:\n\n${transcript}\n\nRespond to the last message (${request.mention.id}), which mentions you.`;
  return { system, user };
}

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RestrictedClaudeOptions {
  readonly restrictedClaudeToken: string;
  readonly command?: string;
}

export function restrictedClaudeProcess(
  token: string,
  home: string,
): {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
} {
  if (token.length < 20 || token.length > 4_096 || /\s/.test(token))
    throw new Error("restricted Claude setup token is invalid");
  return {
    command: "/usr/local/bin/claude",
    args: [
      "--restricted",
      "--safe-mode",
      "--permission-prompts",
      "none",
      "--strict-mcp-config",
      "--disallowedTools",
      "mcp__*",
      "--max-turns",
      "24",
    ],
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: home,
      TMPDIR: home,
      XDG_CONFIG_HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CLAUDE_CODE_OAUTH_TOKEN: token,
      DISABLE_AUTOUPDATER: "1",
      NO_COLOR: "1",
    },
  };
}

/** Spawn a harness; every output chunk is teed into the run log as it arrives. */
function run(
  command: string,
  args: readonly string[],
  input: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  runLog: AgentRunLog | undefined,
  maxOutputBytes?: number,
  signal?: AbortSignal,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let exceeded = false;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = (): void => {
      child.kill("SIGTERM");
      abortTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => child.kill("SIGTERM"), RUN_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (maxOutputBytes !== undefined && outputBytes > maxOutputBytes) {
        exceeded = true;
        child.kill("SIGTERM");
        return;
      }
      const text = chunk.toString();
      stdout += text;
      runLog?.write("stdout", text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (maxOutputBytes !== undefined && outputBytes > maxOutputBytes) {
        exceeded = true;
        child.kill("SIGTERM");
        return;
      }
      const text = chunk.toString();
      stderr += text;
      runLog?.write("stderr", text);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (abortTimer !== undefined) clearTimeout(abortTimer);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (abortTimer !== undefined) clearTimeout(abortTimer);
      signal?.removeEventListener("abort", abort);
      resolve({ code, stdout, stderr: exceeded ? `${stderr}\noutput limit exceeded` : stderr });
    });
    child.stdin.end(input);
  });
}

function lastLines(text: string): string {
  return text.trim().split("\n").slice(-3).join(" ").slice(0, 300);
}

/** The final `{"type":"result",…}` event of a Claude Code `stream-json` transcript. */
export function claudeStreamResult(stdout: string):
  | {
      readonly isError: boolean;
      readonly subtype: string;
      readonly result: string;
    }
  | undefined {
  const lines = stdout.trim().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let event: { type?: unknown; is_error?: unknown; subtype?: unknown; result?: unknown };
    try {
      event = JSON.parse(lines[index]!) as typeof event;
    } catch {
      continue;
    }
    if (event.type !== "result") continue;
    return {
      isError: event.is_error === true,
      subtype: typeof event.subtype === "string" ? event.subtype : "unknown",
      result: typeof event.result === "string" ? event.result : "",
    };
  }
  return undefined;
}

function claudeModel(request: AgentReplyRequest): string | undefined {
  return request.agent.model.startsWith("claude-") ? request.agent.model : undefined;
}

function codexModel(request: AgentReplyRequest): string | undefined {
  return request.agent.model === "codex" || request.agent.model.startsWith("claude-")
    ? undefined
    : request.agent.model;
}

async function runClaudeCode(
  request: AgentReplyRequest,
  cwd: string,
  workspace?: AgentWorkspace,
  restricted?: RestrictedClaudeOptions,
): Promise<string> {
  const { system, user } = agentPrompt(request, workspace);
  const model = claudeModel(request);
  const home =
    restricted === undefined ? undefined : await mkdtemp(join(tmpdir(), "eforest-claude-"));
  try {
    const process =
      restricted === undefined
        ? {
            command: "claude",
            args: [] as readonly string[],
            env: Object.fromEntries(
              Object.entries(globalThis.process.env).filter(
                ([name]) => name !== "ANTHROPIC_API_KEY" && name !== "ANTHROPIC_AUTH_TOKEN",
              ),
            ),
          }
        : restrictedClaudeProcess(restricted.restrictedClaudeToken, home!);
    const result = await run(
      restricted?.command ?? process.command,
      [
        ...process.args,
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--tools",
        workspace === undefined ? "" : "Read,Edit,Write,Glob,Grep",
        ...(workspace === undefined ? [] : ["--permission-mode", "acceptEdits"]),
        "--no-session-persistence",
        "--effort",
        request.agent.effort,
        "--append-system-prompt",
        system,
        ...(model === undefined ? [] : ["--model", model]),
      ],
      user,
      cwd,
      process.env,
      restricted === undefined ? request.runLog : undefined,
      restricted === undefined ? undefined : 16 * 1024 * 1024,
      request.signal,
    );
    const stdout =
      restricted === undefined
        ? result.stdout
        : result.stdout.replaceAll(restricted.restrictedClaudeToken, "[redacted]");
    const stderr =
      restricted === undefined
        ? result.stderr
        : result.stderr.replaceAll(restricted.restrictedClaudeToken, "[redacted]");
    if (restricted !== undefined) {
      request.runLog?.write("stdout", stdout);
      request.runLog?.write("stderr", stderr);
    }
    const final = claudeStreamResult(stdout);
    if (final === undefined) {
      throw new Error(`claude exited ${String(result.code)}: ${lastLines(stderr || stdout)}`);
    }
    if (final.isError) throw new Error(`claude ${final.subtype}: ${final.result}`);
    return final.result;
  } finally {
    if (home !== undefined) await rm(home, { recursive: true, force: true });
  }
}

async function runCodex(
  request: AgentReplyRequest,
  cwd: string,
  workspace?: AgentWorkspace,
): Promise<string> {
  const { system, user } = agentPrompt(request, workspace);
  // Outside the checkout, so the watcher never syncs Codex's own output file.
  const output = join(tmpdir(), `eforest-codex-${process.pid}-${Date.now()}.txt`);
  const model = codexModel(request);
  const result = await run(
    "codex",
    [
      "exec",
      // JSONL event stream on stdout — recorded verbatim in the run log.
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      workspace === undefined ? "read-only" : "workspace-write",
      "-C",
      cwd,
      "-o",
      output,
      ...(model === undefined ? [] : ["-m", model]),
      "-",
    ],
    `${system}\n\n${user}`,
    cwd,
    process.env,
    request.runLog,
  );
  try {
    if (result.code !== 0) {
      throw new Error(`codex exited ${String(result.code)}: ${lastLines(result.stderr)}`);
    }
    return await readFile(output, "utf8");
  } finally {
    await rm(output, { force: true });
  }
}

function branchLink(workspace: AgentWorkspace): string {
  const { org, repo } = workspace.codebase;
  return `/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/tree/${encodeURIComponent(workspace.branch)}/`;
}

/**
 * Harness-backed replies. With `workspace` options, a thread that references a
 * `$codebase` runs the agent in a live-synced checkout on the thread's agent branch
 * (one branch per agent per thread, so follow-up mentions keep building on it).
 */
export function createHarnessReplyGenerator(
  workspace?: AgentWorkspaceOptions,
  restricted?: RestrictedClaudeOptions,
): AgentReplyGenerator {
  return async (request) => {
    const runner = harnessRunner(request.agent.harness);
    if (
      restricted !== undefined &&
      !["claude-code", "sol", "terra", "luna"].includes(request.agent.harness)
    )
      throw new Error("this hosted deployment supports only Claude Code agents");
    if (runner === undefined) {
      throw new Error(`the ${request.agent.harness} harness is not supported yet`);
    }
    const model =
      (runner === "codex" ? codexModel(request) : claudeModel(request)) ?? "harness-default";
    const trigger = { streamId: request.streamId, messageId: request.mention.id };
    const harnessRun = (cwd: string, checkout?: AgentWorkspace) =>
      runner === "codex"
        ? runCodex(request, cwd, checkout)
        : runClaudeCode(request, cwd, checkout, restricted);
    // The mention's own $codebase wins; otherwise the latest one earlier in the thread.
    const codebase =
      referencedCodebases([request.mention.body], request.org)[0] ??
      referencedCodebases(
        [...request.thread].reverse().map((message) => message.body),
        request.org,
      )[0];
    if (workspace === undefined || codebase === undefined) {
      await request.runLog?.start({ harness: runner, model, trigger });
      const cwd = await mkdtemp(join(tmpdir(), `eforest-agent-${request.agent.handle}-`));
      try {
        return { body: await harnessRun(cwd) };
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
    if (codebase.org !== request.org) {
      throw new Error(
        `I can only edit codebases in the "${request.org}" workspace, not $${codebase.org}/${codebase.repo}`,
      );
    }
    const rootId = request.mention.threadOf ?? request.mention.id;
    const branch = agentBranchName(request.agent.handle, rootId);
    await request.runLog?.start({
      harness: runner,
      model,
      trigger,
      codebase: { org: codebase.org, repo: codebase.repo, branch },
    });
    return withAgentWorkspace(
      workspace,
      { codebase, handle: request.agent.handle, branch },
      async (checkout) => {
        await request.announce?.(
          `Working in $${codebase.repo} on branch [\`${branch}\`](${branchLink(checkout)}) — my edits sync to it live.`,
        );
        const summary = await harnessRun(checkout.dir, checkout);
        return {
          body: summary.trim(),
          workspace: { org: codebase.org, repo: codebase.repo, branch },
        };
      },
      request.signal,
    );
  };
}
