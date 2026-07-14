import { canonicalJson, compareOffsets, type Event, type Offset } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import type { StreamRecord } from "@eforest/client";
import {
  isFsBranchForkEvent,
  isFsEvent,
  isFsFastForwardMergeEvent,
  isFsThreeWayMergeEvent,
  type FsMergeChange,
  type FsMergeConflictKind,
  type FsMergeConflictPayload,
  type FsMergeConflictReason,
  type FsMergeNodeRef,
  type FsMergeRevisionRef,
  type FsMergeSideRef,
} from "./events.js";
import { BASE_NONE } from "./fencing.js";
import type { StreamFsRepo } from "./fs.js";
import { expandThreeWayMergeRecords } from "./merge-records.js";
import { mergeTextBytes } from "./patch/merge.js";
import { digestBytes } from "./patch/ops.js";
import { fsReducer } from "./reducer.js";
import { mergePlanId } from "./merge-integrity.js";
import { treeDigest, unresolvedMergeConflicts, type FsFileState, type FsTree } from "./tree.js";

function eventOf(record: StreamRecord): Event {
  return { type: record.type, payload: record.payload, ts: record.ts };
}

function lastForkIndex(records: readonly StreamRecord[]): number {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (isFsBranchForkEvent(eventOf(records[index]!))) return index;
  }
  return -1;
}

function offsetOrdinal(offset: string): number {
  if (offset === "-1") return -1;
  const ordinal = Number(offset.slice(offset.lastIndexOf("_") + 1));
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new ThreeWayMergeError("merge/malformed-offset", `invalid application offset ${offset}`);
  }
  return ordinal;
}

function nextOffset(records: readonly StreamRecord[]): Offset {
  let ordinal = -1;
  for (const record of records) {
    ordinal = Math.max(ordinal, offsetOrdinal(record.offset));
    const event = eventOf(record);
    if (isFsFastForwardMergeEvent(event)) {
      ordinal = Math.max(ordinal, offsetOrdinal(event.payload.mergedThroughOffset));
    }
  }
  return offsetForOrdinal(ordinal + 1);
}

function plannedOffsets(records: readonly StreamRecord[], count: number): readonly Offset[] {
  const allocation = [...records];
  const result: Offset[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = nextOffset(allocation);
    result.push(offset);
    allocation.push({ offset, type: "plan.offset", payload: {}, ts: 0 });
  }
  return result;
}

type MergeNode =
  | { readonly kind: "missing" }
  | { readonly kind: "dir" }
  | { readonly kind: "file"; readonly file: FsFileState };

function nodeAt(tree: FsTree, path: string): MergeNode {
  const file = tree.files[path];
  if (file !== undefined) return { kind: "file", file };
  if (tree.dirs[path] !== undefined) return { kind: "dir" };
  return { kind: "missing" };
}

function equalNode(left: MergeNode, right: MergeNode): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind !== "file" || right.kind !== "file") return true;
  return left.file.contentSha256 === right.file.contentSha256 && left.file.size === right.file.size;
}

function nodeReference(path: string, node: MergeNode): FsMergeNodeRef {
  if (node.kind === "missing") return { kind: "missing", path };
  if (node.kind === "dir") return { kind: "dir", path };
  return {
    kind: "file",
    path,
    contentStreamId: node.file.contentStreamId,
    contentSha256: node.file.contentSha256,
    size: node.file.size,
    lastContentOffset: node.file.lastContentOffset,
  };
}

function sideReference(
  revision: FsMergeRevisionRef,
  path: string,
  node: MergeNode,
): FsMergeSideRef {
  return { ...revision, node: nodeReference(path, node) };
}

function findIdentityPath(tree: FsTree, contentStreamId: string): string | undefined {
  return Object.entries(tree.files).find(
    ([, file]) => file.contentStreamId === contentStreamId,
  )?.[0];
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

interface RankedChange {
  readonly phase: number;
  readonly path: string;
  readonly change: FsMergeChange;
}

function compareRankedChanges(left: RankedChange, right: RankedChange): number {
  if (left.phase !== right.phase) return left.phase - right.phase;
  const deep = left.phase <= 1;
  const depth = deep
    ? pathDepth(right.path) - pathDepth(left.path)
    : pathDepth(left.path) - pathDepth(right.path);
  if (depth !== 0) return depth;
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  return left.change.type < right.change.type ? -1 : left.change.type > right.change.type ? 1 : 0;
}

function isPatchOnlyMutation(records: readonly StreamRecord[], path: string): boolean {
  let sawPatch = false;
  for (const record of expandThreeWayMergeRecords(records)) {
    const event = eventOf(record);
    if (!isFsEvent(event)) continue;
    if (event.type === "fs.file.write" && event.payload.path === path) return false;
    if (event.type === "fs.file.patch" && event.payload.path === path) sawPatch = true;
  }
  return sawPatch;
}

function isPathWithin(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function subtreeIdentity(tree: FsTree, root: string): readonly unknown[] {
  const entries: unknown[] = [];
  for (const path of Object.keys(tree.dirs).sort()) {
    if (isPathWithin(root, path)) entries.push(["dir", path.slice(root.length)]);
  }
  for (const [path, file] of Object.entries(tree.files).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (!isPathWithin(root, path)) continue;
    entries.push([
      "file",
      path.slice(root.length),
      file.contentStreamId,
      file.contentSha256,
      file.size,
      file.lastContentOffset,
    ]);
  }
  return entries;
}

function sameSubtree(left: FsTree, leftRoot: string, right: FsTree, rightRoot: string): boolean {
  return (
    canonicalJson(subtreeIdentity(left, leftRoot)) ===
    canonicalJson(subtreeIdentity(right, rightRoot))
  );
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathWithin(left, right) || isPathWithin(right, left);
}

interface SourceMergeStep {
  readonly index: number;
  readonly record: StreamRecord;
  readonly change: FsMergeChange;
}

interface SourceRenameStep extends SourceMergeStep {
  readonly change: Extract<FsMergeChange, { readonly type: "fs.rename" }>;
}

interface RejectedRenameComponent {
  readonly path: string;
  readonly targetPath: string;
  readonly sourcePath: string;
  readonly roots: readonly string[];
}

function sourceMergeStep(record: StreamRecord, index: number): SourceMergeStep | undefined {
  const event = eventOf(record);
  if (!isFsEvent(event)) return undefined;
  switch (event.type) {
    case "fs.file.create":
      return { index, record, change: { type: event.type, payload: event.payload } };
    case "fs.file.write":
      return { index, record, change: { type: event.type, payload: event.payload } };
    case "fs.file.delete":
      return { index, record, change: { type: event.type, payload: event.payload } };
    case "fs.dir.create":
      return { index, record, change: { type: event.type, payload: event.payload } };
    case "fs.dir.remove":
      return { index, record, change: { type: event.type, payload: event.payload } };
    case "fs.rename":
      return { index, record, change: { type: event.type, payload: event.payload } };
    case "fs.file.patch":
      return { index, record, change: { type: event.type, payload: event.payload } };
    default:
      return undefined;
  }
}

function renameComponents(
  steps: readonly SourceRenameStep[],
  sourceSteps: readonly SourceMergeStep[],
): readonly SourceRenameStep[][] {
  const components: SourceRenameStep[][] = [];
  for (const step of steps) {
    const touching: number[] = [];
    for (const [index, component] of components.entries()) {
      if (
        component.some((candidate) =>
          [candidate.change.payload.from, candidate.change.payload.to].some((left) =>
            [step.change.payload.from, step.change.payload.to].some((right) =>
              pathsOverlap(left, right),
            ),
          ),
        )
      ) {
        touching.push(index);
      }
    }
    const merged = [step];
    for (const index of touching.reverse()) merged.push(...components.splice(index, 1)[0]!);
    merged.sort((left, right) => left.index - right.index);
    components.push(merged);
  }
  for (const step of sourceSteps) {
    const touching = components.flatMap((component, index) =>
      component.some((rename) =>
        sourceStepPaths(step).some((path) =>
          sourceStepPaths(rename).some((renamePath) => pathsOverlap(renamePath, path)),
        ),
      )
        ? [index]
        : [],
    );
    if (touching.length < 2) continue;
    const merged: SourceRenameStep[] = [];
    for (const index of touching.reverse()) merged.push(...components.splice(index, 1)[0]!);
    merged.sort((left, right) => left.index - right.index);
    components.push(merged);
  }
  return components.sort((left, right) => left[0]!.index - right[0]!.index);
}

function sourceStepPaths(step: SourceMergeStep): readonly string[] {
  return step.change.type === "fs.rename"
    ? [step.change.payload.from, step.change.payload.to]
    : [step.change.payload.path];
}

function applySourceStep(state: FsTree, step: SourceMergeStep): FsTree {
  return fsReducer(state, step.record);
}

function isCommonStructuralStep(step: SourceMergeStep): boolean {
  return (
    step.change.type === "fs.file.delete" ||
    step.change.type === "fs.dir.create" ||
    step.change.type === "fs.dir.remove" ||
    step.change.type === "fs.rename"
  );
}

function basePathMap(base: FsTree): Map<string, string> {
  return new Map(
    [...Object.keys(base.dirs), ...Object.keys(base.files)].map((path) => [path, path]),
  );
}

function updateBasePathMap(paths: Map<string, string>, step: SourceMergeStep): void {
  if (step.change.type === "fs.file.delete" || step.change.type === "fs.dir.remove") {
    for (const path of [...paths.keys()]) {
      if (isPathWithin(step.change.payload.path, path)) paths.delete(path);
    }
    return;
  }
  if (step.change.type !== "fs.rename") return;
  const { from, to } = step.change.payload;
  const moved = [...paths.entries()].filter(([path]) => isPathWithin(from, path));
  for (const [path] of moved) paths.delete(path);
  for (const [path, original] of moved) {
    paths.set(`${to}${path.slice(from.length)}`, original);
  }
}

function structurallyEqualAt(left: FsTree, right: FsTree, path: string): boolean {
  return sameSubtree(left, path, right, path);
}

/**
 * Replay every source event causally connected to a rename program when the target still
 * matches its fork inputs. Keeping the original event order preserves inherited content
 * identity through edits, chains, destination replacement, and swap permutations.
 */
function sourceRenameAdoptions(
  base: FsTree,
  target: FsTree,
  source: FsTree,
  sourcePostFork: readonly StreamRecord[],
  targetPostFork: readonly StreamRecord[],
): {
  readonly ranked: readonly RankedChange[];
  readonly excludedRoots: readonly string[];
  readonly rejected: readonly RejectedRenameComponent[];
  readonly alignedBase: FsTree;
  readonly alignedBasePaths: ReadonlyMap<string, string>;
} {
  const sourceSteps = expandThreeWayMergeRecords(sourcePostFork)
    .map(sourceMergeStep)
    .filter((step): step is SourceMergeStep => step !== undefined);
  const targetSteps = expandThreeWayMergeRecords(targetPostFork)
    .map(sourceMergeStep)
    .filter((step): step is SourceMergeStep => step !== undefined);
  const renames = sourceSteps.filter(
    (step): step is SourceRenameStep => step.change.type === "fs.rename",
  );
  let alignedBase = base;
  let alignedBasePaths = basePathMap(base);
  if (renames.length === 0) {
    return {
      ranked: [],
      excludedRoots: [],
      rejected: [],
      alignedBase,
      alignedBasePaths,
    };
  }

  const accepted = new Map<number, SourceMergeStep>();
  const excludedRoots = new Set<string>();
  const rejected: RejectedRenameComponent[] = [];
  for (const component of renameComponents(renames, sourceSteps)) {
    const renameIndexes = new Set(component.map(({ index }) => index));
    const componentPaths = component.flatMap((step) => sourceStepPaths(step));
    const relevant = sourceSteps.filter((step) => {
      if (renameIndexes.has(step.index)) return true;
      if (step.change.type === "fs.rename") return false;
      return sourceStepPaths(step).some((path) =>
        componentPaths.some((componentPath) => pathsOverlap(componentPath, path)),
      );
    });
    const roots = new Set(relevant.flatMap(sourceStepPaths));
    if ([...roots].every((path) => structurallyEqualAt(target, source, path))) {
      for (const root of roots) excludedRoots.add(root);
      continue;
    }
    const sourceStructure = relevant.filter(isCommonStructuralStep);
    const targetStructure = targetSteps.filter(
      (step) =>
        isCommonStructuralStep(step) &&
        sourceStepPaths(step).some((path) =>
          componentPaths.some((componentPath) => pathsOverlap(componentPath, path)),
        ),
    );
    let commonLength = 0;
    while (
      commonLength < sourceStructure.length &&
      commonLength < targetStructure.length &&
      canonicalJson(sourceStructure[commonLength]!.change) ===
        canonicalJson(targetStructure[commonLength]!.change)
    ) {
      commonLength += 1;
    }
    const commonStructure = sourceStructure.slice(0, commonLength);
    const hasCommonRename = commonStructure.some((step) => step.change.type === "fs.rename");
    let program = relevant;
    let commonAligned = false;
    if (hasCommonRename) {
      let nextBase = alignedBase;
      const nextPaths = new Map(alignedBasePaths);
      let aligned = true;
      try {
        for (const step of commonStructure) {
          nextBase = applySourceStep(nextBase, step);
          updateBasePathMap(nextPaths, step);
        }
      } catch {
        aligned = false;
      }
      if (aligned) {
        alignedBase = nextBase;
        alignedBasePaths = nextPaths;
        commonAligned = true;
        const commonIndexes = new Set(commonStructure.map(({ index }) => index));
        program = relevant.filter(({ index }) => !commonIndexes.has(index));
        if (program.length === 0) continue;
      }
    }
    let baseSim = alignedBase;
    let targetSim = target;
    let safe = true;
    let rejectedPath: string | undefined;
    for (const step of program) {
      const paths = sourceStepPaths(step);
      rejectedPath = paths.find((path) => !structurallyEqualAt(baseSim, targetSim, path));
      if (rejectedPath !== undefined) {
        safe = false;
        break;
      }
      try {
        baseSim = applySourceStep(baseSim, step);
        targetSim = applySourceStep(targetSim, step);
      } catch {
        rejectedPath = paths[0];
        safe = false;
        break;
      }
    }
    rejectedPath ??= [...roots].find((path) => !structurallyEqualAt(targetSim, source, path));
    if ((!safe || rejectedPath !== undefined) && commonAligned) continue;
    if (!safe || rejectedPath !== undefined) {
      const path = rejectedPath ?? component[0]!.change.payload.from;
      const baseNode = nodeAt(base, path);
      const targetPath =
        baseNode.kind === "file"
          ? (findIdentityPath(target, baseNode.file.contentStreamId) ?? path)
          : path;
      const sourcePath =
        baseNode.kind === "file"
          ? (findIdentityPath(source, baseNode.file.contentStreamId) ?? path)
          : path;
      rejected.push({ path, targetPath, sourcePath, roots: [...roots].sort() });
      continue;
    }
    for (const step of program) accepted.set(step.index, step);
    for (const root of roots) excludedRoots.add(root);
  }

  return {
    ranked: [...accepted.values()]
      .sort((left, right) => left.index - right.index)
      .map((step) => ({
        phase: -1_000_000 + step.index,
        path:
          step.change.type === "fs.rename" ? step.change.payload.from : step.change.payload.path,
        change: step.change,
      })),
    excludedRoots: [...excludedRoots].sort(),
    rejected,
    alignedBase,
    alignedBasePaths,
  };
}

function deterministicTimestamp(records: readonly StreamRecord[]): number {
  let timestamp = 0;
  for (const record of records) {
    if (Number.isSafeInteger(record.ts)) timestamp = Math.max(timestamp, record.ts);
  }
  return timestamp < Number.MAX_SAFE_INTEGER ? timestamp + 1 : timestamp;
}

interface ConflictDraft {
  readonly path: string;
  readonly kind: FsMergeConflictKind;
  readonly reason: FsMergeConflictReason;
  readonly base: FsMergeSideRef;
  readonly target: FsMergeSideRef;
  readonly source: FsMergeSideRef;
}

function conflictDraft(
  path: string,
  kind: FsMergeConflictKind,
  reason: FsMergeConflictReason,
  baseRevision: FsMergeRevisionRef,
  targetRevision: FsMergeRevisionRef,
  sourceRevision: FsMergeRevisionRef,
  basePath: string,
  base: MergeNode,
  targetPath: string,
  target: MergeNode,
  sourcePath: string,
  source: MergeNode,
): ConflictDraft {
  return {
    path,
    kind,
    reason,
    base: sideReference(baseRevision, basePath, base),
    target: sideReference(targetRevision, targetPath, target),
    source: sideReference(sourceRevision, sourcePath, source),
  };
}

function conflictKind(base: MergeNode, target: MergeNode, source: MergeNode): FsMergeConflictKind {
  if (base.kind === "missing") return "add-add";
  if (target.kind === "missing" || source.kind === "missing") return "delete-edit";
  return "edit-edit";
}

export class ThreeWayMergeError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(code: string, message = code, details?: unknown) {
    super(`${code}: ${message}`);
    this.name = "ThreeWayMergeError";
    this.code = code;
    this.details = details;
  }
}

export interface FastForwardMergeReceipt {
  readonly mergeOffset: string;
  readonly mergedThroughOffset: string;
  readonly treeDigest: string;
}

export interface ThreeWayMergePlan {
  readonly kind: "three-way";
  readonly mergeId: string;
  readonly base: FsMergeRevisionRef;
  readonly target: FsMergeRevisionRef;
  readonly source: FsMergeRevisionRef;
  readonly forkOffset: Offset;
  readonly changes: readonly FsMergeChange[];
  readonly conflicts: readonly FsMergeConflictPayload[];
  readonly events: readonly [Event, ...Event[]];
  readonly firstOffset: Offset;
  readonly terminalOffset: Offset;
  readonly resultTreeDigest: string;
}

export interface ThreeWayMergeReceipt {
  readonly kind: "three-way";
  readonly mergeId: string;
  readonly mergeOffset: Offset;
  readonly resultTreeDigest: string;
  readonly conflicts: readonly Pick<FsMergeConflictPayload, "path" | "kind" | "reason">[];
}

export interface MergeResolutionReceipt {
  readonly mergeId: string;
  readonly path: string;
  readonly resolutionOffset: Offset;
  readonly resultTreeDigest: string;
}

/** Append one adoption event after the server validates the fast-forward. */
export async function mergeFastForward(
  target: StreamFsRepo,
  source: StreamFsRepo,
): Promise<FastForwardMergeReceipt> {
  const sourceDump = await source.dump();
  const forkIndex = lastForkIndex(sourceDump);
  const forkRecord = forkIndex < 0 ? undefined : sourceDump[forkIndex];
  const forkEvent = forkRecord === undefined ? undefined : eventOf(forkRecord);
  if (forkRecord === undefined || forkEvent === undefined || !isFsBranchForkEvent(forkEvent)) {
    throw new Error("source stream is not a branch");
  }
  const sourcePostFork = sourceDump.slice(forkIndex + 1);
  const mergedThroughOffset =
    sourcePostFork.length === 0 ? forkEvent.payload.forkOffset : sourcePostFork.at(-1)!.offset;
  const receipt = await target.dispatchToStream(target.metadataStreamId, {
    type: "fs.branch.merge",
    payload: {
      v: 1,
      sourceStreamId: source.metadataStreamId,
      forkOffset: forkEvent.payload.forkOffset,
      mergedThroughOffset,
    },
    ts: target.now(),
  });
  return {
    mergeOffset: receipt.event.offset,
    mergedThroughOffset,
    treeDigest: await target.digest(),
  };
}

async function sourceAdoptionChanges(
  path: string,
  target: MergeNode,
  source: MergeNode,
  targetRepo: StreamFsRepo,
  sourceRepo: StreamFsRepo,
): Promise<readonly RankedChange[]> {
  const changes: RankedChange[] = [];
  if (target.kind === "file" && source.kind !== "file") {
    changes.push({
      phase: 0,
      path,
      change: { type: "fs.file.delete", payload: { v: 2, path } },
    });
  }
  if (target.kind === "dir" && source.kind !== "dir") {
    changes.push({
      phase: 1,
      path,
      change: { type: "fs.dir.remove", payload: { v: 2, path } },
    });
  }
  if (source.kind === "missing") return changes;
  if (source.kind === "dir") {
    if (target.kind !== "dir") {
      changes.push({
        phase: 2,
        path,
        change: { type: "fs.dir.create", payload: { v: 2, path } },
      });
    }
    return changes;
  }

  if (target.kind === "file" && target.file.contentStreamId === source.file.contentStreamId) {
    const targetBytes = await targetRepo.readFile(path);
    const sourceBytes = await sourceRepo.readFile(path);
    const composed = mergeTextBytes(targetBytes, targetBytes, sourceBytes);
    if (composed.kind !== "clean") {
      throw new ThreeWayMergeError(
        "merge/source-content-unavailable",
        `cannot adopt source bytes for ${path}`,
      );
    }
    changes.push({
      phase: 6,
      path,
      change: {
        type: "fs.file.patch",
        payload: {
          v: 2,
          path,
          base: target.file.lastContentOffset,
          baseDigest: target.file.contentSha256,
          ops: composed.ops,
          resultDigest: source.file.contentSha256,
        },
      },
    });
    return changes;
  }

  if (target.kind !== "file") {
    changes.push({
      phase: 3,
      path,
      change: {
        type: "fs.file.create",
        payload: { v: 2, path, contentStreamId: source.file.contentStreamId },
      },
    });
  }
  changes.push({
    phase: 4,
    path,
    change: {
      type: "fs.file.write",
      payload: {
        v: 2,
        path,
        base: target.kind === "file" ? target.file.lastContentOffset : BASE_NONE,
        contentSha256: source.file.contentSha256,
        size: source.file.size,
      },
    },
  });
  if (target.kind === "file" && target.file.contentStreamId !== source.file.contentStreamId) {
    changes.push({
      phase: 5,
      path,
      change: {
        type: "fs.file.create",
        payload: { v: 2, path, contentStreamId: source.file.contentStreamId },
      },
    });
  }
  return changes;
}

/** Freeze a deterministic three-way plan without mutating either stream. */
export async function planThreeWayMerge(
  target: StreamFsRepo,
  source: StreamFsRepo,
): Promise<ThreeWayMergePlan> {
  const [targetRaw, sourceRaw] = await Promise.all([target.rawDump(), source.rawDump()]);
  const forkIndex = lastForkIndex(sourceRaw);
  const forkRecord = forkIndex < 0 ? undefined : sourceRaw[forkIndex];
  const forkEvent = forkRecord === undefined ? undefined : eventOf(forkRecord);
  if (
    forkEvent === undefined ||
    !isFsBranchForkEvent(forkEvent) ||
    forkEvent.payload.parentStreamId !== target.metadataStreamId
  ) {
    throw new ThreeWayMergeError("merge/unrelated-source", "source does not fork from target");
  }
  const forkOffset = forkEvent.payload.forkOffset;
  const targetHead = targetRaw.at(-1)?.offset ?? ("-1" as Offset);
  const sourceHead = sourceRaw.at(-1)?.offset ?? ("-1" as Offset);
  const sourcePostFork = sourceRaw.slice(forkIndex + 1);
  const mergedThroughOffset = sourcePostFork.at(-1)?.offset ?? forkOffset;
  const [baseTree, targetTree, sourceTree, targetResolved] = await Promise.all([
    target.treeAt(forkOffset),
    target.tree(),
    source.tree(),
    target.resolvedDump(),
  ]);
  if (unresolvedMergeConflicts(targetTree).length > 0) {
    throw new ThreeWayMergeError("merge/target-conflicted", "target has unresolved conflicts");
  }

  const baseRevision: FsMergeRevisionRef = {
    streamId: target.metadataStreamId,
    offset: forkOffset,
    treeDigest: treeDigest(baseTree),
  };
  const targetRevision: FsMergeRevisionRef = {
    streamId: target.metadataStreamId,
    offset: targetHead,
    treeDigest: treeDigest(targetTree),
  };
  const sourceRevision: FsMergeRevisionRef = {
    streamId: source.metadataStreamId,
    offset: sourceHead,
    treeDigest: treeDigest(sourceTree),
  };

  const ranked: RankedChange[] = [];
  const drafts: ConflictDraft[] = [];
  const excluded = new Set<string>();

  for (const [basePath, file] of Object.entries(baseTree.files).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const targetPath = findIdentityPath(targetTree, file.contentStreamId);
    const sourcePath = findIdentityPath(sourceTree, file.contentStreamId);
    if (
      targetPath !== undefined &&
      sourcePath !== undefined &&
      targetPath !== basePath &&
      sourcePath !== basePath &&
      targetPath !== sourcePath
    ) {
      drafts.push(
        conflictDraft(
          basePath,
          "rename-rename",
          "non-patchable",
          baseRevision,
          targetRevision,
          sourceRevision,
          basePath,
          { kind: "file", file },
          targetPath,
          nodeAt(targetTree, targetPath),
          sourcePath,
          nodeAt(sourceTree, sourcePath),
        ),
      );
      excluded.add(basePath);
      excluded.add(targetPath);
      excluded.add(sourcePath);
    }
  }

  const targetPostFork = targetResolved.filter(
    (record) => compareOffsets(record.offset, forkOffset) > 0,
  );
  const structuralAdoptions = sourceRenameAdoptions(
    baseTree,
    targetTree,
    sourceTree,
    sourcePostFork,
    targetPostFork,
  );
  const comparisonBaseTree = structuralAdoptions.alignedBase;
  const paths = new Set([
    ...Object.keys(baseTree.files),
    ...Object.keys(baseTree.dirs),
    ...Object.keys(comparisonBaseTree.files),
    ...Object.keys(comparisonBaseTree.dirs),
    ...Object.keys(targetTree.files),
    ...Object.keys(targetTree.dirs),
    ...Object.keys(sourceTree.files),
    ...Object.keys(sourceTree.dirs),
  ]);
  ranked.push(...structuralAdoptions.ranked);
  for (const rejected of structuralAdoptions.rejected) {
    if (!drafts.some((draft) => draft.path === rejected.path)) {
      drafts.push(
        conflictDraft(
          rejected.path,
          "rename-rename",
          "non-patchable",
          baseRevision,
          targetRevision,
          sourceRevision,
          rejected.path,
          nodeAt(baseTree, rejected.path),
          rejected.targetPath,
          nodeAt(targetTree, rejected.targetPath),
          rejected.sourcePath,
          nodeAt(sourceTree, rejected.sourcePath),
        ),
      );
    }
  }
  const excludedRenameRoots = [
    ...structuralAdoptions.excludedRoots,
    ...structuralAdoptions.rejected.flatMap(({ roots }) => roots),
  ];
  for (const path of paths) {
    if (excludedRenameRoots.some((root) => isPathWithin(root, path))) {
      excluded.add(path);
    }
  }
  for (const path of [...paths].sort()) {
    if (excluded.has(path)) continue;
    const basePath = structuralAdoptions.alignedBasePaths.get(path) ?? path;
    const baseNode = nodeAt(comparisonBaseTree, path);
    const baseReferenceNode = nodeAt(baseTree, basePath);
    const targetNode = nodeAt(targetTree, path);
    const sourceNode = nodeAt(sourceTree, path);
    const independentSameContentAdds =
      baseNode.kind === "missing" &&
      targetNode.kind === "file" &&
      sourceNode.kind === "file" &&
      targetNode.file.contentStreamId !== sourceNode.file.contentStreamId;
    if (
      (!independentSameContentAdds && equalNode(targetNode, sourceNode)) ||
      equalNode(sourceNode, baseNode)
    ) {
      continue;
    }
    if (equalNode(targetNode, baseNode)) {
      ranked.push(...(await sourceAdoptionChanges(path, targetNode, sourceNode, target, source)));
      continue;
    }

    if (baseNode.kind === "file" && targetNode.kind === "file" && sourceNode.kind === "file") {
      const [baseBytes, targetBytes, sourceBytes] = await Promise.all([
        target.readFileAt(basePath, forkOffset),
        target.readFile(path),
        source.readFile(path),
      ]);
      const composed = mergeTextBytes(baseBytes, targetBytes, sourceBytes);
      const directPatches =
        isPatchOnlyMutation(targetPostFork, path) && isPatchOnlyMutation(sourcePostFork, path);
      if (composed.kind === "clean" && directPatches) {
        ranked.push({
          phase: 6,
          path,
          change: {
            type: "fs.file.patch",
            payload: {
              v: 2,
              path,
              base: targetNode.file.lastContentOffset,
              baseDigest: targetNode.file.contentSha256,
              ops: composed.ops,
              resultDigest: digestBytes(composed.bytes),
            },
          },
        });
        continue;
      }
      drafts.push(
        conflictDraft(
          path,
          "edit-edit",
          composed.kind === "conflict" ? composed.reason : "non-patchable",
          baseRevision,
          targetRevision,
          sourceRevision,
          basePath,
          baseReferenceNode,
          path,
          targetNode,
          path,
          sourceNode,
        ),
      );
      continue;
    }

    drafts.push(
      conflictDraft(
        path,
        conflictKind(baseNode, targetNode, sourceNode),
        "non-patchable",
        baseRevision,
        targetRevision,
        sourceRevision,
        basePath,
        baseReferenceNode,
        path,
        targetNode,
        path,
        sourceNode,
      ),
    );
  }

  const conflictsSorted = drafts.sort((left, right) =>
    left.path < right.path
      ? -1
      : left.path > right.path
        ? 1
        : left.kind < right.kind
          ? -1
          : left.kind > right.kind
            ? 1
            : 0,
  );
  const conflictPaths = conflictsSorted.map((conflict) => conflict.path);
  const changes = ranked
    .filter(
      ({ path }) =>
        !conflictPaths.some(
          (conflictPath) =>
            path === conflictPath ||
            path.startsWith(`${conflictPath}/`) ||
            conflictPath.startsWith(`${path}/`),
        ),
    )
    .sort(compareRankedChanges)
    .map(({ change }) => change);
  const mergeId = mergePlanId({
    base: baseRevision,
    target: targetRevision,
    source: sourceRevision,
    changes,
    conflicts: conflictsSorted,
  });
  const conflicts: FsMergeConflictPayload[] = conflictsSorted.map((conflict) => ({
    v: 1,
    mergeId,
    ...conflict,
  }));
  const eventCount = changes.length + conflicts.length + 1;
  const offsets = plannedOffsets(targetRaw, eventCount);
  const firstOffset = offsets[0]!;
  const terminalOffset = offsets.at(-1)!;
  const ts = deterministicTimestamp([...targetRaw, ...sourceRaw]);
  let resultState = targetTree;
  for (const change of changes) {
    resultState = fsReducer(resultState, {
      type: change.type,
      payload: change.payload,
      ts,
      offset: terminalOffset,
    } as Event);
  }
  const resultTreeDigest = treeDigest(resultState);
  const stagedChanges: Event[] = changes.map((change, index) => ({
    type: "fs/merge-change",
    payload: { v: 1, mergeId, index, change },
    ts,
  }));
  const conflictEvents: Event[] = conflicts.map((payload) => ({
    type: "fs/merge-conflict",
    payload,
    ts,
  }));
  const terminal: Event = {
    type: "fs.branch.merge",
    payload: {
      v: 2,
      kind: "three-way",
      mergeId,
      targetStreamId: target.metadataStreamId,
      sourceStreamId: source.metadataStreamId,
      forkOffset,
      mergedThroughOffset,
      sourceHeadOffset: sourceHead,
      targetHeadOffset: targetHead,
      baseTreeDigest: baseRevision.treeDigest,
      targetTreeDigest: targetRevision.treeDigest,
      sourceTreeDigest: sourceRevision.treeDigest,
      resultTreeDigest,
      changes,
      conflicts,
    },
    ts,
  };
  const staged = [...stagedChanges, ...conflictEvents];
  const events: [Event, ...Event[]] =
    staged.length === 0 ? [terminal] : [staged[0]!, ...staged.slice(1), terminal];
  return {
    kind: "three-way",
    mergeId,
    base: baseRevision,
    target: targetRevision,
    source: sourceRevision,
    forkOffset,
    changes,
    conflicts,
    events,
    firstOffset,
    terminalOffset,
    resultTreeDigest,
  };
}

function assertPlanTerminal(plan: ThreeWayMergePlan): void {
  const terminal = plan.events.at(-1);
  if (!isFsThreeWayMergeEvent(terminal) || terminal.payload.mergeId !== plan.mergeId) {
    throw new ThreeWayMergeError("merge/reference-mismatch", "plan has no matching terminal event");
  }
}

/** Validate a frozen plan against live heads, then append it exactly once. */
export async function applyThreeWayMerge(
  target: StreamFsRepo,
  source: StreamFsRepo,
  plan: ThreeWayMergePlan,
): Promise<ThreeWayMergeReceipt> {
  assertPlanTerminal(plan);
  const [targetRaw, sourceRaw] = await Promise.all([target.rawDump(), source.rawDump()]);
  const targetHead = targetRaw.at(-1)?.offset ?? ("-1" as Offset);
  const sourceHead = sourceRaw.at(-1)?.offset ?? ("-1" as Offset);
  if (targetHead !== plan.target.offset) {
    throw new ThreeWayMergeError("merge/target-advanced", "target changed after planning", {
      expectedHead: plan.target.offset,
      actualHead: targetHead,
    });
  }
  if (sourceHead !== plan.source.offset) {
    throw new ThreeWayMergeError("merge/source-advanced", "source changed after planning", {
      expectedHead: plan.source.offset,
      actualHead: sourceHead,
    });
  }
  if (unresolvedMergeConflicts(await target.tree()).length > 0) {
    throw new ThreeWayMergeError("merge/target-conflicted", "target has unresolved conflicts");
  }
  const fresh = await planThreeWayMerge(target, source);
  if (canonicalJson(fresh.events) !== canonicalJson(plan.events)) {
    throw new ThreeWayMergeError("merge/reference-mismatch", "plan no longer matches its inputs");
  }
  let records: readonly StreamRecord[];
  try {
    records = await target.appendFencedBatch(plan.events, plan.target.offset);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "body" in error &&
      (error as { readonly body?: { readonly error?: { readonly reason?: unknown } } }).body?.error
        ?.reason === "merge/target-advanced"
    ) {
      throw new ThreeWayMergeError("merge/target-advanced", "target changed during append");
    }
    throw error;
  }
  const terminal = records.at(-1)!;
  return {
    kind: "three-way",
    mergeId: plan.mergeId,
    mergeOffset: terminal.offset,
    resultTreeDigest: plan.resultTreeDigest,
    conflicts: plan.conflicts.map(({ path, kind, reason }) => ({ path, kind, reason })),
  };
}

export async function mergeThreeWay(
  target: StreamFsRepo,
  source: StreamFsRepo,
): Promise<ThreeWayMergeReceipt> {
  const plan = await planThreeWayMerge(target, source);
  return applyThreeWayMerge(target, source, plan);
}

/** Record that the current target state is the chosen resolution for one conflict. */
export async function resolveMergeConflict(
  target: StreamFsRepo,
  mergeId: string,
  path: string,
): Promise<MergeResolutionReceipt> {
  const state = await target.tree();
  if (
    !unresolvedMergeConflicts(state).some(
      (conflict) => conflict.mergeId === mergeId && conflict.path === path,
    )
  ) {
    throw new ThreeWayMergeError(
      "merge/conflict-not-found",
      `no unresolved conflict ${mergeId}:${path}`,
    );
  }
  const resultTreeDigest = treeDigest(state);
  const receipt = await target.dispatchToStream(target.metadataStreamId, {
    type: "fs/merge-resolve",
    payload: { v: 1, mergeId, path, resolutionDigest: resultTreeDigest },
    ts: target.now(),
  });
  return {
    mergeId,
    path,
    resolutionOffset: receipt.event.offset as Offset,
    resultTreeDigest,
  };
}
