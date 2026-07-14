import { DurableStreamTestServer, type TestServerOptions } from "@durable-streams/server";

/**
 * Electric's published reference server is the only local Durable Streams
 * transport shipped by electric-forest. Keep product behavior above this
 * boundary so local E2E runs exercise the same protocol as Electric Cloud.
 */
export function createDurableStreamTestServer(
  options: TestServerOptions = {},
): DurableStreamTestServer {
  return new DurableStreamTestServer(options);
}

export { DurableStreamTestServer, type TestServerOptions };
