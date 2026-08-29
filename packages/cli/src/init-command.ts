import { createDurableJsonStream, appendDurableJson, readDurableJson } from "@eforest/client";
import type { StreamRecord } from "@eforest/client";
import { streamFsReducerDefinition } from "@eforest/reducers";
import { BRANCH_EVENT_VERSION, worktreeDigest, type FsTree } from "@eforest/streamfs";
import { worktreeDigestDirectory } from "@eforest/streamfs/worktree-node";
import {
  BASE_NONE,
  save as saveWorkspace,
  type WorkspaceFileBase,
  type WorkspaceState,
} from "@eforest/workspace";
import { canonicalJson, type Event, type Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import { existsSync, lstatSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { loadCredentials, NO_CREDENTIALS_MESSAGE, type StoredCredentials } from "./credentials.js";
import type { CliIo } from "./cli.js";
import { uploadTree, type TreeUploadTransport } from "./sync/tree-upload.js";

export const INIT_USAGE =
  "Usage: ef init [--org <org>] [--project <name>] [--repo <name>] [--visibility public|private] [dir]";

export const INIT_NO_CREDENTIALS_EXIT = 10;
export const INIT_ALREADY_INITIALIZED_EXIT = 14;
export const INIT_DIGEST_MISMATCH_EXIT = 15;
export const INIT_WORKSPACE_PATH_CONFLICT_EXIT = 16;

export class InitCliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "InitCliError";
  }
}

interface InitOptions {
  readonly directory: string;
  readonly org: string;
  readonly project: string;
  readonly repo: string;
  readonly visibility: "public" | "private";
  readonly serverUrl: string;
  readonly streamServerUrl: string;
}

interface NamespaceResolution {
  readonly org: string;
  readonly projects: readonly string[];
  readonly repos: readonly {
    readonly name: string;
    readonly project: string;
    readonly visibility: "public" | "private";
  }[];
}

interface NamespaceResponse {
  readonly ok?: boolean;
  readonly resolution?: unknown;
}

interface ServerErrorBody {
  readonly error?: {
    readonly class?: unknown;
    readonly code?: unknown;
    readonly reason?: unknown;
  };
}

function trimUrl(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.length === 0) throw new InitCliError("init/invalid-server", "server URL is empty");
  return trimmed;
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function existsAsNonDirectory(path: string): boolean {
  try {
    return !lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function streamUrl(baseUrl: string, streamId: string): string {
  return `${baseUrl}/streams/${encodeURIComponent(streamId)}`;
}

function errorValue(body: unknown): string {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const error = (body as ServerErrorBody).error;
    if (error !== undefined) {
      for (const value of [error.reason, error.class, error.code]) {
        if (typeof value === "string" && value.length > 0) return value;
      }
    }
  }
  return "init/request-refused";
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function offsetAt(index: number): Offset {
  return offsetForOrdinal(index);
}

function replayWorktree(records: readonly StreamRecord[]): {
  readonly state: FsTree;
  readonly digest: string;
} {
  let state = streamFsReducerDefinition.initialState as FsTree;
  for (const record of records) state = streamFsReducerDefinition.reduce(state, record) as FsTree;
  return { state, digest: worktreeDigest(state) };
}

function workspaceFiles(state: FsTree): Readonly<Record<string, WorkspaceFileBase>> {
  const files = Object.create(null) as Record<string, WorkspaceFileBase>;
  for (const [path, file] of Object.entries(state.files)) {
    files[path] = {
      base: file.lastContentOffset || BASE_NONE,
      contentSha256: file.contentSha256,
      size: file.size,
    };
  }
  return files;
}

class InitHttpClient {
  private readonly authorization: string;

  constructor(
    private readonly serverUrl: string,
    private readonly streamServerUrl: string,
    credentials: StoredCredentials,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.authorization = `Bearer ${credentials.accessToken}`;
  }

  private headers(contentType = false): Record<string, string> {
    return {
      authorization: this.authorization,
      ...(contentType ? { "content-type": "application/json" } : {}),
    };
  }

  async namespace(org: string): Promise<NamespaceResolution> {
    const response = await this.fetcher(
      `${this.serverUrl}/api/namespaces/${encodeURIComponent(org)}`,
      { headers: this.headers() },
    );
    const body = await responseBody(response);
    if (!response.ok) {
      throw new InitCliError(
        errorValue(body),
        `namespace lookup refused (${String(response.status)})`,
        response.status === 401 ? 13 : 1,
      );
    }
    const resolution = (body as NamespaceResponse | undefined)?.resolution;
    if (
      resolution === null ||
      typeof resolution !== "object" ||
      Array.isArray(resolution) ||
      (resolution as { readonly found?: unknown }).found === false
    ) {
      throw new InitCliError("ns/org-not-found", `organization ${org} was not found`);
    }
    const value = resolution as Partial<NamespaceResolution>;
    if (
      value.org !== org ||
      !Array.isArray(value.projects) ||
      !value.projects.every((project) => typeof project === "string") ||
      !Array.isArray(value.repos)
    ) {
      throw new InitCliError(
        "init/invalid-namespace",
        "namespace resolver returned an invalid view",
      );
    }
    return value as NamespaceResolution;
  }

  async dispatch(streamId: string, event: Event): Promise<void> {
    const response = await this.fetcher(`${this.serverUrl}/api/dispatch`, {
      method: "POST",
      headers: this.headers(true),
      body: canonicalJson({ streamId, event }),
    });
    const body = await responseBody(response);
    if (!response.ok) {
      const reason = errorValue(body);
      throw new InitCliError(
        reason,
        `${reason} (${String(response.status)})`,
        response.status === 401 ? 13 : 1,
      );
    }
  }

  async createContentStream(streamId: string): Promise<void> {
    try {
      await createDurableJsonStream({
        url: streamUrl(this.streamServerUrl, streamId),
        fetch: this.fetcher,
        headers: this.headers(),
      });
    } catch (error) {
      throw new InitCliError(
        "init/content-stream-create-failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async appendContent(streamId: string, event: Event): Promise<void> {
    try {
      const offset = offsetAt(0);
      await appendDurableJson(
        {
          url: streamUrl(this.streamServerUrl, streamId),
          fetch: this.fetcher,
          headers: this.headers(),
        },
        { ...event, offset },
        offset,
      );
    } catch (error) {
      throw new InitCliError(
        "init/content-stream-append-failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async createMetadataStream(streamId: string): Promise<void> {
    try {
      await createDurableJsonStream({
        url: streamUrl(this.streamServerUrl, streamId),
        fetch: this.fetcher,
        headers: this.headers(),
      });
    } catch (error) {
      throw new InitCliError(
        "init/metadata-stream-create-failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async metadata(streamId: string): Promise<readonly StreamRecord[]> {
    try {
      return await readDurableJson<StreamRecord>({
        url: streamUrl(this.streamServerUrl, streamId),
        fetch: this.fetcher,
        headers: this.headers(),
      });
    } catch (error) {
      throw new InitCliError(
        "init/metadata-read-failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

function parseOptions(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): InitOptions | undefined {
  let directory: string | undefined;
  let org = environment.EF_ORG;
  let project: string | undefined;
  let repo: string | undefined;
  let visibility: "public" | "private" = "private";
  let serverUrl = environment.EF_SERVER_URL;
  let streamServerUrl = environment.EF_STREAM_SERVER_URL ?? environment.EFOREST_SERVER_URL;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const next = args[index + 1];
    if (
      argument === "--org" ||
      argument === "--project" ||
      argument === "--repo" ||
      argument === "--server" ||
      argument === "--stream-server"
    ) {
      if (next === undefined || next.startsWith("--"))
        throw new InitCliError("usage", INIT_USAGE, 2);
      if (argument === "--org") org = next;
      else if (argument === "--project") project = next;
      else if (argument === "--repo") repo = next;
      else if (argument === "--server") serverUrl = next;
      else streamServerUrl = next;
      index += 1;
    } else if (argument === "--visibility") {
      if (next !== "public" && next !== "private") throw new InitCliError("usage", INIT_USAGE, 2);
      visibility = next;
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new InitCliError("usage", INIT_USAGE, 2);
    } else if (directory === undefined) {
      directory = argument;
    } else {
      throw new InitCliError("usage", INIT_USAGE, 2);
    }
  }
  const root = resolve(directory ?? ".");
  const defaultName = basename(root);
  if (org === undefined || org.length === 0)
    throw new InitCliError("ns/org-required", "--org is required", 2);
  if (serverUrl === undefined || serverUrl.length === 0) {
    throw new InitCliError("init/server-required", "EF_SERVER_URL is required", 2);
  }
  if (streamServerUrl === undefined || streamServerUrl.length === 0) streamServerUrl = serverUrl;
  return {
    directory: root,
    org,
    project: project ?? defaultName,
    repo: repo ?? defaultName,
    visibility,
    serverUrl: trimUrl(serverUrl),
    streamServerUrl: trimUrl(streamServerUrl),
  };
}

async function initDirectory(
  options: InitOptions,
  credentials: StoredCredentials,
  fetcher: typeof fetch,
): Promise<{
  readonly digest: string;
  readonly headOffset: Offset;
  readonly metadataStreamId: string;
}> {
  const client = new InitHttpClient(
    options.serverUrl,
    options.streamServerUrl,
    credentials,
    fetcher,
  );
  // Validate the local tree before any namespace mutation. The upload engine
  // uses the same enumerator again and returns its projection for the actual
  // digest comparison after the server replay.
  worktreeDigestDirectory(options.directory);
  const namespace = await client.namespace(options.org);
  if (!namespace.projects.includes(options.project)) {
    await client.dispatch(`ns:org:${options.org}`, {
      type: "ns.project.create",
      payload: { v: 1, name: options.project },
      ts: Date.now(),
    });
  }
  const repoPrefix = `fs:${options.org}/${options.repo}`;
  await client.dispatch(`ns:org:${options.org}`, {
    type: "ns.repo.create",
    payload: {
      v: 1,
      name: options.repo,
      project: options.project,
      visibility: options.visibility,
    },
    ts: Date.now(),
  });

  const metadataStreamId = `${repoPrefix}:main:meta`;
  await client.createMetadataStream(metadataStreamId);
  await client.dispatch(metadataStreamId, {
    type: "fs.branch.genesis",
    payload: { v: BRANCH_EVENT_VERSION, branch: "main" },
    ts: Date.now(),
  });
  const transport: TreeUploadTransport = {
    dispatch: (event) => client.dispatch(metadataStreamId, event),
    createContentStream: (streamId) => client.createContentStream(streamId),
    appendContent: (streamId, event) => client.appendContent(streamId, event),
  };
  const upload = await uploadTree({
    directory: options.directory,
    branchStreamId: metadataStreamId,
    contentStreamPrefix: `${repoPrefix}:main:file:`,
    transport,
  });
  const records = await client.metadata(metadataStreamId);
  const replayed = replayWorktree(records);
  const localDigest = worktreeDigest(upload.projection);
  if (replayed.digest !== localDigest) {
    throw new InitCliError(
      "init/digest-mismatch",
      `server replay ${replayed.digest} does not match local tree ${localDigest}`,
      INIT_DIGEST_MISMATCH_EXIT,
    );
  }
  const headOffset = records.at(-1)?.offset ?? ("-1" as Offset);
  const state: WorkspaceState = {
    v: 1,
    identity: {
      server: options.serverUrl,
      project: options.project,
      repo: options.repo,
      branch: "main",
      metadataStreamId,
    },
    headOffset,
    files: workspaceFiles(replayed.state),
  };
  saveWorkspace(options.directory, state);
  return { digest: localDigest, headOffset, metadataStreamId };
}

export async function runInit(
  args: readonly string[],
  io: CliIo,
  environment: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  let options: InitOptions;
  try {
    const parsed = parseOptions(args, environment);
    if (parsed === undefined) {
      io.stderr(`${INIT_USAGE}\n`);
      return 2;
    }
    options = parsed;
  } catch (error) {
    if (error instanceof InitCliError) {
      io.stderr(`${error.code === "usage" ? error.message : `${error.code}: ${error.message}`}\n`);
      return error.exitCode;
    }
    throw error;
  }
  const efPath = join(options.directory, ".ef");
  if (isDirectory(efPath)) {
    io.stderr(`init/already-initialized: ${efPath}\n`);
    return INIT_ALREADY_INITIALIZED_EXIT;
  }
  // E4-T01 deliberately measures a root regular file named `.ef`, but the
  // frozen workspace format also requires a `.ef/` directory.  These paths
  // cannot coexist on the local filesystem; refuse before credentials or any
  // dispatch so init never leaves a remote half-adoption behind.
  if (existsAsNonDirectory(efPath)) {
    io.stderr(`init/workspace-path-conflict: ${efPath} must be a directory\n`);
    return INIT_WORKSPACE_PATH_CONFLICT_EXIT;
  }
  let credentials: StoredCredentials | null;
  try {
    credentials = await loadCredentials(environment);
  } catch (error) {
    io.stderr(`credentials-invalid: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (credentials === null) {
    io.stderr(`no-credentials: ${NO_CREDENTIALS_MESSAGE}\n`);
    return INIT_NO_CREDENTIALS_EXIT;
  }
  let workspaceAttempted = true;
  try {
    // Keep the final local commit as the last mutation. If save() is fault
    // injected after creating .ef, remove only the directory created by this
    // invocation; a pre-existing .ef was refused above and is never touched.
    const result = await initDirectory(options, credentials, fetcher);
    io.stdout(`${result.digest}\n`);
    return 0;
  } catch (error) {
    if (workspaceAttempted && !existsSync(efPath)) workspaceAttempted = false;
    if (workspaceAttempted && isDirectory(efPath)) rmSync(efPath, { recursive: true, force: true });
    if (error instanceof InitCliError) {
      io.stderr(`${error.code}: ${error.message}\n`);
      return error.exitCode;
    }
    io.stderr(`init/failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
