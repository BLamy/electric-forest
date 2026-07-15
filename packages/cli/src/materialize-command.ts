import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { compareOffsets, stateDigest, type Event, type Offset } from "@eforest/protocol";
import {
  assertCompleteMergeStage,
  contentMap,
  digestBytes,
  fsInitialState,
  fsReducer,
  isValidFsPath,
  patchResultSize,
  treeDigest,
  withContentMap,
  type FsTree,
} from "@eforest/streamfs";
import {
  loadReducer,
  readDump,
  ReplayCliError,
  type DumpRecord,
  type ReducerModule,
} from "./replay-command.js";

function fail(message: string): never {
  throw new ReplayCliError(message);
}

function assertTree(value: unknown): asserts value is FsTree {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Object.hasOwn(value, "files") ||
    !Object.hasOwn(value, "dirs") ||
    !Object.hasOwn(value, "tombstones")
  ) {
    fail("materialize reducer did not produce an fs tree");
  }
}

function assertSafePath(root: string, path: string): string {
  if (!isValidFsPath(path)) fail(`reducer produced an invalid path ${JSON.stringify(path)}`);
  const target = resolve(root, ...path.split("/"));
  const rootWithSeparator = `${root.endsWith("/") ? root : `${root}/`}`;
  if (target !== root && !target.startsWith(rootWithSeparator)) {
    fail(`path escapes materialize root: ${path}`);
  }
  return target;
}

function rejectSymlinkTraversal(root: string, path: string): void {
  let current = root;
  const segments = path.split("/");
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) fail(`path traverses a symlink: ${path}`);
    if (!stat.isDirectory()) fail(`path parent is not a directory: ${path}`);
  }
}

function prepareOut(outPath: string): string {
  const root = resolve(outPath);
  if (existsSync(root)) {
    const stat = lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("--out must name a directory");
    if (readdirSync(root).length > 0) fail("--out must name a nonexistent or empty directory");
  } else {
    mkdirSync(root, { recursive: false });
  }
  return root;
}

function reduceTree(records: readonly DumpRecord[], reducer: ReducerModule): FsTree {
  let state = reducer.initialState;
  for (const [index, record] of records.entries()) {
    const event = recordEvent(record);
    try {
      state = reducer.reducer(state, event);
    } catch (error) {
      fail(
        `reducer rejected event at line ${record.line ?? index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  assertTree(state);
  if (reducer.reducer === (fsReducer as ReducerModule["reducer"])) {
    try {
      assertCompleteMergeStage(state);
    } catch (error) {
      fail(
        `reducer rejected final state: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return state;
}

function recordEvent(record: DumpRecord): Event {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== "line"),
  ) as unknown as Event;
}

interface ExpectedContent {
  readonly digest: string;
  readonly size: number;
}

interface DecodedContent {
  readonly bytes: Uint8Array;
  readonly offset: Offset;
  readonly record: DumpRecord;
}

function effectiveChange(record: DumpRecord): Event {
  const event = recordEvent(record);
  if (event.type !== "fs/merge-change") return event;
  const payload = event.payload as { readonly change?: unknown };
  if (
    payload.change === null ||
    typeof payload.change !== "object" ||
    Array.isArray(payload.change)
  ) {
    return event;
  }
  return payload.change as Event;
}

function movePathMap<T>(values: Map<string, T>, from: string, to: string): void {
  const prefix = `${from}/`;
  for (const [path, value] of [...values.entries()]) {
    if (path === from) {
      values.delete(path);
      values.set(to, value);
    } else if (path.startsWith(prefix)) {
      values.delete(path);
      values.set(`${to}${path.slice(from.length)}`, value);
    }
  }
}

function decodeContent(record: DumpRecord): DecodedContent {
  const event = recordEvent(record);
  let decoded: FsTree;
  try {
    decoded = fsReducer(fsInitialState, event);
  } catch (error) {
    fail(
      `content event at line ${record.line ?? 0} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const payload = event.payload as { readonly contentStreamId?: unknown };
  if (typeof payload.contentStreamId !== "string") {
    fail(`content event at line ${record.line ?? 0} has no stream identity`);
  }
  const bytes = contentMap(decoded).get(payload.contentStreamId);
  if (bytes === undefined) fail(`content event at line ${record.line ?? 0} produced no bytes`);
  return { bytes, offset: record.offset, record };
}

function contentQueues(records: readonly DumpRecord[]): Map<string, readonly DecodedContent[]> {
  const grouped = new Map<string, DecodedContent[]>();
  for (const record of records) {
    const decoded = decodeContent(record);
    const streamId = (record.payload as { readonly contentStreamId: string }).contentStreamId;
    const queue = grouped.get(streamId) ?? [];
    queue.push(decoded);
    grouped.set(streamId, queue);
  }
  for (const [streamId, queue] of grouped) {
    queue.sort((left, right) => compareOffsets(left.offset, right.offset));
    for (let index = 1; index < queue.length; index += 1) {
      if (compareOffsets(queue[index - 1]!.offset, queue[index]!.offset) >= 0) {
        fail(`content stream ${streamId} has duplicate/out-of-order offsets`);
      }
    }
  }
  return grouped;
}

function hydrateContentDependency(
  state: FsTree,
  queues: ReadonlyMap<string, readonly DecodedContent[]>,
  indexes: Map<string, number>,
  streamId: string,
  expected: ExpectedContent,
  path: string,
  required = false,
): FsTree {
  const queue = queues.get(streamId);
  if (queue === undefined) return state;
  const start = indexes.get(streamId) ?? 0;
  const match = queue.findIndex(
    ({ bytes }, index) =>
      index >= start &&
      bytes.byteLength === expected.size &&
      digestBytes(bytes) === expected.digest,
  );
  if (match < 0) {
    if (!required) return state;
    fail(
      `content dependency for ${path} has no ${streamId} generation matching ${expected.digest}/${expected.size}`,
    );
  }
  const contents = contentMap(state);
  contents.set(streamId, queue[match]!.bytes);
  indexes.set(streamId, match + 1);
  return withContentMap(state, contents);
}

function reduceFsTreeWithContent(
  metadata: readonly DumpRecord[],
  content: readonly DumpRecord[],
): FsTree {
  const queues = contentQueues(content);
  const indexes = new Map<string, number>();
  const paths = new Map<string, string>();
  const expectedByPath = new Map<string, ExpectedContent>();
  let state = fsInitialState;

  for (const [index, record] of metadata.entries()) {
    const change = effectiveChange(record);
    const payload = change.payload as Record<string, unknown>;
    const path = typeof payload.path === "string" ? payload.path : undefined;

    if (change.type === "fs.file.write" && path !== undefined) {
      const streamId = paths.get(path);
      if (
        streamId !== undefined &&
        typeof payload.contentSha256 === "string" &&
        typeof payload.size === "number"
      ) {
        state = hydrateContentDependency(
          state,
          queues,
          indexes,
          streamId,
          { digest: payload.contentSha256, size: payload.size },
          path,
        );
      }
    } else if (
      change.type === "fs.file.create" &&
      path !== undefined &&
      typeof payload.contentStreamId === "string"
    ) {
      const previous = paths.get(path);
      const expected = expectedByPath.get(path);
      if (
        previous !== undefined &&
        previous !== payload.contentStreamId &&
        expected !== undefined
      ) {
        state = hydrateContentDependency(
          state,
          queues,
          indexes,
          payload.contentStreamId,
          expected,
          path,
          true,
        );
      }
    }

    try {
      state = fsReducer(state, recordEvent(record));
    } catch (error) {
      fail(
        `reducer rejected event at line ${record.line ?? index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (
      change.type === "fs.file.create" &&
      path !== undefined &&
      typeof payload.contentStreamId === "string"
    ) {
      if (paths.get(path) === undefined) expectedByPath.delete(path);
      paths.set(path, payload.contentStreamId);
    } else if (
      change.type === "fs.file.write" &&
      path !== undefined &&
      typeof payload.contentSha256 === "string" &&
      typeof payload.size === "number"
    ) {
      expectedByPath.set(path, { digest: payload.contentSha256, size: payload.size });
    } else if (
      change.type === "fs.file.patch" &&
      path !== undefined &&
      typeof payload.baseDigest === "string" &&
      typeof payload.resultDigest === "string"
    ) {
      const previous = expectedByPath.get(path);
      if (previous === undefined || previous.digest !== payload.baseDigest) {
        fail(`patch content dependency for ${path} does not match its metadata base`);
      }
      let size: number;
      try {
        size = patchResultSize(previous.size, payload.ops as Parameters<typeof patchResultSize>[1]);
      } catch (error) {
        fail(
          `patch content dependency for ${path} is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      expectedByPath.set(path, { digest: payload.resultDigest, size });
    } else if (change.type === "fs.file.delete" && path !== undefined) {
      paths.delete(path);
      expectedByPath.delete(path);
    } else if (
      change.type === "fs.rename" &&
      typeof payload.from === "string" &&
      typeof payload.to === "string"
    ) {
      movePathMap(paths, payload.from, payload.to);
      movePathMap(expectedByPath, payload.from, payload.to);
    }
  }
  try {
    assertCompleteMergeStage(state);
  } catch (error) {
    fail(`reducer rejected final state: ${error instanceof Error ? error.message : String(error)}`);
  }
  return state;
}

async function readContentRecords(paths: readonly string[]): Promise<readonly DumpRecord[]> {
  const records: DumpRecord[] = [];
  for (const path of paths) {
    const segment = await readDump(path, { allowSegmentResets: true });
    for (const record of segment) {
      if (record.type !== "fs.file.content") {
        fail(`content dump contains non-content event at line ${record.line ?? 0}: ${record.type}`);
      }
      records.push(record);
    }
  }
  return records;
}

function preflight(root: string, state: FsTree): void {
  for (const path of Object.keys(state.dirs).sort()) {
    assertSafePath(root, path);
    rejectSymlinkTraversal(root, path);
  }
  for (const path of Object.keys(state.files).sort()) {
    assertSafePath(root, path);
    rejectSymlinkTraversal(root, path);
  }
}

function writeTree(root: string, state: FsTree): void {
  preflight(root, state);
  for (const path of Object.keys(state.dirs).sort(
    (left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right),
  )) {
    const target = assertSafePath(root, path);
    mkdirSync(target, { recursive: false });
  }
  const contents = contentMap(state);
  for (const path of Object.keys(state.files).sort()) {
    const file = state.files[path]!;
    const target = assertSafePath(root, path);
    const parent = dirname(target);
    if (!existsSync(parent)) fail(`file parent was not materialized: ${path}`);
    rejectSymlinkTraversal(root, path);
    const value = contents.get(file.contentStreamId) ?? new Uint8Array();
    if (value.byteLength !== file.size) fail(`content size mismatch for ${path}`);
    const digest = digestBytes(value);
    if (digest !== file.contentSha256) fail(`content digest mismatch for ${path}`);
    writeFileSync(target, value);
  }
}

export async function materializeDump(
  dumpPath: string,
  outPath: string,
  options: {
    readonly at?: string;
    readonly contentPaths?: readonly string[];
    readonly reducerPath?: string;
  } = {},
): Promise<string> {
  const records = await readDump(dumpPath);
  const selected =
    options.at === undefined
      ? records
      : (() => {
          const index = records.findIndex((record) => record.offset === options.at);
          if (index < 0) fail(`--at offset is not present in dump: ${options.at}`);
          return records.slice(0, index + 1);
        })();
  const reducer =
    options.reducerPath === undefined
      ? { reducer: fsReducer as ReducerModule["reducer"], initialState: fsInitialState }
      : await loadReducer(options.reducerPath);
  const content = await readContentRecords(options.contentPaths ?? []);
  const state =
    reducer.reducer === (fsReducer as ReducerModule["reducer"])
      ? reduceFsTreeWithContent(selected, content)
      : reduceTree([...content, ...selected], reducer);
  const root = prepareOut(outPath);
  writeTree(root, state);
  return reducer.reducer === (fsReducer as ReducerModule["reducer"])
    ? treeDigest(state)
    : stateDigest(state);
}
