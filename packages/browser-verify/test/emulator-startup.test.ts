import { createServer, type Server } from "node:net";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { browserVerifyStartupTestHooks } from "../src/index.js";

async function listen(port = 0): Promise<{ readonly port: number; readonly server: Server }> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "::", resolveListen);
  });
  server.on("connection", (socket) => socket.destroy());
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("TCP port unavailable");
  return { port: address.port, server };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) =>
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
  );
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

describe("browser verification emulator startup", () => {
  it("retries a deterministic initial bind collision and cleans every child", async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const firstAdvertised = await listen();
    const occupiedInternal = await listen();
    const retryAdvertised = await listen();
    const retryInternal = await listen();
    await close(firstAdvertised.server);
    await close(retryAdvertised.server);
    await close(retryInternal.server);
    const ports = [
      firstAdvertised.port,
      occupiedInternal.port,
      retryAdvertised.port,
      retryInternal.port,
    ];
    const attempts: Array<{
      readonly number: number;
      readonly pid: number;
      readonly port: number;
    }> = [];
    let startup: Awaited<
      ReturnType<typeof browserVerifyStartupTestHooks.startAuth0Emulator>
    > | null = null;

    try {
      startup = await browserVerifyStartupTestHooks.startAuth0Emulator({
        root,
        fixtureLogin: true,
        platformUrl: "http://127.0.0.1:3000",
        subject: {
          id: "startup-race",
          email: "startup-race@example.test",
          password: "StartupRace1234!",
        },
        clientId: "browser-verify-startup-race",
        nowSeconds: 1_700_000_000,
        allocatePort: async () => {
          const port = ports.shift();
          if (port === undefined) throw new Error("unexpected extra startup attempt");
          return port;
        },
        onAttempt: (attempt) => attempts.push(attempt),
      });

      expect(attempts.map(({ number, port }) => ({ number, port }))).toEqual([
        { number: 1, port: occupiedInternal.port },
        { number: 2, port: retryInternal.port },
      ]);
      expect(processExists(attempts[0]!.pid)).toBe(false);
      expect(processExists(attempts[1]!.pid)).toBe(true);
      const advertisedUrl = `http://127.0.0.1:${String(retryAdvertised.port)}`;
      expect(startup.emulator.url).toBe(advertisedUrl);
      expect(startup.fixtureProxy?.url).toBe(advertisedUrl);
      const discovery = await fetch(
        new URL("/.well-known/openid-configuration", startup.fixtureProxy!.url),
      );
      expect(discovery.status).toBe(200);
      expect(await discovery.json()).toMatchObject({ issuer: `${advertisedUrl}/` });
    } finally {
      await startup?.fixtureProxy?.close();
      await startup?.emulator.close();
      await close(occupiedInternal.server);
    }

    expect(processExists(attempts[1]!.pid)).toBe(false);
    for (const port of [retryAdvertised.port, retryInternal.port]) {
      const reusable = await listen(port);
      await close(reusable.server);
    }
  });
});
