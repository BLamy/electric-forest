import { canonicalJson } from "@eforest/protocol";
import { FS_EVENT_VERSION } from "../version.js";
import { BASE_NONE } from "../fencing.js";
import { diffText } from "./diff.js";
import { applyPatch, digestBytes, type PatchOps } from "./ops.js";

export interface FsWriteAction {
  readonly type: "fs.file.write";
  readonly payload: {
    readonly v: typeof FS_EVENT_VERSION;
    readonly path: string;
    readonly base: string;
    readonly contentSha256: string;
    readonly size: number;
  };
}

export interface FsPatchAction {
  readonly type: "fs.file.patch";
  readonly payload: {
    readonly v: typeof FS_EVENT_VERSION;
    readonly path: string;
    readonly base: string;
    readonly baseDigest: string;
    readonly ops: PatchOps;
    readonly resultDigest: string;
  };
}

export type FsWriteChoice = FsWriteAction | FsPatchAction;

function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

export function chooseWriteEvent(
  baseBytes: Uint8Array,
  targetBytes: Uint8Array,
  path: string,
  base: string = BASE_NONE,
): FsWriteChoice {
  const fullPayload = {
    v: FS_EVENT_VERSION,
    path,
    base,
    contentSha256: digestBytes(targetBytes),
    size: targetBytes.byteLength,
  } as const;
  const fullWireBytes = byteLength(fullPayload) + targetBytes.byteLength;
  if (!isText(baseBytes) || !isText(targetBytes))
    return { type: "fs.file.write", payload: fullPayload };
  const ops = diffText(new TextDecoder().decode(baseBytes), new TextDecoder().decode(targetBytes));
  const patchPayload = {
    v: FS_EVENT_VERSION,
    path,
    base,
    baseDigest: digestBytes(baseBytes),
    ops,
    resultDigest: digestBytes(targetBytes),
  } as const;
  if (
    byteLength(patchPayload) < fullWireBytes &&
    equalBytes(applyPatch(baseBytes, ops), targetBytes)
  ) {
    return { type: "fs.file.patch", payload: patchPayload };
  }
  return { type: "fs.file.write", payload: fullPayload };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}
