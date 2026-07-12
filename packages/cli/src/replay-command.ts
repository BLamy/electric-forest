import { createReadStream } from "node:fs";
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

export async function readDump(path: string): Promise<readonly DumpRecord[]> {
  if (!path) fail("missing dump path");
  const records: DumpRecord[] = [];
  let lineNumber = 0;
  let previous: Offset | undefined;
  let buffer = "";
  const consume = (line: string): void => {
    lineNumber += 1;
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
    records.push({ ...event, offset } as DumpRecord);
    previous = offset;
  };
  try {
    const input = createReadStream(path, { encoding: "utf8" });
    for await (const chunk of input) {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
  } catch (error) {
    if (error instanceof ReplayCliError) throw error;
    fail(`cannot read dump: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (buffer.length > 0) fail("truncated final line", lineNumber + 1);
  if (records.length === 0) fail("dump is empty");
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

export async function replayDigest(path: string, reducerPath?: string): Promise<string> {
  const [records, reducerModule] = await Promise.all([readDump(path), loadReducer(reducerPath)]);
  const events = records.map(({ offset: _offset, ...event }) => event);
  return stateDigest(replay(events, reducerModule.reducer, reducerModule.initialState));
}

export const defaultInitialState: FixtureState = fixtureInitialState;
