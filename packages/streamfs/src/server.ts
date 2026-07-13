import {
  ActionValidatorRegistry,
  createDefaultActionValidatorRegistry,
  createDefaultReducerRegistry,
  ReducerRegistry,
  type ActionValidatorResult,
  type ActionValidatorContext,
} from "@eforest/server";
import { isSnapshotEvent, type Event } from "@eforest/protocol";
import {
  isFsDirCreatePayload,
  isFsDirRemovePayload,
  isFsFileCreatePayload,
  isFsFileDeletePayload,
  isFsFileContentEvent,
  isFsBranchForkPayload,
  isFsFilePatchPayload,
  isFsFileWritePayload,
  isFsEvent,
  isFsRenamePayload,
  isValidFsPath,
} from "./events.js";
import { fsInitialState, fsReducer } from "./reducer.js";
import { applyPatch, digestBytes, isPatchOps, patchResultSize, PatchError } from "./patch/ops.js";
import type { FsTree } from "./tree.js";
import { FS_EVENT_VERSION } from "./version.js";
import { registerFsFencing } from "./fencing.js";
import { isBranchContentStreamId, isBranchName } from "./branch.js";
import { resolveBranchLog, type BranchDump } from "./resolve.js";

const FS_STREAM_TYPE = "fs-meta";
const FS_REDUCER_VERSION = `fs-v${FS_EVENT_VERSION}`;

function rejected(reason: string, field = "payload"): ActionValidatorResult {
  return { ok: false, class: "validator-rejected", reason, field };
}

function snapshotValidator(action: Event): ActionValidatorResult {
  return isSnapshotEvent(action) ? { ok: true } : rejected("snapshot payload is malformed");
}

function isMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rawStream(context: ActionValidatorContext): readonly {
  readonly offset: string;
  readonly type: string;
  readonly payload: unknown;
  readonly ts: number;
}[] {
  if (context.streamId === undefined || context.readStream === undefined) return [];
  try {
    return context.readStream(context.streamId);
  } catch {
    return [];
  }
}

function resolvedRecords(context: ActionValidatorContext):
  | readonly {
      readonly offset: import("@eforest/protocol").Offset;
      readonly type: string;
      readonly payload: unknown;
      readonly ts: number;
    }[]
  | undefined {
  const current = rawStream(context);
  const first = current[0];
  if (first?.type !== "fs.branch.fork") return undefined;
  const dumps: BranchDump[] = [];
  const seen = new Set<string>();
  let streamId = context.streamId;
  while (streamId !== undefined) {
    if (seen.has(streamId)) return undefined;
    seen.add(streamId);
    let records: ReadonlyArray<(typeof current)[number]>;
    try {
      records = context.readStream?.(streamId) ?? [];
    } catch {
      return undefined;
    }
    dumps.push({ streamId, records: records as never });
    const firstRecord = records[0];
    if (firstRecord?.type !== "fs.branch.fork") break;
    const payload = firstRecord.payload as Record<string, unknown>;
    if (typeof payload.parentStreamId !== "string") return undefined;
    streamId = payload.parentStreamId;
  }
  try {
    return resolveBranchLog(dumps);
  } catch {
    return undefined;
  }
}

function treeState(context: ActionValidatorContext): FsTree | undefined {
  const resolved = resolvedRecords(context);
  if (resolved !== undefined) {
    let state = fsInitialState;
    try {
      for (const record of resolved) state = fsReducer(state, record as never);
      return state;
    } catch {
      return undefined;
    }
  }
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

function movePathMap(values: Map<string, string>, from: string, to: string): void {
  const prefix = `${from}/`;
  for (const [path, streamId] of [...values.entries()]) {
    if (path === from) {
      values.delete(path);
      values.set(to, streamId);
    } else if (path.startsWith(prefix)) {
      values.delete(path);
      values.set(`${to}${path.slice(from.length)}`, streamId);
    }
  }
}

function decodeContentEvent(value: unknown): Uint8Array | undefined {
  if (!isFsFileContentEvent(value)) return undefined;
  const bytes = new Uint8Array(Buffer.from(value.payload.contentBase64, "base64"));
  return Buffer.from(bytes).toString("base64") === value.payload.contentBase64 ? bytes : undefined;
}

function contentBytes(context: ActionValidatorContext, streamId: string): Uint8Array | undefined {
  const contentRecords = context.readStream?.(streamId) ?? [];
  const fullContents: Uint8Array[] = [];
  for (const record of contentRecords) {
    const event = { ...record } as Record<string, unknown>;
    delete event.offset;
    const bytes = decodeContentEvent(event);
    if (bytes === undefined) return undefined;
    fullContents.push(bytes);
  }

  const metadataRecords = resolvedRecords(context) ?? rawStream(context);
  const paths = new Map<string, string>();
  const contents = new Map<string, Uint8Array>();
  let contentIndex = 0;
  for (const record of metadataRecords) {
    const event = { ...record } as Record<string, unknown>;
    delete event.offset;
    if (!isFsEvent(event)) continue;
    switch (event.type) {
      case "fs.file.create": {
        const previous = paths.get(event.payload.path);
        if (previous !== undefined && previous !== event.payload.contentStreamId) {
          const index = contentIndex;
          const bytes = fullContents[index];
          if (event.payload.contentStreamId === streamId && bytes !== undefined) {
            contents.set(streamId, bytes);
            contentIndex += 1;
          }
        }
        paths.set(event.payload.path, event.payload.contentStreamId);
        break;
      }
      case "fs.file.write": {
        if (paths.get(event.payload.path) !== streamId) break;
        const bytes = fullContents[contentIndex];
        if (bytes === undefined) return undefined;
        contents.set(streamId, bytes);
        contentIndex += 1;
        break;
      }
      case "fs.file.patch": {
        if (paths.get(event.payload.path) !== streamId) break;
        const base = contents.get(streamId);
        if (base === undefined || digestBytes(base) !== event.payload.baseDigest) return undefined;
        try {
          const result = applyPatch(base, event.payload.ops);
          if (digestBytes(result) !== event.payload.resultDigest) return undefined;
          contents.set(streamId, result);
        } catch {
          return undefined;
        }
        break;
      }
      case "fs.file.delete":
        paths.delete(event.payload.path);
        break;
      case "fs.rename":
        movePathMap(paths, event.payload.from, event.payload.to);
        break;
      case "fs.dir.create":
      case "fs.dir.remove":
      case "fs.file.content":
        break;
    }
  }
  return contents.get(streamId);
}

function createValidator(action: Event, context: ActionValidatorContext): ActionValidatorResult {
  if (!isFsFileCreatePayload(action.payload)) {
    return rejected(`fs.file.create payload must match version ${FS_EVENT_VERSION}`);
  }
  const state = treeState(context);
  if (!state) return rejected("filesystem state is malformed", "state");
  if (hasLivePath(state, action.payload.path)) {
    if (
      context.streamId !== undefined &&
      context.streamId.includes(":") &&
      ownsBranchContentStream(context.streamId, action.payload.contentStreamId) &&
      state.files[action.payload.path] !== undefined &&
      state.files[action.payload.path]!.contentStreamId !== action.payload.contentStreamId
    ) {
      return { ok: true };
    }
    return rejected(`cannot create existing path ${action.payload.path}`, "path");
  }
  if (!hasParent(state, action.payload.path)) {
    return rejected(`cannot create orphaned path ${action.payload.path}`, "path");
  }
  return { ok: true };
}

function branchNameFromMetadataStreamId(streamId: string | undefined): string | undefined {
  if (streamId === undefined) return undefined;
  // Keep the branch segment unambiguous. A colon in the repo segment would
  // make a raw stream id indistinguishable from a colon-containing branch.
  return /^fs:[^:]+:([^:]+):meta$/.exec(streamId)?.[1];
}

function ownsBranchContentStream(
  metadataStreamId: string | undefined,
  contentStreamId: string,
): boolean {
  const branchName = branchNameFromMetadataStreamId(metadataStreamId);
  return (
    branchName !== undefined &&
    isBranchContentStreamId(contentStreamId) &&
    contentStreamId.startsWith(`${metadataStreamId!.slice(0, -":meta".length)}:file:`)
  );
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

function patchValidator(action: Event, context: ActionValidatorContext): ActionValidatorResult {
  if (!isFsFilePatchPayload(action.payload)) {
    const payload = action.payload as Record<string, unknown> | null;
    if (
      payload !== null &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      Object.keys(payload).sort().join(",") === "base,baseDigest,ops,path,resultDigest,v" &&
      payload.v === FS_EVENT_VERSION &&
      isValidFsPath(payload.path) &&
      typeof payload.baseDigest === "string" &&
      typeof payload.resultDigest === "string" &&
      !isPatchOps(payload.ops)
    ) {
      return rejected("patch/malformed-ops", "ops");
    }
    return rejected(`fs.file.patch payload must match version ${FS_EVENT_VERSION}`);
  }
  const state = treeState(context);
  if (!state) return rejected("filesystem state is malformed", "state");
  const file = state.files[action.payload.path];
  if (file === undefined)
    return rejected(`cannot patch missing path ${action.payload.path}`, "path");
  if (file.contentSha256 !== action.payload.baseDigest) {
    return rejected("patch/base-mismatch", "baseDigest");
  }
  const bytes = contentBytes(context, file.contentStreamId);
  if (bytes === undefined) {
    try {
      patchResultSize(file.size, action.payload.ops);
    } catch (error) {
      return rejected(error instanceof PatchError ? error.code : String(error), "ops");
    }
    return rejected("patch/target-not-a-text-file", "path");
  }
  try {
    const result = applyPatch(bytes, action.payload.ops);
    if (digestBytes(result) !== action.payload.resultDigest) {
      return rejected("patch/result-mismatch", "resultDigest");
    }
  } catch (error) {
    return rejected(error instanceof PatchError ? error.code : String(error), "ops");
  }
  return { ok: true };
}

function branchForkValidator(
  action: Event,
  context: ActionValidatorContext,
): ActionValidatorResult {
  const payload = action.payload;
  if (!isFsBranchForkPayload(payload)) {
    return rejected("fs.branch.fork payload is malformed");
  }
  const records = rawStream(context);
  const branchName = branchNameFromMetadataStreamId(context.streamId);
  if (branchName === undefined || !isBranchName(branchName)) {
    return rejected("fs/invalid-branch-name", "branch");
  }
  if (records.length > 0) {
    const first = records[0];
    if (first?.type === "fs.branch.fork") return rejected("fs/branch-exists", "branch");
    return rejected("fs/fork-not-first-event", "event");
  }
  if (context.readStream === undefined) return rejected("fs/parent-not-found", "parentStreamId");
  let parent: readonly { readonly offset: string }[];
  try {
    parent = context.readStream(payload.parentStreamId);
  } catch {
    return rejected("fs/parent-not-found", "parentStreamId");
  }
  if (
    payload.forkOffset === "-1" ||
    !parent.some((record) => record.offset === payload.forkOffset)
  ) {
    return rejected("fs/fork-offset-out-of-range", "forkOffset");
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
    "fs.file.patch",
    "fs.snapshot",
    "fs.branch.fork",
  ]);
  return registry;
}

export function registerFsActionValidators(
  validators: ActionValidatorRegistry,
): ActionValidatorRegistry {
  registerFsFencing(validators, treeState);
  validators.registerValidator("fs.file.create", createValidator);
  validators.registerValidator("fs.file.write", writeValidator);
  validators.registerValidator("fs.file.delete", deleteValidator);
  validators.registerValidator("fs.dir.create", dirCreateValidator);
  validators.registerValidator("fs.dir.remove", dirRemoveValidator);
  validators.registerValidator("fs.rename", renameValidator);
  validators.registerValidator("fs.file.patch", patchValidator);
  validators.registerValidator("fs.snapshot", snapshotValidator);
  validators.registerValidator("fs.branch.fork", branchForkValidator);
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
