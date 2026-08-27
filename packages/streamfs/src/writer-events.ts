import { BASE_NONE } from "./fencing.js";
import {
  assertFsEvent,
  type FsFileCreateEvent,
  type FsFileContentEvent,
  type FsFileDeleteEvent,
  type FsFilePatchEvent,
  type FsFileWriteEvent,
  type FsRenameEvent,
} from "./events.js";
import { chooseWriteEvent } from "./patch/choose.js";
import { diffText } from "./patch/diff.js";
import { digestBytes } from "./patch/ops.js";
import { FS_EVENT_VERSION } from "./version.js";

export type FsFileWriteChoiceEvent = FsFilePatchEvent | FsFileWriteEvent;

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function canonicalEvent<EventType extends Parameters<typeof assertFsEvent>[0]>(
  event: EventType,
): EventType {
  assertFsEvent(event);
  return event;
}

/** Canonical E1 file-create envelope shared by every StreamFS writer. */
export function fileCreateEvent(
  path: string,
  contentStreamId: string,
  ts: number = Date.now(),
): FsFileCreateEvent {
  return canonicalEvent({
    type: "fs.file.create",
    payload: { v: FS_EVENT_VERSION, path, contentStreamId },
    ts,
  }) as FsFileCreateEvent;
}

/** Canonical immutable content-generation event written to a file content stream. */
export function fileContentEvent(
  contentStreamId: string,
  bytes: Uint8Array,
  ts: number = Date.now(),
): FsFileContentEvent {
  return canonicalEvent({
    type: "fs.file.content",
    payload: {
      v: FS_EVENT_VERSION,
      contentStreamId,
      contentBase64: base64(bytes),
    },
    ts,
  }) as FsFileContentEvent;
}

/** Canonical E1 file-delete envelope shared by every StreamFS writer. */
export function fileDeleteEvent(path: string, ts: number = Date.now()): FsFileDeleteEvent {
  return canonicalEvent({
    type: "fs.file.delete",
    payload: { v: FS_EVENT_VERSION, path },
    ts,
  }) as FsFileDeleteEvent;
}

/** Canonical E1 rename envelope shared by every StreamFS writer. */
export function fileRenameEvent(from: string, to: string, ts: number = Date.now()): FsRenameEvent {
  return canonicalEvent({
    type: "fs.rename",
    payload: { v: FS_EVENT_VERSION, from, to },
    ts,
  }) as FsRenameEvent;
}

/**
 * Build an explicit canonical text-patch event. Writers that are choosing
 * between patch and full-write must use chooseFileWriteEvent instead.
 */
export function filePatchEvent(
  baseBytes: Uint8Array,
  targetBytes: Uint8Array,
  path: string,
  base: string = BASE_NONE,
  ts: number = Date.now(),
): FsFilePatchEvent {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return canonicalEvent({
    type: "fs.file.patch",
    payload: {
      v: FS_EVENT_VERSION,
      path,
      base,
      baseDigest: digestBytes(baseBytes),
      ops: diffText(decoder.decode(baseBytes), decoder.decode(targetBytes)),
      resultDigest: digestBytes(targetBytes),
    },
    ts,
  }) as FsFilePatchEvent;
}

/** Canonical forced full-write envelope for writers that already persisted the bytes. */
export function fileWriteEvent(
  targetBytes: Uint8Array,
  path: string,
  base: string = BASE_NONE,
  ts: number = Date.now(),
): FsFileWriteEvent {
  return canonicalEvent({
    type: "fs.file.write",
    payload: {
      v: FS_EVENT_VERSION,
      path,
      base,
      contentSha256: digestBytes(targetBytes),
      size: targetBytes.byteLength,
    },
    ts,
  }) as FsFileWriteEvent;
}

/** Timestamp the frozen E1-T03 chooser result without changing its type or payload. */
export function chooseFileWriteEvent(
  baseBytes: Uint8Array,
  targetBytes: Uint8Array,
  path: string,
  base: string = BASE_NONE,
  ts: number = Date.now(),
): FsFileWriteChoiceEvent {
  return canonicalEvent({ ...chooseWriteEvent(baseBytes, targetBytes, path, base), ts }) as
    FsFilePatchEvent | FsFileWriteEvent;
}
