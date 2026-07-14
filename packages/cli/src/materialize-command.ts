import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stateDigest } from "@eforest/protocol";
import {
  assertCompleteMergeStage,
  contentMap,
  digestBytes,
  fsInitialState,
  fsReducer,
  isValidFsPath,
  treeDigest,
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
    const event = Object.fromEntries(
      Object.entries(record).filter(([key]) => key !== "line"),
    ) as Parameters<ReducerModule["reducer"]>[1];
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
  options: { readonly at?: string; readonly reducerPath?: string } = {},
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
  const state = reduceTree(selected, reducer);
  const root = prepareOut(outPath);
  writeTree(root, state);
  return reducer.reducer === (fsReducer as ReducerModule["reducer"])
    ? treeDigest(state)
    : stateDigest(state);
}
