import type { Event } from "@eforest/protocol";
import { assertFsEvent, type FsEvent } from "./events.js";
import { emptyTree, sortedTree, type FsTree } from "./tree.js";

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

export function fsReducer(state: FsTree, event: Event): FsTree {
  const candidate = event as Event & { readonly offset?: unknown };
  const eventWithoutOffset = { ...candidate };
  delete eventWithoutOffset.offset;
  assertFsEvent(eventWithoutOffset);
  const fsEvent = eventWithoutOffset as FsEvent;
  const { files, dirs, tombstones } = treeParts(state);
  const eventType = fsEvent.type;

  switch (fsEvent.type) {
    case "fs.file.create":
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
          `cannot create orphaned path ${fsEvent.payload.path}`,
          fsEvent.payload.path,
        );
      }
      files[fsEvent.payload.path] = {
        contentStreamId: fsEvent.payload.contentStreamId,
        contentSha256: "0".repeat(64),
        size: 0,
      };
      delete tombstones[fsEvent.payload.path];
      return sortedTree(files, dirs, tombstones);
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
      };
      return sortedTree(files, dirs, tombstones);
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
      return sortedTree(files, dirs, tombstones);
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
      return sortedTree(files, dirs, tombstones);
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
      return sortedTree(files, dirs, tombstones);
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
      return sortedTree(movedFiles, movedDirs, tombstones);
    }
  }
}
