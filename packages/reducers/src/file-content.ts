import { sha256Hex, stateDigest, type Event } from "@eforest/protocol";
import { applyPatch, digestBytes, patchResultSize, type PatchOps } from "@eforest/streamfs";

export const FILE_CONTENT_REDUCER_VERSION = 1;
export const FILE_VIEW_MAX_BYTES = 256 * 1024;

export type FileContentStatus = "empty" | "text" | "binary" | "oversize" | "deleted";

export interface FileIdentityState {
  readonly contentStreamId: string;
  readonly contentSha256: string;
  readonly size: number;
}

export interface FileContentState {
  readonly routePath: string;
  readonly identity: string | null;
  readonly currentPath: string | null;
  readonly contentStreamId: string | null;
  readonly bytes: Uint8Array | null;
  readonly text: string | null;
  readonly contentDigest: string;
  readonly size: number;
  readonly status: FileContentStatus;
  readonly known: Readonly<Record<string, FileIdentityState>>;
}

export class FileContentReducerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "FileContentReducerError";
  }
}

export function fileViewStreamId(org: string, repo: string, branch: string, path: string): string {
  return `file-view:${encodeURIComponent(org)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/${encodeURIComponent(path)}`;
}

function initialDigest(): string {
  return digestBytes(new Uint8Array());
}

export const fileContentInitialState: FileContentState = Object.freeze({
  routePath: "",
  identity: null,
  currentPath: null,
  contentStreamId: null,
  bytes: null,
  text: null,
  contentDigest: initialDigest(),
  size: 0,
  status: "empty",
  known: Object.freeze({}),
});

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FileContentReducerError("file/malformed-event", "payload must be an object");
  }
  return value as Record<string, unknown>;
}

function stringField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new FileContentReducerError(
      "file/malformed-event",
      `${field} must be a non-empty string`,
    );
  }
  return value;
}

function numberField(payload: Record<string, unknown>, field: string): number {
  const value = payload[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new FileContentReducerError("file/malformed-event", `${field} must be a safe integer`);
  }
  return value;
}

function isUnicodeText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function base64Bytes(value: unknown): Uint8Array {
  if (typeof value !== "string") {
    throw new FileContentReducerError("file/content-missing", "full write has no content bytes");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new FileContentReducerError("file/noncanonical-base64", "content is not base64");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  let canonical = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    canonical += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  const encoded = btoa(canonical);
  if (encoded !== value) {
    throw new FileContentReducerError("file/noncanonical-base64", "content is not canonical");
  }
  return bytes;
}

function metadata(
  state: FileContentState,
  identity: string,
  path: string,
  contentStreamId: string,
): FileContentState {
  return {
    ...state,
    identity,
    currentPath: path,
    contentStreamId,
    bytes: null,
    text: null,
    contentDigest: initialDigest(),
    size: 0,
    status: "empty",
  };
}

function fullContent(
  state: FileContentState,
  payload: Record<string, unknown>,
  base: FileIdentityState,
): FileContentState {
  const bytes = base64Bytes(payload.contentBase64);
  const digest = sha256Hex(bytes);
  const expectedDigest = stringField(payload, "contentSha256");
  const expectedSize = numberField(payload, "size");
  if (digest !== expectedDigest || bytes.byteLength !== expectedSize) {
    throw new FileContentReducerError("file/content-integrity", "bytes do not match metadata");
  }
  const status: FileContentStatus =
    bytes.byteLength > FILE_VIEW_MAX_BYTES ? "oversize" : isUnicodeText(bytes) ? "text" : "binary";
  const text = status === "text" ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : null;
  return {
    ...state,
    contentStreamId: base.contentStreamId,
    bytes: status === "oversize" ? null : bytes,
    text,
    contentDigest: digest,
    size: bytes.byteLength,
    status,
  };
}

function moveKnown(
  known: Readonly<Record<string, FileIdentityState>>,
  from: string,
  to: string,
): Record<string, FileIdentityState> {
  const moved: Record<string, FileIdentityState> = {};
  const prefix = `${from}/`;
  for (const [path, value] of Object.entries(known)) {
    if (path === from) moved[to] = value;
    else if (path.startsWith(prefix)) moved[`${to}${path.slice(from.length)}`] = value;
    else moved[path] = value;
  }
  return moved;
}

function removeKnown(
  known: Readonly<Record<string, FileIdentityState>>,
  path: string,
): Record<string, FileIdentityState> {
  const next = { ...known };
  delete next[path];
  return next;
}

function patchState(
  state: FileContentState,
  payload: Record<string, unknown>,
  knownFile: FileIdentityState,
): FileContentState {
  const baseDigest = stringField(payload, "baseDigest");
  const resultDigest = stringField(payload, "resultDigest");
  const ops = payload.ops as PatchOps;
  if (knownFile.contentSha256 !== baseDigest) {
    throw new FileContentReducerError("file/patch-base-mismatch", "metadata base digest mismatch");
  }
  let resultSize: number;
  try {
    resultSize = patchResultSize(knownFile.size, ops);
  } catch (error) {
    throw new FileContentReducerError(
      "file/patch-malformed",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (state.identity !== knownFile.contentStreamId) return state;
  if (state.bytes === null || state.status !== "text") {
    throw new FileContentReducerError("file/patch-base-unavailable", "text bytes are unavailable");
  }
  let result: Uint8Array;
  try {
    result = applyPatch(state.bytes, ops);
  } catch (error) {
    throw new FileContentReducerError(
      "file/patch-malformed",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (digestBytes(result) !== resultDigest) {
    throw new FileContentReducerError("file/patch-result-mismatch", "result digest mismatch");
  }
  if (result.byteLength !== resultSize) {
    throw new FileContentReducerError("file/patch-result-mismatch", "result size mismatch");
  }
  return {
    ...state,
    bytes: result,
    text: new TextDecoder("utf-8", { fatal: true }).decode(result),
    contentDigest: resultDigest,
    size: result.byteLength,
    status: "text",
  };
}

export function fileContentReducer(state: FileContentState, event: Event): FileContentState {
  if (event.type === "file.view.target") {
    const payload = record(event.payload);
    const routePath = stringField(payload, "path");
    return { ...fileContentInitialState, routePath };
  }
  const payload = record(event.payload);
  const nextKnown = { ...state.known };

  if (event.type === "fs.file.create") {
    const path = stringField(payload, "path");
    const contentStreamId = stringField(payload, "contentStreamId");
    const existing = nextKnown[path];
    const identity = existing?.contentStreamId ?? contentStreamId;
    const file: FileIdentityState = {
      contentStreamId,
      contentSha256:
        typeof payload.contentSha256 === "string"
          ? payload.contentSha256
          : (existing?.contentSha256 ?? initialDigest()),
      size: typeof payload.size === "number" ? payload.size : (existing?.size ?? 0),
    };
    nextKnown[path] = file;
    let next: FileContentState = { ...state, known: nextKnown };
    if (
      (state.identity === null && path === state.routePath) ||
      (state.status === "deleted" && path === state.routePath)
    ) {
      next = metadata(next, contentStreamId, path, contentStreamId);
    } else if (state.identity === contentStreamId) {
      next = { ...next, currentPath: path, contentStreamId };
    }
    if (payload.contentBase64 !== undefined && next.identity === contentStreamId) {
      next = fullContent(next, payload, file);
    }
    // A create event that replaces an inherited stream keeps the logical path
    // but starts a new content identity. The reducer follows that handoff.
    if (identity !== contentStreamId && state.identity === identity && path === state.currentPath) {
      next = metadata(next, contentStreamId, path, contentStreamId);
      if (payload.contentBase64 !== undefined) next = fullContent(next, payload, file);
    }
    return next;
  }

  if (event.type === "fs.file.write") {
    const path = stringField(payload, "path");
    const knownFile = nextKnown[path];
    if (knownFile === undefined) {
      throw new FileContentReducerError("file/write-before-create", path);
    }
    const file: FileIdentityState = {
      contentStreamId: knownFile.contentStreamId,
      contentSha256: stringField(payload, "contentSha256"),
      size: numberField(payload, "size"),
    };
    nextKnown[path] = file;
    const next = { ...state, known: nextKnown };
    return state.identity === knownFile.contentStreamId ? fullContent(next, payload, file) : next;
  }

  if (event.type === "fs.file.patch") {
    const path = stringField(payload, "path");
    const knownFile = nextKnown[path];
    if (knownFile === undefined) {
      throw new FileContentReducerError("file/patch-before-create", path);
    }
    const resultDigest = stringField(payload, "resultDigest");
    let resultSize: number;
    try {
      resultSize = patchResultSize(knownFile.size, payload.ops as PatchOps);
    } catch (error) {
      throw new FileContentReducerError(
        "file/patch-malformed",
        error instanceof Error ? error.message : String(error),
      );
    }
    nextKnown[path] = {
      ...knownFile,
      contentSha256: resultDigest,
      size: resultSize,
    };
    const next = patchState({ ...state, known: nextKnown }, payload, knownFile);
    return next;
  }

  if (event.type === "fs.rename") {
    const from = stringField(payload, "from");
    const to = stringField(payload, "to");
    const source = nextKnown[from];
    const known = moveKnown(nextKnown, from, to);
    let next: FileContentState = { ...state, known };
    if (source !== undefined && state.identity === source.contentStreamId) {
      next = { ...next, currentPath: to };
    } else if (state.identity === null && to === state.routePath && source !== undefined) {
      next = metadata(next, source.contentStreamId, to, source.contentStreamId);
    }
    return next;
  }

  if (event.type === "fs.file.delete") {
    const path = stringField(payload, "path");
    const deleted = nextKnown[path];
    const next = { ...state, known: removeKnown(nextKnown, path) };
    if (deleted === undefined || state.identity !== deleted.contentStreamId) return next;
    return {
      ...next,
      currentPath: null,
      bytes: null,
      text: null,
      status: "deleted",
    };
  }

  return state;
}

export const fileContentReducerDefinition = Object.freeze({
  id: "file-content",
  version: FILE_CONTENT_REDUCER_VERSION,
  initialState: fileContentInitialState,
  reduce: (state: unknown, event: Event): unknown =>
    fileContentReducer(state as FileContentState, event),
  digest: (state: unknown): string => {
    if (state !== null && typeof state === "object" && "contentDigest" in state) {
      const digest = (state as { readonly contentDigest?: unknown }).contentDigest;
      if (typeof digest === "string") return digest;
    }
    return stateDigest(state);
  },
  matchesStream: (streamId: string): boolean => streamId.startsWith("file-view:"),
});
