import { fork } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  compareOffsets,
  isEvent,
  stateDigest,
  type Event,
  type Offset,
} from "@eforest/protocol";
import {
  assertCompleteMergeStage,
  BranchResolutionError,
  isFsFastForwardMergeEvent,
  resolveBranchLog,
  treeDigest,
  worktreeDigest,
  type BranchDump,
  type MergeDump,
  type FsTree,
} from "@eforest/streamfs";
import {
  reducerById,
  reducerForStream,
  streamFsReducerDefinition,
  type ReducerDefinition,
} from "@eforest/reducers";
import {
  fixtureInitialState,
  fixtureReducer,
  type FixtureState,
} from "@eforest/protocol/fixtures/reducer";

export interface DumpRecord extends Event {
  readonly offset: Offset;
  readonly line?: number;
}

export interface ReducerModule {
  readonly reducer: (state: unknown, event: Event) => unknown;
  readonly initialState: unknown;
  readonly initialStateForStream?: (streamId: string) => unknown;
}

function registeredReducer(definition: ReducerDefinition): ReducerModule {
  return {
    reducer: definition.reduce,
    initialState: definition.initialState,
    ...(definition.initialStateForStream === undefined
      ? {}
      : { initialStateForStream: definition.initialStateForStream }),
  };
}

export type DigestKind = "tree" | "worktree";

const STREAMFS_REDUCER: ReducerModule = {
  reducer: streamFsReducerDefinition.reduce,
  initialState: streamFsReducerDefinition.initialState,
};

export class ReplayCliError extends Error {
  readonly mergeRejection: boolean;

  constructor(message: string, mergeRejection = false) {
    super(message);
    this.name = "ReplayCliError";
    this.mergeRejection = mergeRejection;
  }
}

function fail(message: string, line?: number): never {
  throw new ReplayCliError(line === undefined ? message : `line ${line}: ${message}`);
}

function validateOffset(value: unknown, line: number): Offset {
  if (typeof value !== "string" || !/^[0-9]+(?:_[0-9]+)?$/.test(value)) {
    fail("invalid offset", line);
  }
  return value as Offset;
}

function parseLine(
  bytes: Uint8Array,
  lineNumber: number,
  previous?: Offset,
  allowSegmentResets = false,
): DumpRecord {
  let line: string;
  try {
    line = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail("invalid UTF-8", lineNumber);
  }
  if (line.endsWith("\r")) fail("non-canonical CRLF line ending", lineNumber);
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    fail("invalid JSON", lineNumber);
  }
  if (canonicalJson(parsed) !== line) fail("non-canonical JSON", lineNumber);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("record must be an object", lineNumber);
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "offset,payload,ts,type") fail("invalid dump fields", lineNumber);
  const offset = validateOffset(record.offset, lineNumber);
  const event = { type: record.type, payload: record.payload, ts: record.ts };
  if (!isEvent(event)) fail("invalid event envelope", lineNumber);
  if (
    previous !== undefined &&
    compareOffsets(previous, offset) >= 0 &&
    !(allowSegmentResets && typeof record.type === "string" && record.type.startsWith("fs."))
  ) {
    fail(previous === offset ? "duplicate offset" : "out-of-order offset", lineNumber);
  }
  return { ...event, offset, line: lineNumber } as DumpRecord;
}

export interface ReadDumpOptions {
  readonly allowEmpty?: boolean;
  /** Resolved branch logs concatenate independent fs offset spaces. */
  readonly allowSegmentResets?: boolean;
}

export async function* iterateDump(
  path: string,
  options: ReadDumpOptions = {},
): AsyncGenerator<DumpRecord> {
  if (!path) fail("missing dump path");
  let lineNumber = 0;
  let previous: Offset | undefined;
  let buffer = Buffer.alloc(0);
  try {
    const input = createReadStream(path);
    for await (const chunk of input) {
      buffer = Buffer.concat([buffer, chunk]);
      let newline = buffer.indexOf(0x0a);
      while (newline >= 0) {
        lineNumber += 1;
        const record = parseLine(
          buffer.subarray(0, newline),
          lineNumber,
          previous,
          options.allowSegmentResets === true,
        );
        yield record;
        previous = record.offset;
        buffer = buffer.subarray(newline + 1);
        newline = buffer.indexOf(0x0a);
      }
    }
  } catch (error) {
    if (error instanceof ReplayCliError) throw error;
    fail(`cannot read dump: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (buffer.length > 0) fail("truncated final line", lineNumber + 1);
  if (lineNumber === 0 && !options.allowEmpty) fail("dump is empty");
}

export async function readDump(
  path: string,
  options: ReadDumpOptions = {},
): Promise<readonly DumpRecord[]> {
  const records: DumpRecord[] = [];
  try {
    for await (const record of iterateDump(path, options)) records.push(record);
  } catch (error) {
    if (error instanceof ReplayCliError) {
      throw new ReplayCliError(`${path}: ${error.message}`);
    }
    throw error;
  }
  return records;
}

export async function loadReducer(modulePath?: string): Promise<ReducerModule> {
  if (!modulePath) {
    return {
      reducer: fixtureReducer as (state: unknown, event: Event) => unknown,
      initialState: fixtureInitialState,
    };
  }
  const definition = reducerById(modulePath);
  if (definition !== undefined) return registeredReducer(definition);
  try {
    const loaded = (await import(pathToFileURL(modulePath).href)) as {
      reducer?: unknown;
      default?: unknown;
      initialState?: unknown;
      initialStateForStream?: unknown;
    };
    const reducer = loaded.reducer ?? loaded.default;
    if (typeof reducer !== "function" || !("initialState" in loaded)) {
      fail("reducer module must export reducer (or default) and initialState");
    }
    if ("initialStateForStream" in loaded && typeof loaded.initialStateForStream !== "function") {
      fail("reducer module initialStateForStream export must be a function");
    }
    return {
      reducer: reducer as (state: unknown, event: Event) => unknown,
      initialState: loaded.initialState,
      ...(typeof loaded.initialStateForStream === "function"
        ? {
            initialStateForStream: loaded.initialStateForStream as (streamId: string) => unknown,
          }
        : {}),
    };
  } catch (error) {
    if (error instanceof ReplayCliError) throw error;
    fail(`cannot load reducer: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function digestRecords(
  records: readonly DumpRecord[],
  reducerModule: ReducerModule,
  prefixLength = records.length,
  digestKind: DigestKind = "tree",
): string {
  let state = reducerModule.initialState;
  for (const [index, record] of records.slice(0, prefixLength).entries()) {
    const event = Object.fromEntries(
      Object.entries(record).filter(([key]) => key !== "line"),
    ) as Event;
    try {
      state = reducerModule.reducer(state, event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(`reducer rejected event: ${message}`, record.line ?? index + 1);
    }
  }
  if (reducerModule.reducer === streamFsReducerDefinition.reduce) {
    try {
      assertCompleteMergeStage(state as FsTree);
    } catch (error) {
      fail(
        `reducer rejected final state: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return digestKind === "worktree"
      ? worktreeDigest(state as FsTree)
      : treeDigest(state as FsTree);
  }
  return stateDigest(state);
}

export async function replayDigestLocal(
  path: string,
  reducerPath?: string,
  digestKind: DigestKind = "tree",
  streamId?: string,
): Promise<string> {
  const records = await readDump(path);
  const streamDefinition = streamId === undefined ? undefined : reducerForStream(streamId);
  const inferredPr =
    reducerPath === undefined &&
    streamId === undefined &&
    records.length > 0 &&
    records.every((record) => record.type.startsWith("pr."))
      ? reducerById("pr")
      : undefined;
  let reducerModule =
    reducerPath === undefined && streamDefinition !== undefined
      ? registeredReducer(streamDefinition)
      : reducerPath === undefined && inferredPr !== undefined
        ? registeredReducer(inferredPr)
        : reducerPath === undefined && records.some((record) => record.type.startsWith("fs."))
          ? STREAMFS_REDUCER
          : await loadReducer(reducerPath);
  if (streamId !== undefined) {
    if (reducerModule.initialStateForStream === undefined) {
      fail("reducer module must export initialStateForStream to use a stream identity");
    }
    let initialState: unknown;
    try {
      initialState = reducerModule.initialStateForStream(streamId);
    } catch (error) {
      fail(
        `reducer initialStateForStream failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    reducerModule = { ...reducerModule, initialState };
  }
  return digestRecords(records, reducerModule, records.length, digestKind);
}

export interface BranchReplayOptions {
  readonly parentPaths?: readonly string[];
  /** Stream identities matching parentPaths in the same order. */
  readonly parentStreamIds?: readonly string[];
  readonly until?: Offset;
  readonly emitLogPath?: string;
  readonly mergeSourcePaths?: readonly string[];
}

export async function replayBranchDigest(
  path: string,
  options: BranchReplayOptions = {},
  reducerPath?: string,
  digestKind: DigestKind = "tree",
): Promise<string> {
  const parentPaths = options.parentPaths ?? [];
  const parentStreamIds = options.parentStreamIds ?? [];
  if (parentStreamIds.length !== parentPaths.length) {
    throw new ReplayCliError(
      `branch/parent-mismatch: provide one --parent-stream-id for each --parent dump (parents=${parentPaths.length}, ids=${parentStreamIds.length})`,
    );
  }
  const dumps: BranchDump[] = [];
  const leafRecords = await readDump(path);
  dumps.push({ records: leafRecords });
  if (
    !leafRecords.some((record) => record.type.startsWith("fs.")) &&
    parentPaths.length === 0 &&
    (options.mergeSourcePaths ?? []).length === 0 &&
    options.until === undefined &&
    options.emitLogPath === undefined
  ) {
    return replayDigest(path, reducerPath, digestKind);
  }
  for (const [index, dumpPath] of parentPaths.entries()) {
    dumps.push({ streamId: parentStreamIds[index]!, records: await readDump(dumpPath) });
  }
  const mergeSourcePaths = options.mergeSourcePaths ?? [];
  const mergeCandidates = leafRecords.filter((record) => record.type === "fs.branch.merge");
  const fastForwardCandidates = mergeCandidates.filter(
    (record) =>
      record.payload !== null &&
      typeof record.payload === "object" &&
      !Array.isArray(record.payload) &&
      (record.payload as { readonly v?: unknown }).v === 1,
  );
  const mergeEvents = leafRecords.filter((record) =>
    isFsFastForwardMergeEvent({ type: record.type, payload: record.payload, ts: record.ts }),
  );
  if (fastForwardCandidates.length !== mergeEvents.length) {
    throw new ReplayCliError("fs/merge-malformed: merge event payload is invalid", true);
  }
  if (mergeSourcePaths.length !== mergeEvents.length) {
    throw new ReplayCliError(
      `merge/source-mismatch: expected ${mergeEvents.length} --merge-source dump(s), got ${mergeSourcePaths.length}`,
      fastForwardCandidates.length > 0,
    );
  }
  const mergeSources: MergeDump[] = [];
  try {
    for (const [index, mergeSourcePath] of mergeSourcePaths.entries()) {
      mergeSources.push({
        streamId: (mergeEvents[index]!.payload as { readonly sourceStreamId: string })
          .sourceStreamId,
        records: await readDump(mergeSourcePath),
      });
    }
  } catch (error) {
    if (error instanceof ReplayCliError && fastForwardCandidates.length > 0) {
      throw new ReplayCliError(error.message, true);
    }
    throw error;
  }
  let records: readonly DumpRecord[];
  try {
    records = resolveBranchLog(dumps, options.until, mergeSources) as DumpRecord[];
  } catch (error) {
    if (error instanceof BranchResolutionError && mergeCandidates.length > 0) {
      throw new ReplayCliError(error.message, true);
    }
    throw error;
  }
  if (options.emitLogPath !== undefined) {
    const body = records
      .map((record) =>
        canonicalJson({
          offset: record.offset,
          payload: record.payload,
          ts: record.ts,
          type: record.type,
        }),
      )
      .join("\n");
    writeFileSync(options.emitLogPath, body.length === 0 ? "" : `${body}\n`, "utf8");
  }
  const reducerModule =
    reducerPath === undefined && records.some((record) => record.type.startsWith("fs."))
      ? STREAMFS_REDUCER
      : await loadReducer(reducerPath);
  return digestRecords(records, reducerModule, records.length, digestKind);
}

export async function bootstrapDigest(
  artifactPath: string,
  tailPath: string,
  reducerPath?: string,
  digestKind: DigestKind = "tree",
): Promise<string> {
  let artifactText: string;
  try {
    artifactText = readFileSync(artifactPath, "utf8");
  } catch (error) {
    fail(
      `cannot read snapshot artifact: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let state: unknown;
  try {
    const canonicalArtifact = artifactText.endsWith("\n")
      ? artifactText.slice(0, -1)
      : artifactText;
    state = JSON.parse(canonicalArtifact) as unknown;
    if (canonicalJson(state) !== canonicalArtifact) fail("snapshot artifact is not canonical JSON");
  } catch (error) {
    if (error instanceof ReplayCliError) throw error;
    fail(`invalid snapshot artifact: ${error instanceof Error ? error.message : String(error)}`);
  }
  const reducer = reducerPath === undefined ? STREAMFS_REDUCER : await loadReducer(reducerPath);
  const records = await readDump(tailPath);
  for (const [index, record] of records.entries()) {
    try {
      const event = Object.fromEntries(
        Object.entries(record).filter(([key]) => key !== "line"),
      ) as Event;
      state = reducer.reducer(state, event);
    } catch (error) {
      fail(
        `reducer rejected event: ${error instanceof Error ? error.message : String(error)}`,
        record.line ?? index + 1,
      );
    }
  }
  if (reducer.reducer === streamFsReducerDefinition.reduce) {
    try {
      assertCompleteMergeStage(state as FsTree);
    } catch (error) {
      fail(
        `reducer rejected final state: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return digestKind === "worktree"
      ? worktreeDigest(state as FsTree)
      : treeDigest(state as FsTree);
  }
  return stateDigest(state);
}

interface WorkerResult {
  readonly ok: boolean;
  readonly digest?: string;
  readonly error?: string;
}

export async function replayDigest(
  path: string,
  reducerPath?: string,
  digestKind: DigestKind = "tree",
  streamId?: string,
): Promise<string> {
  if (!reducerPath || digestKind === "worktree") {
    return replayDigestLocal(path, reducerPath, digestKind, streamId);
  }
  return new Promise<string>((resolve, reject) => {
    const worker = fork(
      fileURLToPath(new URL("./reducer-worker.js", import.meta.url)),
      streamId === undefined ? [path, reducerPath] : [path, reducerPath, streamId],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    const messages: WorkerResult[] = [];
    let workerError: Error | undefined;
    worker.on("message", (message: WorkerResult) => messages.push(message));
    worker.once("error", (error) => {
      workerError = error;
    });
    worker.once("exit", (code) => {
      if (workerError) {
        reject(new ReplayCliError(`reducer worker failed: ${workerError.message}`));
        return;
      }
      if (code !== 0 || messages.length !== 1) {
        reject(new ReplayCliError("reducer worker returned an invalid result transcript"));
        return;
      }
      const [message] = messages;
      if (
        message?.ok === true &&
        typeof message.digest === "string" &&
        /^[0-9a-f]{64}$/.test(message.digest)
      ) {
        resolve(message.digest);
      } else if (message?.ok === false && typeof message.error === "string") {
        reject(new ReplayCliError(message.error));
      } else {
        reject(new ReplayCliError("reducer worker returned an invalid result"));
      }
    });
  });
}

export const defaultInitialState: FixtureState = fixtureInitialState;
