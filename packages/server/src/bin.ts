import { createHttpServer } from "./http.js";
import { FileStreamStore } from "./store/file.js";
import { MemoryStreamStore } from "./store/memory.js";

function readValue(args: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function readPort(args: readonly string[]): number {
  const raw = readValue(args, "port") ?? process.env.PORT ?? "4321";
  if (!raw || !/^\d+$/.test(raw)) throw new Error("--port must be a non-negative integer");
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port > 65_535) throw new Error("--port is out of range");
  return port;
}

const args = process.argv.slice(2);
const storeKind = readValue(args, "store") ?? process.env.EF_STORE ?? "memory";
if (storeKind !== "memory" && storeKind !== "file") {
  throw new Error("--store must be memory or file");
}
const dataDir = readValue(args, "data-dir") ?? process.env.EF_DATA_DIR ?? ".eforest-data";
const store = storeKind === "file" ? new FileStreamStore(dataDir) : new MemoryStreamStore();
const server = createHttpServer(store);
const port = readPort(args);
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
