import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createDurableStreamTestServer } from "@eforest/server";
import {
  BearerVerifier,
  GrantAwareVerifier,
  IdentityStore,
  OidcClient,
  OidcTransactions,
  OfficialStreamAdapter,
  PlatformGateway,
  PlatformWebApp,
  createPlatformServer,
  listenPlatformServer,
} from "@eforest/platform";
import { chromium, type BrowserContext, type Page } from "playwright-core";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
const task = resolve(root, ".eforest/tasks/epic-2-the-gates/E2-T05-cli-device-token-flow");
const evidence = resolve(task, "evidence");
const transcriptPath = resolve(evidence, "e2-t05-browser.txt");
const tracePath = resolve(evidence, "e2-t05-playwright-trace.zip");
const manifestPath = resolve(evidence, "e2-t05-browser-artifacts.json");
const update = process.env.E2_T05_UPDATE_GOLDENS === "1";
const captureVideo = process.env.E2_T05_CAPTURE_VIDEO === "1";
const mp4Path = resolve(root, "recordings/e2-t05-final.mp4");
const activeTracePath = captureVideo ? tracePath : resolve(task, "work/e2-t05-latest-trace.zip");
const nowSeconds = 1_800_000_000;
const nowMs = nowSeconds * 1_000;
const emulatorPort = Number(process.env.E2_T05_BROWSER_EMULATOR_PORT ?? 46910);
const streamPort = Number(process.env.E2_T05_BROWSER_STREAM_PORT ?? 46911);
const platformPort = Number(process.env.E2_T05_BROWSER_PLATFORM_PORT ?? 46912);
const emulatorUrl = `http://127.0.0.1:${emulatorPort}`;
const streamUrl = `http://127.0.0.1:${streamPort}`;
const platformUrl = `http://127.0.0.1:${platformPort}`;
const clientId = "eforest-e2-t05-browser";
const user = { email: "browser@example.test", password: "Browser1234!", id: "browser-user" };

const privateJwk = JSON.parse(
  await readFile(
    resolve(
      root,
      "vendor/emulate/packages/@emulators/auth0/fixtures/test-keypair.private.jwk.json",
    ),
    "utf8",
  ),
);
const publicJwk = JSON.parse(
  await readFile(
    resolve(root, "vendor/emulate/packages/@emulators/auth0/fixtures/test-keypair.public.jwk.json"),
    "utf8",
  ),
);
const privatePem = createPrivateKey({ key: privateJwk, format: "jwk" })
  .export({ format: "pem", type: "pkcs8" })
  .toString();
const publicPem = createPublicKey({ key: publicJwk, format: "jwk" })
  .export({ format: "pem", type: "spki" })
  .toString();
const { createEmulator } = await import(
  resolve(root, "vendor/emulate/packages/emulate/dist/api.js")
);

function loopback(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
}

const network: string[] = [];
const guardedFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (!loopback(url)) throw new TypeError(`network guard refused ${url.hostname}`);
  network.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
  return fetch(input, init);
};

function deterministicRandom() {
  let counter = 0;
  return (size: number): Uint8Array => {
    counter += 1;
    return Uint8Array.from({ length: size }, (_, index) => (counter * 43 + index * 17) & 0xff);
  };
}

async function closeServer(server: ReturnType<typeof createPlatformServer>): Promise<void> {
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error === undefined ? resolveClose() : reject(error))),
  );
}

async function browserGuard(context: BrowserContext): Promise<void> {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!loopback(url)) return route.abort("blockedbyclient");
    network.push(`BROWSER ${route.request().method()} ${url.origin}${url.pathname}`);
    await route.continue();
  });
}

async function enter(page: Page, testId: string, value: string): Promise<void> {
  await page.getByTestId(testId).fill(value);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

const official = createDurableStreamTestServer({ host: "127.0.0.1", port: streamPort });
const emulator = await createEmulator({
  service: "auth0",
  port: emulatorPort,
  baseUrl: emulatorUrl,
  now: nowSeconds,
  seedMaterial: "e2-t05-browser",
  seed: {
    auth0: {
      now: nowSeconds,
      seed: "e2-t05-browser",
      connections: [{ name: "Username-Password-Authentication" }],
      users: [
        {
          email: user.email,
          password: user.password,
          user_id: user.id,
          email_verified: true,
          name: "Browser User",
        },
      ],
      oauth_clients: [
        {
          client_id: clientId,
          client_secret: "",
          redirect_uris: [`${platformUrl}/auth/callback`],
          grant_types: ["authorization_code"],
          audience: clientId,
        },
      ],
      signing_key: {
        private_key_pem: privatePem,
        public_key_pem: publicPem,
        kid: "e2-t05-browser-key",
      },
    },
  },
});
await official.start();
const identity = new IdentityStore({ baseUrl: streamUrl, fetch: guardedFetch, now: () => nowMs });
await identity.ensure();
const bearer = new BearerVerifier({
  issuer: emulatorUrl,
  audience: clientId,
  now: () => nowMs,
  fetch: guardedFetch,
});
const gateway = new PlatformGateway({
  verifier: new GrantAwareVerifier({ bearer, identity }),
  streams: new OfficialStreamAdapter({ baseUrl: streamUrl, fetch: guardedFetch }),
});
const random = deterministicRandom();
const app = new PlatformWebApp({
  oidc: new OidcClient({ issuer: emulatorUrl, clientId, fetch: guardedFetch, now: () => nowMs }),
  transactions: new OidcTransactions(random),
  identity,
  sessionSecret: "e2-t05-browser-session-secret-long-enough",
  sessionTtlMs: 60_000,
  now: () => nowMs,
  random,
  gateway,
  deviceVerifier: bearer,
});
const platform = createPlatformServer((request) => app.handle(request));
await listenPlatformServer(platform, platformPort);

const replayChromium = resolve(
  homedir(),
  ".replay/runtimes/Replay-Chromium.app/Contents/MacOS/Chromium",
);
const executablePath = process.env.AGENT_BROWSER_EXECUTABLE_PATH ?? replayChromium;
assert.ok(existsSync(executablePath), `browser executable missing: ${executablePath}`);
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext(
  captureVideo ? { recordVideo: { dir: resolve(task, "work/browser-video") } } : {},
);
await browserGuard(context);
await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
const page = await context.newPage();
const video = page.video();
const consoleFailures: string[] = [];
page.on("console", (message) => {
  if (message.type() === "error" || message.type() === "warning") {
    consoleFailures.push(`${message.type()}: ${message.text()}`);
  }
});
page.on("pageerror", (error) => consoleFailures.push(`pageerror: ${error.message}`));

let transcript = "";
try {
  await page.goto(platformUrl);
  await page.getByTestId("login").click();
  await page.getByTestId("auth0-login-form").waitFor();
  await enter(page, "auth0-login-email", user.email);
  await enter(page, "auth0-login-password", user.password);
  await Promise.all([
    page.waitForURL((url) => url.origin === platformUrl && url.pathname === "/"),
    page.getByTestId("auth0-login-submit").click(),
  ]);
  await page.getByTestId("cli-tokens-link").click();
  const main = page.locator("main");
  const initialOffset = await main.getAttribute("data-identity-offset");
  const initialDigest = await main.getAttribute("data-identity-digest");
  assert.ok(initialOffset && initialDigest);
  transcript += `tokens-page initial-offset=${initialOffset} initial-digest=${initialDigest}: OK\n`;

  await page.locator('input[name="name"]').fill("browser workstation");
  await page.locator('input[name="scopes"]').fill("repo:write");
  await page.getByRole("button", { name: "Mint token" }).click();
  const secretNode = page.getByTestId("cli-token-secret");
  await secretNode.waitFor({ state: "visible" });
  const secret = await secretNode.textContent();
  assert.ok(secret !== null && secret.startsWith("ef_cli_"));
  await page.getByTestId("cli-token-list").locator("li").waitFor();
  const mintedOffset = await main.getAttribute("data-identity-offset");
  const mintedDigest = await main.getAttribute("data-identity-digest");
  assert.notEqual(mintedOffset, initialOffset);
  assert.notEqual(mintedDigest, initialDigest);
  const listText = await page.getByTestId("cli-token-list").textContent();
  assert.ok(listText !== null && listText.includes("browser workstation"));
  assert.ok(!listText.includes(secret));
  transcript += `mint offset=${mintedOffset} digest=${mintedDigest} one-time-secret-visible=true list-secret=false: OK\n`;

  const issued = await identity.snapshot();
  const issueEvent = issued.events.find(
    (event) =>
      event.type === "identity.grant.issued" &&
      (event.payload as { readonly tokenKind?: unknown }).tokenKind === "web-mint",
  );
  assert.ok(issueEvent);
  assert.ok(!JSON.stringify(issued.events).includes(secret));
  transcript += `mint-event offset=${issueEvent.offset} raw-secret-in-events=0: OK\n`;

  await page.getByRole("button", { name: "Revoke" }).click();
  await page.getByTestId("cli-token-list").locator("li").waitFor({ state: "detached" });
  const revokedOffset = await main.getAttribute("data-identity-offset");
  const revokedDigest = await main.getAttribute("data-identity-digest");
  assert.notEqual(revokedOffset, mintedOffset);
  assert.notEqual(revokedDigest, mintedDigest);
  const revoked = await identity.snapshot();
  const revokeEvent = revoked.events.find((event) => event.type === "identity.grant.revoked");
  assert.ok(revokeEvent);
  transcript += `revoke offset=${revokedOffset} digest=${revokedDigest} revoke-event-offset=${revokeEvent.offset} list-active=0: OK\n`;

  assert.equal(consoleFailures.length, 0, consoleFailures.join("\n"));
  transcript += "console-errors=0 console-warnings=0 uncaught-exceptions=0: OK\n";
  transcript += `network-observations=${network.length} all-loopback=true: OK\n`;
  if (update) {
    await mkdir(evidence, { recursive: true });
    await writeFile(transcriptPath, transcript);
  } else {
    assert.equal(await readFile(transcriptPath, "utf8"), transcript);
  }
  process.stdout.write(transcript);
  process.stdout.write("E2_T05_BROWSER_OK\n");
} finally {
  await mkdir(resolve(task, "work"), { recursive: true });
  await context.tracing.stop({ path: activeTracePath }).catch(() => undefined);
  await context.close();
  if (captureVideo && video !== null) {
    const webmPath = await video.path();
    await mkdir(resolve(root, "recordings"), { recursive: true });
    await run("ffmpeg", [
      "-y",
      "-i",
      webmPath,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      mp4Path,
    ]);
    await run("ffprobe", ["-v", "error", "-show_entries", "format=duration,size", mp4Path]);
    const [trace, mp4] = await Promise.all([readFile(tracePath), readFile(mp4Path)]);
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          capturedTogether: true,
          trace: { path: "evidence/e2-t05-playwright-trace.zip", sha256: sha256(trace) },
          video: { path: "recordings/e2-t05-final.mp4", sha256: sha256(mp4) },
        },
        null,
        2,
      )}\n`,
    );
    process.stdout.write(`E2_T05_MP4_OK ${mp4Path}\n`);
  }
  await browser.close();
  await closeServer(platform);
  await emulator.close();
  await official.stop();
}
