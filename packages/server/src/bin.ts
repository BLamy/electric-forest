import { createHttpServer } from "./http.js";

function readPort(args: readonly string[]): number {
  const index = args.indexOf("--port");
  const raw = index >= 0 ? args[index + 1] : (process.env.PORT ?? "4321");
  if (!raw || !/^\d+$/.test(raw)) throw new Error("--port must be a non-negative integer");
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port > 65_535) throw new Error("--port is out of range");
  return port;
}

const server = createHttpServer();
const port = readPort(process.argv.slice(2));
server.once("error", (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("server did not expose a TCP address");
  process.stdout.write(`LISTENING http://127.0.0.1:${address.port}\n`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
