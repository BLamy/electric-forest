import { isDurableNotFound } from "@eforest/client";
import {
  BASE_NONE,
  SnapshotIntegrityError,
  StreamFsRepo,
  contentMap,
  digestBytes,
  isValidFsPath,
  worktreeDigest,
  type FsTree,
} from "@eforest/streamfs";
import { compareOffsets, type Offset } from "@eforest/protocol";
import { worktreeDigestDirectory } from "@eforest/streamfs/worktree-node";
import {
  load as loadWorkspace,
  save as saveWorkspace,
  type WorkspaceFileBase,
  type WorkspaceState,
} from "@eforest/workspace";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadCredentials, type StoredCredentials } from "./credentials.js";
import type { CliIo } from "./cli.js";

export const CLONE_USAGE =
  "Usage: ef clone <org>/<repo> [branch] [dir] [--server <url>] [--at <offset>]";
export const WORKSPACE_CHECK_USAGE = "Usage: ef workspace check <dir>";
export const COMPLETE_MARKER = '{"v":1}\n';
const CLONE_TIMEOUT_MS = 5_000;
const INTERRUPTED_HEADER = "x-eforest-clone-error";

export type CloneErrorCode =
  | "ETARGET_NOT_EMPTY"
  | "EREFUSED"
  | "ENOT_FOUND"
  | "EBAD_OFFSET"
  | "ESNAPSHOT_INTEGRITY"
  | "ECORRUPT_EVENT"
  | "EINTERRUPTED"
  | "EWORKSPACE_INVALID";

export class CloneCliError extends Error {
  readonly code: CloneErrorCode;
  readonly exitCode: number;

  constructor(code: CloneErrorCode, message: string, exitCode = 1) {
    super(`${code}: ${message}`);
    this.name = "CloneCliError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

interface CloneOptions {
  readonly org: string;
  readonly repo: string;
  readonly branch: string;
  readonly directory: string;
  readonly at?: Offset;
  readonly serverUrl: string;
  readonly streamServerUrl: string;
}

interface CloneDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetcher?: typeof fetch;
}

interface NamespaceRepo {
  readonly project: string;
  readonly directFallback?: boolean;
}

interface ErrorBody {
  readonly error?: {
    readonly class?: unknown;
    readonly code?: unknown;
    readonly reason?: unknown;
  };
}

function trimUrl(value: string, code: CloneErrorCode = "EREFUSED"): string {
  const result = value.replace(/\/+$/, "");
  if (result.length === 0) throw new CloneCliError(code, "server URL is empty");
  return result;
}

function validName(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) && value !== "meta" && value !== "file";
}

function parseRepo(value: string): { readonly org: string; readonly repo: string } {
  const parts = value.split("/");
  if (parts.length !== 2 || !parts.every(validName)) {
    throw new CloneCliError("EREFUSED", "repository reference is invalid", 2);
  }
  return { org: parts[0]!, repo: parts[1]! };
}

function parseOptions(args: readonly string[], environment: NodeJS.ProcessEnv): CloneOptions {
  if (args.length === 0) throw new CloneCliError("EREFUSED", CLONE_USAGE, 2);
  const positional: string[] = [];
  let server: string | undefined;
  let at: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--server" || argument === "--at") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CloneCliError("EREFUSED", CLONE_USAGE, 2);
      }
      if (argument === "--server") {
        if (server !== undefined) throw new CloneCliError("EREFUSED", CLONE_USAGE, 2);
        server = value;
      } else {
        if (at !== undefined) throw new CloneCliError("EREFUSED", CLONE_USAGE, 2);
        at = value;
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) throw new CloneCliError("EREFUSED", CLONE_USAGE, 2);
    positional.push(argument);
  }
  if (positional.length < 1 || positional.length > 3) {
    throw new CloneCliError("EREFUSED", CLONE_USAGE, 2);
  }
  const { org, repo } = parseRepo(positional[0]!);
  const branch = positional[1] ?? "main";
  if (!validName(branch)) throw new CloneCliError("ENOT_FOUND", `branch ${branch} was not found`);
  const directory = resolve(positional[2] ?? repo);
  const serverUrl = trimUrl(
    server ??
      environment.EF_SERVER ??
      environment.EF_SERVER_URL ??
      environment.EFOREST_SERVER_URL ??
      "",
  );
  const streamServerUrl = trimUrl(
    environment.EF_STREAM_SERVER_URL ?? environment.EFOREST_SERVER_URL ?? serverUrl,
  );
  let offset: Offset | undefined;
  if (at !== undefined) {
    if (at !== "-1" && !/^[0-9]+(?:_[0-9]+)?$/.test(at)) {
      throw new CloneCliError("EBAD_OFFSET", `offset ${at} is not well formed`);
    }
    offset = at as Offset;
  }
  return {
    org,
    repo,
    branch,
    directory,
    ...(offset === undefined ? {} : { at: offset }),
    serverUrl,
    streamServerUrl,
  };
}

function authFetch(fetcher: typeof fetch, credentials: StoredCredentials | null): typeof fetch {
  const authorization = credentials === null ? undefined : `Bearer ${credentials.accessToken}`;
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    if (authorization !== undefined && !headers.has("authorization")) {
      headers.set("authorization", authorization);
    }
    return fetcher(input, { ...init, headers });
  };
}

function interruptedResponse(): Response {
  return new Response(JSON.stringify({ error: { code: "interrupted" } }), {
    status: 400,
    headers: {
      "content-type": "application/json",
      [INTERRUPTED_HEADER]: "1",
    },
  });
}

function boundedFetch(fetcher: typeof fetch, timeoutMs = CLONE_TIMEOUT_MS): typeof fetch {
  const deadline = Date.now() + timeoutMs;
  return async (input, init) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return interruptedResponse();

    const controller = new AbortController();
    const upstream = init?.signal;
    const relayAbort = () => controller.abort(upstream?.reason);
    if (upstream?.aborted) relayAbort();
    else upstream?.addEventListener("abort", relayAbort, { once: true });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Response>((resolve) => {
      timeoutHandle = setTimeout(() => {
        controller.abort("clone timeout");
        resolve(interruptedResponse());
      }, remaining);
    });
    try {
      return await Promise.race([fetcher(input, { ...init, signal: controller.signal }), timeout]);
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      upstream?.removeEventListener("abort", relayAbort);
    }
  };
}

async function responseBody(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

function errorText(body: unknown): string {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const error = (body as ErrorBody).error;
    for (const candidate of [error?.reason, error?.class, error?.code]) {
      if (typeof candidate === "string" && candidate.length > 0) return candidate;
    }
  }
  return "repository read was refused";
}

function namespaceRepo(body: unknown, org: string, repo: string): NamespaceRepo | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const resolution = (body as { readonly resolution?: unknown }).resolution;
  if (resolution === null || typeof resolution !== "object" || Array.isArray(resolution)) {
    return undefined;
  }
  const candidate = resolution as {
    readonly org?: unknown;
    readonly project?: unknown;
    readonly repoStreamPrefix?: unknown;
    readonly found?: unknown;
  };
  if (
    candidate.found === false ||
    (candidate.org !== undefined && candidate.org !== org) ||
    typeof candidate.repoStreamPrefix !== "string" ||
    candidate.repoStreamPrefix !== `fs:${org}/${repo}` ||
    typeof candidate.project !== "string" ||
    candidate.project.length === 0
  ) {
    return undefined;
  }
  return { project: candidate.project };
}

async function resolveNamespace(
  options: CloneOptions,
  credentials: StoredCredentials | null,
  fetcher: typeof fetch,
): Promise<NamespaceRepo> {
  let response: Response;
  try {
    response = await fetcher(
      `${options.serverUrl}/api/namespaces/${encodeURIComponent(options.org)}/${encodeURIComponent(options.repo)}`,
      {
        headers: credentials === null ? {} : { authorization: `Bearer ${credentials.accessToken}` },
      },
    );
  } catch (error) {
    // A direct Durable Streams URL is also a valid local server in E1/E3
    // fixtures. It has no platform namespace route, so stream existence is
    // the only available resolution signal in that composition.
    if (credentials === null) return { project: options.repo, directFallback: true };
    throw new CloneCliError(
      "EINTERRUPTED",
      error instanceof Error ? error.message : "namespace read failed",
    );
  }
  const body = await responseBody(response);
  if (response.headers.get(INTERRUPTED_HEADER) === "1") {
    throw new CloneCliError("EINTERRUPTED", "repository read timed out");
  }
  if (response.ok) {
    const resolved = namespaceRepo(body, options.org, options.repo);
    if (resolved !== undefined) return resolved;
    throw new CloneCliError("EREFUSED", "repository is not readable");
  }
  if (response.status === 401 && credentials === null) {
    // E2-T07 deliberately permits public repo reads without a bearer token,
    // while its namespace route remains authenticated. Probe the authorized
    // repo door before touching the physical stream so private and unknown
    // repositories remain privacy-neutral.
    try {
      const probe = await fetcher(
        `${options.serverUrl}/api/repos/${encodeURIComponent(options.org)}/${encodeURIComponent(options.repo)}/${encodeURIComponent(options.branch)}/events`,
      );
      if (probe.headers.get(INTERRUPTED_HEADER) === "1") {
        throw new CloneCliError("EINTERRUPTED", "repository probe timed out");
      }
      if (probe.ok) return { project: options.repo };
      if (probe.status === 404 || probe.status === 401 || probe.status === 403) {
        throw new CloneCliError("EREFUSED", "repository is not readable");
      }
      throw new CloneCliError("EINTERRUPTED", `repository probe failed (${probe.status})`);
    } catch (error) {
      if (error instanceof CloneCliError) throw error;
      throw new CloneCliError(
        "EINTERRUPTED",
        error instanceof Error ? error.message : "repository probe failed",
      );
    }
  }
  if (response.status === 404 && credentials === null) {
    return { project: options.repo, directFallback: true };
  }
  throw new CloneCliError("EREFUSED", errorText(body));
}

function targetState(directory: string): { readonly existed: boolean } {
  if (!existsSync(directory)) return { existed: false };
  let stat;
  try {
    stat = lstatSync(directory);
  } catch (error) {
    throw new CloneCliError("ETARGET_NOT_EMPTY", `cannot inspect target: ${String(error)}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || readdirSync(directory).length > 0) {
    throw new CloneCliError("ETARGET_NOT_EMPTY", "target directory must be empty");
  }
  return { existed: true };
}

function safeTarget(root: string, path: string): string {
  if (!isValidFsPath(path)) throw new CloneCliError("ECORRUPT_EVENT", `invalid tree path ${path}`);
  if (path === ".ef" || path.startsWith(".ef/")) {
    throw new CloneCliError("ECORRUPT_EVENT", `tree path is reserved: ${path}`);
  }
  const target = resolve(root, ...path.split("/"));
  const prefix = `${root.endsWith("/") ? root : `${root}/`}`;
  if (target !== root && !target.startsWith(prefix)) {
    throw new CloneCliError("ECORRUPT_EVENT", `tree path escapes target: ${path}`);
  }
  return target;
}

function ordered<T>(values: Iterable<T>, compare: (left: T, right: T) => number): T[] {
  const result: T[] = [];
  for (const value of values) {
    let index = 0;
    while (index < result.length && compare(result[index]!, value) <= 0) index += 1;
    result.splice(index, 0, value);
  }
  return result;
}

function materializeTree(
  root: string,
  state: FsTree,
  readFile: (path: string) => Promise<Uint8Array>,
): Promise<void> {
  for (const path of ordered(
    Object.keys(state.dirs),
    (left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right),
  )) {
    const target = safeTarget(root, path);
    mkdirSync(target, { recursive: false, mode: 0o755 });
  }
  return (async () => {
    for (const path of ordered(Object.keys(state.files), (left, right) =>
      left.localeCompare(right),
    )) {
      const target = safeTarget(root, path);
      const parent = dirname(target);
      if (!existsSync(parent) || !lstatSync(parent).isDirectory()) {
        throw new CloneCliError("ECORRUPT_EVENT", `file parent was not materialized: ${path}`);
      }
      const bytes =
        contentMap(state).get(state.files[path]!.contentStreamId) ?? (await readFile(path));
      const file = state.files[path]!;
      if (bytes.byteLength !== file.size) {
        throw new CloneCliError("ECORRUPT_EVENT", `content size mismatch for ${path}`);
      }
      if (digestBytes(bytes) !== file.contentSha256) {
        throw new CloneCliError("ECORRUPT_EVENT", `content digest mismatch for ${path}`);
      }
      // StreamFS has already verified a content digest before returning bytes.
      // The local write is opened exclusively so a concurrent replacement cannot
      // silently turn a successful clone into a different worktree.
      const fd = openSync(target, "wx", 0o600);
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  })();
}

function workspaceFiles(state: FsTree): Readonly<Record<string, WorkspaceFileBase>> {
  const files = Object.create(null) as Record<string, WorkspaceFileBase>;
  for (const path of ordered(Object.keys(state.files), (left, right) =>
    left.localeCompare(right),
  )) {
    const file = state.files[path]!;
    files[path] = {
      base: file.lastContentOffset || BASE_NONE,
      contentSha256: file.contentSha256,
      size: file.size,
    };
  }
  return files;
}

function writeCompleteMarker(directory: string): void {
  const markerDirectory = join(directory, ".ef");
  const temporary = join(markerDirectory, `.complete.${process.pid}.tmp`);
  const bytes = Buffer.from(COMPLETE_MARKER, "utf8");
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, join(markerDirectory, "complete"));
    const dirFd = openSync(markerDirectory, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The marker is either absent or fully renamed; a crash here is invalid
      // until the next explicit workspace check.
    }
  }
}

function workspaceState(
  options: CloneOptions,
  project: string,
  headOffset: Offset,
  state: FsTree,
): WorkspaceState {
  return {
    v: 1,
    identity: {
      server: workspaceServerIdentity(options.serverUrl),
      project,
      repo: options.repo,
      branch: options.branch,
      metadataStreamId: `fs:${options.org}/${options.repo}:${options.branch}:meta`,
    },
    headOffset,
    files: workspaceFiles(state),
  };
}

function workspaceServerIdentity(serverUrl: string): string {
  try {
    const parsed = new URL(serverUrl);
    return `${parsed.protocol}//${parsed.hostname}`;
  } catch {
    return serverUrl.replace(/:\d+(?=\/|$)/, "");
  }
}

function mapFailure(error: unknown): CloneCliError {
  if (error instanceof CloneCliError) return error;
  if (error instanceof SnapshotIntegrityError) {
    return new CloneCliError("ESNAPSHOT_INTEGRITY", error.message);
  }
  if (
    error !== null &&
    typeof error === "object" &&
    "status" in error &&
    (error as { readonly status?: unknown }).status === 410
  ) {
    return new CloneCliError("EBAD_OFFSET", "requested history is below the compaction point");
  }
  if (
    error !== null &&
    typeof error === "object" &&
    "status" in error &&
    (error as { readonly status?: unknown }).status === 400 &&
    "headers" in error &&
    (error as { readonly headers?: unknown }).headers !== null &&
    typeof (error as { readonly headers?: unknown }).headers === "object" &&
    (error as { readonly headers: Record<string, unknown> }).headers[INTERRUPTED_HEADER] === "1"
  ) {
    return new CloneCliError("EINTERRUPTED", "clone transport deadline exceeded");
  }
  if (isDurableNotFound(error))
    return new CloneCliError("ENOT_FOUND", "repository or branch was not found");
  if (
    error instanceof Error &&
    (error.name === "AbortError" || /interrupted|aborted|reset/i.test(error.message))
  ) {
    return new CloneCliError("EINTERRUPTED", error.message);
  }
  return new CloneCliError(
    "ECORRUPT_EVENT",
    error instanceof Error ? error.message : String(error),
  );
}

function isNotFoundFailure(error: unknown): boolean {
  return (
    isDurableNotFound(error) ||
    (error !== null &&
      typeof error === "object" &&
      "status" in error &&
      (error as { readonly status?: unknown }).status === 404)
  );
}

async function cloneDirectory(
  options: CloneOptions,
  environment: NodeJS.ProcessEnv,
  fetcher: typeof fetch,
): Promise<{ readonly checkpoint: Offset; readonly digest: string }> {
  const target = targetState(options.directory);
  const credentials = await loadCredentials(environment);
  const authorized = authFetch(boundedFetch(fetcher), credentials);
  const namespace = await resolveNamespace(options, credentials, authorized);
  if (!target.existed) mkdirSync(options.directory, { recursive: true, mode: 0o755 });
  let committed = false;
  try {
    const repo = new StreamFsRepo(
      options.streamServerUrl,
      authorized,
      `${options.org}/${options.repo}`,
      options.branch,
    );
    let records;
    try {
      records = await repo.rawDump();
    } catch (error) {
      if (!namespace.directFallback || !isNotFoundFailure(error)) throw error;
      if (options.branch === "main") {
        throw new CloneCliError("EREFUSED", "repository is not readable");
      }
      const mainRepo = new StreamFsRepo(
        options.streamServerUrl,
        authorized,
        `${options.org}/${options.repo}`,
        "main",
      );
      try {
        await mainRepo.rawDump();
      } catch (mainError) {
        if (isNotFoundFailure(mainError)) {
          throw new CloneCliError("EREFUSED", "repository is not readable");
        }
        throw mainError;
      }
      throw error;
    }
    const headOffset = (records.at(-1)?.offset ?? "-1") as Offset;
    const checkpoint = options.at ?? headOffset;
    if (options.at !== undefined && !records.some((record) => record.offset === options.at)) {
      throw new CloneCliError(
        "EBAD_OFFSET",
        `offset ${options.at} is not present in the branch log`,
      );
    }
    if (compareOffsets(checkpoint, headOffset) > 0) {
      throw new CloneCliError(
        "EBAD_OFFSET",
        `offset ${checkpoint} is beyond branch head ${headOffset}`,
      );
    }
    const state = await repo.treeAt(checkpoint);
    await materializeTree(options.directory, state, (path) => repo.readFileAt(path, checkpoint));
    const digest = worktreeDigest(state);
    const localDigest = worktreeDigestDirectory(options.directory);
    if (digest !== localDigest) {
      throw new CloneCliError(
        "ECORRUPT_EVENT",
        `materialized digest ${localDigest} does not match ${digest}`,
      );
    }
    saveWorkspace(options.directory, workspaceState(options, namespace.project, checkpoint, state));
    loadWorkspace(options.directory);
    writeCompleteMarker(options.directory);
    committed = true;
    return { checkpoint, digest };
  } finally {
    if (!committed && !target.existed) {
      rmSync(options.directory, { recursive: true, force: true });
    }
  }
}

export async function runClone(
  args: readonly string[],
  io: CliIo,
  dependencies: CloneDependencies = {},
): Promise<number> {
  const environment = dependencies.environment ?? process.env;
  try {
    const options = parseOptions(args, environment);
    const result = await cloneDirectory(options, environment, dependencies.fetcher ?? fetch);
    io.stdout(`checkpoint ${result.checkpoint}\n${result.digest}\n`);
    return 0;
  } catch (error) {
    const failure = mapFailure(error);
    io.stderr(`${failure.message}\n`);
    return failure.exitCode;
  }
}

export function runWorkspaceCheck(args: readonly string[], io: CliIo): number {
  if (args.length !== 2 || args[0] !== "check" || args[1]!.startsWith("--")) {
    io.stderr(`${WORKSPACE_CHECK_USAGE}\n`);
    return 2;
  }
  const directory = resolve(args[1]!);
  try {
    const marker = readFileSync(join(directory, ".ef", "complete"), "utf8");
    if (marker !== COMPLETE_MARKER) throw new Error("complete marker is not canonical");
    loadWorkspace(directory);
    return 0;
  } catch (error) {
    io.stderr(`EWORKSPACE_INVALID: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
