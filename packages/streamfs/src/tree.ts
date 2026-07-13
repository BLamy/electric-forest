import { stateDigest } from "@eforest/protocol";

export interface FsFileState {
  readonly contentStreamId: string;
  readonly contentSha256: string;
  readonly size: number;
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
