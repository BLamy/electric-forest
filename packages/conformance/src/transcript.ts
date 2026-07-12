import { connect } from "node:net";
import { normalizeExchange, type NormalizedExchange } from "./normalize.js";

export async function exchange(
  baseUrl: string,
  name: string,
  path: string,
  init: RequestInit = {},
): Promise<NormalizedExchange> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.text();
  const input = {
    name,
    method: init.method ?? "GET",
    path,
    requestBody: typeof init.body === "string" ? init.body : "",
    status: response.status,
    responseHeaders: response.headers,
    responseBody: body,
    ...(init.headers === undefined ? {} : { requestHeaders: init.headers }),
  } satisfies Parameters<typeof normalizeExchange>[0];
  return normalizeExchange(input);
}

export async function sseExchange(
  baseUrl: string,
  name: string,
  path: string,
  expectedFrames: number,
): Promise<NormalizedExchange> {
  const url = new URL(path, baseUrl);
  return new Promise((resolveExchange, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    let bytes = Buffer.alloc(0);
    let settled = false;
    const finish = (): void => {
      const separator = bytes.indexOf("\r\n\r\n");
      if (separator < 0) return;
      const headerText = bytes.subarray(0, separator).toString("utf8");
      const headerLines = headerText.split("\r\n");
      const status = Number(headerLines[0]?.split(" ", 3)[1]);
      const headers: Record<string, string> = {};
      for (const line of headerLines.slice(1)) {
        const colon = line.indexOf(":");
        if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      const body = decodeHttpBody(bytes.subarray(separator + 4), headers);
      if (body === undefined || countFrames(body) < expectedFrames) return;
      settled = true;
      socket.destroy();
      resolveExchange(
        normalizeExchange({
          name,
          method: "GET",
          path,
          responseHeaders: headers,
          status,
          responseBody: body,
        }),
      );
    };
    socket.on("connect", () => {
      socket.end(
        `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
      finish();
    });
    socket.on("error", (error) => {
      if (!settled) reject(error);
    });
    socket.on("close", () => {
      if (!settled) reject(new Error("SSE socket closed before the expected frames arrived"));
    });
  });
}

function decodeHttpBody(
  bytes: Uint8Array,
  headers: Readonly<Record<string, string>>,
): string | undefined {
  if (!headers["transfer-encoding"]?.toLowerCase().includes("chunked")) {
    return Buffer.from(bytes).toString("utf8");
  }
  const chunks: Buffer[] = [];
  let cursor = 0;
  for (;;) {
    const lineEnd = Buffer.from(bytes).indexOf("\r\n", cursor);
    if (lineEnd < 0) break;
    const size = Number.parseInt(
      Buffer.from(bytes).subarray(cursor, lineEnd).toString("ascii"),
      16,
    );
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid SSE chunk size");
    cursor = lineEnd + 2;
    if (size === 0) return Buffer.concat(chunks).toString("utf8");
    if (cursor + size + 2 > bytes.length) break;
    chunks.push(Buffer.from(bytes).subarray(cursor, cursor + size));
    cursor += size + 2;
  }
  return Buffer.concat(chunks).toString("utf8");
}

function countFrames(body: string): number {
  let count = 0;
  let index = body.indexOf("\n\n");
  while (index >= 0) {
    count += 1;
    index = body.indexOf("\n\n", index + 2);
  }
  return count;
}

export interface SseFrame {
  readonly id: string;
  readonly data: string;
}

export function parseSseFrames(body: string): readonly SseFrame[] {
  const frames: SseFrame[] = [];
  let start = 0;
  for (;;) {
    const end = body.indexOf("\n\n", start);
    if (end < 0) break;
    const block = body.slice(start, end);
    const idLine = block.match(/(?:^|\n)id: ([^\n]+)/)?.[1];
    const dataLine = block.match(/(?:^|\n)data: ([\s\S]*)/)?.[1];
    if (idLine !== undefined && dataLine !== undefined) frames.push({ id: idLine, data: dataLine });
    start = end + 2;
  }
  return frames;
}
