import type { Event } from "@eforest/protocol";
import { assertFsEvent } from "./events.js";
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

function filesOf(state: FsTree): Record<string, FsTree["files"][string]> {
  if (state === null || typeof state !== "object" || !Object.hasOwn(state, "files")) {
    throw new FsReducerError("<state>", "filesystem reducer state is malformed");
  }
  const files = state.files;
  if (files === null || typeof files !== "object" || Array.isArray(files)) {
    throw new FsReducerError("<state>", "filesystem tree files must be an object");
  }
  return { ...files };
}

export function fsReducer(state: FsTree, event: Event): FsTree {
  const candidate = event as Event & { readonly offset?: unknown };
  const eventWithoutOffset = { ...candidate };
  delete eventWithoutOffset.offset;
  assertFsEvent(eventWithoutOffset);
  const files = filesOf(state);
  const path = eventWithoutOffset.payload.path;
  switch (eventWithoutOffset.type) {
    case "fs.file.create":
      if (files[path] !== undefined) {
        throw new FsReducerError(
          eventWithoutOffset.type,
          `cannot create existing path ${path}`,
          path,
        );
      }
      files[path] = {
        contentStreamId: eventWithoutOffset.payload.contentStreamId,
        contentSha256: "0".repeat(64),
        size: 0,
      };
      return sortedTree(files);
    case "fs.file.write":
      if (files[path] === undefined) {
        throw new FsReducerError(
          eventWithoutOffset.type,
          `cannot write missing path ${path}`,
          path,
        );
      }
      files[path] = {
        contentStreamId: files[path]!.contentStreamId,
        contentSha256: eventWithoutOffset.payload.contentSha256,
        size: eventWithoutOffset.payload.size,
      };
      return sortedTree(files);
    case "fs.file.delete":
      if (files[path] === undefined) {
        throw new FsReducerError(
          eventWithoutOffset.type,
          `cannot delete missing path ${path}`,
          path,
        );
      }
      delete files[path];
      return sortedTree(files);
  }
}
