import { createPlatformProductionRuntime } from "./production.js";
import { listenPlatformServer } from "./server.js";

function portFromEnvironment(value: string | undefined): number {
  const raw = value ?? "4322";
  if (!/^\d+$/.test(raw)) throw new Error("PORT must be a non-negative integer");
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port > 65_535) throw new Error("PORT is out of range");
  return port;
}

try {
  const runtime = await createPlatformProductionRuntime();
  const url = await listenPlatformServer(runtime.server, portFromEnvironment(process.env.PORT));
  process.stdout.write(`LISTENING ${url}\n`);

  const shutdown = (): void => {
    runtime.server.close((error) => {
      if (error !== undefined) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
