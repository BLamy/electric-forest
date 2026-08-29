import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type PlatformRequestHandler = (request: Request) => Promise<Response>;

async function bytes(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function handleNodeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  handler: PlatformRequestHandler,
): Promise<void> {
  const host = request.headers.host ?? "127.0.0.1";
  const body = await bytes(request);
  const web = new Request(`http://${host}${request.url ?? "/"}`, {
    method: request.method ?? "GET",
    headers: Object.entries(request.headers).flatMap<[string, string]>(([name, value]) =>
      value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]],
    ),
    ...((request.method === "GET" || request.method === "HEAD") && body.length === 0
      ? {}
      : { body: new Uint8Array(body) }),
  });
  const result = await handler(web);
  response.statusCode = result.status;
  result.headers.forEach((value, name) => response.setHeader(name, value));
  // E2-T08: SSE responses stream — buffering an endless event stream would
  // never terminate. Everything else keeps the buffered write.
  if (
    result.body !== null &&
    result.headers.get("content-type")?.startsWith("text/event-stream") === true
  ) {
    const reader = result.body.getReader();
    response.on("close", () => {
      void reader.cancel().catch(() => undefined);
    });
    response.flushHeaders();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      response.write(value);
    }
    response.end();
    return;
  }
  response.end(Buffer.from(await result.arrayBuffer()));
}

export function createPlatformServer(handler: PlatformRequestHandler): Server {
  return createServer((request, response) => {
    void handleNodeRequest(request, response, handler).catch((error: unknown) => {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: { class: "internal", reason: "request_failed" } }));
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    });
  });
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
