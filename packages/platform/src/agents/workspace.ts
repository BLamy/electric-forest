import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentCapabilities } from "./capabilities.js";

/**
 * A live agent workspace: the codebase checked out on a fresh agent branch with the
 * `ef` duplex watcher running, so every file the agent saves is uploaded to the branch
 * stream as it happens — anyone viewing the branch sees the edits land live. The run's
 * credential is an in-memory capability (read the org, write only this branch), revoked
 * when the run ends. All writes go through the ordinary gateway dispatch door.
 */

export interface AgentWorkspaceOptions {
  readonly capabilities: AgentCapabilities;
  /** The platform's own base URL (the gateway `ef` writes through), once listening. */
  readonly platformUrl: () => string | undefined;
  /** The Durable Streams server URL (`ef` reads branches from it directly). */
  readonly streamUrl: string;
  /** Path to the `ef` CLI entry (default: this monorepo's built `packages/cli`). */
  readonly cliBin?: string;
}

export interface CodebaseRef {
  readonly org: string;
  readonly repo: string;
}

const CODEBASE_REF_RE = /(?:^|[\s([{])\$([A-Za-z_][\w./-]*)/g;
const NAME_RE = /^[a-z0-9](?:-?[a-z0-9])*$/;
const COMMAND_TIMEOUT_MS = 120_000;

/**
 * `$repo` / `$org/repo` chips in message bodies, in order, deduplicated. A bare `$repo`
 * belongs to `org`; `$other/repo` is kept so the caller can refuse it (capabilities are
 * org-scoped).
 */
export function referencedCodebases(bodies: readonly string[], org: string): CodebaseRef[] {
  const refs: CodebaseRef[] = [];
  for (const body of bodies) {
    for (const match of body.matchAll(CODEBASE_REF_RE)) {
      const id = match[1]!.replace(/[./-]+$/, "");
      const [first, second] = id.split("/");
      const ref = second === undefined ? { org, repo: first! } : { org: first!, repo: second };
      if (!NAME_RE.test(ref.org) || !NAME_RE.test(ref.repo)) continue;
      if (!refs.some((seen) => seen.org === ref.org && seen.repo === ref.repo)) refs.push(ref);
    }
  }
  return refs;
}

/** Deterministic per mention, so a restarted responder resumes the same branch. */
export function agentBranchName(handle: string, mentionId: string): string {
  const digest = createHash("sha256").update(mentionId).digest("hex").slice(0, 8);
  return `agent-${handle}-${digest}`.slice(0, 64);
}

function defaultCliBin(): string {
  // dist/src/agents/workspace.js → packages/cli/dist/src/bin.js
  return fileURLToPath(new URL("../../../../cli/dist/src/bin.js", import.meta.url));
}

interface EfResult {
  readonly code: number | null;
  readonly output: string;
}

function ef(
  cliBin: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<EfResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliBin, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

function tail(text: string): string {
  return text.trim().split("\n").slice(-3).join(" ").slice(0, 400);
}

export interface AgentWorkspace {
  readonly dir: string;
  readonly branch: string;
  readonly codebase: CodebaseRef;
}

/**
 * Check `codebase` out on `branch` (forked from main, or resumed), keep it live-synced
 * while `work` runs, then flush every pending edit, stop syncing, and revoke the
 * capability. Throws with the CLI's own message when a step is refused.
 */
export async function withAgentWorkspace<T>(
  options: AgentWorkspaceOptions,
  run: { readonly codebase: CodebaseRef; readonly handle: string; readonly branch: string },
  work: (workspace: AgentWorkspace) => Promise<T>,
): Promise<T> {
  const platformUrl = options.platformUrl();
  if (platformUrl === undefined) throw new Error("the platform is not listening yet");
  const cliBin = options.cliBin ?? defaultCliBin();
  const { codebase, handle, branch } = run;
  const capability = options.capabilities.issue({ org: codebase.org, handle, branch });
  const scratch = await mkdtemp(join(tmpdir(), `eforest-agent-${handle}-`));
  const home = join(scratch, "ef-home");
  const dir = join(scratch, codebase.repo);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EF_HOME: home,
    EF_SERVER_URL: platformUrl,
    EF_STREAM_SERVER_URL: options.streamUrl,
  };
  let watching = false;
  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(
      join(home, "credentials.json"),
      `${JSON.stringify({
        accessToken: capability.token,
        tokenType: "Bearer",
        issuer: platformUrl,
        clientId: "eforest-agent",
        scopes: ["repo:read", `repo:write:${codebase.org}/${codebase.repo}:${branch}`],
      })}\n`,
      { mode: 0o600 },
    );
    const slug = `${codebase.org}/${codebase.repo}`;
    // The platform (EF_SERVER_URL) resolves and authorizes the repo; the branch bytes come
    // from the stream server (EF_STREAM_SERVER_URL).
    const cloned = await ef(cliBin, ["clone", slug, "main", dir], scratch, env);
    if (cloned.code !== 0) throw new Error(`could not check out $${slug}: ${tail(cloned.output)}`);
    const forked = await ef(cliBin, ["branch", branch], dir, env);
    if (forked.code !== 0 && !forked.output.includes("branch-exists")) {
      throw new Error(`could not create branch ${branch}: ${tail(forked.output)}`);
    }
    const switched = await ef(cliBin, ["checkout", branch], dir, env);
    if (switched.code !== 0) {
      throw new Error(`could not switch to branch ${branch}: ${tail(switched.output)}`);
    }
    const started = await ef(cliBin, ["watch", "start", "--dir", dir], dir, env);
    if (started.code !== 0) throw new Error(`could not start live sync: ${tail(started.output)}`);
    watching = true;
    const result = await work({ dir, branch, codebase });
    // Stop the live watcher, then a final quiesced upload proves nothing is left behind.
    const stopped = await ef(cliBin, ["watch", "stop", "--dir", dir], dir, env);
    watching = false;
    if (stopped.code !== 0)
      throw new Error(`live sync did not stop cleanly: ${tail(stopped.output)}`);
    const flushed = await ef(cliBin, ["watch", "--up", "--quiesce"], dir, env);
    if (flushed.code !== 0) {
      throw new Error(`some edits did not sync to ${branch}: ${tail(flushed.output)}`);
    }
    return result;
  } finally {
    if (watching)
      await ef(cliBin, ["watch", "stop", "--dir", dir], dir, env).catch(() => undefined);
    capability.revoke();
    await rm(scratch, { recursive: true, force: true });
  }
}
