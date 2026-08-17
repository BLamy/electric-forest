import { StreamReader } from "@eforest/client";
import { canonicalJson, compareOffsets, OFFSET_BEFORE_FIRST, type Offset } from "@eforest/protocol";
import { WorktreeDigestError, worktreeDigest } from "@eforest/streamfs";
import { worktreeDigestDirectory } from "@eforest/streamfs/worktree-node";
import {
  WorkspaceFormatError,
  load as loadWorkspace,
  type WorkspaceState,
} from "@eforest/workspace";
import { existsSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { bearerHeaders } from "./credentials.js";
import type { CliIo } from "./cli.js";
import { classifyWorkingTree } from "./classify.js";
import { hasCheckoutMarker } from "./checkout-marker.js";
import { readWatchState, watchDivergencePath } from "./sync/watch-state.js";

export const STATUS_JSON_VERSION = 2 as const;
export const STATUS_USAGE = "Usage: ef status [--json] [--offline]";
export const STATUS_HEAD_TIMEOUT_MS = 10_000;

export type StatusErrorCode =
  | "status/usage"
  | "status/workspace-not-found"
  | "status/workspace-path-conflict"
  | "status/workspace-invalid"
  | "status/worktree-invalid"
  | "status/head-probe-failed"
  | "cli/interrupted-checkout";

export class StatusCliError extends Error {
  readonly code: StatusErrorCode;
  readonly exitCode: number;

  constructor(code: StatusErrorCode, message: string, exitCode = 1) {
    super(`${code}: ${message}`);
    this.name = "StatusCliError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export interface StatusJson {
  readonly v: typeof STATUS_JSON_VERSION;
  readonly branch: string;
  readonly streamId: string;
  readonly checkpointOffset: string;
  readonly headOffset: string | null;
  readonly behindBy: number | null;
  readonly clean: boolean;
  readonly baseTreeDigest: string;
  readonly workingTreeDigest: string;
  readonly paths: {
    readonly added: readonly string[];
    readonly deleted: readonly string[];
    readonly modified: readonly string[];
    readonly conflicted: readonly {
      readonly path: string;
      readonly conflictFile: string;
      readonly offset: string;
    }[];
  };
  readonly watch: {
    readonly running: boolean;
    readonly pid?: number;
  };
}

export interface StatusDependencies {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface BranchHead {
  readonly headOffset: Offset;
  readonly behindBy: number;
}

interface StatusOptions {
  readonly json: boolean;
  readonly offline: boolean;
}

function parseOptions(args: readonly string[]): StatusOptions {
  let json = false;
  let offline = false;
  for (const argument of args) {
    if (argument === "--json" && !json) {
      json = true;
      continue;
    }
    if (argument === "--offline" && !offline) {
      offline = true;
      continue;
    }
    throw new StatusCliError("status/usage", STATUS_USAGE, 2);
  }
  return { json, offline };
}

export function findWorkspaceRoot(startDirectory: string): string {
  let directory = resolve(startDirectory);
  while (true) {
    const workspaceDirectory = join(directory, ".ef");
    try {
      const stat = lstatSync(workspaceDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new StatusCliError(
          "status/workspace-path-conflict",
          `${workspaceDirectory} must be a directory`,
        );
      }
      return directory;
    } catch (error) {
      if (error instanceof StatusCliError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new StatusCliError(
          "status/workspace-not-found",
          `cannot inspect ${workspaceDirectory}: ${String(error)}`,
        );
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new StatusCliError(
        "status/workspace-not-found",
        `no .ef workspace found from ${resolve(startDirectory)}`,
      );
    }
    directory = parent;
  }
}

function streamServerUrl(workspace: WorkspaceState, environment: NodeJS.ProcessEnv): string {
  const value =
    environment.EF_STREAM_SERVER_URL ??
    environment.EF_SERVER_URL ??
    environment.EFOREST_SERVER_URL ??
    environment.EF_SERVER ??
    workspace.identity.server;
  const normalized = value.replace(/\/+$/, "");
  if (normalized.length === 0) {
    throw new StatusCliError("status/head-probe-failed", "stream server URL is empty");
  }
  return normalized;
}

function statusError(error: unknown): StatusCliError {
  if (error instanceof StatusCliError) return error;
  if (error instanceof WorkspaceFormatError) {
    return new StatusCliError("status/workspace-invalid", `${error.code}: ${error.message}`);
  }
  if (error instanceof WorktreeDigestError) {
    return new StatusCliError("status/worktree-invalid", `${error.code}: ${error.message}`);
  }
  return new StatusCliError(
    "status/head-probe-failed",
    error instanceof Error ? error.message : String(error),
  );
}

function fetchWithSignal(
  fetcher: typeof fetch,
  headers: Readonly<Record<string, string>> | null,
  controller: AbortController,
): typeof fetch {
  return async (input, init) => {
    const upstream = init?.signal;
    if (upstream?.aborted) controller.abort(upstream.reason);
    else
      upstream?.addEventListener("abort", () => controller.abort(upstream.reason), { once: true });
    const requestHeaders = new Headers(init?.headers);
    for (const [key, value] of Object.entries(headers ?? {})) requestHeaders.set(key, value);
    return fetcher(input, {
      ...init,
      signal: controller.signal,
      headers: requestHeaders,
    });
  };
}

/** Read application events after a checkpoint through the official client. */
export async function probeBranchHead(
  baseUrl: string,
  streamId: string,
  checkpointOffset: Offset,
  options: {
    readonly fetcher?: typeof fetch;
    readonly headers?: Readonly<Record<string, string>> | null;
    readonly timeoutMs?: number;
  } = {},
): Promise<BranchHead> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? STATUS_HEAD_TIMEOUT_MS;
  const reader = new StreamReader({
    baseUrl,
    streamId,
    fetch: fetchWithSignal(options.fetcher ?? fetch, options.headers ?? null, controller),
  });
  const operation = (async (): Promise<BranchHead> => {
    let headOffset = OFFSET_BEFORE_FIRST;
    let behindBy = 0;
    for await (const batch of reader.read(OFFSET_BEFORE_FIRST)) {
      for (const event of batch.events) {
        headOffset = event.offset;
        if (compareOffsets(event.offset, checkpointOffset) > 0) behindBy += 1;
      }
    }
    if (compareOffsets(checkpointOffset, headOffset) > 0) {
      throw new StatusCliError(
        "status/head-probe-failed",
        `checkpoint ${checkpointOffset} is beyond branch head ${headOffset}`,
      );
    }
    return { headOffset, behindBy };
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<BranchHead>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort("status head probe timeout");
      reject(new StatusCliError("status/head-probe-failed", `head probe exceeded ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function buildStatus(
  workspace: WorkspaceState,
  rootDirectory: string,
  head: BranchHead | null,
): StatusJson {
  const classification = classifyWorkingTree(rootDirectory, workspace);
  const paths = {
    added: classification.added,
    deleted: classification.deleted,
    modified: classification.modified,
    conflicted: classification.conflicted,
  };
  return {
    v: STATUS_JSON_VERSION,
    branch: workspace.identity.branch,
    streamId: workspace.identity.metadataStreamId,
    checkpointOffset: workspace.headOffset,
    headOffset: head?.headOffset ?? null,
    behindBy: head?.behindBy ?? null,
    clean:
      paths.added.length === 0 &&
      paths.deleted.length === 0 &&
      paths.modified.length === 0 &&
      paths.conflicted.length === 0,
    baseTreeDigest: worktreeDigestDirectoryFromLedger(workspace),
    workingTreeDigest: worktreeDigestDirectory(rootDirectory),
    paths,
    watch: readWatchState(rootDirectory),
  };
}

function worktreeDigestDirectoryFromLedger(workspace: WorkspaceState): string {
  // Importing the same E4-T01 digest implementation for the ledger makes
  // corruption visible in baseTreeDigest without changing path classification.
  return worktreeDigest({ files: workspace.files });
}

function humanStatus(status: StatusJson, rootDirectory: string): string {
  const branchLine = `On branch ${status.branch}`;
  const remoteLine =
    status.behindBy === null
      ? "Remote head: unknown (offline)."
      : status.behindBy === 0
        ? "Your branch is up to date with the remote head."
        : `Your branch is behind the remote head by ${status.behindBy} event${status.behindBy === 1 ? "" : "s"}.`;
  const changes = status.clean
    ? "nothing to commit, working tree clean"
    : [
        ...status.paths.modified.map((path) => `modified: ${path}`),
        ...status.paths.added.map((path) => `added: ${path}`),
        ...status.paths.deleted.map((path) => `deleted: ${path}`),
      ].join("\n");
  const watchState = status.watch.running
    ? `Watch: running (pid ${status.watch.pid})`
    : "Watch: stopped";
  const divergence = existsSync(watchDivergencePath(rootDirectory))
    ? "Diverged: a self-provenance event was suppressed; inspect .ef/watch-diverged."
    : "";
  return `${branchLine}\n${remoteLine}\n${watchState}\n${divergence}${divergence.length > 0 ? "\n" : ""}${changes}\n`;
}

export async function runStatus(
  args: readonly string[],
  io: CliIo,
  dependencies: StatusDependencies = {},
): Promise<number> {
  try {
    const options = parseOptions(args);
    const environment = dependencies.environment ?? process.env;
    const rootDirectory = findWorkspaceRoot(dependencies.cwd ?? process.cwd());
    if (hasCheckoutMarker(rootDirectory)) {
      throw new StatusCliError("cli/interrupted-checkout", "checkout journal is present", 3);
    }
    const workspace = loadWorkspace(rootDirectory);
    let head: BranchHead | null = null;
    if (!options.offline) {
      const headers = await bearerHeaders(environment);
      const probeOptions = {
        headers,
        ...(dependencies.fetcher === undefined ? {} : { fetcher: dependencies.fetcher }),
        ...(dependencies.timeoutMs === undefined ? {} : { timeoutMs: dependencies.timeoutMs }),
      };
      head = await probeBranchHead(
        streamServerUrl(workspace, environment),
        workspace.identity.metadataStreamId,
        workspace.headOffset as Offset,
        probeOptions,
      );
    }
    const status = buildStatus(workspace, rootDirectory, head);
    io.stdout(options.json ? `${canonicalJson(status)}\n` : humanStatus(status, rootDirectory));
    return 0;
  } catch (error) {
    const failure = statusError(error);
    io.stderr(
      `${failure.code === "cli/interrupted-checkout" ? "error: " : ""}${failure.message}\n`,
    );
    return failure.exitCode;
  }
}
