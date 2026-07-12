import { canonicalJson } from "@eforest/protocol";

// HTTP framing and connection metadata vary by client/runtime. Every other header is
// retained so a later protocol-visible header cannot be normalized away silently.
const VOLATILE_RESPONSE_HEADERS = new Set([
  "connection",
  "date",
  "keep-alive",
  "transfer-encoding",
]);
const VOLATILE_REQUEST_HEADERS = new Set(["connection", "host", "content-length"]);

export interface NormalizedExchange {
  readonly name: string;
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  };
  readonly response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  };
}

function normalizedHeaders(
  headers: HeadersInit | Headers,
  volatile: ReadonlySet<string>,
): Record<string, string> {
  const source = new Headers(headers);
  const result: Record<string, string> = {};
  for (const [name, value] of source) {
    if (!volatile.has(name)) result[name] = value;
  }
  return result;
}

export function normalizeExchange(input: {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly requestHeaders?: HeadersInit;
  readonly requestBody?: string;
  readonly status: number;
  readonly responseHeaders: HeadersInit;
  readonly responseBody: string;
}): NormalizedExchange {
  return {
    name: input.name,
    request: {
      method: input.method,
      path: input.path,
      headers: normalizedHeaders(input.requestHeaders ?? {}, VOLATILE_REQUEST_HEADERS),
      body: input.requestBody ?? "",
    },
    response: {
      status: input.status,
      headers: normalizedHeaders(input.responseHeaders, VOLATILE_RESPONSE_HEADERS),
      body: input.responseBody,
    },
  };
}

export function serializeTranscript(exchanges: readonly NormalizedExchange[]): string {
  return exchanges.map((exchange) => `${canonicalJson(exchange)}\n`).join("");
}

export function firstDiffByte(left: string, right: string): number {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  const limit = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < limit; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return index;
  }
  return leftBytes.length === rightBytes.length ? -1 : limit;
}
