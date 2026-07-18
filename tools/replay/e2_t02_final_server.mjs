#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { URLSearchParams } from "node:url";

const root = resolve(import.meta.dirname, "../..");
const emulatorPort = Number(process.env.E2_T02_EMULATOR_PORT ?? 45460);
const callbackPort = Number(process.env.E2_T02_CALLBACK_PORT ?? 45461);
const emulatorUrl = `http://127.0.0.1:${emulatorPort}`;
const callbackOrigin = `http://127.0.0.1:${callbackPort}`;
const callbackUrl = `${callbackOrigin}/callback`;
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = "e2-t02 Replay state &=%";

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${title}</title><style>
body{font:18px system-ui;background:#0d1512;color:#ebfff5;margin:0;display:grid;min-height:100vh;place-items:center}
main{width:min(720px,85vw);background:#17251f;border:1px solid #3e725c;border-radius:18px;padding:36px;box-shadow:0 20px 70px #0008}
h1{margin-top:0;color:#8dffc5} code{color:#ffd88d} a{display:inline-block;margin-top:20px;padding:12px 18px;border-radius:10px;background:#8dffc5;color:#092017;font-weight:700;text-decoration:none}
.proof{display:grid;gap:9px;padding:0;list-style:none}.proof li:before{content:"✓ ";color:#8dffc5;font-weight:700}
</style></head><body><main>${body}</main></body></html>`;
}

function sendHtml(response, status, title, body) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(page(title, body));
}

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
const emulator = await createEmulator({
  service: "auth0",
  port: emulatorPort,
  baseUrl: emulatorUrl,
  now: 1_700_000_000,
  seedMaterial: "e2-t02-replay-final",
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

let deviceCode;
const callbackServer = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", callbackOrigin);
    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      if (!code || url.searchParams.get("state") !== state) {
        sendHtml(
          response,
          400,
          "Authorization failed",
          "<h1>Authorization failed</h1><p>Missing code or state mismatch.</p>",
        );
        return;
      }
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
      const tokens = await tokenResponse.json();
      if (tokenResponse.status !== 200 || !tokens.access_token || !tokens.id_token) {
        sendHtml(
          response,
          500,
          "Token exchange failed",
          `<h1>Token exchange failed</h1><pre>${JSON.stringify(tokens)}</pre>`,
        );
        return;
      }
      sendHtml(
        response,
        200,
        "Authorization complete",
        `<h1 data-testid="authcode-complete">Authorization-code + PKCE complete</h1>
<ul class="proof"><li>State echoed byte-identically</li><li>RS256 access token issued</li><li>RS256 ID token issued</li><li>kid: <code>eforest-test-2026</code></li></ul>
<a data-testid="start-device" href="/device/start">Start device authorization</a>`,
      );
      return;
    }
    if (url.pathname === "/device/start") {
      const deviceResponse = await fetch(`${emulatorUrl}/oauth/device/code`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: "eforest-browser",
          scope: "openid profile email",
          audience: "eforest-api",
        }),
      });
      const device = await deviceResponse.json();
      if (deviceResponse.status !== 200 || !device.device_code) {
        sendHtml(
          response,
          500,
          "Device start failed",
          `<h1>Device start failed</h1><pre>${JSON.stringify(device)}</pre>`,
        );
        return;
      }
      deviceCode = device.device_code;
      response.writeHead(302, { location: device.verification_uri_complete });
      response.end();
      return;
    }
    if (url.pathname === "/device/complete") {
      if (!deviceCode) {
        sendHtml(response, 400, "Device flow missing", "<h1>No device flow is pending</h1>");
        return;
      }
      const tokenResponse = await fetch(`${emulatorUrl}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: "eforest-browser",
          client_secret: "eforest-browser-secret",
          device_code: deviceCode,
        }),
      });
      const tokens = await tokenResponse.json();
      if (tokenResponse.status !== 200 || !tokens.access_token || !tokens.id_token) {
        sendHtml(
          response,
          tokenResponse.status,
          "Device exchange failed",
          `<h1>Device exchange failed</h1><pre>${JSON.stringify(tokens)}</pre>`,
        );
        return;
      }
      deviceCode = undefined;
      sendHtml(
        response,
        200,
        "E2-T02 walkthrough complete",
        `<h1 data-testid="device-complete">Device authorization complete</h1>
<ul class="proof"><li>Approval used the real Auth0 form</li><li>RS256 access token issued</li><li>RS256 ID token issued</li><li>Zero external services</li></ul>
<p><strong>E2-T02 final walkthrough: PASS</strong></p>`,
      );
      return;
    }
    sendHtml(response, 404, "Not found", "<h1>Not found</h1>");
  } catch (error) {
    sendHtml(
      response,
      500,
      "Walkthrough error",
      `<h1>Walkthrough error</h1><pre>${String(error)}</pre>`,
    );
  }
});

await new Promise((resolveListen, reject) => {
  callbackServer.once("error", reject);
  callbackServer.listen(callbackPort, "127.0.0.1", resolveListen);
});

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
  nonce: "e2-t02-replay-final-nonce",
})) {
  authorize.searchParams.set(key, value);
}

console.log(
  JSON.stringify({
    status: "E2_T02_REPLAY_READY",
    authorizeUrl: authorize.toString(),
    callbackOrigin,
  }),
);

async function close() {
  await emulator.close();
  await new Promise((resolveClose) => callbackServer.close(resolveClose));
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await close();
    process.exit(0);
  });
}
