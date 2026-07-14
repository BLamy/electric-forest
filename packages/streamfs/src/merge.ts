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
  return (
    left.file.contentStreamId === right.file.contentStreamId &&
    left.file.contentSha256 === right.file.contentSha256 &&
    left.file.size === right.file.size
  );
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

function pathDepth(path: string): number {
  return path.split("/").length;
}

interface RankedChange {
  readonly phase: number;
  readonly path: string;
  readonly change: FsMergeChange;
  readonly identities?: ReadonlySet<string> | undefined;
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

function isPatchOnlyMutation(
  records: readonly StreamRecord[],
  path: string,
  basePath = path,
): boolean {
  let identityPath: string | undefined = basePath;
  let sawPatch = false;
  for (const record of expandThreeWayMergeRecords(records)) {
    const event = eventOf(record);
    if (!isFsEvent(event)) continue;
    if (identityPath === undefined) continue;
    if (event.type === "fs.file.write" && event.payload.path === identityPath) return false;
    if (event.type === "fs.file.patch" && event.payload.path === identityPath) sawPatch = true;
    if (event.type === "fs.file.delete" && event.payload.path === identityPath) {
      identityPath = undefined;
      continue;
    }
    if (event.type === "fs.rename" && isPathWithin(event.payload.from, identityPath)) {
      identityPath = `${event.payload.to}${identityPath.slice(event.payload.from.length)}`;
    }
  }
  return sawPatch && identityPath === path;
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

interface CausalStepInfo {
  readonly step: SourceMergeStep;
  readonly identities: ReadonlySet<string>;
  readonly structuralIdentities: ReadonlySet<string>;
  readonly supportIdentities: ReadonlySet<string>;
}

interface SourceRenameComponent {
  readonly renames: readonly SourceRenameStep[];
  readonly identities: ReadonlySet<string>;
  readonly movedIdentities: ReadonlySet<string>;
  readonly supportIdentities: ReadonlySet<string>;
}

interface RenameExclusion {
  readonly roots: readonly string[];
  readonly identities: ReadonlySet<string>;
}

interface RejectedRenameComponent extends RenameExclusion {
  readonly path: string;
  readonly basePath: string;
  readonly targetPath: string;
  readonly sourcePath: string;
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

function sourceStepPaths(step: SourceMergeStep): readonly string[] {
  return step.change.type === "fs.rename"
    ? [step.change.payload.from, step.change.payload.to]
    : [step.change.payload.path];
}

interface TracedNode {
  readonly identity: string;
  readonly kind: "file" | "dir";
  readonly originalPath?: string;
}

function baseIdentity(path: string): string {
  return `base:${path}`;
}

function identitiesOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const identity of left) if (right.has(identity)) return true;
  return false;
}

function tracedNodes(base: FsTree): Map<string, TracedNode> {
  const nodes = new Map<string, TracedNode>();
  for (const path of Object.keys(base.dirs)) {
    nodes.set(path, { identity: baseIdentity(path), kind: "dir", originalPath: path });
  }
  for (const path of Object.keys(base.files)) {
    nodes.set(path, { identity: baseIdentity(path), kind: "file", originalPath: path });
  }
  return nodes;
}

function baseIdentitiesWithin(base: FsTree, root: string): readonly string[] {
  return [...Object.keys(base.dirs), ...Object.keys(base.files)]
    .filter((path) => isPathWithin(root, path))
    .map(baseIdentity);
}

function createdDirectoryAncestors(
  nodes: ReadonlyMap<string, TracedNode>,
  path: string,
): readonly string[] {
  return [...nodes.entries()]
    .filter(
      ([candidate, node]) =>
        node.kind === "dir" &&
        node.originalPath === undefined &&
        candidate !== path &&
        isPathWithin(candidate, path),
    )
    .map(([, node]) => node.identity);
}

/**
 * Trace the logical node occupying each path at every event. Raw path overlap is not a
 * causal relation: a temporary alias can be vacated by one identity and reused later by
 * another. The identities here connect only the node being changed plus real structural
 * prerequisites (created parents, replaced base destinations, and directory cleanup).
 */
function causalTrace(
  base: FsTree,
  steps: readonly SourceMergeStep[],
): {
  readonly infos: readonly CausalStepInfo[];
  readonly nodes: ReadonlyMap<string, TracedNode>;
} {
  const nodes = tracedNodes(base);
  const infos: CausalStepInfo[] = [];
  for (const step of steps) {
    const identities = new Set<string>();
    const structuralIdentities = new Set<string>();
    const supportIdentities = new Set<string>();
    const change = step.change;
    if (change.type === "fs.rename") {
      const moved = [...nodes.entries()].filter(([path]) =>
        isPathWithin(change.payload.from, path),
      );
      for (const [, node] of moved) structuralIdentities.add(node.identity);
      for (const identity of createdDirectoryAncestors(nodes, change.payload.from)) {
        supportIdentities.add(identity);
      }
      for (const identity of createdDirectoryAncestors(nodes, change.payload.to)) {
        supportIdentities.add(identity);
      }
      // A destination that existed at the fork is a semantic dependency even after a
      // prior delete/move vacates it. This is what keeps replacement and swap programs
      // atomic without coupling later reuse of a path that was only ever temporary.
      for (const identity of baseIdentitiesWithin(base, change.payload.to)) {
        identities.add(identity);
      }
      for (const [path] of moved) nodes.delete(path);
      for (const [path, node] of moved) {
        nodes.set(`${change.payload.to}${path.slice(change.payload.from.length)}`, node);
      }
    } else if (change.type === "fs.file.create" || change.type === "fs.dir.create") {
      const existing = nodes.get(change.payload.path);
      const node: TracedNode =
        existing ??
        ({
          identity: `created:${step.index}:${change.payload.path}`,
          kind: change.type === "fs.file.create" ? "file" : "dir",
        } satisfies TracedNode);
      structuralIdentities.add(node.identity);
      nodes.set(change.payload.path, node);
    } else if (change.type === "fs.file.delete" || change.type === "fs.dir.remove") {
      const removed = [...nodes.entries()].filter(([path]) =>
        isPathWithin(change.payload.path, path),
      );
      for (const [, node] of removed) {
        structuralIdentities.add(node.identity);
        if (change.type === "fs.dir.remove" && node.originalPath !== undefined) {
          for (const identity of baseIdentitiesWithin(base, node.originalPath)) {
            structuralIdentities.add(identity);
          }
        }
      }
      for (const [path] of removed) nodes.delete(path);
    } else {
      const node = nodes.get(change.payload.path);
      if (node !== undefined) structuralIdentities.add(node.identity);
    }
    for (const identity of structuralIdentities) identities.add(identity);
    infos.push({ step, identities, structuralIdentities, supportIdentities });
  }
  return { infos, nodes };
}

function causalStepInfos(
  base: FsTree,
  steps: readonly SourceMergeStep[],
): readonly CausalStepInfo[] {
  return causalTrace(base, steps).infos;
}

function renameComponents(
  base: FsTree,
  renames: readonly SourceRenameStep[],
  sourceSteps: readonly SourceMergeStep[],
): readonly SourceRenameComponent[] {
  const infos = causalStepInfos(base, sourceSteps);
  const byIndex = new Map(infos.map((info) => [info.step.index, info]));
  const components: Array<{
    renames: SourceRenameStep[];
    identities: Set<string>;
    movedIdentities: Set<string>;
    supportIdentities: Set<string>;
  }> = renames.map((step) => {
    const info = byIndex.get(step.index);
    return {
      renames: [step],
      identities: new Set(info?.identities ?? []),
      movedIdentities: new Set(info?.structuralIdentities ?? []),
      supportIdentities: new Set(info?.supportIdentities ?? []),
    };
  });

  const mergeTouching = (identities: ReadonlySet<string>): boolean => {
    const touching = components.flatMap((component, index) =>
      identitiesOverlap(component.identities, identities) ? [index] : [],
    );
    if (touching.length === 0) return false;
    const merged = {
      renames: [] as SourceRenameStep[],
      identities: new Set(identities),
      movedIdentities: new Set<string>(),
      supportIdentities: new Set<string>(),
    };
    for (const index of touching.reverse()) {
      const component = components.splice(index, 1)[0]!;
      merged.renames.push(...component.renames);
      for (const identity of component.identities) merged.identities.add(identity);
      for (const identity of component.movedIdentities) merged.movedIdentities.add(identity);
      for (const identity of component.supportIdentities) merged.supportIdentities.add(identity);
    }
    merged.renames.sort((left, right) => left.index - right.index);
    components.push(merged);
    return touching.length > 1;
  };

  // Rename identities form the initial components. Then close them over every causal
  // support step. A cleanup such as rmdir can intentionally join sibling moves; a patch
  // to an earlier occupant of a reused alias cannot.
  for (const rename of renames) mergeTouching(byIndex.get(rename.index)!.identities);
  let changed = true;
  while (changed) {
    changed = false;
    for (const info of infos) {
      const touching = components.filter((component) =>
        identitiesOverlap(component.identities, info.identities),
      );
      if (touching.length === 0) continue;
      const before = touching.reduce((size, component) => size + component.identities.size, 0);
      const merged = mergeTouching(info.identities);
      const after = components.find((component) =>
        identitiesOverlap(component.identities, info.identities),
      )?.identities.size;
      if (merged || (after !== undefined && after > before)) changed = true;
    }
  }
  return components
    .map((component) => ({
      renames: component.renames,
      identities: component.identities,
      movedIdentities: component.movedIdentities,
      supportIdentities: component.supportIdentities,
    }))
    .sort((left, right) => left.renames[0]!.index - right.renames[0]!.index);
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

function affectedOriginalPaths(
  paths: ReadonlyMap<string, string>,
  step: SourceMergeStep,
): ReadonlySet<string> {
  if (step.change.type === "fs.rename") {
    const root = step.change.payload.from;
    return new Set(
      [...paths.entries()]
        .filter(([path]) => isPathWithin(root, path))
        .map(([, original]) => original),
    );
  }
  if (step.change.type === "fs.file.delete" || step.change.type === "fs.dir.remove") {
    const root = step.change.payload.path;
    return new Set(
      [...paths.entries()]
        .filter(([path]) => isPathWithin(root, path))
        .map(([, original]) => original),
    );
  }
  return new Set();
}

function structuralOriginalPaths(
  paths: ReadonlyMap<string, string>,
  steps: readonly SourceMergeStep[],
): ReadonlySet<string> {
  const current = new Map(paths);
  const originals = new Set<string>();
  for (const step of steps) {
    for (const original of affectedOriginalPaths(current, step)) originals.add(original);
    updateBasePathMap(current, step);
  }
  return originals;
}

function structuralStepsForOriginals(
  base: FsTree,
  steps: readonly SourceMergeStep[],
  originals: ReadonlySet<string>,
): readonly SourceMergeStep[] {
  if (originals.size === 0) return steps.filter(isCommonStructuralStep);
  const infos = causalStepInfos(base, steps).filter(({ step }) => isCommonStructuralStep(step));
  const identities = new Set([...originals].map(baseIdentity));
  const selected = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const info of infos) {
      if (
        selected.has(info.step.index) ||
        !identitiesOverlap(identities, info.structuralIdentities)
      ) {
        continue;
      }
      selected.add(info.step.index);
      for (const identity of info.structuralIdentities) identities.add(identity);
      for (const identity of info.supportIdentities) identities.add(identity);
      changed = true;
    }
  }
  return infos.filter(({ step }) => selected.has(step.index)).map(({ step }) => step);
}

function structuralProjection(
  base: FsTree,
  paths: ReadonlyMap<string, string>,
  steps: readonly SourceMergeStep[],
): { readonly tree: FsTree; readonly paths: Map<string, string> } | undefined {
  let tree = base;
  const projectedPaths = new Map(paths);
  try {
    for (const step of steps) {
      tree = applySourceStep(tree, step);
      updateBasePathMap(projectedPaths, step);
    }
  } catch {
    return undefined;
  }
  return { tree, paths: projectedPaths };
}

function pathAfterSteps(path: string, steps: readonly SourceMergeStep[]): string | undefined {
  let current: string | undefined = path;
  for (const step of steps) {
    if (current === undefined) break;
    if (
      (step.change.type === "fs.file.delete" || step.change.type === "fs.dir.remove") &&
      isPathWithin(step.change.payload.path, current)
    ) {
      current = undefined;
      continue;
    }
    if (step.change.type === "fs.rename" && isPathWithin(step.change.payload.from, current)) {
      current = `${step.change.payload.to}${current.slice(step.change.payload.from.length)}`;
    }
  }
  return current;
}

function liveReferencePath(
  tree: FsTree,
  originalPath: string,
  observedPath: string,
  steps: readonly SourceMergeStep[],
  preferObserved = false,
): string {
  if (preferObserved && nodeAt(tree, observedPath).kind !== "missing") return observedPath;
  const projectedPath = pathAfterSteps(originalPath, steps);
  if (projectedPath !== undefined && nodeAt(tree, projectedPath).kind !== "missing") {
    return projectedPath;
  }
  if (nodeAt(tree, observedPath).kind !== "missing") return observedPath;
  if (nodeAt(tree, originalPath).kind !== "missing") return originalPath;
  return projectedPath ?? observedPath;
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
  readonly exclusions: readonly RenameExclusion[];
  readonly rejected: readonly RejectedRenameComponent[];
  readonly alignedBase: FsTree;
  readonly alignedBasePaths: ReadonlyMap<string, string>;
  readonly sourceIdentities: ReadonlyMap<string, string>;
} {
  const sourceSteps = expandThreeWayMergeRecords(sourcePostFork)
    .map(sourceMergeStep)
    .filter((step): step is SourceMergeStep => step !== undefined);
  const targetSteps = expandThreeWayMergeRecords(targetPostFork)
    .map(sourceMergeStep)
    .filter((step): step is SourceMergeStep => step !== undefined);
  const sourceTrace = causalTrace(base, sourceSteps);
  const sourceInfos = sourceTrace.infos;
  const sourceIdentities = new Map(
    [...sourceTrace.nodes].map(([path, node]) => [path, node.identity] as const),
  );
  const targetIdentityPaths = new Map(
    [...causalTrace(base, targetSteps).nodes].map(([path, node]) => [node.identity, path] as const),
  );
  const liveSourceIdentities = new Set(sourceIdentities.values());
  const sourceInfoByIndex = new Map(sourceInfos.map((info) => [info.step.index, info]));
  const renames = sourceSteps.filter(
    (step): step is SourceRenameStep => step.change.type === "fs.rename",
  );
  let alignedBase = base;
  let alignedBasePaths = basePathMap(base);
  if (renames.length === 0) {
    return {
      ranked: [],
      exclusions: [],
      rejected: [],
      alignedBase,
      alignedBasePaths,
      sourceIdentities,
    };
  }

  const accepted = new Map<number, SourceMergeStep>();
  const exclusions: RenameExclusion[] = [];
  const rejected: RejectedRenameComponent[] = [];
  for (const component of renameComponents(base, renames, sourceSteps)) {
    if (
      component.movedIdentities.size > 0 &&
      [...component.movedIdentities].every(
        (identity) => identity.startsWith("created:") && !liveSourceIdentities.has(identity),
      )
    ) {
      continue;
    }
    const renameIndexes = new Set(component.renames.map(({ index }) => index));
    const componentPaths = component.renames.flatMap((step) => sourceStepPaths(step));
    const relevantIdentities = new Set([...component.identities, ...component.supportIdentities]);
    const relevant = sourceSteps.filter((step) => {
      if (renameIndexes.has(step.index)) return true;
      if (step.change.type === "fs.rename") return false;
      const info = sourceInfoByIndex.get(step.index);
      return info !== undefined && identitiesOverlap(relevantIdentities, info.identities);
    });
    const roots = new Set(relevant.flatMap(sourceStepPaths));
    if ([...roots].every((path) => structurallyEqualAt(target, source, path))) {
      exclusions.push({ roots: [...roots].sort(), identities: relevantIdentities });
      continue;
    }
    const alreadyAlignedSupport = new Set(
      relevant
        .filter((step) => {
          if (step.change.type !== "fs.dir.create") return false;
          const info = sourceInfoByIndex.get(step.index);
          return (
            info !== undefined &&
            identitiesOverlap(component.supportIdentities, info.identities) &&
            nodeAt(alignedBase, step.change.payload.path).kind === "dir" &&
            nodeAt(target, step.change.payload.path).kind === "dir" &&
            nodeAt(source, step.change.payload.path).kind === "dir"
          );
        })
        .map(({ index }) => index),
    );
    const activeRelevant = relevant.filter(({ index }) => !alreadyAlignedSupport.has(index));
    const sourceStructure = activeRelevant.filter(isCommonStructuralStep);
    const allTargetStructure = targetSteps.filter(isCommonStructuralStep);
    const overlappingTargetStructure = allTargetStructure.filter((step) =>
      sourceStepPaths(step).some((path) =>
        componentPaths.some((componentPath) => pathsOverlap(componentPath, path)),
      ),
    );
    const sourceOriginals = structuralOriginalPaths(alignedBasePaths, sourceStructure);
    const targetStructure =
      sourceOriginals.size === 0
        ? overlappingTargetStructure
        : structuralStepsForOriginals(base, targetSteps, sourceOriginals);
    const sourceProjection = structuralProjection(alignedBase, alignedBasePaths, sourceStructure);
    const targetProjection = structuralProjection(alignedBase, alignedBasePaths, targetStructure);
    let program = activeRelevant;
    let commonAligned = false;
    if (
      sourceProjection !== undefined &&
      targetProjection !== undefined &&
      [...roots].every((path) =>
        structurallyEqualAt(sourceProjection.tree, targetProjection.tree, path),
      )
    ) {
      alignedBase = targetProjection.tree;
      alignedBasePaths = targetProjection.paths;
      commonAligned = true;
      const structureIndexes = new Set(sourceStructure.map(({ index }) => index));
      program = activeRelevant.filter(({ index }) => !structureIndexes.has(index));
      if (program.length === 0) continue;
    }
    let commonLength = 0;
    while (
      !commonAligned &&
      commonLength < sourceStructure.length &&
      commonLength < targetStructure.length &&
      canonicalJson(sourceStructure[commonLength]!.change) ===
        canonicalJson(targetStructure[commonLength]!.change)
    ) {
      commonLength += 1;
    }
    const commonStructure = sourceStructure.slice(0, commonLength);
    const hasCommonAlignment = commonStructure.some(
      (step) => step.change.type === "fs.rename" || step.change.type === "fs.dir.create",
    );
    if (!commonAligned && hasCommonAlignment) {
      const projection = structuralProjection(alignedBase, alignedBasePaths, commonStructure);
      if (projection !== undefined) {
        alignedBase = projection.tree;
        alignedBasePaths = projection.paths;
        commonAligned = true;
        const commonIndexes = new Set(commonStructure.map(({ index }) => index));
        program = activeRelevant.filter(({ index }) => !commonIndexes.has(index));
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
    const programRoots = new Set(program.flatMap(sourceStepPaths));
    rejectedPath ??= [...programRoots].find((path) => {
      const currentIdentity = sourceIdentities.get(path);
      return (
        (currentIdentity === undefined || component.identities.has(currentIdentity)) &&
        !structurallyEqualAt(targetSim, source, path)
      );
    });
    const hasRemainingStructure = program.some(isCommonStructuralStep);
    if ((!safe || rejectedPath !== undefined) && commonAligned && !hasRemainingStructure) {
      continue;
    }
    if (!safe || rejectedPath !== undefined) {
      // A source-created identity has no fork state that must be moved atomically. If its
      // historical rename program crosses a target-only transient occupant, compare its
      // live final state normally instead of rejecting every path in the program. The
      // generic pass can reconstruct source-created bytes and will independently surface
      // any current occupant of the vacated alias.
      if (
        component.movedIdentities.size > 0 &&
        [...component.movedIdentities].every((identity) => identity.startsWith("created:"))
      ) {
        continue;
      }
      // A rejected rename component can contain several live inherited generations (a
      // swap is the smallest example). Emit one draft per live root identity instead of
      // collapsing the whole component onto the first path. Descendant identities ride
      // with their directory root, while later occupants of vacated aliases remain free
      // for the generic current-state comparison below.
      const programIdentities = new Set(
        program.flatMap((step) => [...(sourceInfoByIndex.get(step.index)?.identities ?? [])]),
      );
      const inheritedMoves = [...sourceIdentities]
        .filter(
          ([, identity]) =>
            identity.startsWith("base:") &&
            component.movedIdentities.has(identity) &&
            programIdentities.has(identity),
        )
        .sort(
          ([left], [right]) =>
            pathDepth(left) - pathDepth(right) || (left < right ? -1 : left > right ? 1 : 0),
        );
      const inheritedRoots = inheritedMoves.filter(
        ([path]) =>
          !inheritedMoves.some(
            ([candidate]) => candidate !== path && isPathWithin(candidate, path),
          ),
      );
      for (const [sourcePath, identity] of inheritedRoots) {
        const basePath = identity.slice("base:".length);
        // A common source/target move can align one inherited generation before a later
        // source replacement arrives at that aligned path. That replacement belongs to
        // the generic comparison against the aligned base generation, not to a stale
        // conflict against its own former base location.
        const alignedOriginal = alignedBasePaths.get(sourcePath);
        const isAlignedReplacement =
          alignedOriginal !== undefined &&
          alignedOriginal !== sourcePath &&
          alignedOriginal !== basePath;
        const identityTargetPath =
          targetIdentityPaths.get(identity) ??
          liveReferencePath(target, basePath, basePath, targetSteps);
        const targetBaseChanged = !sameSubtree(target, identityTargetPath, base, basePath);
        if (isAlignedReplacement && !targetBaseChanged) {
          exclusions.push({
            roots: [...new Set([basePath, identityTargetPath])].sort(),
            identities: new Set([identity]),
          });
          continue;
        }
        if (isAlignedReplacement) {
          const destinationIdentity = baseIdentity(alignedOriginal);
          rejected.push({
            path: sourcePath,
            basePath: alignedOriginal,
            targetPath:
              targetIdentityPaths.get(destinationIdentity) ??
              liveReferencePath(target, alignedOriginal, sourcePath, targetSteps),
            sourcePath,
            roots: [sourcePath],
            identities: new Set([identity, destinationIdentity]),
          });
        }
        const replacesForkDestination =
          sourcePath !== basePath &&
          nodeAt(base, sourcePath).kind !== "missing" &&
          component.identities.has(baseIdentity(sourcePath));
        const targetPath = replacesForkDestination ? sourcePath : identityTargetPath;
        const replacementIdentity = sourceIdentities.get(basePath);
        const isSplitInheritedRoot = inheritedRoots.some(([, candidate]) => {
          if (candidate === identity) return false;
          return pathsOverlap(basePath, candidate.slice("base:".length));
        });
        const conflictPath =
          sourcePath !== basePath &&
          (isSplitInheritedRoot ||
            (replacementIdentity !== undefined && replacementIdentity !== identity) ||
            replacesForkDestination)
            ? sourcePath
            : basePath;
        const sourceRoot = nodeAt(source, sourcePath);
        const identities = new Set(
          [...sourceIdentities]
            .filter(
              ([path, candidate]) =>
                isPathWithin(sourcePath, path) &&
                ((candidate.startsWith("base:") &&
                  isPathWithin(basePath, candidate.slice("base:".length))) ||
                  (sourceRoot.kind === "dir" && path !== sourcePath)),
            )
            .map(([, candidate]) => candidate),
        );
        rejected.push({
          path: conflictPath,
          basePath,
          targetPath,
          sourcePath,
          roots: [...roots].sort(),
          identities,
        });
      }
      continue;
    }
    for (const step of program) accepted.set(step.index, step);
    exclusions.push({ roots: [...roots].sort(), identities: relevantIdentities });
  }

  return {
    ranked: [...accepted.values()]
      .sort((left, right) => left.index - right.index)
      .map((step) => ({
        phase: -1_000_000 + step.index,
        path:
          step.change.type === "fs.rename" ? step.change.payload.from : step.change.payload.path,
        change: step.change,
        identities: sourceInfoByIndex.get(step.index)?.identities,
      })),
    exclusions,
    rejected,
    alignedBase,
    alignedBasePaths,
    sourceIdentities,
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
  readonly identities: ReadonlySet<string>;
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
  identities: ReadonlySet<string>,
): ConflictDraft {
  return {
    path,
    kind,
    reason,
    base: sideReference(baseRevision, basePath, base),
    target: sideReference(targetRevision, targetPath, target),
    source: sideReference(sourceRevision, sourcePath, source),
    identities,
  };
}

function identitiesWithin(
  identities: ReadonlyMap<string, string>,
  root: string,
): ReadonlySet<string> {
  return new Set(
    [...identities].filter(([path]) => isPathWithin(root, path)).map(([, identity]) => identity),
  );
}

function setConflictDraft(drafts: ConflictDraft[], draft: ConflictDraft, replace: boolean): void {
  const index = drafts.findIndex(({ path }) => path === draft.path);
  if (index < 0) {
    drafts.push(draft);
  } else if (replace) {
    drafts[index] = draft;
  }
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

  const targetPostFork = targetResolved.filter(
    (record) => compareOffsets(record.offset, forkOffset) > 0,
  );
  const sourceReferenceSteps = expandThreeWayMergeRecords(sourcePostFork)
    .map(sourceMergeStep)
    .filter((step): step is SourceMergeStep => step !== undefined);
  const targetReferenceSteps = expandThreeWayMergeRecords(targetPostFork)
    .map(sourceMergeStep)
    .filter((step): step is SourceMergeStep => step !== undefined);
  const targetIdentities = new Map(
    [...causalTrace(baseTree, targetReferenceSteps).nodes].map(
      ([path, node]) => [path, node.identity] as const,
    ),
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
    setConflictDraft(
      drafts,
      conflictDraft(
        rejected.path,
        "rename-rename",
        "non-patchable",
        baseRevision,
        targetRevision,
        sourceRevision,
        rejected.basePath,
        nodeAt(baseTree, rejected.basePath),
        rejected.targetPath,
        nodeAt(targetTree, rejected.targetPath),
        rejected.sourcePath,
        nodeAt(sourceTree, rejected.sourcePath),
        rejected.identities,
      ),
      false,
    );
  }
  const renameExclusions = [...structuralAdoptions.exclusions, ...structuralAdoptions.rejected];
  for (const path of paths) {
    const sourceIdentity = structuralAdoptions.sourceIdentities.get(path);
    if (
      renameExclusions.some(
        ({ roots, identities }) =>
          roots.some((root) => isPathWithin(root, path)) &&
          (sourceIdentity === undefined || identities.has(sourceIdentity)),
      )
    ) {
      excluded.add(path);
    }
  }
  const hasCurrentDescendantConflict = (root: string): boolean =>
    [...paths].some((path) => {
      if (path === root || !isPathWithin(root, path) || excluded.has(path)) return false;
      const basePath = structuralAdoptions.alignedBasePaths.get(path) ?? path;
      const baseNode = nodeAt(comparisonBaseTree, path);
      const targetNode = nodeAt(targetTree, path);
      const sourceNode = nodeAt(sourceTree, path);
      const independentSameContentAdds =
        baseNode.kind === "missing" &&
        targetNode.kind === "file" &&
        sourceNode.kind === "file" &&
        targetNode.file.contentStreamId !== sourceNode.file.contentStreamId;
      const targetMatchesBase = equalNode(targetNode, baseNode);
      const sourceMatchesBase = equalNode(sourceNode, baseNode);
      return (
        (independentSameContentAdds || !equalNode(targetNode, sourceNode)) &&
        !targetMatchesBase &&
        !sourceMatchesBase &&
        nodeAt(baseTree, basePath).kind !== "missing"
      );
    });
  for (const path of [...paths].sort()) {
    if (excluded.has(path)) continue;
    const basePath = structuralAdoptions.alignedBasePaths.get(path) ?? path;
    const baseNode = nodeAt(comparisonBaseTree, path);
    const baseReferenceNode = nodeAt(baseTree, basePath);
    const targetNode = nodeAt(targetTree, path);
    const sourceNode = nodeAt(sourceTree, path);
    const targetIdentity = targetIdentities.get(path);
    const sourceIdentity = structuralAdoptions.sourceIdentities.get(path);
    const independentDirectoryGenerations =
      targetNode.kind === "dir" &&
      sourceNode.kind === "dir" &&
      targetIdentity !== undefined &&
      sourceIdentity !== undefined &&
      targetIdentity !== sourceIdentity;
    const directoryGenerationConflict =
      independentDirectoryGenerations && !hasCurrentDescendantConflict(path);
    const baseReferenceIdentity =
      baseReferenceNode.kind === "missing" ? undefined : baseIdentity(basePath);
    const preferObservedTargetReference =
      baseReferenceIdentity === undefined || targetIdentities.get(path) !== baseReferenceIdentity;
    const preferObservedSourceReference =
      baseReferenceIdentity === undefined ||
      structuralAdoptions.sourceIdentities.get(path) !== baseReferenceIdentity;
    const targetReferencePath = liveReferencePath(
      targetTree,
      basePath,
      path,
      targetReferenceSteps,
      preferObservedTargetReference,
    );
    const sourceReferencePath = liveReferencePath(
      sourceTree,
      basePath,
      path,
      sourceReferenceSteps,
      preferObservedSourceReference,
    );
    const targetMatchesBase =
      equalNode(targetNode, baseNode) &&
      !directoryGenerationConflict &&
      !(
        targetNode.kind === "dir" &&
        baseNode.kind === "dir" &&
        sourceNode.kind === "file" &&
        !sameSubtree(targetTree, path, comparisonBaseTree, path)
      );
    const sourceMatchesBase = equalNode(sourceNode, baseNode) && !directoryGenerationConflict;
    const independentSameContentAdds =
      baseNode.kind === "missing" &&
      targetNode.kind === "file" &&
      sourceNode.kind === "file" &&
      targetNode.file.contentStreamId !== sourceNode.file.contentStreamId;
    if (
      (!independentSameContentAdds &&
        !directoryGenerationConflict &&
        equalNode(targetNode, sourceNode)) ||
      sourceMatchesBase
    ) {
      continue;
    }
    if (targetMatchesBase) {
      const identity = structuralAdoptions.sourceIdentities.get(path);
      const identities = identity === undefined ? undefined : new Set([identity]);
      ranked.push(
        ...(await sourceAdoptionChanges(path, targetNode, sourceNode, target, source)).map(
          (change) => ({ ...change, identities }),
        ),
      );
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
        isPatchOnlyMutation(targetPostFork, path, basePath) &&
        isPatchOnlyMutation(sourcePostFork, path, basePath);
      if (composed.kind === "clean" && directPatches) {
        ranked.push({
          phase: 6,
          path,
          identities: identitiesWithin(structuralAdoptions.sourceIdentities, path),
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
      setConflictDraft(
        drafts,
        conflictDraft(
          path,
          "edit-edit",
          composed.kind === "conflict" ? composed.reason : "non-patchable",
          baseRevision,
          targetRevision,
          sourceRevision,
          basePath,
          baseReferenceNode,
          targetReferencePath,
          nodeAt(targetTree, targetReferencePath),
          sourceReferencePath,
          nodeAt(sourceTree, sourceReferencePath),
          identitiesWithin(structuralAdoptions.sourceIdentities, path),
        ),
        true,
      );
      continue;
    }

    setConflictDraft(
      drafts,
      conflictDraft(
        path,
        conflictKind(baseNode, targetNode, sourceNode),
        "non-patchable",
        baseRevision,
        targetRevision,
        sourceRevision,
        basePath,
        baseReferenceNode,
        targetReferencePath,
        nodeAt(targetTree, targetReferencePath),
        sourceReferencePath,
        nodeAt(sourceTree, sourceReferencePath),
        directoryGenerationConflict && sourceIdentity !== undefined
          ? new Set([sourceIdentity])
          : identitiesWithin(structuralAdoptions.sourceIdentities, path),
      ),
      true,
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
  const changes = ranked
    .filter(
      ({ path, identities }) =>
        !conflictsSorted.some(
          (conflict) =>
            pathsOverlap(conflict.path, path) &&
            (identities === undefined ||
              identities.size === 0 ||
              conflict.identities.size === 0 ||
              identitiesOverlap(identities, conflict.identities)),
        ),
    )
    .sort(compareRankedChanges)
    .map(({ change }) => change);
  const publicConflictDrafts = conflictsSorted.map(
    ({ identities: _identities, ...conflict }) => conflict,
  );
  const mergeId = mergePlanId({
    base: baseRevision,
    target: targetRevision,
    source: sourceRevision,
    changes,
    conflicts: publicConflictDrafts,
  });
  const conflicts: FsMergeConflictPayload[] = publicConflictDrafts.map((conflict) => ({
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
