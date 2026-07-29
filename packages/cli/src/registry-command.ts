import {
  OfficialStreamAdapter,
  rebuildRegistry,
  RegistryPresentError,
  RegistryProjectionError,
} from "@eforest/platform";
import { createDurableStreamTestServer } from "@eforest/server";
import type { CliIo } from "./cli.js";

export const REGISTRY_USAGE = "Usage: ef registry rebuild --data-dir <dir> [--force]";

/**
 * E2-T08: `ef registry rebuild` — rebuild the `__registry__` derived stream
 * from the source `ns:*` logs alone, inside the given stream-store data
 * directory, and print the rebuilt index's state digest.
 *
 * The store is opened through the reference Durable Streams server (the
 * store's own surface — no side-channel file writes), the rebuild refuses to
 * run while a `__registry__` stream survives unless `--force` discards it,
 * and the frozen total order (`ns:root` first, then each `ns:org:<org>` in
 * lexicographic org order, each stream in offset order) makes two independent
 * rebuilds byte-identical.
 */
export async function runRegistryCommand(args: readonly string[], io: CliIo): Promise<number> {
  if (args[0] !== "rebuild") {
    io.stderr(`${REGISTRY_USAGE}\n`);
    return 2;
  }
  let dataDir: string | undefined;
  let force = false;
  const rest = args.slice(1);
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]!;
    if (argument === "--data-dir") {
      index += 1;
      dataDir = rest[index];
      if (dataDir === undefined || dataDir.startsWith("--")) {
        io.stderr(`${REGISTRY_USAGE}\n`);
        return 2;
      }
    } else if (argument === "--force") {
      force = true;
    } else {
      io.stderr(`${REGISTRY_USAGE}\n`);
      return 2;
    }
  }
  if (dataDir === undefined) {
    io.stderr(`${REGISTRY_USAGE}\n`);
    return 2;
  }
  let server: ReturnType<typeof createDurableStreamTestServer> | undefined;
  try {
    // Opening the store lives INSIDE the failure arm: an unusable --data-dir
    // (not a directory, unreadable, corrupt) is a loud typed failure line and
    // exit 1, never an unhandled crash.
    server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0, dataDir });
    const baseUrl = await server.start();
    const streams = new OfficialStreamAdapter({ baseUrl });
    const result = await rebuildRegistry(streams, { force });
    io.stderr(
      `registry rebuild: events=${String(result.events)} headOffset=${result.headOffset} pid=${String(process.pid)}\n`,
    );
    io.stdout(`${result.digest}\n`);
    return 0;
  } catch (error) {
    if (error instanceof RegistryPresentError || error instanceof RegistryProjectionError) {
      io.stderr(`${error.message}\n`);
      return 1;
    }
    io.stderr(
      `registry rebuild failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  } finally {
    await server?.stop();
  }
}
