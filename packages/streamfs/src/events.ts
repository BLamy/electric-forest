import { isEvent, type Event } from "@eforest/protocol";
import { FS_EVENT_VERSION } from "./version.js";

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

export type FsEvent = FsFileCreateEvent | FsFileWriteEvent | FsFileDeleteEvent;

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

export function isFsEvent(value: unknown): value is FsEvent {
  if (!isEvent(value)) return false;
  switch (value.type) {
    case "fs.file.create":
      return isFsFileCreatePayload(value.payload);
    case "fs.file.write":
      return isFsFileWritePayload(value.payload);
    case "fs.file.delete":
      return isFsFileDeletePayload(value.payload);
    default:
      return false;
  }
}

export function assertFsEvent(value: unknown): asserts value is FsEvent {
  if (!isFsEvent(value)) throw new FsEventValidationError("invalid fs event envelope or payload");
}
