import { createServer } from "node:http";
import { URL } from "node:url";

export async function createEmulator(options) {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", options.internalUrl).pathname;
    if (pathname !== "/.well-known/openid-configuration") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ issuer: `${options.baseUrl}/` }));
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(options.port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  return {
    async close() {
      server.closeIdleConnections();
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}
