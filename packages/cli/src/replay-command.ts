import { fork } from "node:child_process";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  compareOffsets,
  isEvent,
  replay,
  stateDigest,
  type Event,
  type Offset,
} from "@eforest/protocol";
import {
  fixtureInitialState,
  fixtureReducer,
  type FixtureState,
} from "@eforest/protocol/fixtures/reducer";

export interface DumpRecord extends Event {
  readonly offset: Offset;
}

export interface ReducerModule {
  readonly reducer: (state: unknown, event: Event) => unknown;
  readonly initialState: unknown;
}

export class ReplayCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayCliError";
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

function parseLine(bytes: Uint8Array, lineNumber: number, previous?: Offset): DumpRecord {
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
  if (previous !== undefined && compareOffsets(previous, offset) >= 0) {
    fail(previous === offset ? "duplicate offset" : "out-of-order offset", lineNumber);
  }
  return { ...event, offset } as DumpRecord;
}

export async function* iterateDump(path: string): AsyncGenerator<DumpRecord> {
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
        const record = parseLine(buffer.subarray(0, newline), lineNumber, previous);
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
  if (lineNumber === 0) fail("dump is empty");
}

export async function readDump(path: string): Promise<readonly DumpRecord[]> {
  const records: DumpRecord[] = [];
  for await (const record of iterateDump(path)) records.push(record);
  return records;
}

async function loadReducer(modulePath?: string): Promise<ReducerModule> {
  if (!modulePath) {
    return {
      reducer: fixtureReducer as (state: unknown, event: Event) => unknown,
      initialState: fixtureInitialState,
    };
  }
  try {
    const loaded = (await import(pathToFileURL(modulePath).href)) as {
      reducer?: unknown;
      default?: unknown;
      initialState?: unknown;
    };
    const reducer = loaded.reducer ?? loaded.default;
    if (typeof reducer !== "function" || !("initialState" in loaded)) {
      fail("reducer module must export reducer (or default) and initialState");
    }
    return {
      reducer: reducer as (state: unknown, event: Event) => unknown,
      initialState: loaded.initialState,
    };
  } catch (error) {
    if (error instanceof ReplayCliError) throw error;
    fail(`cannot load reducer: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function replayDigestLocal(path: string, reducerPath?: string): Promise<string> {
  const reducerModule = await loadReducer(reducerPath);
  let state = reducerModule.initialState;
  for await (const record of iterateDump(path)) {
    const event: Event = { type: record.type, payload: record.payload, ts: record.ts };
    state = replay([event], reducerModule.reducer, state);
  }
  return stateDigest(state);
}

interface WorkerResult {
  readonly ok: boolean;
  readonly digest?: string;
  readonly error?: string;
}

export async function replayDigest(path: string, reducerPath?: string): Promise<string> {
  if (!reducerPath) return replayDigestLocal(path);
  return new Promise<string>((resolve, reject) => {
    const worker = fork(
      fileURLToPath(new URL("./reducer-worker.js", import.meta.url)),
      [path, reducerPath],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    let resultReceived = false;
    worker.once("message", (message: WorkerResult) => {
      resultReceived = true;
      if (message.ok && typeof message.digest === "string") resolve(message.digest);
      else reject(new ReplayCliError(message.error ?? "custom reducer failed"));
    });
    worker.once("error", (error) =>
      reject(new ReplayCliError(`reducer worker failed: ${error.message}`)),
    );
    worker.once("exit", (code) => {
      if (!resultReceived)
        reject(new ReplayCliError(`reducer worker exited without a digest (${code})`));
    });
  });
}

export const defaultInitialState: FixtureState = fixtureInitialState;
