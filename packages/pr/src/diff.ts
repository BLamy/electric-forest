import { stateDigest } from "@eforest/protocol";
import { contentMap, type FsTree } from "@eforest/streamfs";

export type PrDiffStatus = "added" | "removed" | "modified";
export type PrDiffLineKind = "context" | "addition" | "deletion";

export interface PrDiffLine {
  readonly kind: PrDiffLineKind;
  readonly content: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

export interface PrDiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly PrDiffLine[];
}

export interface PrDiffFile {
  readonly path: string;
  readonly status: PrDiffStatus;
  /** Canonical text supplied to @pierre/diffs. */
  readonly oldContent: string;
  /** Canonical text supplied to @pierre/diffs. */
  readonly newContent: string;
  readonly hunks: readonly PrDiffHunk[];
}

export interface PrDiff {
  readonly files: readonly PrDiffFile[];
}

function splitLines(value: string): readonly string[] {
  if (value === "") return [];
  return value.match(/[^\n]*(?:\n|$)/g)?.filter((line) => line !== "") ?? [];
}

function fileText(tree: FsTree, path: string): string {
  const file = tree.files[path];
  if (file === undefined) return "";
  const bytes = contentMap(tree).get(file.contentStreamId);
  if (bytes === undefined) return `[content ${file.contentSha256} · ${String(file.size)} bytes]\n`;
  if (bytes.includes(0)) return `[binary ${file.contentSha256} · ${String(file.size)} bytes]\n`;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return `[binary ${file.contentSha256} · ${String(file.size)} bytes]\n`;
  }
}

function lineScript(oldContent: string, newContent: string): readonly PrDiffLine[] {
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const lengths = Array.from(
    { length: oldLines.length + 1 },
    () => new Uint32Array(newLines.length + 1),
  );
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      lengths[oldIndex]![newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? lengths[oldIndex + 1]![newIndex + 1]! + 1
          : Math.max(lengths[oldIndex + 1]![newIndex]!, lengths[oldIndex]![newIndex + 1]!);
    }
  }

  const result: PrDiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  let oldLine = 1;
  let newLine = 1;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (
      oldIndex < oldLines.length &&
      newIndex < newLines.length &&
      oldLines[oldIndex] === newLines[newIndex]
    ) {
      result.push({
        kind: "context",
        content: oldLines[oldIndex]!,
        oldLine,
        newLine,
      });
      oldIndex += 1;
      newIndex += 1;
      oldLine += 1;
      newLine += 1;
    } else if (
      oldIndex < oldLines.length &&
      (newIndex >= newLines.length ||
        lengths[oldIndex + 1]![newIndex]! >= lengths[oldIndex]![newIndex + 1]!)
    ) {
      result.push({ kind: "deletion", content: oldLines[oldIndex]!, oldLine });
      oldIndex += 1;
      oldLine += 1;
    } else {
      result.push({ kind: "addition", content: newLines[newIndex]!, newLine });
      newIndex += 1;
      newLine += 1;
    }
  }
  return result;
}

function diffFile(baseTree: FsTree, sourceTree: FsTree, path: string): PrDiffFile | undefined {
  const oldFile = baseTree.files[path];
  const newFile = sourceTree.files[path];
  if (
    oldFile !== undefined &&
    newFile !== undefined &&
    oldFile.contentSha256 === newFile.contentSha256 &&
    oldFile.size === newFile.size
  ) {
    return undefined;
  }
  const oldContent = fileText(baseTree, path);
  const newContent = fileText(sourceTree, path);
  const status: PrDiffStatus =
    oldFile === undefined ? "added" : newFile === undefined ? "removed" : "modified";
  return {
    path,
    status,
    oldContent,
    newContent,
    hunks: [
      {
        oldStart: 1,
        oldLines: splitLines(oldContent).length,
        newStart: 1,
        newLines: splitLines(newContent).length,
        lines: lineScript(oldContent, newContent),
      },
    ],
  };
}

/** One canonical since-fork diff authority shared by the app and verifier. */
export function computeSinceForkDiff(baseTree: FsTree, sourceTree: FsTree): PrDiff {
  const paths = [
    ...new Set([...Object.keys(baseTree.files), ...Object.keys(sourceTree.files)]),
  ].sort();
  return {
    files: paths
      .map((path) => diffFile(baseTree, sourceTree, path))
      .filter((file): file is PrDiffFile => file !== undefined),
  };
}

export function prDiffDigest(diff: PrDiff): string {
  return stateDigest(diff);
}
