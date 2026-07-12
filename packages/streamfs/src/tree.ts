import { stateDigest } from "@eforest/protocol";

export interface FsFileState {
  readonly contentStreamId: string;
  readonly contentSha256: string;
  readonly size: number;
}

export interface FsTree {
  readonly files: Readonly<Record<string, FsFileState>>;
}

export function emptyTree(): FsTree {
  return { files: {} };
}

export function sortedTree(files: Readonly<Record<string, FsFileState>>): FsTree {
  const sorted: Record<string, FsFileState> = {};
  for (const path of Object.keys(files).sort()) sorted[path] = files[path]!;
  return { files: sorted };
}

export function treeDigest(state: FsTree): string {
  return stateDigest(state);
}
