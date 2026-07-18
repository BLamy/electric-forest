import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../..");
const emulatorPort = Number(process.env.E2_T02_EMULATOR_PORT ?? 45450);
const callbackPort = Number(process.env.E2_T02_CALLBACK_PORT ?? 45451);
const emulatorUrl = `http://127.0.0.1:${emulatorPort}`;
const callbackUrl = `http://127.0.0.1:${callbackPort}/callback`;
const tracePath = resolve(
  root,
  ".eforest/tasks/epic-2-the-gates/E2-T02-oidc-emulator/evidence/e2-t02-playwright-trace.zip",
);
const replayChromium = resolve(
  homedir(),
  ".replay/runtimes/Replay-Chromium.app/Contents/MacOS/Chromium",
);
const executablePath = process.env.AGENT_BROWSER_EXECUTABLE_PATH ?? replayChromium;

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

let callbackRequest: URL | undefined;
const callbackServer = createServer((request, response) => {
  callbackRequest = new URL(request.url ?? "/", callbackUrl);
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(
    "<!doctype html><title>Authorization complete</title><main data-testid=callback-complete>Authorization complete</main>",
  );
});
await new Promise<void>((resolveListen, reject) => {
  callbackServer.once("error", reject);
  callbackServer.listen(callbackPort, "127.0.0.1", resolveListen);
});

const emulator = await createEmulator({
  service: "auth0",
  port: emulatorPort,
  baseUrl: emulatorUrl,
  now: 1_700_000_000,
  seedMaterial: "e2-t02-browser",
  seed: {
    auth0: {
      users: [
        {
          email: "ada@example.test",
          password: "AdaTest1234!",
          user_id: "ada",
          name: "Ada Lovelace",
          email_verified: true,
        },
      ],
      oauth_clients: [
        {
          client_id: "eforest-browser",
          client_secret: "eforest-browser-secret",
          redirect_uris: [callbackUrl],
          grant_types: ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code"],
          audience: "eforest-api",
        },
      ],
      signing_key: {
        private_key_pem: privatePem,
        public_key_pem: publicPem,
        kid: "eforest-test-2026",
      },
    },
  },
});

const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext();
await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
const page = await context.newPage();
const consoleErrors: string[] = [];
const observedRequests: string[] = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("request", (request) => observedRequests.push(request.url()));

try {
  const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = "e2 state &=%";
  const authorize = new URL(`${emulatorUrl}/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: "eforest-browser",
    redirect_uri: callbackUrl,
    scope: "openid profile email",
    audience: "eforest-api",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce: "e2-t02-browser-nonce",
  })) {
    authorize.searchParams.set(key, value);
  }

  await page.goto(authorize.toString());
  await page.getByTestId("auth0-login-email").fill("ada@example.test");
  await page.getByTestId("auth0-login-password").fill("AdaTest1234!");
  await Promise.all([
    page.waitForURL(`${callbackUrl}*`),
    page.getByTestId("auth0-login-submit").click(),
  ]);
  await page.getByTestId("callback-complete").waitFor();
  assert(callbackRequest, "authorization callback was not observed");
  assert.equal(callbackRequest.searchParams.get("state"), state);
  const code = callbackRequest.searchParams.get("code");
  assert(code, "authorization callback omitted code");

  const tokenResponse = await fetch(`${emulatorUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "eforest-browser",
      client_secret: "eforest-browser-secret",
      redirect_uri: callbackUrl,
      code,
      code_verifier: verifier,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const authCodeTokens = await tokenResponse.json();
  assert.equal(typeof authCodeTokens.access_token, "string");
  assert.equal(typeof authCodeTokens.id_token, "string");

  const deviceResponse = await fetch(`${emulatorUrl}/oauth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: "eforest-browser",
      scope: "openid profile email",
      audience: "eforest-api",
    }),
  });
  assert.equal(deviceResponse.status, 200);
  const device = await deviceResponse.json();
  await page.goto(device.verification_uri_complete);
  await page.getByTestId("auth0-device-email").fill("ada@example.test");
  await page.getByTestId("auth0-device-password").fill("AdaTest1234!");
  await page.getByTestId("auth0-device-approve").click();
  await page.getByText("Device approved").waitFor();

  const deviceTokenResponse = await fetch(`${emulatorUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "eforest-browser",
      client_secret: "eforest-browser-secret",
      device_code: device.device_code,
    }),
  });
  assert.equal(deviceTokenResponse.status, 200);
  const deviceTokens = await deviceTokenResponse.json();
  assert.equal(typeof deviceTokens.access_token, "string");
  assert.equal(typeof deviceTokens.id_token, "string");

  assert.deepEqual(consoleErrors, [], `browser console errors: ${consoleErrors.join(" | ")}`);
  for (const requestUrl of observedRequests) {
    const host = new URL(requestUrl).hostname;
    assert(
      host === "127.0.0.1" || host === "localhost" || host === "::1",
      `non-loopback browser request: ${requestUrl}`,
    );
  }
  console.log(
    JSON.stringify({
      authCodeExchange: "OK",
      browserConsoleErrors: consoleErrors.length,
      deviceExchange: "OK",
      observedRequests: observedRequests.length,
      status: "E2_T02_BROWSER_OK",
      trace: tracePath,
    }),
  );
} finally {
  await context.tracing.stop({ path: tracePath });
  await context.close();
  await browser.close();
  await emulator.close();
  await new Promise<void>((resolveClose, reject) =>
    callbackServer.close((error) => (error ? reject(error) : resolveClose())),
  );
}
