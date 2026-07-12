import { createHttpServer, FileStreamStore, MemoryStreamStore } from "@eforest/server";

function value(args: readonly string[], name: string): string | undefined {
  const inline = `--${name}=`;
  const withEquals = args.find((arg) => arg.startsWith(inline));
  if (withEquals !== undefined) return withEquals.slice(inline.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const args = process.argv.slice(2);
const kind = value(args, "store") ?? "memory";
const dataDir = value(args, "data-dir");
if (kind !== "memory" && kind !== "file") throw new Error("--store must be memory or file");
if (kind === "file" && dataDir === undefined) throw new Error("file store requires --data-dir");

const store = kind === "file" ? new FileStreamStore(dataDir!) : new MemoryStreamStore();
const server = createHttpServer(store, { longPollTimeoutMs: 50, sseHeartbeatMs: 20 });
server.once("error", (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
  process.stdout.write(`LISTENING http://127.0.0.1:${address.port}\n`);
});

const shutdown = () => server.close(() => process.exit(0));
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
