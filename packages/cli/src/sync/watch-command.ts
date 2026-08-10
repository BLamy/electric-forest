import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { closeSync, existsSync, fsyncSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { load as loadWorkspace } from "@eforest/workspace";
import type { CliIo } from "../cli.js";
import { loadCredentials, type StoredCredentials } from "../credentials.js";
import { DuplexWatchEngine, type DuplexEngineOptions } from "./duplex.js";
import {
  isProcessAlive,
  readWatchPid,
  readWatchState,
  watchPidPath,
  watchReadyPath,
} from "./watch-state.js";

export const WATCH_COMMAND_USAGE =
  "Usage: ef watch start|stop|status [--dir <dir>] | ef watch --up ... | ef watch --down ...";
export const WATCH_START_TIMEOUT_MS = 15_000;

export type WatchCommandErrorCode =
  | "cli/not-a-workspace"
  | "cli/watch-already-running"
  | "cli/watch-not-running"
  | "cli/watch-start-failed"
  | "cli/watch-stop-timeout";

export class WatchCommandError extends Error {
  readonly exitCode = 3;

  constructor(
    readonly code: WatchCommandErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "WatchCommandError";
  }
}

export interface WatchCommandDependencies {
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetcher?: typeof fetch;
  readonly writerId?: string;
  readonly spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  readonly timeoutMs?: number;
}

interface ParsedWatchCommand {
  readonly directory: string;
}

function parseDirectory(args: readonly string[], cwd: string): ParsedWatchCommand {
  let directory = cwd;
  for (let index = 0; index < args.length; index += 1) {
    if (
      args[index] !== "--dir" ||
      args[index + 1] === undefined ||
      args[index + 1]!.startsWith("--")
    ) {
      throw new WatchCommandError("cli/not-a-workspace", WATCH_COMMAND_USAGE);
    }
    directory = resolve(cwd, args[++index]!);
  }
  return { directory };
}

function findWorkspaceRoot(start: string): string {
  let directory = resolve(start);
  while (true) {
    if (existsSync(join(directory, ".ef"))) {
      try {
        loadWorkspace(directory);
        return directory;
      } catch (error) {
        throw new WatchCommandError(
          "cli/not-a-workspace",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new WatchCommandError("cli/not-a-workspace", `no .ef workspace found from ${start}`);
    }
    directory = parent;
  }
}

function remove(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function removeOwnPidfile(root: string): void {
  if (readWatchPid(root) === process.pid) remove(watchPidPath(root));
}

function reservePidfile(root: string): { readonly path: string; readonly stale: boolean } {
  const path = watchPidPath(root);
  let stale = false;
  for (;;) {
    const pid = readWatchPid(root);
    if (pid !== undefined && isProcessAlive(pid)) {
      throw new WatchCommandError(
        "cli/watch-already-running",
        `watcher is already running with pid ${pid}`,
      );
    }
    if (existsSync(path)) {
      remove(path);
      stale = true;
    }
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, `${process.pid}\n`);
        fsyncSync(fd);
      } finally {
        // The descriptor is deliberately closed before the child is spawned;
        // the exclusive create above is the lifecycle fence.
        closeSync(fd);
      }
      return { path, stale };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function decodeJwtSubject(accessToken: string): string | undefined {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      readonly sub?: unknown;
    };
    return typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

function serverUrls(
  root: string,
  environment: NodeJS.ProcessEnv,
): {
  readonly serverUrl: string;
  readonly streamServerUrl: string;
} {
  const workspace = loadWorkspace(root);
  const serverUrl =
    environment.EF_SERVER_URL ??
    environment.EFOREST_SERVER_URL ??
    environment.EF_SERVER ??
    workspace.identity.server;
  const streamServerUrl =
    environment.EF_STREAM_SERVER_URL ?? environment.EFOREST_SERVER_URL ?? serverUrl;
  return { serverUrl, streamServerUrl };
}

function spawnDaemon(
  root: string,
  environment: NodeJS.ProcessEnv,
  writerId: string | undefined,
  spawnProcess: (command: string, args: string[], options: SpawnOptions) => ChildProcess,
): ChildProcess {
  const entry = process.argv[1] ?? fileURLToPath(import.meta.url);
  const options: SpawnOptions = {
    cwd: root,
    detached: true,
    stdio: "ignore",
    env: {
      ...environment,
      ...(writerId === undefined ? {} : { EF_WRITER_ID: writerId }),
    },
  };
  return spawnProcess(process.execPath, [entry, "watch", "--daemon", "--dir", root], options);
}

async function waitForReady(root: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pid = readWatchPid(root);
    if (existsSync(watchReadyPath(root)) && pid !== undefined && isProcessAlive(pid)) return;
    if (
      child.exitCode !== null ||
      child.signalCode !== null ||
      (pid !== undefined && !isProcessAlive(pid))
    ) {
      throw new WatchCommandError("cli/watch-start-failed", "watcher exited before becoming ready");
    }
    if (Date.now() >= deadline) {
      throw new WatchCommandError("cli/watch-start-failed", "watcher did not become ready");
    }
    await new Promise<void>((done) => setTimeout(done, 25));
  }
}

async function startWatcher(
  root: string,
  io: CliIo,
  dependencies: WatchCommandDependencies,
): Promise<number> {
  const environment = dependencies.environment ?? process.env;
  const reservation = reservePidfile(root);
  remove(watchReadyPath(root));
  if (reservation.stale) io.stderr("warning: reclaimed stale watcher pidfile\n");
  let credentials: StoredCredentials | null;
  try {
    credentials = await loadCredentials(environment);
  } catch (error) {
    remove(reservation.path);
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (credentials === null) {
    remove(reservation.path);
    io.stderr("No credentials. Run `ef login`.\n");
    return 10;
  }
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  let child: ChildProcess | undefined;
  try {
    child = spawnDaemon(root, environment, dependencies.writerId, spawnProcess);
    if (child.pid === undefined) throw new Error("spawn returned no pid");
    writeFileSync(reservation.path, `${child.pid}\n`, { mode: 0o600 });
    child.unref();
    await waitForReady(root, child, dependencies.timeoutMs ?? WATCH_START_TIMEOUT_MS);
    return 0;
  } catch (error) {
    remove(reservation.path);
    if (child?.pid !== undefined && isProcessAlive(child.pid)) child.kill("SIGTERM");
    const failure =
      error instanceof WatchCommandError
        ? error
        : new WatchCommandError("cli/watch-start-failed", String(error));
    io.stderr(`error: ${failure.message}\n`);
    return failure.exitCode;
  }
}

async function stopWatcher(root: string, io: CliIo, timeoutMs: number): Promise<number> {
  const pid = readWatchPid(root);
  if (pid === undefined || !isProcessAlive(pid)) {
    remove(watchPidPath(root));
    io.stderr("error: cli/watch-not-running: no watcher is running\n");
    return 3;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      remove(watchPidPath(root));
      io.stderr("error: cli/watch-not-running: no watcher is running\n");
      return 3;
    }
    io.stderr(`error: cli/watch-stop-timeout: ${String(error)}\n`);
    return 3;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!existsSync(watchPidPath(root)) || !isProcessAlive(pid)) {
      remove(watchPidPath(root));
      return 0;
    }
    await new Promise<void>((done) => setTimeout(done, 25));
  }
  io.stderr("error: cli/watch-stop-timeout: watcher did not stop gracefully\n");
  return 3;
}

async function runDaemon(
  root: string,
  io: CliIo,
  dependencies: WatchCommandDependencies,
): Promise<number> {
  const environment = dependencies.environment ?? process.env;
  let credentials: StoredCredentials | null;
  try {
    credentials = await loadCredentials(environment);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    removeOwnPidfile(root);
    return 1;
  }
  if (credentials === null) {
    io.stderr("No credentials. Run `ef login`.\n");
    removeOwnPidfile(root);
    return 10;
  }
  let engine: DuplexWatchEngine | undefined;
  let stopping = false;
  let resolveStop!: () => void;
  const stopRequested = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    resolveStop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const urls = serverUrls(root, environment);
    const writerId =
      dependencies.writerId ??
      environment.EF_WRITER_ID ??
      decodeJwtSubject(credentials.accessToken);
    const options: DuplexEngineOptions = {
      root,
      ...urls,
      accessToken: credentials.accessToken,
      ...(writerId === undefined ? {} : { writerId }),
      ...(dependencies.fetcher === undefined ? {} : { fetcher: dependencies.fetcher }),
    };
    engine = new DuplexWatchEngine(options);
    await engine.start();
    writeFileSync(watchReadyPath(root), `${process.pid}\n`, { mode: 0o600 });
    const running = engine.run();
    await Promise.race([running, stopRequested]);
    if (stopping) await engine.close();
    else await running;
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    try {
      await engine?.close();
    } catch {
      // Preserve the original daemon failure.
    }
    return 1;
  } finally {
    remove(watchReadyPath(root));
    removeOwnPidfile(root);
  }
}

export async function runWatchCommand(
  args: readonly string[],
  io: CliIo,
  dependencies: WatchCommandDependencies = {},
): Promise<number> {
  const command = args[0];
  if (command !== "start" && command !== "stop" && command !== "status" && command !== "--daemon") {
    io.stderr(`${WATCH_COMMAND_USAGE}\n`);
    return 2;
  }
  let parsed: ParsedWatchCommand;
  try {
    parsed = parseDirectory(args.slice(1), resolve(dependencies.cwd ?? process.cwd()));
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : WATCH_COMMAND_USAGE}\n`);
    return 2;
  }
  let root: string;
  try {
    root = findWorkspaceRoot(parsed.directory);
  } catch (error) {
    io.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  }
  if (command === "status") {
    const state = readWatchState(root);
    io.stdout(state.running ? `running ${state.pid}\n` : "stopped\n");
    return 0;
  }
  if (command === "stop") {
    return stopWatcher(root, io, dependencies.timeoutMs ?? WATCH_START_TIMEOUT_MS);
  }
  if (command === "--daemon") return runDaemon(root, io, dependencies);
  try {
    return await startWatcher(root, io, dependencies);
  } catch (error) {
    const failure =
      error instanceof WatchCommandError
        ? error
        : new WatchCommandError("cli/watch-start-failed", String(error));
    io.stderr(`error: ${failure.message}\n`);
    return failure.exitCode;
  }
}

export { decodeJwtSubject };
