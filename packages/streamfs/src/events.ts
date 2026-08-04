import {
  isEvent,
  isSnapshotEvent,
  OFFSET_BEFORE_FIRST,
  type Event,
  type Offset,
  type SnapshotEvent,
} from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";
import { FS_EVENT_VERSION } from "./version.js";
import { isPatchOps, type PatchOps } from "./patch/ops.js";

export interface FsFileCreatePayload {
  readonly v: typeof FS_EVENT_VERSION;
  readonly path: string;
  readonly contentStreamId: string;
}

export interface FsFileWritePayload {
  readonly v: typeof FS_EVENT_VERSION;
  readonly path: string;
  readonly base: string;
  readonly contentSha256: string;
  readonly size: number;
}

export interface FsFileDeletePayload {
  readonly v: typeof FS_EVENT_VERSION;
  readonly path: string;
}

export interface FsDirCreatePayload {
  readonly v: typeof FS_EVENT_VERSION;
  readonly path: string;
}

export interface FsDirRemovePayload {
  readonly v: typeof FS_EVENT_VERSION;
  readonly path: string;
}

export interface FsRenamePayload {
  readonly v: typeof FS_EVENT_VERSION;
  readonly from: string;
  readonly to: string;
}

export interface FsFilePatchPayload {
  readonly v: typeof FS_EVENT_VERSION;
  readonly path: string;
  readonly base: string;
  readonly baseDigest: string;
  readonly ops: PatchOps;
  readonly resultDigest: string;
}

export interface FsFileContentPayload {
  readonly v: typeof FS_EVENT_VERSION;
  readonly contentStreamId: string;
  readonly contentBase64: string;
}

/** Branch directives are versioned independently from the v2 fs payloads. */
export interface FsBranchForkPayload {
  readonly v: 1;
  readonly parentStreamId: string;
  readonly forkOffset: Offset;
}

/** The root branch marker emitted once when an adopted repository is created. */
export interface FsBranchGenesisPayload {
  readonly v: 1;
  readonly branch: string;
}

export interface FsBranchFastForwardMergePayload {
  readonly v: 1;
  readonly sourceStreamId: string;
  readonly forkOffset: Offset;
  readonly mergedThroughOffset: Offset;
}

export interface FsMergeRevisionRef {
  readonly streamId: string;
  readonly offset: Offset;
  readonly treeDigest: string;
}

export type FsMergeNodeRef =
  | { readonly kind: "missing"; readonly path: string }
  | { readonly kind: "dir"; readonly path: string }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly contentStreamId: string;
      readonly contentSha256: string;
      readonly size: number;
      readonly lastContentOffset: string;
    };

export interface FsMergeSideRef extends FsMergeRevisionRef {
  readonly node: FsMergeNodeRef;
}

export type FsMergeConflictKind = "edit-edit" | "delete-edit" | "rename-rename" | "add-add";
export type FsMergeConflictReason = "overlap" | "binary" | "non-patchable";

export interface FsMergeConflictPayload {
  readonly v: 1;
  readonly mergeId: string;
  readonly path: string;
  readonly kind: FsMergeConflictKind;
  readonly reason: FsMergeConflictReason;
  readonly base: FsMergeSideRef;
  readonly target: FsMergeSideRef;
  readonly source: FsMergeSideRef;
}

export type FsMergeChange =
  | { readonly type: "fs.file.create"; readonly payload: FsFileCreatePayload }
  | { readonly type: "fs.file.write"; readonly payload: FsFileWritePayload }
  | { readonly type: "fs.file.delete"; readonly payload: FsFileDeletePayload }
  | { readonly type: "fs.dir.create"; readonly payload: FsDirCreatePayload }
  | { readonly type: "fs.dir.remove"; readonly payload: FsDirRemovePayload }
  | { readonly type: "fs.rename"; readonly payload: FsRenamePayload }
  | { readonly type: "fs.file.patch"; readonly payload: FsFilePatchPayload };

export interface FsMergeChangePayload {
  readonly v: 1;
  readonly mergeId: string;
  readonly index: number;
  readonly change: FsMergeChange;
}

export interface FsBranchThreeWayMergePayload {
  readonly v: 2;
  readonly kind: "three-way";
  readonly mergeId: string;
  readonly targetStreamId: string;
  readonly sourceStreamId: string;
  readonly forkOffset: Offset;
  readonly mergedThroughOffset: Offset;
  readonly sourceHeadOffset: Offset;
  readonly targetHeadOffset: Offset;
  readonly baseTreeDigest: string;
  readonly targetTreeDigest: string;
  readonly sourceTreeDigest: string;
  readonly resultTreeDigest: string;
  readonly changes: readonly FsMergeChange[];
  readonly conflicts: readonly FsMergeConflictPayload[];
}

export type FsBranchMergePayload = FsBranchFastForwardMergePayload | FsBranchThreeWayMergePayload;

export interface FsMergeResolvePayload {
  readonly v: 1;
  readonly mergeId: string;
  readonly path: string;
  readonly resolutionDigest: string;
}

export interface FsFileCreateEvent extends Event {
  readonly type: "fs.file.create";
  readonly payload: FsFileCreatePayload;
}

export interface FsFileWriteEvent extends Event {
  readonly type: "fs.file.write";
  readonly payload: FsFileWritePayload;
}

export interface FsFileDeleteEvent extends Event {
  readonly type: "fs.file.delete";
  readonly payload: FsFileDeletePayload;
}

export interface FsDirCreateEvent extends Event {
  readonly type: "fs.dir.create";
  readonly payload: FsDirCreatePayload;
}

export interface FsDirRemoveEvent extends Event {
  readonly type: "fs.dir.remove";
  readonly payload: FsDirRemovePayload;
}

export interface FsRenameEvent extends Event {
  readonly type: "fs.rename";
  readonly payload: FsRenamePayload;
}

export interface FsFilePatchEvent extends Event {
  readonly type: "fs.file.patch";
  readonly payload: FsFilePatchPayload;
}

export interface FsFileContentEvent extends Event {
  readonly type: "fs.file.content";
  readonly payload: FsFileContentPayload;
}

export interface FsBranchForkEvent extends Event {
  readonly type: "fs.branch.fork";
  readonly payload: FsBranchForkPayload;
}

export interface FsBranchGenesisEvent extends Event {
  readonly type: "fs.branch.genesis";
  readonly payload: FsBranchGenesisPayload;
}

export interface FsBranchMergeEvent extends Event {
  readonly type: "fs.branch.merge";
  readonly payload: FsBranchMergePayload;
}

export interface FsMergeChangeEvent extends Event {
  readonly type: "fs/merge-change";
  readonly payload: FsMergeChangePayload;
}

export interface FsMergeConflictEvent extends Event {
  readonly type: "fs/merge-conflict";
  readonly payload: FsMergeConflictPayload;
}

export interface FsMergeResolveEvent extends Event {
  readonly type: "fs/merge-resolve";
  readonly payload: FsMergeResolvePayload;
}

export type FsEvent =
  | FsFileCreateEvent
  | FsFileWriteEvent
  | FsFileDeleteEvent
  | FsDirCreateEvent
  | FsDirRemoveEvent
  | FsRenameEvent
  | FsFilePatchEvent
  | FsFileContentEvent
  | FsBranchGenesisEvent
  | FsBranchForkEvent
  | FsBranchMergeEvent
  | FsMergeChangeEvent
  | FsMergeConflictEvent
  | FsMergeResolveEvent
  | SnapshotEvent;

export class FsEventValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "FsEventValidationError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isUnicodeScalarString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function isValidFsPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (!isUnicodeScalarString(value) || value.includes("\0") || value.normalize("NFC") !== value) {
    return false;
  }
  if (value.startsWith("/") || value.endsWith("/")) return false;
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isVersion(value: unknown): value is typeof FS_EVENT_VERSION {
  return value === FS_EVENT_VERSION;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && isUnicodeScalarString(value);
}

function isBranchOffset(value: unknown): value is Offset {
  return value === OFFSET_BEFORE_FIRST || (typeof value === "string" && isWellFormedOffset(value));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isFsFileCreatePayload(value: unknown): value is FsFileCreatePayload {
  const payload = record(value);
  return (
    payload !== undefined &&
    hasExactKeys(payload, ["contentStreamId", "path", "v"]) &&
    isVersion(payload.v) &&
    isValidFsPath(payload.path) &&
    isNonEmptyString(payload.contentStreamId)
  );
}

export function isFsFileWritePayload(value: unknown): value is FsFileWritePayload {
  const payload = record(value);
  return (
    payload !== undefined &&
    hasExactKeys(payload, ["base", "contentSha256", "path", "size", "v"]) &&
    isVersion(payload.v) &&
    isValidFsPath(payload.path) &&
    typeof payload.base === "string" &&
    isSha256(payload.contentSha256) &&
    isSize(payload.size)
  );
}

export function isFsFileDeletePayload(value: unknown): value is FsFileDeletePayload {
  const payload = record(value);
  return (
    payload !== undefined &&
    hasExactKeys(payload, ["path", "v"]) &&
    isVersion(payload.v) &&
    isValidFsPath(payload.path)
  );
}

export function isFsDirCreatePayload(value: unknown): value is FsDirCreatePayload {
  const payload = record(value);
  return (
    payload !== undefined &&
    hasExactKeys(payload, ["path", "v"]) &&
    isVersion(payload.v) &&
    isValidFsPath(payload.path)
  );
}

export function isFsDirRemovePayload(value: unknown): value is FsDirRemovePayload {
  return isFsDirCreatePayload(value);
}

export function isFsRenamePayload(value: unknown): value is FsRenamePayload {
  const payload = record(value);
  return (
    payload !== undefined &&
    hasExactKeys(payload, ["from", "to", "v"]) &&
    isVersion(payload.v) &&
    isValidFsPath(payload.from) &&
    isValidFsPath(payload.to)
  );
}

export function isFsFilePatchPayload(value: unknown): value is FsFilePatchPayload {
  const payload = record(value);
  return (
    payload !== undefined &&
    hasExactKeys(payload, ["base", "baseDigest", "ops", "path", "resultDigest", "v"]) &&
    isVersion(payload.v) &&
    isValidFsPath(payload.path) &&
    typeof payload.base === "string" &&
    isSha256(payload.baseDigest) &&
    isPatchOps(payload.ops) &&
    isSha256(payload.resultDigest)
  );
}

export function isFsFileContentPayload(value: unknown): value is FsFileContentPayload {
  const payload = record(value);
  return (
    payload !== undefined &&
    hasExactKeys(payload, ["contentBase64", "contentStreamId", "v"]) &&
    isVersion(payload.v) &&
    isNonEmptyString(payload.contentStreamId) &&
    typeof payload.contentBase64 === "string"
  );
}

export function isFsBranchForkPayload(value: unknown): value is FsBranchForkPayload {
  const payload = record(value);
  return (
    payload !== undefined &&
    hasExactKeys(payload, ["forkOffset", "parentStreamId", "v"]) &&
    payload.v === 1 &&
    isNonEmptyString(payload.parentStreamId) &&
    isBranchOffset(payload.forkOffset)
  );
}

export function isFsBranchGenesisPayload(value: unknown): value is FsBranchGenesisPayload {
  const payload = record(value);
  return (
    payload !== undefined &&
    hasExactKeys(payload, ["branch", "v"]) &&
    payload.v === 1 &&
    isNonEmptyString(payload.branch)
  );
}

export function isFsBranchGenesisEvent(value: unknown): value is FsBranchGenesisEvent {
  return (
    isEvent(value) && value.type === "fs.branch.genesis" && isFsBranchGenesisPayload(value.payload)
  );
}

function isFsMergeRevisionRef(value: unknown): value is FsMergeRevisionRef {
  const reference = record(value);
  return (
    reference !== undefined &&
    hasExactKeys(reference, ["offset", "streamId", "treeDigest"]) &&
    isNonEmptyString(reference.streamId) &&
    isBranchOffset(reference.offset) &&
    isSha256(reference.treeDigest)
  );
}

function isFsMergeNodeRef(value: unknown): value is FsMergeNodeRef {
  const node = record(value);
  if (node === undefined || !isValidFsPath(node.path)) return false;
  if (node.kind === "missing" || node.kind === "dir") {
    return hasExactKeys(node, ["kind", "path"]);
  }
  return (
    node.kind === "file" &&
    hasExactKeys(node, [
      "contentSha256",
      "contentStreamId",
      "kind",
      "lastContentOffset",
      "path",
      "size",
    ]) &&
    isNonEmptyString(node.contentStreamId) &&
    isSha256(node.contentSha256) &&
    isSize(node.size) &&
    typeof node.lastContentOffset === "string"
  );
}

function isFsMergeSideRef(value: unknown): value is FsMergeSideRef {
  const reference = record(value);
  if (
    reference === undefined ||
    !hasExactKeys(reference, ["node", "offset", "streamId", "treeDigest"])
  ) {
    return false;
  }
  return (
    isFsMergeRevisionRef({
      streamId: reference.streamId,
      offset: reference.offset,
      treeDigest: reference.treeDigest,
    }) && isFsMergeNodeRef(reference.node)
  );
}

export function isFsMergeChange(value: unknown): value is FsMergeChange {
  const change = record(value);
  if (change === undefined || !hasExactKeys(change, ["payload", "type"])) return false;
  switch (change.type) {
    case "fs.file.create":
      return isFsFileCreatePayload(change.payload);
    case "fs.file.write":
      return isFsFileWritePayload(change.payload);
    case "fs.file.delete":
      return isFsFileDeletePayload(change.payload);
    case "fs.dir.create":
      return isFsDirCreatePayload(change.payload);
    case "fs.dir.remove":
      return isFsDirRemovePayload(change.payload);
    case "fs.rename":
      return isFsRenamePayload(change.payload);
    case "fs.file.patch":
      return isFsFilePatchPayload(change.payload);
    default:
      return false;
  }
}

export function isFsMergeConflictPayload(value: unknown): value is FsMergeConflictPayload {
  const payload = record(value);
  return (
    payload !== undefined &&
    hasExactKeys(payload, ["base", "kind", "mergeId", "path", "reason", "source", "target", "v"]) &&
    payload.v === 1 &&
    isSha256(payload.mergeId) &&
    isValidFsPath(payload.path) &&
    (payload.kind === "edit-edit" ||
      payload.kind === "delete-edit" ||
      payload.kind === "rename-rename" ||
      payload.kind === "add-add") &&
    (payload.reason === "overlap" ||
      payload.reason === "binary" ||
      payload.reason === "non-patchable") &&
    isFsMergeSideRef(payload.base) &&
    isFsMergeSideRef(payload.target) &&
    isFsMergeSideRef(payload.source)
  );
}

export function isFsMergeChangePayload(value: unknown): value is FsMergeChangePayload {
  const payload = record(value);
  return (
    payload !== undefined &&
    hasExactKeys(payload, ["change", "index", "mergeId", "v"]) &&
    payload.v === 1 &&
    isSha256(payload.mergeId) &&
    typeof payload.index === "number" &&
    Number.isSafeInteger(payload.index) &&
    payload.index >= 0 &&
    isFsMergeChange(payload.change)
  );
}

export function isFsBranchMergePayload(value: unknown): value is FsBranchMergePayload {
  const payload = record(value);
  if (payload === undefined) return false;
  if (payload.v === 1) {
    return (
      hasExactKeys(payload, ["forkOffset", "mergedThroughOffset", "sourceStreamId", "v"]) &&
      isNonEmptyString(payload.sourceStreamId) &&
      isBranchOffset(payload.forkOffset) &&
      isBranchOffset(payload.mergedThroughOffset)
    );
  }
  return (
    payload.v === 2 &&
    hasExactKeys(payload, [
      "baseTreeDigest",
      "changes",
      "conflicts",
      "forkOffset",
      "kind",
      "mergeId",
      "mergedThroughOffset",
      "resultTreeDigest",
      "sourceHeadOffset",
      "sourceStreamId",
      "sourceTreeDigest",
      "targetHeadOffset",
      "targetStreamId",
      "targetTreeDigest",
      "v",
    ]) &&
    payload.kind === "three-way" &&
    isSha256(payload.mergeId) &&
    isNonEmptyString(payload.targetStreamId) &&
    isNonEmptyString(payload.sourceStreamId) &&
    isBranchOffset(payload.forkOffset) &&
    isBranchOffset(payload.mergedThroughOffset) &&
    isBranchOffset(payload.sourceHeadOffset) &&
    isBranchOffset(payload.targetHeadOffset) &&
    isSha256(payload.baseTreeDigest) &&
    isSha256(payload.targetTreeDigest) &&
    isSha256(payload.sourceTreeDigest) &&
    isSha256(payload.resultTreeDigest) &&
    Array.isArray(payload.changes) &&
    payload.changes.every(isFsMergeChange) &&
    Array.isArray(payload.conflicts) &&
    payload.conflicts.every(isFsMergeConflictPayload)
  );
}

export function isFsMergeResolvePayload(value: unknown): value is FsMergeResolvePayload {
  const payload = record(value);
  return (
    payload !== undefined &&
    hasExactKeys(payload, ["mergeId", "path", "resolutionDigest", "v"]) &&
    payload.v === 1 &&
    isSha256(payload.mergeId) &&
    isValidFsPath(payload.path) &&
    isSha256(payload.resolutionDigest)
  );
}

export function isFsFileContentEvent(value: unknown): value is FsFileContentEvent {
  return (
    isEvent(value) && value.type === "fs.file.content" && isFsFileContentPayload(value.payload)
  );
}

export function isFsBranchForkEvent(value: unknown): value is FsBranchForkEvent {
  return isEvent(value) && value.type === "fs.branch.fork" && isFsBranchForkPayload(value.payload);
}

export function isFsBranchMergeEvent(value: unknown): value is FsBranchMergeEvent {
  return (
    isEvent(value) && value.type === "fs.branch.merge" && isFsBranchMergePayload(value.payload)
  );
}

export function isFsFastForwardMergeEvent(
  value: unknown,
): value is FsBranchMergeEvent & { readonly payload: FsBranchFastForwardMergePayload } {
  return isFsBranchMergeEvent(value) && value.payload.v === 1;
}

export function isFsThreeWayMergeEvent(
  value: unknown,
): value is FsBranchMergeEvent & { readonly payload: FsBranchThreeWayMergePayload } {
  return isFsBranchMergeEvent(value) && value.payload.v === 2;
}

export function isFsMergeChangeEvent(value: unknown): value is FsMergeChangeEvent {
  return (
    isEvent(value) && value.type === "fs/merge-change" && isFsMergeChangePayload(value.payload)
  );
}

export function isFsMergeConflictEvent(value: unknown): value is FsMergeConflictEvent {
  return (
    isEvent(value) && value.type === "fs/merge-conflict" && isFsMergeConflictPayload(value.payload)
  );
}

export function isFsMergeResolveEvent(value: unknown): value is FsMergeResolveEvent {
  return (
    isEvent(value) && value.type === "fs/merge-resolve" && isFsMergeResolvePayload(value.payload)
  );
}

export function isFsEvent(value: unknown): value is FsEvent {
  if (!isEvent(value)) return false;
  switch (value.type) {
    case "fs.file.create":
      return isFsFileCreatePayload(value.payload);
    case "fs.file.write":
      return isFsFileWritePayload(value.payload);
    case "fs.file.delete":
      return isFsFileDeletePayload(value.payload);
    case "fs.dir.create":
      return isFsDirCreatePayload(value.payload);
    case "fs.dir.remove":
      return isFsDirRemovePayload(value.payload);
    case "fs.rename":
      return isFsRenamePayload(value.payload);
    case "fs.file.patch":
      return isFsFilePatchPayload(value.payload);
    case "fs.file.content":
      return isFsFileContentPayload(value.payload);
    case "fs.branch.genesis":
      return isFsBranchGenesisPayload(value.payload);
    case "fs.branch.fork":
      return isFsBranchForkPayload(value.payload);
    case "fs.branch.merge":
      return isFsBranchMergePayload(value.payload);
    case "fs/merge-change":
      return isFsMergeChangePayload(value.payload);
    case "fs/merge-conflict":
      return isFsMergeConflictPayload(value.payload);
    case "fs/merge-resolve":
      return isFsMergeResolvePayload(value.payload);
    case "fs.snapshot":
      return isSnapshotEvent(value);
    default:
      return false;
  }
}

export function assertFsEvent(value: unknown): asserts value is FsEvent {
  if (!isFsEvent(value)) throw new FsEventValidationError("invalid fs event envelope or payload");
}
