import { createHash } from "node:crypto";

export type PatchOp = readonly ["=", number] | readonly ["+", string] | readonly ["-", number];
export type PatchOps = readonly PatchOp[];

export type PatchErrorCode =
  | "patch/malformed-ops"
  | "patch/base-mismatch"
  | "patch/result-mismatch"
  | "patch/target-not-a-text-file";

export class PatchError extends Error {
  readonly code: PatchErrorCode;

  constructor(code: PatchErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "PatchError";
    this.code = code;
  }
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

function isPositiveLength(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isPatchOps(value: unknown): value is PatchOps {
  if (!Array.isArray(value)) return false;
  let previous: string | undefined;
  for (const candidate of value) {
    if (!Array.isArray(candidate) || candidate.length !== 2 || typeof candidate[0] !== "string") {
      return false;
    }
    const kind = candidate[0];
    if (kind === "+") {
      if (
        typeof candidate[1] !== "string" ||
        candidate[1].length === 0 ||
        !isUnicodeScalarString(candidate[1])
      ) {
        return false;
      }
    } else if ((kind === "=" || kind === "-") && !isPositiveLength(candidate[1])) {
      return false;
    } else if (kind !== "=" && kind !== "-") {
      return false;
    }
    if (kind === previous) return false;
    previous = kind;
  }
  return true;
}

export function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function patchResultSize(baseSize: number, ops: PatchOps): number {
  if (!isPatchOps(ops))
    throw new PatchError("patch/malformed-ops", "ops do not match the canonical grammar");
  let consumed = 0;
  let result = 0;
  for (const [kind, value] of ops) {
    if (kind === "+") result += new TextEncoder().encode(value).byteLength;
    else {
      consumed += value;
      if (consumed > baseSize)
        throw new PatchError("patch/malformed-ops", "ops over-consume the base");
      if (kind === "=") result += value;
    }
  }
  if (consumed !== baseSize)
    throw new PatchError("patch/malformed-ops", "ops do not exhaust the base");
  return result;
}

export function applyPatch(baseBytes: Uint8Array, ops: PatchOps): Uint8Array {
  if (!isPatchOps(ops))
    throw new PatchError("patch/malformed-ops", "ops do not match the canonical grammar");
  const chunks: Uint8Array[] = [];
  let cursor = 0;
  for (const [kind, value] of ops) {
    if (kind === "+") {
      chunks.push(new TextEncoder().encode(value));
      continue;
    }
    if (cursor + value > baseBytes.byteLength) {
      throw new PatchError("patch/malformed-ops", "ops over-consume the base");
    }
    if (kind === "=") chunks.push(baseBytes.slice(cursor, cursor + value));
    cursor += value;
  }
  if (cursor !== baseBytes.byteLength) {
    throw new PatchError("patch/malformed-ops", "ops do not exhaust the base");
  }
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!validText(result))
    throw new PatchError("patch/target-not-a-text-file", "result is not valid text");
  return result;
}
