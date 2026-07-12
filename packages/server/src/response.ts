import type { ServerResponse } from "node:http";

export function jsonResponse(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    ...headers,
  });
  response.end(body);
}

export function textResponse(
  response: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    ...headers,
  });
  response.end(body);
}

export function errorResponse(
  response: ServerResponse,
  status: number,
  error: string,
  message: string,
  headers: Record<string, string> = {},
): void {
  jsonResponse(response, status, { error, message }, headers);
}
