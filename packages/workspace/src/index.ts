import { canonicalJson } from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const EF_WORKSPACE_VERSION = 1 as const;
export const WORKSPACE_DIR = ".ef" as const;
export const WORKSPACE_FILE = "workspace.json" as const;
export const WORKSPACE_PATH = `${WORKSPACE_DIR}/${WORKSPACE_FILE}` as const;
export const BASE_NONE = "BASE_NONE" as const;

export interface WorkspaceIdentity {
  readonly server: string;
  readonly project: string;
  readonly repo: string;
  readonly branch: string;
  readonly metadataStreamId: string;
}

export interface WorkspaceFileBase {
  readonly base: string;
  readonly contentSha256: string;
  readonly size: number;
}

export interface WorkspaceState {
  readonly v: typeof EF_WORKSPACE_VERSION;
  readonly identity: WorkspaceIdentity;
  readonly headOffset: string;
  readonly files: Readonly<Record<string, WorkspaceFileBase>>;
}

export type WorkspaceFormatErrorCode =
  | "missing"
  | "io"
  | "invalid-utf8"
  | "invalid-json"
  | "duplicate-key"
  | "unknown-version"
  | "invalid-schema"
  | "noncanonical"
  | "atomicity";

export class WorkspaceFormatError extends Error {
  readonly code: WorkspaceFormatErrorCode;
  readonly path: string | undefined;

  constructor(code: WorkspaceFormatErrorCode, message: string, path?: string) {
    super(message);
    this.name = "WorkspaceFormatError";
    this.code = code;
    this.path = path;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function isValidFsPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !isUnicodeScalarString(value) ||
    value.includes("\0") ||
    value.normalize("NFC") !== value ||
    value.startsWith("/") ||
    value.endsWith("/")
  ) {
    return false;
  }
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function failSchema(message: string, path?: string): never {
  throw new WorkspaceFormatError("invalid-schema", message, path);
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || !isUnicodeScalarString(value)) {
    failSchema(`workspace field must be a non-empty Unicode scalar string: ${path}`, path);
  }
}

function assertState(value: unknown): asserts value is WorkspaceState {
  if (!isRecord(value)) failSchema("workspace state must be an object");
  if (value.v !== EF_WORKSPACE_VERSION) {
    if (typeof value.v === "number" || typeof value.v === "string") {
      throw new WorkspaceFormatError(
        "unknown-version",
        `unsupported workspace version: ${String(value.v)}`,
        "v",
      );
    }
    failSchema("workspace version must be 1", "v");
  }
  if (!hasExactKeys(value, ["files", "headOffset", "identity", "v"])) {
    failSchema("workspace state has unknown or missing fields");
  }
  if (
    !isRecord(value.identity) ||
    !hasExactKeys(value.identity, ["branch", "metadataStreamId", "project", "repo", "server"])
  ) {
    failSchema("workspace identity has unknown or missing fields", "identity");
  }
  for (const key of ["server", "project", "repo", "branch", "metadataStreamId"] as const) {
    assertNonEmptyString(value.identity[key], `identity.${key}`);
  }
  if (typeof value.headOffset !== "string" || !isWellFormedOffset(value.headOffset)) {
    failSchema("workspace headOffset is not a stream offset", "headOffset");
  }
  if (!isRecord(value.files)) failSchema("workspace files must be an object", "files");
  for (const [path, ledger] of Object.entries(value.files)) {
    if (!isValidFsPath(path))
      failSchema(`workspace ledger path is invalid: ${path}`, `files.${path}`);
    if (!isRecord(ledger) || !hasExactKeys(ledger, ["base", "contentSha256", "size"])) {
      failSchema("workspace ledger entry has unknown or missing fields", `files.${path}`);
    }
    assertNonEmptyString(ledger.base, `files.${path}.base`);
    if (
      typeof ledger.contentSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(ledger.contentSha256) ||
      typeof ledger.size !== "number" ||
      !Number.isSafeInteger(ledger.size) ||
      ledger.size < 0
    ) {
      failSchema("workspace ledger content metadata is invalid", `files.${path}`);
    }
  }
}

function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/** Parse just enough JSON grammar to classify duplicate object keys before JSON.parse. */
function assertNoDuplicateKeys(source: string): void {
  let index = 0;
  const skip = (): void => {
    while (index < source.length && isWhitespace(source.charCodeAt(index))) index += 1;
  };
  const parseString = (): string => {
    const start = index;
    if (source[index] !== '"') throw new Error("expected string");
    index += 1;
    let escaped = false;
    while (index < source.length) {
      const char = source[index]!;
      if (escaped) {
        escaped = false;
        index += 1;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        index += 1;
        continue;
      }
      if (char === '"') {
        index += 1;
        return JSON.parse(source.slice(start, index)) as string;
      }
      if (char < " ") throw new Error("control character in string");
      index += 1;
    }
    throw new Error("unterminated string");
  };
  const parseValue = (): void => {
    skip();
    const char = source[index];
    if (char === "{") {
      index += 1;
      skip();
      const keys = new Set<string>();
      if (source[index] === "}") {
        index += 1;
        return;
      }
      while (index < source.length) {
        skip();
        const key = parseString();
        if (keys.has(key))
          throw new WorkspaceFormatError("duplicate-key", `duplicate JSON key: ${key}`, key);
        keys.add(key);
        skip();
        if (source[index] !== ":") throw new Error("expected colon");
        index += 1;
        parseValue();
        skip();
        if (source[index] === "}") {
          index += 1;
          return;
        }
        if (source[index] !== ",") throw new Error("expected comma");
        index += 1;
      }
      throw new Error("unterminated object");
    }
    if (char === "[") {
      index += 1;
      skip();
      if (source[index] === "]") {
        index += 1;
        return;
      }
      while (index < source.length) {
        parseValue();
        skip();
        if (source[index] === "]") {
          index += 1;
          return;
        }
        if (source[index] !== ",") throw new Error("expected comma");
        index += 1;
      }
      throw new Error("unterminated array");
    }
    if (char === '"') {
      parseString();
      return;
    }
    const start = index;
    while (
      index < source.length &&
      !isWhitespace(source.charCodeAt(index)) &&
      ![",", "]", "}"].includes(source[index]!)
    ) {
      index += 1;
    }
    if (start === index) throw new Error("expected value");
  };
  try {
    parseValue();
    skip();
    if (index !== source.length) throw new Error("trailing bytes");
  } catch (error) {
    if (error instanceof WorkspaceFormatError) throw error;
    throw new WorkspaceFormatError(
      "invalid-json",
      `workspace JSON is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function workspacePath(dir: string): string {
  return join(dir, WORKSPACE_DIR, WORKSPACE_FILE);
}

function decode(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new WorkspaceFormatError(
      "invalid-utf8",
      `workspace bytes are not valid UTF-8: ${String(error)}`,
      path,
    );
  }
}

export function load(dir: string): WorkspaceState {
  const path = workspacePath(dir);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new WorkspaceFormatError(
      code === "ENOENT" ? "missing" : "io",
      `cannot read ${path}: ${String(error)}`,
      path,
    );
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new WorkspaceFormatError(
      "noncanonical",
      "workspace JSON must not contain a UTF-8 BOM",
      path,
    );
  }
  const source = decode(bytes, path);
  if (
    source.startsWith("\ufeff") ||
    !source.endsWith("\n") ||
    source.endsWith("\r\n") ||
    source.slice(0, -1).includes("\r")
  ) {
    throw new WorkspaceFormatError(
      "noncanonical",
      "workspace JSON must end with exactly one LF and no CR",
      path,
    );
  }
  const json = source.slice(0, -1);
  assertNoDuplicateKeys(json);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (error) {
    throw new WorkspaceFormatError(
      "invalid-json",
      `workspace JSON is malformed: ${String(error)}`,
      path,
    );
  }
  assertState(parsed);
  if (`${canonicalJson(parsed)}\n` !== source) {
    throw new WorkspaceFormatError("noncanonical", "workspace JSON is not canonical", path);
  }
  return parsed;
}

function randomSuffix(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function save(dir: string, state: WorkspaceState): void {
  assertState(state);
  const workspaceDir = join(dir, WORKSPACE_DIR);
  mkdirSync(workspaceDir, { recursive: true });
  const path = workspacePath(dir);
  const temp = join(workspaceDir, `.${WORKSPACE_FILE}.${randomSuffix()}.tmp`);
  const bytes = Buffer.from(`${canonicalJson(state)}\n`, "utf8");
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (process.env.EFOREST_WORKSPACE_FAILPOINT === "after-fsync") {
      throw new WorkspaceFormatError("atomicity", "workspace save interrupted after fsync", temp);
    }
    renameSync(temp, path);
    const dirFd = openSync(workspaceDir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error instanceof WorkspaceFormatError) throw error;
    throw new WorkspaceFormatError("io", `cannot save ${path}: ${String(error)}`, path);
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file is intentionally retained after an injected crash so a
      // parent process can model a process dying between fsync and rename.
    }
  }
}

export function workspaceFilePath(dir: string): string {
  return workspacePath(dir);
}

export { OFFSET_BEFORE_FIRST } from "@eforest/protocol";
