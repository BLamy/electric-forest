import { canonicalJson, isSnapshotEvent, type Event } from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";
import {
  assertFsEvent,
  isFsBranchForkEvent,
  isFsFileContentEvent,
  type FsEvent,
} from "./events.js";
import { isBranchContentStreamId, markBranchState } from "./branch.js";
import { BASE_NONE } from "./fencing.js";
import { applyPatch, digestBytes, patchResultSize, PatchError } from "./patch/ops.js";
import { conflictIdentity, mergePlanId, sameRevision } from "./merge-integrity.js";
import {
  contentMap,
  emptyTree,
  inheritTreeMetadata,
  mergeStage,
  sortedTree,
  treeDigest,
  unresolvedMergeConflicts,
  withContentMap,
  withMergeConflicts,
  withMergeStage,
  type FsTree,
} from "./tree.js";

export class FsReducerError extends Error {
  readonly eventType: string;
  readonly path: string | undefined;

  constructor(eventType: string, message: string, path?: string) {
    super(message);
    this.name = "FsReducerError";
    this.eventType = eventType;
    this.path = path;
  }
}

export const fsInitialState = emptyTree();

function contentOffset(event: Event, eventType: string, path: string): string {
  const offset = (event as Event & { readonly offset?: unknown }).offset;
  if (typeof offset !== "string" || !isWellFormedOffset(offset)) {
    throw new FsReducerError(eventType, "content event is missing a valid stream offset", path);
  }
  return offset;
}

function isMap(value: unknown): value is Record<string, never> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function treeParts(state: FsTree): {
  files: Record<string, FsTree["files"][string]>;
  dirs: Record<string, FsTree["dirs"][string]>;
  tombstones: Record<string, FsTree["tombstones"][string]>;
} {
  if (
    state === null ||
    typeof state !== "object" ||
    !isMap(state.files) ||
    !isMap(state.dirs) ||
    !isMap(state.tombstones)
  ) {
    throw new FsReducerError("<state>", "filesystem reducer state is malformed");
  }
  return {
    files: { ...state.files },
    dirs: { ...state.dirs },
    tombstones: { ...state.tombstones },
  };
}

function parentPath(path: string): string | undefined {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? undefined : path.slice(0, separator);
}

function hasLivePath(
  files: Readonly<Record<string, unknown>>,
  dirs: Readonly<Record<string, unknown>>,
  path: string,
): boolean {
  return files[path] !== undefined || dirs[path] !== undefined;
}

function hasParent(dirs: Readonly<Record<string, unknown>>, path: string): boolean {
  const parent = parentPath(path);
  return parent === undefined || dirs[parent] !== undefined;
}

function isDescendant(parent: string, path: string): boolean {
  return path.startsWith(`${parent}/`);
}

function moveEntries<T>(
  entries: Readonly<Record<string, T>>,
  from: string,
  to: string,
): Record<string, T> {
  const moved: Record<string, T> = {};
  const prefix = `${from}/`;
  for (const [path, value] of Object.entries(entries)) {
    if (path === from) moved[to] = value;
    else if (path.startsWith(prefix)) moved[`${to}${path.slice(from.length)}`] = value;
    else moved[path] = value;
  }
  return moved;
}

function liveDescendant(
  files: Readonly<Record<string, unknown>>,
  dirs: Readonly<Record<string, unknown>>,
  path: string,
): string | undefined {
  const prefix = `${path}/`;
  return [...Object.keys(files), ...Object.keys(dirs)].find((entry) => entry.startsWith(prefix));
}

function nextTree(
  state: FsTree,
  files: Readonly<Record<string, FsTree["files"][string]>>,
  dirs: Readonly<Record<string, FsTree["dirs"][string]>>,
  tombstones: Readonly<Record<string, FsTree["tombstones"][string]>>,
  contents: ReadonlyMap<string, Uint8Array>,
): FsTree {
  const next = withContentMap(sortedTree(files, dirs, tombstones), contents);
  withMergeConflicts(next, unresolvedMergeConflicts(state));
  withMergeStage(next, mergeStage(state));
  return next;
}

function decodeContent(value: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (Buffer.from(bytes).toString("base64") !== value) {
    throw new FsReducerError("fs.file.content", "content event is not canonical base64");
  }
  return bytes;
}

export function fsReducer(state: FsTree, event: Event): FsTree {
  const candidate = event as Event & { readonly offset?: unknown };
  const eventWithoutOffset = { ...candidate };
  delete eventWithoutOffset.offset;
  const staged = mergeStage(state);
  if (
    (staged.changes.length > 0 || staged.conflicts.length > 0) &&
    eventWithoutOffset.type !== "fs/merge-change" &&
    eventWithoutOffset.type !== "fs/merge-conflict" &&
    eventWithoutOffset.type !== "fs.branch.merge"
  ) {
    throw new FsReducerError(eventWithoutOffset.type, "merge/interleaved-batch");
  }
  if (isSnapshotEvent(eventWithoutOffset)) return state;
  if (isFsBranchForkEvent(eventWithoutOffset)) {
    const next = sortedTree(state.files, state.dirs, state.tombstones);
    return markBranchState(next, {
      parentStreamId: eventWithoutOffset.payload.parentStreamId,
      forkOffset: eventWithoutOffset.payload.forkOffset,
    });
  }
  if (isFsFileContentEvent(eventWithoutOffset)) {
    const contents = contentMap(state);
    try {
      contents.set(
        eventWithoutOffset.payload.contentStreamId,
        decodeContent(eventWithoutOffset.payload.contentBase64),
      );
    } catch (error) {
      if (error instanceof FsReducerError) throw error;
      throw new FsReducerError(
        "fs.file.content",
        error instanceof Error ? error.message : String(error),
      );
    }
    return withContentMap(state, contents);
  }
  assertFsEvent(eventWithoutOffset);
  const fsEvent = eventWithoutOffset as FsEvent;
  const { files, dirs, tombstones } = treeParts(state);
  const contents = contentMap(state);
  const eventType = fsEvent.type;

  switch (fsEvent.type) {
    case "fs.file.create":
      if (hasLivePath(files, dirs, fsEvent.payload.path)) {
        const existing = files[fsEvent.payload.path];
        if (
          existing !== undefined &&
          existing.contentStreamId !== fsEvent.payload.contentStreamId &&
          isBranchContentStreamId(fsEvent.payload.contentStreamId)
        ) {
          files[fsEvent.payload.path] = {
            ...existing,
            contentStreamId: fsEvent.payload.contentStreamId,
          };
          return nextTree(state, files, dirs, tombstones, contents);
        }
        throw new FsReducerError(
          eventType,
          `cannot create existing path ${fsEvent.payload.path}`,
          fsEvent.payload.path,
        );
      }
      if (!hasParent(dirs, fsEvent.payload.path)) {
        throw new FsReducerError(
          eventType,
          `cannot create orphaned path ${fsEvent.payload.path}`,
          fsEvent.payload.path,
        );
      }
      files[fsEvent.payload.path] = {
        contentStreamId: fsEvent.payload.contentStreamId,
        contentSha256: "0".repeat(64),
        size: 0,
        lastContentOffset: BASE_NONE,
      };
      delete tombstones[fsEvent.payload.path];
      return nextTree(state, files, dirs, tombstones, contents);
    case "fs.file.write":
      if (files[fsEvent.payload.path] === undefined) {
        throw new FsReducerError(
          eventType,
          `cannot write missing path ${fsEvent.payload.path}`,
          fsEvent.payload.path,
        );
      }
      files[fsEvent.payload.path] = {
        contentStreamId: files[fsEvent.payload.path]!.contentStreamId,
        contentSha256: fsEvent.payload.contentSha256,
        size: fsEvent.payload.size,
        lastContentOffset: contentOffset(candidate, eventType, fsEvent.payload.path),
      };
      return nextTree(state, files, dirs, tombstones, contents);
    case "fs.file.delete":
      if (files[fsEvent.payload.path] === undefined) {
        throw new FsReducerError(
          eventType,
          `cannot delete missing file ${fsEvent.payload.path}`,
          fsEvent.payload.path,
        );
      }
      tombstones[fsEvent.payload.path] = {
        contentStreamId: files[fsEvent.payload.path]!.contentStreamId,
      };
      delete files[fsEvent.payload.path];
      return nextTree(state, files, dirs, tombstones, contents);
    case "fs.dir.create":
      if (hasLivePath(files, dirs, fsEvent.payload.path)) {
        throw new FsReducerError(
          eventType,
          `cannot create existing path ${fsEvent.payload.path}`,
          fsEvent.payload.path,
        );
      }
      if (!hasParent(dirs, fsEvent.payload.path)) {
        throw new FsReducerError(
          eventType,
          `cannot create orphaned directory ${fsEvent.payload.path}`,
          fsEvent.payload.path,
        );
      }
      dirs[fsEvent.payload.path] = {};
      delete tombstones[fsEvent.payload.path];
      return nextTree(state, files, dirs, tombstones, contents);
    case "fs.dir.remove":
      if (dirs[fsEvent.payload.path] === undefined) {
        throw new FsReducerError(
          eventType,
          `cannot remove missing directory ${fsEvent.payload.path}`,
          fsEvent.payload.path,
        );
      }
      {
        const descendant = liveDescendant(files, dirs, fsEvent.payload.path);
        if (descendant !== undefined) {
          throw new FsReducerError(
            eventType,
            `cannot remove non-empty directory ${fsEvent.payload.path}; contains ${descendant}`,
            fsEvent.payload.path,
          );
        }
      }
      delete dirs[fsEvent.payload.path];
      return nextTree(state, files, dirs, tombstones, contents);
    case "fs.rename": {
      const sourceFile = files[fsEvent.payload.from];
      const sourceDir = dirs[fsEvent.payload.from];
      if (sourceFile === undefined && sourceDir === undefined) {
        throw new FsReducerError(
          eventType,
          `cannot rename missing path ${fsEvent.payload.from}`,
          fsEvent.payload.from,
        );
      }
      if (hasLivePath(files, dirs, fsEvent.payload.to)) {
        throw new FsReducerError(
          eventType,
          `cannot rename onto existing path ${fsEvent.payload.to}`,
          fsEvent.payload.to,
        );
      }
      if (!hasParent(dirs, fsEvent.payload.to)) {
        throw new FsReducerError(
          eventType,
          `cannot rename into missing parent ${fsEvent.payload.to}`,
          fsEvent.payload.to,
        );
      }
      if (sourceDir !== undefined && isDescendant(fsEvent.payload.from, fsEvent.payload.to)) {
        throw new FsReducerError(
          eventType,
          `cannot rename directory into its own descendant ${fsEvent.payload.to}`,
          fsEvent.payload.to,
        );
      }
      const movedFiles = moveEntries(files, fsEvent.payload.from, fsEvent.payload.to);
      const movedDirs = moveEntries(dirs, fsEvent.payload.from, fsEvent.payload.to);
      delete tombstones[fsEvent.payload.to];
      return nextTree(state, movedFiles, movedDirs, tombstones, contents);
    }
    case "fs.file.patch": {
      const file = files[fsEvent.payload.path];
      if (file === undefined) {
        throw new FsReducerError(
          eventType,
          `cannot patch missing path ${fsEvent.payload.path}`,
          fsEvent.payload.path,
        );
      }
      if (file.contentSha256 !== fsEvent.payload.baseDigest) {
        throw new FsReducerError(eventType, "patch/base-mismatch", fsEvent.payload.path);
      }
      const current = contents.get(file.contentStreamId);
      let resultSize: number;
      if (current === undefined) {
        try {
          resultSize = patchResultSize(file.size, fsEvent.payload.ops);
        } catch (error) {
          throw new FsReducerError(
            eventType,
            error instanceof PatchError ? error.code : String(error),
            fsEvent.payload.path,
          );
        }
      } else {
        let result: Uint8Array;
        try {
          result = applyPatch(current, fsEvent.payload.ops);
        } catch (error) {
          throw new FsReducerError(
            eventType,
            error instanceof PatchError ? error.code : String(error),
            fsEvent.payload.path,
          );
        }
        if (digestBytes(result) !== fsEvent.payload.resultDigest) {
          throw new FsReducerError(eventType, "patch/result-mismatch", fsEvent.payload.path);
        }
        contents.set(file.contentStreamId, result);
        resultSize = result.byteLength;
      }
      files[fsEvent.payload.path] = {
        contentStreamId: file.contentStreamId,
        contentSha256: fsEvent.payload.resultDigest,
        size: resultSize,
        lastContentOffset: contentOffset(candidate, eventType, fsEvent.payload.path),
      };
      return nextTree(state, files, dirs, tombstones, contents);
    }
    case "fs.file.content":
      throw new FsReducerError(
        eventType,
        "content event must be handled before metadata reduction",
      );
    case "fs.snapshot":
      return state;
    case "fs.branch.genesis":
      return state;
    case "fs.branch.fork":
      return state;
    case "fs/merge-change": {
      const stage = mergeStage(state);
      const stagedMergeId = stage.changes[0]?.mergeId ?? stage.conflicts[0]?.mergeId;
      if (stagedMergeId !== undefined && stagedMergeId !== fsEvent.payload.mergeId) {
        throw new FsReducerError(eventType, "merge/interleaved-batch");
      }
      if (fsEvent.payload.index !== stage.changes.length) {
        throw new FsReducerError(eventType, "merge/change-order");
      }
      const next = inheritTreeMetadata(
        state,
        sortedTree(state.files, state.dirs, state.tombstones),
      );
      return withMergeStage(next, {
        changes: [...stage.changes, fsEvent.payload],
        conflicts: stage.conflicts,
      });
    }
    case "fs/merge-conflict": {
      const stage = mergeStage(state);
      const stagedMergeId = stage.changes[0]?.mergeId ?? stage.conflicts[0]?.mergeId;
      if (stagedMergeId !== undefined && stagedMergeId !== fsEvent.payload.mergeId) {
        throw new FsReducerError(eventType, "merge/interleaved-batch");
      }
      const next = inheritTreeMetadata(
        state,
        sortedTree(state.files, state.dirs, state.tombstones),
      );
      return withMergeStage(next, {
        changes: stage.changes,
        conflicts: [...stage.conflicts, fsEvent.payload],
      });
    }
    case "fs/merge-resolve": {
      const conflicts = unresolvedMergeConflicts(state);
      if (
        !conflicts.some(
          (conflict) =>
            conflict.mergeId === fsEvent.payload.mergeId && conflict.path === fsEvent.payload.path,
        )
      ) {
        throw new FsReducerError(eventType, "merge/conflict-not-found", fsEvent.payload.path);
      }
      const digest = treeDigest(state);
      if (digest !== fsEvent.payload.resolutionDigest) {
        throw new FsReducerError(
          eventType,
          "merge/resolution-digest-mismatch",
          fsEvent.payload.path,
        );
      }
      const next = inheritTreeMetadata(
        state,
        sortedTree(state.files, state.dirs, state.tombstones),
      );
      withMergeConflicts(
        next,
        conflicts.filter(
          (conflict) =>
            conflict.mergeId !== fsEvent.payload.mergeId || conflict.path !== fsEvent.payload.path,
        ),
      );
      return next;
    }
    case "fs.branch.merge": {
      if (fsEvent.payload.v === 1) {
        if (staged.changes.length > 0 || staged.conflicts.length > 0) {
          throw new FsReducerError(eventType, "merge/interleaved-batch");
        }
        return state;
      }
      const payload = fsEvent.payload;
      const stage = mergeStage(state);
      const stagedMergeId = stage.changes[0]?.mergeId ?? stage.conflicts[0]?.mergeId;
      if (
        (stagedMergeId !== undefined && stagedMergeId !== payload.mergeId) ||
        canonicalJson(stage.changes.map(({ change }) => change)) !==
          canonicalJson(payload.changes) ||
        canonicalJson(stage.conflicts) !== canonicalJson(payload.conflicts)
      ) {
        throw new FsReducerError(eventType, "merge/staged-record-mismatch");
      }
      const baseRevision = {
        streamId: payload.targetStreamId,
        offset: payload.forkOffset,
        treeDigest: payload.baseTreeDigest,
      };
      const targetRevision = {
        streamId: payload.targetStreamId,
        offset: payload.targetHeadOffset,
        treeDigest: payload.targetTreeDigest,
      };
      const sourceRevision = {
        streamId: payload.sourceStreamId,
        offset: payload.sourceHeadOffset,
        treeDigest: payload.sourceTreeDigest,
      };
      if (
        payload.conflicts.some(
          (conflict) =>
            conflict.mergeId !== payload.mergeId ||
            !sameRevision(conflict.base, baseRevision) ||
            !sameRevision(conflict.target, targetRevision) ||
            !sameRevision(conflict.source, sourceRevision),
        ) ||
        mergePlanId({
          base: baseRevision,
          target: targetRevision,
          source: sourceRevision,
          changes: payload.changes,
          conflicts: payload.conflicts.map(conflictIdentity),
        }) !== payload.mergeId
      ) {
        throw new FsReducerError(eventType, "merge/reference-mismatch");
      }
      if (unresolvedMergeConflicts(state).length > 0) {
        throw new FsReducerError(eventType, "merge/target-conflicted");
      }
      const actualTargetDigest = treeDigest(state);
      if (actualTargetDigest !== payload.targetTreeDigest) {
        throw new FsReducerError(eventType, "merge/target-digest-mismatch");
      }
      let merged = withMergeStage(
        inheritTreeMetadata(state, sortedTree(state.files, state.dirs, state.tombstones)),
        { changes: [], conflicts: [] },
      );
      for (const change of payload.changes) {
        merged = fsReducer(merged, {
          type: change.type,
          payload: change.payload,
          ts: fsEvent.ts,
          offset: candidate.offset,
        } as Event);
      }
      const actualResultDigest = treeDigest(merged);
      if (actualResultDigest !== payload.resultTreeDigest) {
        throw new FsReducerError(eventType, "merge/result-digest-mismatch");
      }
      withMergeConflicts(merged, payload.conflicts);
      return withMergeStage(merged, { changes: [], conflicts: [] });
    }
  }
}
