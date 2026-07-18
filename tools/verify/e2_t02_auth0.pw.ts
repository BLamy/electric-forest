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
const expiredEmulatorPort = Number(process.env.E2_T02_EXPIRED_EMULATOR_PORT ?? 45452);
const emulatorUrl = `http://127.0.0.1:${emulatorPort}`;
const expiredEmulatorUrl = `http://127.0.0.1:${expiredEmulatorPort}`;
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
assert.equal(process.env.HTTP_PROXY, "http://127.0.0.1:1");
assert.equal(process.env.HTTPS_PROXY, "http://127.0.0.1:1");
assert.equal(process.env.http_proxy, "http://127.0.0.1:1");
assert.equal(process.env.https_proxy, "http://127.0.0.1:1");

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
        {
          email: "blocked@example.test",
          password: "BlockedTest1234!",
          user_id: "blocked",
          name: "Blocked User",
          email_verified: true,
          blocked: true,
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

const expiredEmulator = await createEmulator({
  service: "auth0",
  port: expiredEmulatorPort,
  baseUrl: expiredEmulatorUrl,
  now: 1_700_000_000,
  seedMaterial: "e2-t02-expired-browser",
  seed: {
    auth0: {
      device_code_ttl_seconds: 0,
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
          grant_types: ["urn:ietf:params:oauth:grant-type:device_code"],
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

async function browserRequest(path: string, values?: Record<string, string>, origin = emulatorUrl) {
  return page.evaluate(
    async ({ url, values: requestValues }) => {
      const response = await fetch(url, {
        method: requestValues ? "POST" : "GET",
        headers: requestValues
          ? { "content-type": "application/x-www-form-urlencoded" }
          : undefined,
        body: requestValues ? new URLSearchParams(requestValues) : undefined,
      });
      return { status: response.status, text: await response.text() };
    },
    { url: `${origin}${path}`, values },
  );
}

async function enter(testId: string, value: string) {
  const field = page.getByTestId(testId);
  await field.click();
  await field.pressSequentially(value);
}

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
  await enter("auth0-login-email", "ada@example.test");
  await enter("auth0-login-password", "wrong-password");
  const [wrongLoginResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url() === `${emulatorUrl}/authorize` && response.request().method() === "POST",
    ),
    page.getByTestId("auth0-login-submit").click(),
  ]);
  assert.equal(wrongLoginResponse.status(), 200);
  assert.equal(wrongLoginResponse.headers().location, undefined);
  await page.getByText("Wrong email or password").waitFor();

  await page.goto(authorize.toString());
  await enter("auth0-login-email", "blocked@example.test");
  await enter("auth0-login-password", "BlockedTest1234!");
  const [blockedResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url() === `${emulatorUrl}/authorize` && response.request().method() === "POST",
    ),
    page.getByTestId("auth0-login-submit").click(),
  ]);
  assert.equal(blockedResponse.status(), 200);
  assert.equal(blockedResponse.headers().location, undefined);
  await page.getByText("user is blocked").waitFor();

  await page.goto(authorize.toString());
  await enter("auth0-login-email", "ada@example.test");
  await enter("auth0-login-password", "AdaTest1234!");
  await Promise.all([
    page.waitForURL(`${callbackUrl}*`),
    page.getByTestId("auth0-login-submit").click(),
  ]);
  await page.getByTestId("callback-complete").waitFor();
  assert(callbackRequest, "authorization callback was not observed");
  assert.equal(callbackRequest.searchParams.get("state"), state);
  const code = callbackRequest.searchParams.get("code");
  assert(code, "authorization callback omitted code");

  const discovery = await browserRequest("/.well-known/openid-configuration");
  const jwks = await browserRequest("/.well-known/jwks.json");
  assert.equal(discovery.status, 200);
  assert.equal(jwks.status, 200);

  const tokenResponse = await browserRequest("/oauth/token", {
    grant_type: "authorization_code",
    client_id: "eforest-browser",
    client_secret: "eforest-browser-secret",
    redirect_uri: callbackUrl,
    code,
    code_verifier: verifier,
  });
  assert.equal(tokenResponse.status, 200);
  const authCodeTokens = JSON.parse(tokenResponse.text);
  assert.equal(typeof authCodeTokens.access_token, "string");
  assert.equal(typeof authCodeTokens.id_token, "string");

  const unknownDevice = await browserRequest("/activate", {
    user_code: "UNKNOWN-E2",
    decision: "approve",
    email: "ada@example.test",
    password: "AdaTest1234!",
  });
  assert.equal(unknownDevice.status, 200);
  assert.match(unknownDevice.text, /Unknown device code/);

  const expiredDeviceResponse = await browserRequest(
    "/oauth/device/code",
    {
      client_id: "eforest-browser",
      scope: "openid profile email",
      audience: "eforest-api",
    },
    expiredEmulatorUrl,
  );
  assert.equal(expiredDeviceResponse.status, 200);
  const expiredDevice = JSON.parse(expiredDeviceResponse.text);
  await page.goto(expiredDevice.verification_uri_complete);
  await enter("auth0-device-email", "ada@example.test");
  await enter("auth0-device-password", "AdaTest1234!");
  const [expiredResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url() === `${expiredEmulatorUrl}/activate` &&
        response.request().method() === "POST",
    ),
    page.getByTestId("auth0-device-approve").click(),
  ]);
  assert.equal(expiredResponse.status(), 200);
  assert.equal(expiredResponse.headers().location, undefined);
  await page.getByText("Expired device code").waitFor();

  const deniedDeviceResponse = await browserRequest("/oauth/device/code", {
    client_id: "eforest-browser",
    scope: "openid profile email",
    audience: "eforest-api",
  });
  assert.equal(deniedDeviceResponse.status, 200);
  const deniedDevice = JSON.parse(deniedDeviceResponse.text);
  await page.goto(deniedDevice.verification_uri_complete);
  const [denialResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url() === `${emulatorUrl}/activate` && response.request().method() === "POST",
    ),
    page.getByTestId("auth0-device-deny").click(),
  ]);
  assert.equal(denialResponse.status(), 200);
  assert.equal(denialResponse.headers().location, undefined);
  await page.getByText("Request denied").waitFor();
  const deniedPoll = await page.evaluate(
    ({ action, deviceCode }) =>
      new Promise<{ status: number; text: string }>((resolve, reject) => {
        const source = `onmessage = async ({ data }) => {
          try {
            const response = await fetch(data.action, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams(data.values),
            });
            postMessage({ status: response.status, text: await response.text() });
          } catch (error) { postMessage({ error: String(error) }); }
        }`;
        const worker = new Worker(
          URL.createObjectURL(new Blob([source], { type: "text/javascript" })),
        );
        worker.onmessage = ({ data }) => {
          worker.terminate();
          if (data.error) reject(new Error(data.error));
          else resolve(data);
        };
        worker.postMessage({
          action,
          values: {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            client_id: "eforest-browser",
            client_secret: "eforest-browser-secret",
            device_code: deviceCode,
          },
        });
      }),
    { action: `${emulatorUrl}/oauth/token`, deviceCode: deniedDevice.device_code },
  );
  assert.equal(deniedPoll.status, 403);
  assert.deepEqual(JSON.parse(deniedPoll.text), {
    error: "access_denied",
    error_description: "The user denied this device request.",
  });

  const deviceResponse = await browserRequest("/oauth/device/code", {
    client_id: "eforest-browser",
    scope: "openid profile email",
    audience: "eforest-api",
  });
  assert.equal(deviceResponse.status, 200);
  const device = JSON.parse(deviceResponse.text);
  const badCredentials = await browserRequest("/activate", {
    user_code: device.user_code,
    decision: "approve",
    email: "ada@example.test",
    password: "wrong-password",
  });
  assert.equal(badCredentials.status, 200);
  assert.match(badCredentials.text, /Wrong email or password/);
  await page.goto(device.verification_uri_complete);
  await enter("auth0-device-email", "ada@example.test");
  await enter("auth0-device-password", "AdaTest1234!");
  await page.getByTestId("auth0-device-approve").click();
  await page.getByText("Device approved").waitFor();

  const deviceTokenResponse = await browserRequest("/oauth/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: "eforest-browser",
    client_secret: "eforest-browser-secret",
    device_code: device.device_code,
  });
  assert.equal(deviceTokenResponse.status, 200);
  const deviceTokens = JSON.parse(deviceTokenResponse.text);
  assert.equal(typeof deviceTokens.access_token, "string");
  assert.equal(typeof deviceTokens.id_token, "string");

  assert.deepEqual(consoleErrors, [], `browser console errors: ${consoleErrors.join(" | ")}`);
  for (const requestUrl of observedRequests) {
    if (requestUrl.startsWith("blob:http://127.0.0.1:") || requestUrl.startsWith("blob:http://localhost:")) {
      continue;
    }
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
  await expiredEmulator.close();
  await new Promise<void>((resolveClose, reject) =>
    callbackServer.close((error) => (error ? reject(error) : resolveClose())),
  );
}
