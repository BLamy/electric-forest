import { isSnapshotEvent, type Event } from "@eforest/protocol";
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
import { contentMap, emptyTree, sortedTree, withContentMap, type FsTree } from "./tree.js";

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
  files: Readonly<Record<string, FsTree["files"][string]>>,
  dirs: Readonly<Record<string, FsTree["dirs"][string]>>,
  tombstones: Readonly<Record<string, FsTree["tombstones"][string]>>,
  contents: ReadonlyMap<string, Uint8Array>,
): FsTree {
  return withContentMap(sortedTree(files, dirs, tombstones), contents);
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
          return nextTree(files, dirs, tombstones, contents);
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
      return nextTree(files, dirs, tombstones, contents);
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
      return nextTree(files, dirs, tombstones, contents);
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
      return nextTree(files, dirs, tombstones, contents);
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
      return nextTree(files, dirs, tombstones, contents);
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
      return nextTree(files, dirs, tombstones, contents);
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
      return nextTree(movedFiles, movedDirs, tombstones, contents);
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
      return nextTree(files, dirs, tombstones, contents);
    }
    case "fs.file.content":
      throw new FsReducerError(
        eventType,
        "content event must be handled before metadata reduction",
      );
    case "fs.snapshot":
      return state;
    case "fs.branch.fork":
      return state;
    case "fs.branch.merge":
      return state;
  }
}
