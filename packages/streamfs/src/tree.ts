import { stateDigest } from "@eforest/protocol";
import type { FsMergeChangePayload, FsMergeConflictPayload } from "./events.js";

const contentMaps = new WeakMap<object, Map<string, Uint8Array>>();
const conflictMaps = new WeakMap<object, Map<string, FsMergeConflictPayload>>();
const mergeStages = new WeakMap<object, MergeStage>();

export interface MergeStage {
  readonly changes: readonly FsMergeChangePayload[];
  readonly conflicts: readonly FsMergeConflictPayload[];
}

export interface FsFileState {
  readonly contentStreamId: string;
  readonly contentSha256: string;
  readonly size: number;
  readonly lastContentOffset: string;
}

export type FsDirState = Record<string, never>;

export interface FsTombstoneState {
  readonly contentStreamId: string;
}

export interface FsTree {
  readonly files: Readonly<Record<string, FsFileState>>;
  readonly dirs: Readonly<Record<string, FsDirState>>;
  readonly tombstones: Readonly<Record<string, FsTombstoneState>>;
}

export function contentMap(state: FsTree): Map<string, Uint8Array> {
  const current = contentMaps.get(state);
  const copy = new Map<string, Uint8Array>();
  if (current !== undefined) {
    for (const [streamId, bytes] of current) copy.set(streamId, new Uint8Array(bytes));
  }
  return copy;
}

export function withContentMap(state: FsTree, contents: ReadonlyMap<string, Uint8Array>): FsTree {
  const copy = new Map<string, Uint8Array>();
  for (const [streamId, bytes] of contents) copy.set(streamId, new Uint8Array(bytes));
  contentMaps.set(state, copy);
  return state;
}

function conflictKey(conflict: Pick<FsMergeConflictPayload, "mergeId" | "path">): string {
  return `${conflict.mergeId}\0${conflict.path}`;
}

export function unresolvedMergeConflicts(state: FsTree): readonly FsMergeConflictPayload[] {
  return [...(conflictMaps.get(state)?.values() ?? [])].sort((left, right) =>
    left.path < right.path
      ? -1
      : left.path > right.path
        ? 1
        : left.mergeId < right.mergeId
          ? -1
          : left.mergeId > right.mergeId
            ? 1
            : 0,
  );
}

export function withMergeConflicts(
  state: FsTree,
  conflicts: readonly FsMergeConflictPayload[],
): FsTree {
  const mapped = new Map<string, FsMergeConflictPayload>();
  for (const conflict of conflicts) mapped.set(conflictKey(conflict), conflict);
  conflictMaps.set(state, mapped);
  return state;
}

export function mergeStage(state: FsTree): MergeStage {
  const stage = mergeStages.get(state);
  return stage === undefined
    ? { changes: [], conflicts: [] }
    : { changes: [...stage.changes], conflicts: [...stage.conflicts] };
}

export function withMergeStage(state: FsTree, stage: MergeStage): FsTree {
  mergeStages.set(state, {
    changes: [...stage.changes],
    conflicts: [...stage.conflicts],
  });
  return state;
}

/** Preserve content bytes and unresolved merge negotiation across immutable tree copies. */
export function inheritTreeMetadata(source: FsTree, target: FsTree): FsTree {
  withContentMap(target, contentMap(source));
  withMergeConflicts(target, unresolvedMergeConflicts(source));
  withMergeStage(target, mergeStage(source));
  return target;
}

export function emptyTree(): FsTree {
  return { files: {}, dirs: {}, tombstones: {} };
}

function sortedMap<T>(values: Readonly<Record<string, T>>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const path of Object.keys(values).sort()) sorted[path] = values[path]!;
  return sorted;
}

export function sortedTree(
  files: Readonly<Record<string, FsFileState>>,
  dirs: Readonly<Record<string, FsDirState>> = {},
  tombstones: Readonly<Record<string, FsTombstoneState>> = {},
): FsTree {
  return { files: sortedMap(files), dirs: sortedMap(dirs), tombstones: sortedMap(tombstones) };
}

function compareSegments(left: string, right: string): number {
  const a = left.split("/");
  const b = right.split("/");
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index]! < b[index]!) return -1;
    if (a[index]! > b[index]!) return 1;
  }
  return a.length - b.length;
}

export function listTree(state: FsTree): readonly string[] {
  const entries = [
    ...Object.keys(state.dirs).map((path) => ({ kind: "D" as const, path })),
    ...Object.entries(state.files).map(([path, file]) => ({
      kind: "F" as const,
      path,
      file,
    })),
  ];
  entries.sort((left, right) => compareSegments(left.path, right.path));
  return entries.map((entry) =>
    entry.kind === "D"
      ? `D ${entry.path}`
      : `F ${entry.path} ${entry.file.contentSha256} ${entry.file.size}`,
  );
}

export function treeDigest(state: FsTree): string {
  return stateDigest(state);
}
