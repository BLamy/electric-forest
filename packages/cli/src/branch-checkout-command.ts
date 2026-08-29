import { isDurableExistsConflict, isDurableNotFound, type StreamRecord } from "@eforest/client";
import { canonicalJson, OFFSET_BEFORE_FIRST, type Event, type Offset } from "@eforest/protocol";
import {
  branchMetadataStreamId,
  isValidFsPath,
  StreamFsError,
  StreamFsRepo,
  worktreeDigest,
} from "@eforest/streamfs";
import { worktreeDigestDirectory } from "@eforest/streamfs/worktree-node";
import {
  load as loadWorkspace,
  save as saveWorkspace,
  type WorkspaceState,
} from "@eforest/workspace";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadCredentials } from "./credentials.js";
import {
  checkoutMarkerPath,
  hasCheckoutMarker,
  removeCheckoutMarker,
  writeCheckoutMarker,
} from "./checkout-marker.js";
import { classifyWorkingTree } from "./classify.js";
import { findWorkspaceRoot, StatusCliError } from "./status.js";
import {
  clearWorktree,
  copyStagedTree,
  materializeTree,
  safeTreeTarget,
  TreeMaterializerError,
  verifyMaterializedTree,
  workspaceStateFromTree,
} from "./tree-materializer.js";
import type { CliIo } from "./cli.js";

export const BRANCH_USAGE = "Usage: ef branch <name>";
export const CHECKOUT_USAGE = "Usage: ef checkout <branch>";

export type BranchCheckoutErrorCode =
  | "cli/dirty-working-tree"
  | "cli/unknown-branch"
  | "cli/not-a-workspace"
  | "cli/interrupted-checkout"
  | "cli/unsafe-path"
  | "cli/checkout-integrity"
  | "cli/invalid-workspace"
  | "fs/invalid-branch-name"
  | "fs/fork-offset-out-of-range"
  | (string & {});

export class BranchCheckoutCliError extends Error {
  readonly exitCode: number;

  constructor(
    readonly code: BranchCheckoutErrorCode,
    message: string,
    exitCode = 3,
  ) {
    super(message);
    this.name = "BranchCheckoutCliError";
    this.exitCode = exitCode;
  }
}

interface Remote {
  readonly serverUrl: string;
  readonly streamUrl: string;
  readonly fetcher: typeof fetch;
}

export interface BranchCheckoutDependencies {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetcher?: typeof fetch;
}

interface ErrorShape {
  readonly error?: {
    readonly reason?: unknown;
    readonly class?: unknown;
    readonly code?: unknown;
    readonly message?: unknown;
  };
}

function trimUrl(value: string, fallbackCode: BranchCheckoutErrorCode): string {
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.length === 0) throw new BranchCheckoutCliError(fallbackCode, "server URL is empty");
  return trimmed;
}

function remoteUrl(
  workspace: WorkspaceState,
  environment: NodeJS.ProcessEnv,
  stream: boolean,
): string {
  const value = stream
    ? (environment.EF_STREAM_SERVER_URL ??
      environment.EF_SERVER_URL ??
      environment.EFOREST_SERVER_URL ??
      environment.EF_SERVER ??
      workspace.identity.server)
    : (environment.EF_SERVER_URL ??
      environment.EFOREST_SERVER_URL ??
      environment.EF_SERVER ??
      environment.EF_STREAM_SERVER_URL ??
      workspace.identity.server);
  return trimUrl(value, "cli/invalid-workspace");
}

async function makeRemote(
  workspace: WorkspaceState,
  environment: NodeJS.ProcessEnv,
  fetcher: typeof fetch,
): Promise<Remote> {
  const credentials = await loadCredentials(environment);
  const authorization = credentials === null ? undefined : `Bearer ${credentials.accessToken}`;
  const authorized: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    if (authorization !== undefined && !headers.has("authorization")) {
      headers.set("authorization", authorization);
    }
    return fetcher(input, { ...init, headers });
  };
  return {
    serverUrl: remoteUrl(workspace, environment, false),
    streamUrl: remoteUrl(workspace, environment, true),
    fetcher: authorized,
  };
}

function workspaceRepoName(workspace: WorkspaceState): string {
  const marker = `:${workspace.identity.branch}:meta`;
  const streamId = workspace.identity.metadataStreamId;
  if (!streamId.startsWith("fs:") || !streamId.endsWith(marker)) {
    throw new BranchCheckoutCliError(
      "cli/invalid-workspace",
      "workspace metadata stream identity is not a repository branch",
    );
  }
  const repoName = streamId.slice(3, -marker.length);
  if (repoName.length === 0 || repoName.includes("\0")) {
    throw new BranchCheckoutCliError(
      "cli/invalid-workspace",
      "workspace repository identity is invalid",
    );
  }
  return repoName;
}

function parseErrorBody(value: unknown): { readonly reason?: string; readonly message?: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const body = value as ErrorShape;
  const error = body.error;
  if (error === undefined) return {};
  const reason = [error.reason, error.class, error.code].find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  const message =
    typeof error.message === "string" && error.message.length > 0 ? error.message : reason;
  return reason === undefined ? {} : { reason, ...(message === undefined ? {} : { message }) };
}

async function responseError(response: Response): Promise<BranchCheckoutCliError> {
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    // Keep the provider's plain-text response as the diagnostic.
  }
  const parsed = parseErrorBody(body);
  const reason =
    parsed.reason ?? (response.status === 404 ? "cli/unknown-branch" : "cli/remote-refusal");
  const message = parsed.message ?? (typeof body === "string" && body.length > 0 ? body : reason);
  return new BranchCheckoutCliError(reason, message);
}

function remoteFailure(error: unknown, fallback: BranchCheckoutErrorCode): BranchCheckoutCliError {
  if (error instanceof BranchCheckoutCliError) return error;
  if (error instanceof StatusCliError) {
    if (
      error.code === "status/workspace-not-found" ||
      error.code === "status/workspace-path-conflict"
    ) {
      return new BranchCheckoutCliError("cli/not-a-workspace", error.message);
    }
    if (error.code === "cli/interrupted-checkout") {
      return new BranchCheckoutCliError("cli/interrupted-checkout", error.message);
    }
  }
  if (isDurableExistsConflict(error)) {
    return new BranchCheckoutCliError("fs/branch-exists", "branch already exists");
  }
  if (isDurableNotFound(error)) {
    return new BranchCheckoutCliError(
      fallback === "fs/invalid-branch-name" ? "fs/parent-not-found" : "cli/unknown-branch",
      fallback === "cli/unknown-branch" ? "branch was not found" : "stream was not found",
    );
  }
  if (error instanceof StreamFsError) {
    if (error.code === "repo_not_found")
      return new BranchCheckoutCliError("cli/unknown-branch", error.message);
    return new BranchCheckoutCliError(error.code, error.message);
  }
  if (error instanceof TreeMaterializerError) {
    return new BranchCheckoutCliError("cli/unsafe-path", error.message);
  }
  if (error instanceof Error && /invalid branch name/i.test(error.message)) {
    return new BranchCheckoutCliError("fs/invalid-branch-name", error.message);
  }
  if (
    error instanceof Error &&
    /ECONNREFUSED|fetch failed|network|timeout|aborted/i.test(error.message)
  ) {
    return new BranchCheckoutCliError("cli/remote-unavailable", error.message);
  }
  return new BranchCheckoutCliError(
    fallback,
    error instanceof Error ? error.message : String(error),
  );
}

function branchEvent(parentStreamId: string, forkOffset: Offset): Event {
  return {
    type: "fs.branch.fork",
    payload: { v: 1, parentStreamId, forkOffset },
    ts: Date.now(),
  };
}

async function registerBranchProjection(
  remote: Remote,
  repoName: string,
  branch: string,
): Promise<void> {
  const parts = repoName.split("/");
  if (parts.length !== 2) return;
  const [org, repo] = parts;
  const response = await remote.fetcher(
    `${remote.serverUrl}/api/repos/${encodeURIComponent(org!)}/${encodeURIComponent(repo!)}/${encodeURIComponent(branch)}/home/branches`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: canonicalJson({ name: branch }),
    },
  );
  if (response.status === 404) return;
  if (!response.ok) throw await responseError(response);
}

async function createNativeBranch(
  workspace: WorkspaceState,
  branch: string,
  remote: Remote,
): Promise<{ readonly streamId: string; readonly forkOffset: Offset }> {
  const repoName = workspaceRepoName(workspace);
  const parentStreamId = workspace.identity.metadataStreamId;
  const checkpoint = workspace.headOffset as Offset;
  const streamId = branchMetadataStreamId(repoName, branch);
  const response = await remote.fetcher(`${remote.serverUrl}/api/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: canonicalJson({
      streamId,
      event: branchEvent(parentStreamId, checkpoint),
    }),
  });
  if (!response.ok) throw await responseError(response);
  await registerBranchProjection(remote, repoName, branch);
  return { streamId, forkOffset: checkpoint };
}

async function runBranchCommand(
  args: readonly string[],
  io: CliIo,
  dependencies: BranchCheckoutDependencies = {},
): Promise<number> {
  if (args.length !== 1 || args[0]!.startsWith("--")) {
    io.stderr(`${BRANCH_USAGE}\n`);
    return 2;
  }
  try {
    const environment = dependencies.environment ?? process.env;
    const root = findWorkspaceRoot(dependencies.cwd ?? process.cwd());
    if (hasCheckoutMarker(root))
      throw new BranchCheckoutCliError("cli/interrupted-checkout", "checkout journal is present");
    const workspace = loadWorkspace(root);
    const remote = await makeRemote(workspace, environment, dependencies.fetcher ?? fetch);
    const result = await createNativeBranch(workspace, args[0]!, remote);
    io.stdout(`branch ${args[0]!} ${result.streamId} forked-at ${result.forkOffset}\n`);
    return 0;
  } catch (error) {
    const failure = remoteFailure(error, "cli/not-a-workspace");
    io.stderr(`error: ${failure.code}: ${failure.message}\n`);
    return failure.exitCode;
  }
}

function validateTree(state: import("@eforest/streamfs").FsTree): void {
  for (const path of Object.keys(state.dirs)) safeTreeTarget("/", path);
  for (const path of Object.keys(state.files)) safeTreeTarget("/", path);
}

function validateRawEventPaths(
  records: readonly { readonly type: string; readonly payload: unknown }[],
): void {
  for (const record of records) {
    if (
      record.payload === null ||
      typeof record.payload !== "object" ||
      Array.isArray(record.payload)
    ) {
      continue;
    }
    const payload = record.payload as Record<string, unknown>;
    for (const field of ["path", "from", "to"] as const) {
      const value = payload[field];
      if (value !== undefined && (typeof value !== "string" || !isValidFsPath(value))) {
        throw new TreeMaterializerError(
          `invalid path in ${record.type}.${field}: ${JSON.stringify(value)}`,
        );
      }
    }
  }
}

async function checkoutTarget(
  root: string,
  workspace: WorkspaceState,
  branch: string,
  remote: Remote,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const repoName = workspaceRepoName(workspace);
  const targetRepo = new StreamFsRepo(remote.streamUrl, remote.fetcher, repoName, branch);
  let records: readonly StreamRecord[];
  try {
    records = await targetRepo.rawDump();
  } catch (error) {
    throw remoteFailure(error, "cli/unknown-branch");
  }
  validateRawEventPaths(records);
  const targetOffset = records.at(-1)?.offset ?? (OFFSET_BEFORE_FIRST as Offset);
  const targetTree = await targetRepo.tree();
  validateTree(targetTree);
  const stage = mkdtempSync(join(root, ".ef", `.checkout-stage-${process.pid}-`));
  let committed = false;
  try {
    await materializeTree(stage, targetTree, (path) => targetRepo.readFile(path));
    verifyMaterializedTree(stage, targetTree);
    writeCheckoutMarker(root, { v: 1, branch, offset: targetOffset });
    clearWorktree(root);
    copyStagedTree(stage, root, targetTree);
    const actualDigest = worktreeDigestDirectory(root);
    const expectedDigest = worktreeDigest(targetTree);
    if (actualDigest !== expectedDigest) {
      throw new BranchCheckoutCliError(
        "cli/checkout-integrity",
        `materialized digest ${actualDigest} does not match ${expectedDigest}`,
      );
    }
    if (environment.EFOREST_CHECKOUT_FAILPOINT === "before-workspace-save") {
      throw new BranchCheckoutCliError(
        "cli/checkout-integrity",
        "injected checkout failure before workspace save",
      );
    }
    const identity = {
      ...workspace.identity,
      branch,
      metadataStreamId: branchMetadataStreamId(repoName, branch),
    };
    saveWorkspace(root, workspaceStateFromTree(identity, targetOffset, targetTree));
    rmSync(stage, { recursive: true, force: true });
    removeCheckoutMarker(root);
    committed = true;
  } finally {
    if (!committed) {
      // The journal intentionally remains on failure; only the disposable stage
      // can be removed because status/branch/checkout use the marker as proof.
      rmSync(stage, { recursive: true, force: true });
    }
  }
}

async function runCheckoutCommand(
  args: readonly string[],
  io: CliIo,
  dependencies: BranchCheckoutDependencies = {},
): Promise<number> {
  if (args.length !== 1 || args[0]!.startsWith("--")) {
    io.stderr(`${CHECKOUT_USAGE}\n`);
    return 2;
  }
  try {
    const environment = dependencies.environment ?? process.env;
    const root = findWorkspaceRoot(dependencies.cwd ?? process.cwd());
    if (hasCheckoutMarker(root))
      throw new BranchCheckoutCliError("cli/interrupted-checkout", "checkout journal is present");
    const workspace = loadWorkspace(root);
    const classification = classifyWorkingTree(root, workspace);
    if (
      classification.added.length > 0 ||
      classification.deleted.length > 0 ||
      classification.modified.length > 0
    ) {
      throw new BranchCheckoutCliError("cli/dirty-working-tree", "working tree is not clean");
    }
    const branch = args[0]!;
    if (branch === workspace.identity.branch) {
      io.stdout(`Already on branch ${branch}.\n`);
      return 0;
    }
    const remote = await makeRemote(workspace, environment, dependencies.fetcher ?? fetch);
    await checkoutTarget(root, workspace, branch, remote, environment);
    io.stdout(`Switched to branch ${branch}.\n`);
    return 0;
  } catch (error) {
    const failure = remoteFailure(error, "cli/checkout-integrity");
    io.stderr(`error: ${failure.code}: ${failure.message}\n`);
    return failure.exitCode;
  }
}

export async function runBranch(
  args: readonly string[],
  io: CliIo,
  dependencies: BranchCheckoutDependencies = {},
): Promise<number> {
  return runBranchCommand(args, io, dependencies);
}

export async function runCheckout(
  args: readonly string[],
  io: CliIo,
  dependencies: BranchCheckoutDependencies = {},
): Promise<number> {
  return runCheckoutCommand(args, io, dependencies);
}

export { checkoutMarkerPath };
