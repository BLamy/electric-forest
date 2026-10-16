import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import type { Socket } from "node:net";

export type PlatformRequestHandler = (request: Request) => Promise<Response>;

export interface PlatformServerOptions {
  /** Pinned public origin; Host and every forwarding header are untrusted input. */
  readonly origin?: string;
  readonly maxBodyBytes?: number;
  /** From socket request admission through finite response headers/body preparation. */
  readonly requestDeadlineMs?: number;
  readonly redactErrors?: boolean;
}

class HttpRefusal extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(reason);
  }
}

async function bytes(request: IncomingMessage, maximum?: number): Promise<Buffer> {
  const declared = request.headers["content-length"];
  if (maximum !== undefined && declared !== undefined && Number(declared) > maximum) {
    throw new HttpRefusal(413, "body-too-large");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      request.off("data", data);
      request.off("end", end);
      request.off("error", error);
      request.off("aborted", aborted);
    };
    const error = (cause: unknown): void => {
      cleanup();
      reject(cause);
    };
    const aborted = (): void => error(new HttpRefusal(408, "request-aborted"));
    const end = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const data = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (maximum !== undefined && size > maximum) {
        request.pause();
        error(new HttpRefusal(413, "body-too-large"));
        return;
      }
      chunks.push(buffer);
    };
    request.on("data", data);
    request.once("end", end);
    request.once("error", error);
    request.once("aborted", aborted);
  });
}

function targetUrl(request: IncomingMessage, origin?: string): string {
  const target = request.url ?? "/";
  if (origin === undefined) return `http://${request.headers.host ?? "127.0.0.1"}${target}`;
  if (
    !target.startsWith("/") ||
    target.startsWith("//") ||
    /[\\\s#]/.test(target) ||
    [...target].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw new HttpRefusal(400, "invalid-target");
  }
  const url = new URL(`${origin}${target}`);
  if (url.origin !== origin || url.pathname.startsWith("//"))
    throw new HttpRefusal(400, "invalid-target");
  return url.href;
}

function writeHeaders(response: ServerResponse, result: Response): void {
  response.statusCode = result.status;
  result.headers.forEach((value, name) => {
    if (name !== "set-cookie") response.setHeader(name, value);
  });
  const cookies = result.headers.getSetCookie();
  if (cookies.length > 0) response.setHeader("set-cookie", cookies);
}

async function handleNodeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  handler: PlatformRequestHandler,
  options: PlatformServerOptions,
  signal: AbortSignal,
  headersReady: () => void,
): Promise<void> {
  const url = targetUrl(request, options.origin);
  const body = await bytes(request, options.maxBodyBytes);
  if (signal.aborted) return;
  const web = new Request(url, {
    method: request.method ?? "GET",
    headers: Object.entries(request.headers).flatMap<[string, string]>(([name, value]) =>
      value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]],
    ),
    signal,
    ...((request.method === "GET" || request.method === "HEAD") && body.length === 0
      ? {}
      : { body: new Uint8Array(body) }),
  });
  const result = await handler(web);
  if (signal.aborted || response.destroyed) {
    await result.body?.cancel().catch(() => undefined);
    return;
  }
  // Established SSE is deliberately exempt from the response-header deadline. Its
  // reader is cancelled on socket close and the hosted owner drains it on shutdown.
  if (
    result.body !== null &&
    result.headers.get("content-type")?.startsWith("text/event-stream") === true
  ) {
    writeHeaders(response, result);
    const reader = result.body.getReader();
    response.on("close", () => {
      void reader.cancel().catch(() => undefined);
    });
    headersReady();
    response.flushHeaders();
    for (;;) {
      const { done, value } = await reader.read();
      if (done || response.destroyed) break;
      response.write(value);
    }
    response.end();
    return;
  }
  const bodyBytes = Buffer.from(await result.arrayBuffer());
  if (signal.aborted || response.destroyed) return;
  writeHeaders(response, result);
  const contentType = result.headers.get("content-type") ?? "";
  const acceptedEncoding = request.headers["accept-encoding"] ?? "";
  const acceptsGzip = (
    Array.isArray(acceptedEncoding) ? acceptedEncoding.join(",") : acceptedEncoding
  )
    .split(",")
    .some((encoding) => encoding.trim().toLowerCase().startsWith("gzip"));
  const compressible = /^(text\/|application\/(javascript|json|xml|wasm))/.test(contentType);
  headersReady();
  if (
    bodyBytes.length > 1024 &&
    acceptsGzip &&
    compressible &&
    result.headers.get("content-encoding") === null
  ) {
    const compressed = gzipSync(bodyBytes);
    response.setHeader("content-encoding", "gzip");
    response.setHeader("vary", "Accept-Encoding");
    response.setHeader("content-length", compressed.length);
    response.end(compressed);
    return;
  }
  response.end(bodyBytes);
}

export function createPlatformServer(
  handler: PlatformRequestHandler,
  options: PlatformServerOptions = {},
): Server {
  for (const value of [options.maxBodyBytes, options.requestDeadlineMs]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
      throw new TypeError("HTTP limits must be positive safe integers");
  }
  const guards = new WeakMap<
    Socket,
    { timer?: ReturnType<typeof setTimeout>; pending: number; expire?: () => void }
  >();
  const arm = (socket: Socket): void => {
    if (options.requestDeadlineMs === undefined || socket.destroyed) return;
    const guard = guards.get(socket)!;
    clearTimeout(guard.timer);
    guard.timer = setTimeout(() => {
      if (guard.expire !== undefined) guard.expire();
      else socket.destroy();
    }, options.requestDeadlineMs);
    guard.timer.unref();
  };
  const server = createServer((request, response) => {
    const controller = new AbortController();
    const guard = guards.get(request.socket);
    if (guard !== undefined) {
      guard.pending += 1;
      if (guard.timer === undefined) arm(request.socket);
    }
    let bodyComplete = false;
    request.once("end", () => {
      bodyComplete = true;
    });
    const refuse = (status: number, reason: string): void => {
      if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
      }
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.setHeader("connection", "close");
      response.end(JSON.stringify({ error: { class: "http-refused", reason } }), () =>
        request.destroy(),
      );
    };
    let settled = false;
    const expire = (): void => {
      headersReady();
      controller.abort();
      refuse(bodyComplete ? 504 : 408, "request-deadline");
    };
    if (guard !== undefined) guard.expire = expire;
    const timer =
      options.requestDeadlineMs === undefined
        ? undefined
        : setTimeout(expire, options.requestDeadlineMs);
    const headersReady = (): void => {
      clearTimeout(timer);
      if (!settled && guard !== undefined) {
        guard.pending -= 1;
        if (guard.pending === 0) {
          clearTimeout(guard.timer);
          delete guard.timer;
          delete guard.expire;
        }
      }
      settled = true;
    };
    response.once("finish", () => {
      if (guard?.pending === 0) arm(request.socket);
    });
    response.once("close", () => {
      headersReady();
      controller.abort();
    });
    void handleNodeRequest(
      request,
      response,
      handler,
      options,
      controller.signal,
      headersReady,
    ).catch((error: unknown) => {
      headersReady();
      controller.abort();
      if (error instanceof HttpRefusal) {
        refuse(error.status, error.reason);
        return;
      }
      if (options.redactErrors !== true)
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      else process.stderr.write("platform request failed\n");
      if (options.origin === undefined && !response.headersSent && !response.destroyed) {
        response.statusCode = 500;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: { class: "internal", reason: "request_failed" } }));
      } else refuse(500, "request-failed");
    });
  });
  if (options.requestDeadlineMs !== undefined) {
    server.on("connection", (socket) => {
      guards.set(socket, { pending: 0 });
      arm(socket);
      socket.once("close", () => clearTimeout(guards.get(socket)?.timer));
    });
  }
  return server;
}

export async function listenPlatformServer(
  server: Server,
  port = 0,
  host = "127.0.0.1",
): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("platform did not bind TCP");
  return `http://${host}:${String(address.port)}`;
}
