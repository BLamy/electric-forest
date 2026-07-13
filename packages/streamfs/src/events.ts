import { isEvent, type Event } from "@eforest/protocol";
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
  readonly baseDigest: string;
  readonly ops: PatchOps;
  readonly resultDigest: string;
}

export interface FsFileContentPayload {
  readonly v: typeof FS_EVENT_VERSION;
  readonly contentStreamId: string;
  readonly contentBase64: string;
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

export type FsEvent =
  | FsFileCreateEvent
  | FsFileWriteEvent
  | FsFileDeleteEvent
  | FsDirCreateEvent
  | FsDirRemoveEvent
  | FsRenameEvent
  | FsFilePatchEvent
  | FsFileContentEvent;

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
    hasExactKeys(payload, ["contentSha256", "path", "size", "v"]) &&
    isVersion(payload.v) &&
    isValidFsPath(payload.path) &&
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
    hasExactKeys(payload, ["baseDigest", "ops", "path", "resultDigest", "v"]) &&
    isVersion(payload.v) &&
    isValidFsPath(payload.path) &&
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

export function isFsFileContentEvent(value: unknown): value is FsFileContentEvent {
  return (
    isEvent(value) && value.type === "fs.file.content" && isFsFileContentPayload(value.payload)
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
    default:
      return false;
  }
}

export function assertFsEvent(value: unknown): asserts value is FsEvent {
  if (!isFsEvent(value)) throw new FsEventValidationError("invalid fs event envelope or payload");
}
