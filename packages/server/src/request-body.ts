import type { IncomingMessage } from "node:http";
import { InvalidRequestError } from "./request-errors.js";

export const MAX_BODY_BYTES = 4 * 1024 * 1024;

function contentType(request: IncomingMessage): string {
  const value = request.headers["content-type"];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const declaredLength = request.headers["content-length"];
    if (declaredLength && Number(declaredLength) > MAX_BODY_BYTES) {
      request.resume();
      reject(new InvalidRequestError("request body is too large"));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        request.resume();
        reject(new InvalidRequestError("request body is too large"));
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function skipWhitespace(raw: string, index: number): number {
  while (index < raw.length && /\s/.test(raw[index] ?? "")) index += 1;
  return index;
}

function readString(raw: string, start: number): number {
  let index = start + 1;
  while (index < raw.length) {
    const character = raw[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === '"') return index + 1;
    index += 1;
  }
  throw new SyntaxError("unterminated JSON string");
}

// JSON.parse intentionally accepts duplicate object keys and keeps only the last
// value. Dispatch envelopes are a frozen canonical shape, so duplicate keys are
// rejected before the last-write-wins interpretation can reach validation.
function assertNoDuplicateKeys(raw: string): void {
  const scanValue = (start: number): number => {
    const index = skipWhitespace(raw, start);
    const character = raw[index];
    if (character === '"') return readString(raw, index);
    if (character === "{") return scanObject(index);
    if (character === "[") return scanArray(index);
    let end = index;
    while (
      end < raw.length &&
      raw[end] !== "," &&
      raw[end] !== "]" &&
      raw[end] !== "}" &&
      !/\s/.test(raw[end] ?? "")
    )
      end += 1;
    return end;
  };

  const scanObject = (start: number): number => {
    let index = skipWhitespace(raw, start + 1);
    const keys = new Set<string>();
    if (raw[index] === "}") return index + 1;
    while (index < raw.length) {
      index = skipWhitespace(raw, index);
      if (raw[index] !== '"') throw new SyntaxError("JSON object key must be a string");
      const keyStart = index;
      index = readString(raw, index);
      const key = JSON.parse(raw.slice(keyStart, index)) as unknown;
      if (typeof key !== "string") throw new SyntaxError("JSON object key is not a string");
      if (keys.has(key)) throw new SyntaxError(`duplicate JSON object key ${key}`);
      keys.add(key);
      index = skipWhitespace(raw, index);
      if (raw[index] !== ":") throw new SyntaxError("JSON object key has no value");
      index = scanValue(index + 1);
      index = skipWhitespace(raw, index);
      if (raw[index] === "}") return index + 1;
      if (raw[index] !== ",") throw new SyntaxError("JSON object is missing a comma");
      index += 1;
    }
    throw new SyntaxError("unterminated JSON object");
  };

  const scanArray = (start: number): number => {
    let index = skipWhitespace(raw, start + 1);
    if (raw[index] === "]") return index + 1;
    while (index < raw.length) {
      index = scanValue(index);
      index = skipWhitespace(raw, index);
      if (raw[index] === "]") return index + 1;
      if (raw[index] !== ",") throw new SyntaxError("JSON array is missing a comma");
      index += 1;
    }
    throw new SyntaxError("unterminated JSON array");
  };

  const end = scanValue(0);
  if (skipWhitespace(raw, end) !== raw.length) throw new SyntaxError("trailing JSON input");
}

export async function parseJsonBody(
  request: IncomingMessage,
  allowEmpty: boolean,
): Promise<unknown> {
  const type = contentType(request).split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (type !== "" && type !== "application/json" && !type.endsWith("+json")) {
    throw new InvalidRequestError("content type must be application/json");
  }
  const raw = await readBody(request);
  if (raw.length === 0 && allowEmpty) return {};
  if (raw.length === 0) throw new InvalidRequestError("request body is empty");
  try {
    const parsed = JSON.parse(raw) as unknown;
    assertNoDuplicateKeys(raw);
    return parsed;
  } catch (error) {
    if (error instanceof InvalidRequestError) throw error;
    throw new InvalidRequestError(
      error instanceof SyntaxError && error.message.startsWith("duplicate JSON object key")
        ? error.message
        : "request body is not valid JSON",
    );
  }
}
