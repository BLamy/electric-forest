import { access, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { browserVerifyStartupTestHooks } from "../src/index.js";

async function listen(port = 0): Promise<{ readonly port: number; readonly server: Server }> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
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

interface PortReservation {
  readonly port: number;
  release(): Promise<void>;
}

async function reservePort(): Promise<PortReservation> {
  const { port, server } = await listen();
  let release: Promise<void> | undefined;
  return {
    port,
    release: () => (release ??= close(server)),
  };
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
    const sourceRoot = resolve(import.meta.dirname, "../../..");
    const root = await mkdtemp(resolve(tmpdir(), "eforest-emulator-startup-"));
    const auth0FixtureRoot = resolve(root, "vendor/emulate/packages/@emulators/auth0/fixtures");
    await mkdir(auth0FixtureRoot, { recursive: true });
    for (const filename of ["test-keypair.private.jwk.json", "test-keypair.public.jwk.json"]) {
      await copyFile(
        resolve(sourceRoot, "vendor/emulate/packages/@emulators/auth0/fixtures", filename),
        resolve(auth0FixtureRoot, filename),
      );
    }
    await expect(
      access(resolve(root, "vendor/emulate/packages/emulate/dist/api.js")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const firstAdvertised = await reservePort();
    const occupiedInternal = await reservePort();
    const reservations = [firstAdvertised, occupiedInternal];
    const portsByAttempt = new Map<
      number,
      { advertised?: PortReservation; internal?: PortReservation }
    >();
    portsByAttempt.set(1, { advertised: firstAdvertised, internal: occupiedInternal });
    let allocation = 0;
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
        emulatorModuleUrl: pathToFileURL(
          resolve(import.meta.dirname, "fixtures/auth0-emulator.mjs"),
        ).href,
        allocatePort: async () => {
          allocation += 1;
          if (allocation === 1) return firstAdvertised.port;
          if (allocation === 2) return occupiedInternal.port;
          const attempt = Math.floor((allocation - 1) / 2) + 1;
          const role = allocation % 2 === 1 ? "advertised" : "internal";
          const reservation = await reservePort();
          reservations.push(reservation);
          portsByAttempt.set(attempt, {
            ...portsByAttempt.get(attempt),
            [role]: reservation,
          });
          return reservation.port;
        },
        onAttempt: (attempt) => {
          attempts.push(attempt);
          if (attempt.number === 1) return;
          const ports = portsByAttempt.get(attempt.number);
          // Keep successful-attempt ports reserved until its child exists. Calling
          // close here stops accepting synchronously, immediately before the child
          // receives its startup options, instead of exposing the old allocation-
          // to-bind window to every parallel test in the suite.
          if (ports?.internal?.port === attempt.port) {
            void ports.advertised?.release();
            void ports.internal.release();
          }
        },
      });

      expect(attempts).toHaveLength(2);
      expect(attempts.map(({ number }) => number)).toEqual([1, 2]);
      expect(attempts[0]!.port).toBe(occupiedInternal.port);
      for (const failed of attempts.slice(0, -1)) expect(processExists(failed.pid)).toBe(false);
      const successful = attempts.at(-1)!;
      expect(processExists(successful.pid)).toBe(true);
      const successfulPorts = portsByAttempt.get(successful.number)!;
      expect(successfulPorts.internal?.port).toBe(successful.port);
      expect(successfulPorts.internal?.port).not.toBe(successfulPorts.advertised?.port);
      const advertisedUrl = `http://127.0.0.1:${String(successfulPorts.advertised!.port)}`;
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
      await Promise.all(reservations.map(({ release }) => release()));
      await rm(root, { recursive: true, force: true });
    }

    expect(processExists(attempts.at(-1)!.pid)).toBe(false);
    for (const port of new Set(reservations.map(({ port }) => port))) {
      const reusable = await listen(port);
      await close(reusable.server);
    }
  });
});
