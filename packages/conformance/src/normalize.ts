import { canonicalJson } from "@eforest/protocol";

const RESPONSE_HEADERS = [
  "allow",
  "cache-control",
  "content-type",
  "stream-next-offset",
  "stream-seq",
  "x-accel-buffering",
] as const;
const REQUEST_HEADERS = ["content-type", "stream-seq"] as const;

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

function selectedHeaders(
  headers: HeadersInit | Headers,
  names: readonly string[],
): Record<string, string> {
  const source = new Headers(headers);
  const result: Record<string, string> = {};
  for (const name of names) {
    const found = source.get(name);
    if (found !== null) result[name] = found;
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
      headers: selectedHeaders(input.requestHeaders ?? {}, REQUEST_HEADERS),
      body: input.requestBody ?? "",
    },
    response: {
      status: input.status,
      headers: selectedHeaders(input.responseHeaders, RESPONSE_HEADERS),
      body: input.responseBody,
    },
  };
}

export function serializeTranscript(exchanges: readonly NormalizedExchange[]): string {
  return exchanges.map((exchange) => `${canonicalJson(exchange)}\n`).join("");
}

export function firstDiffByte(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left.charCodeAt(index) !== right.charCodeAt(index)) return index;
  }
  return left.length === right.length ? -1 : limit;
}
