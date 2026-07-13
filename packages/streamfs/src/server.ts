import {
  ActionValidatorRegistry,
  createDefaultActionValidatorRegistry,
  createDefaultReducerRegistry,
  ReducerRegistry,
  type ActionValidatorResult,
  type ActionValidatorContext,
} from "@eforest/server";
import type { Event } from "@eforest/protocol";
import {
  isFsDirCreatePayload,
  isFsDirRemovePayload,
  isFsFileCreatePayload,
  isFsFileDeletePayload,
  isFsFileWritePayload,
  isFsRenamePayload,
} from "./events.js";
import { fsInitialState, fsReducer } from "./reducer.js";
import type { FsTree } from "./tree.js";
import { FS_EVENT_VERSION } from "./version.js";

const FS_STREAM_TYPE = "fs-meta";
const FS_REDUCER_VERSION = `fs-v${FS_EVENT_VERSION}`;

function rejected(reason: string, field = "payload"): ActionValidatorResult {
  return { ok: false, class: "validator-rejected", reason, field };
}

function isMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function treeState(context: ActionValidatorContext): FsTree | undefined {
  const state = context.state as Record<string, unknown> | null;
  if (
    state === null ||
    typeof state !== "object" ||
    Array.isArray(state) ||
    !isMap(state.files) ||
    !isMap(state.dirs) ||
    !isMap(state.tombstones)
  ) {
    return undefined;
  }
  return state as unknown as FsTree;
}

function hasLivePath(state: FsTree, path: string): boolean {
  return state.files[path] !== undefined || state.dirs[path] !== undefined;
}

function parentPath(path: string): string | undefined {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? undefined : path.slice(0, separator);
}

function hasParent(state: FsTree, path: string): boolean {
  const parent = parentPath(path);
  return parent === undefined || state.dirs[parent] !== undefined;
}

function isDescendant(parent: string, path: string): boolean {
  return path.startsWith(`${parent}/`);
}

function hasLiveDescendant(state: FsTree, path: string): boolean {
  const prefix = `${path}/`;
  return [...Object.keys(state.files), ...Object.keys(state.dirs)].some((entry) =>
    entry.startsWith(prefix),
  );
}

function createValidator(action: Event, context: ActionValidatorContext): ActionValidatorResult {
  if (!isFsFileCreatePayload(action.payload)) {
    return rejected(`fs.file.create payload must match version ${FS_EVENT_VERSION}`);
  }
  const state = treeState(context);
  if (!state) return rejected("filesystem state is malformed", "state");
  if (hasLivePath(state, action.payload.path)) {
    return rejected(`cannot create existing path ${action.payload.path}`, "path");
  }
  if (!hasParent(state, action.payload.path)) {
    return rejected(`cannot create orphaned path ${action.payload.path}`, "path");
  }
  return { ok: true };
}

function writeValidator(action: Event, context: ActionValidatorContext): ActionValidatorResult {
  if (!isFsFileWritePayload(action.payload)) {
    return rejected(`fs.file.write payload must match version ${FS_EVENT_VERSION}`);
  }
  const state = treeState(context);
  if (!state) return rejected("filesystem state is malformed", "state");
  if (state.files[action.payload.path] === undefined) {
    return rejected(`cannot write missing path ${action.payload.path}`, "path");
  }
  return { ok: true };
}

function deleteValidator(action: Event, context: ActionValidatorContext): ActionValidatorResult {
  if (!isFsFileDeletePayload(action.payload)) {
    return rejected(`fs.file.delete payload must match version ${FS_EVENT_VERSION}`);
  }
  const state = treeState(context);
  if (!state) return rejected("filesystem state is malformed", "state");
  if (state.files[action.payload.path] === undefined) {
    return rejected(`cannot delete missing file ${action.payload.path}`, "path");
  }
  return { ok: true };
}

function dirCreateValidator(action: Event, context: ActionValidatorContext): ActionValidatorResult {
  if (!isFsDirCreatePayload(action.payload)) {
    return rejected(`fs.dir.create payload must match version ${FS_EVENT_VERSION}`);
  }
  const state = treeState(context);
  if (!state) return rejected("filesystem state is malformed", "state");
  if (hasLivePath(state, action.payload.path)) {
    return rejected(`cannot create existing path ${action.payload.path}`, "path");
  }
  if (!hasParent(state, action.payload.path)) {
    return rejected(`cannot create orphaned directory ${action.payload.path}`, "path");
  }
  return { ok: true };
}

function dirRemoveValidator(action: Event, context: ActionValidatorContext): ActionValidatorResult {
  if (!isFsDirRemovePayload(action.payload)) {
    return rejected(`fs.dir.remove payload must match version ${FS_EVENT_VERSION}`);
  }
  const state = treeState(context);
  if (!state) return rejected("filesystem state is malformed", "state");
  if (state.dirs[action.payload.path] === undefined) {
    return rejected(`cannot remove missing directory ${action.payload.path}`, "path");
  }
  if (hasLiveDescendant(state, action.payload.path)) {
    return rejected(`cannot remove non-empty directory ${action.payload.path}`, "path");
  }
  return { ok: true };
}

function renameValidator(action: Event, context: ActionValidatorContext): ActionValidatorResult {
  if (!isFsRenamePayload(action.payload)) {
    return rejected(`fs.rename payload must match version ${FS_EVENT_VERSION}`);
  }
  const state = treeState(context);
  if (!state) return rejected("filesystem state is malformed", "state");
  const sourceIsFile = state.files[action.payload.from] !== undefined;
  const sourceIsDir = state.dirs[action.payload.from] !== undefined;
  if (!sourceIsFile && !sourceIsDir) {
    return rejected(`cannot rename missing path ${action.payload.from}`, "from");
  }
  if (hasLivePath(state, action.payload.to)) {
    return rejected(`cannot rename onto existing path ${action.payload.to}`, "to");
  }
  if (!hasParent(state, action.payload.to)) {
    return rejected(`cannot rename into missing parent ${action.payload.to}`, "to");
  }
  if (sourceIsDir && isDescendant(action.payload.from, action.payload.to)) {
    return rejected(`cannot rename directory into its own descendant ${action.payload.to}`, "to");
  }
  return { ok: true };
}

export function registerFsReducer(registry: ReducerRegistry): ReducerRegistry {
  registry.register(FS_STREAM_TYPE, fsReducer, FS_REDUCER_VERSION, fsInitialState, [
    "fs.file.create",
    "fs.file.write",
    "fs.file.delete",
    "fs.dir.create",
    "fs.dir.remove",
    "fs.rename",
  ]);
  return registry;
}

export function registerFsActionValidators(
  validators: ActionValidatorRegistry,
): ActionValidatorRegistry {
  validators.registerValidator("fs.file.create", createValidator);
  validators.registerValidator("fs.file.write", writeValidator);
  validators.registerValidator("fs.file.delete", deleteValidator);
  validators.registerValidator("fs.dir.create", dirCreateValidator);
  validators.registerValidator("fs.dir.remove", dirRemoveValidator);
  validators.registerValidator("fs.rename", renameValidator);
  return validators;
}

export function createStreamFsReducerRegistry(): ReducerRegistry {
  return registerFsReducer(createDefaultReducerRegistry());
}

export function createStreamFsActionValidatorRegistry(): ActionValidatorRegistry {
  return registerFsActionValidators(createDefaultActionValidatorRegistry());
}

export function createStreamFsServerOptions(): {
  readonly reducerRegistry: ReducerRegistry;
  readonly actionValidators: ActionValidatorRegistry;
} {
  return {
    reducerRegistry: createStreamFsReducerRegistry(),
    actionValidators: createStreamFsActionValidatorRegistry(),
  };
}
