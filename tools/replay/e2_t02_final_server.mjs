#!/usr/bin/env node
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const emulatorPort = Number(process.env.E2_T02_EMULATOR_PORT ?? 45460);
const callbackPort = Number(process.env.E2_T02_CALLBACK_PORT ?? 45461);
const expiredEmulatorPort = Number(process.env.E2_T02_EXPIRED_EMULATOR_PORT ?? 45462);
const emulatorUrl = `http://127.0.0.1:${emulatorPort}`;
const expiredEmulatorUrl = `http://127.0.0.1:${expiredEmulatorPort}`;
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
h1{margin-top:0;color:#8dffc5} code{color:#ffd88d} button,a{display:inline-block;margin:8px 6px 8px 0;padding:12px 18px;border:0;border-radius:10px;background:#8dffc5;color:#092017;font:inherit;font-weight:700;text-decoration:none;cursor:pointer}.secondary{background:#ffd88d}.danger{background:#ff9f9f}pre{white-space:pre-wrap;background:#09110e;padding:14px;border-radius:10px;font-size:13px;max-height:220px;overflow:auto}
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
        {
          client_id: "eforest-redirect-probe",
          client_secret: "eforest-redirect-probe-secret",
          redirect_uris: [`${emulatorUrl}/`],
          grant_types: ["authorization_code"],
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
  seedMaterial: "e2-t02-replay-expired",
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

function proofApp(url) {
  const code = JSON.stringify(url.searchParams.get("code"));
  const returnedState = JSON.stringify(url.searchParams.get("state"));
  return `<h1 data-testid="proof-title">E2-T02 browser-owned proof</h1>
<p>Every OAuth request below is initiated by this Replay Chromium page and is visible in the recording network table.</p>
<div id="actions">
  <button data-testid="probe-metadata" onclick="probeMetadata()">Fetch discovery + JWKS</button>
  <button data-testid="exchange-authcode" onclick="exchangeAuthCode()" ${code === "null" ? "disabled" : ""}>Exchange authorization code</button>
  <button data-testid="probe-unknown-device" class="danger" onclick="probeUnknownDevice()">Probe unknown device refusal</button>
  <button data-testid="start-expired-device" class="danger" onclick="startExpiredDevice()">Start expired device refusal</button>
  <button data-testid="start-device" onclick="startDevice()">Start device authorization</button>
  <button data-testid="probe-device-credentials" class="danger" onclick="probeBadDeviceCredentials()">Probe bad device credentials</button>
  <button data-testid="poll-device" class="secondary" onclick="pollDevice()">Poll current device grant</button>
</div>
<div id="device-link"></div><pre data-testid="browser-proof-log" id="log">Ready.</pre>
<script>
const emulatorUrl = ${JSON.stringify(emulatorUrl)};
const expiredEmulatorUrl = ${JSON.stringify(expiredEmulatorUrl)};
const callbackUrl = ${JSON.stringify(callbackUrl)};
const verifier = ${JSON.stringify(verifier)};
const expectedState = ${JSON.stringify(state)};
const authorizationCode = ${code};
const returnedState = ${returnedState};
const log = document.getElementById("log");
const show = (label, value) => { log.textContent = label + "\\n" + JSON.stringify(value, null, 2); };
async function request(path, body, origin = emulatorUrl) {
  const response = await fetch(origin + path, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/x-www-form-urlencoded" } : undefined,
    body: body ? new URLSearchParams(body) : undefined,
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { html: text.replace(/<[^>]+>/g, " ").replace(/\\s+/g, " ").trim() }; }
  return { status: response.status, data };
}
async function probeMetadata() {
  const discovery = await request("/.well-known/openid-configuration");
  const jwks = await request("/.well-known/jwks.json");
  show("DISCOVERY_AND_JWKS", { discoveryStatus: discovery.status, tokenEndpoint: discovery.data.token_endpoint, deviceEndpoint: discovery.data.device_authorization_endpoint, jwksStatus: jwks.status, kid: jwks.data.keys?.[0]?.kid });
}
async function exchangeAuthCode() {
  if (!authorizationCode || returnedState !== expectedState) return show("AUTH_CODE_REFUSED", { authorizationCode: Boolean(authorizationCode), stateMatches: returnedState === expectedState });
  const result = await request("/oauth/token", { grant_type: "authorization_code", client_id: "eforest-browser", client_secret: "eforest-browser-secret", redirect_uri: callbackUrl, code: authorizationCode, code_verifier: verifier });
  show("AUTH_CODE_EXCHANGE", { status: result.status, stateMatches: returnedState === expectedState, accessTokenSegments: result.data.access_token?.split(".").length, idTokenSegments: result.data.id_token?.split(".").length, tokenType: result.data.token_type });
}
async function probeUnknownDevice() {
  const result = await request("/activate", { user_code: "UNKNOWN-E2", decision: "approve", email: "ada@example.test", password: "AdaTest1234!" });
  show("UNKNOWN_DEVICE_REFUSAL", result);
}
async function startExpiredDevice() {
  const result = await request("/oauth/device/code", { client_id: "eforest-browser", scope: "openid profile email", audience: "eforest-api" }, expiredEmulatorUrl);
  if (result.status !== 200) return show("EXPIRED_DEVICE_START_FAILED", result);
  document.getElementById("device-link").innerHTML = '<a data-testid="open-expired-device" class="danger" href="' + result.data.verification_uri_complete + '">Open expired device refusal form</a>';
  show("EXPIRED_DEVICE_CREATED", { status: result.status, userCode: result.data.user_code, verificationUri: result.data.verification_uri_complete });
}
async function startDevice() {
  const result = await request("/oauth/device/code", { client_id: "eforest-browser", scope: "openid profile email", audience: "eforest-api" });
  if (result.status !== 200) return show("DEVICE_START_FAILED", result);
  sessionStorage.setItem("e2-device-code", result.data.device_code);
  sessionStorage.setItem("e2-user-code", result.data.user_code);
  document.getElementById("device-link").innerHTML = '<a data-testid="open-device-approval" href="' + result.data.verification_uri_complete + '">Open real device approval form</a>';
  show("DEVICE_CODE_CREATED", { status: result.status, userCode: result.data.user_code, verificationUri: result.data.verification_uri_complete });
}
async function probeBadDeviceCredentials() {
  const userCode = sessionStorage.getItem("e2-user-code");
  if (!userCode) return show("BAD_CREDENTIAL_PROBE", { status: "start a device flow first" });
  const result = await request("/activate", { user_code: userCode, decision: "approve", email: "ada@example.test", password: "wrong-password" });
  show("BAD_DEVICE_CREDENTIALS_REFUSAL", result);
}
async function pollDevice() {
  const deviceCode = sessionStorage.getItem("e2-device-code");
  if (!deviceCode) return show("DEVICE_POLL", { status: "no stored device code" });
  const result = await request("/oauth/token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "eforest-browser", client_secret: "eforest-browser-secret", device_code: deviceCode });
  show(result.status === 200 ? "E2_T02_FINAL_PASS" : "DEVICE_TOKEN_REFUSAL", { status: result.status, error: result.data.error, accessTokenSegments: result.data.access_token?.split(".").length, idTokenSegments: result.data.id_token?.split(".").length, tokenType: result.data.token_type });
}
</script>`;
}

const callbackServer = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", callbackOrigin);
    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (url.pathname === "/callback" || url.pathname === "/device") {
      sendHtml(response, 200, "E2-T02 browser-owned proof", proofApp(url));
      return;
    }
    if (url.pathname === "/start") {
      sendHtml(
        response,
        200,
        "E2-T02 Replay walkthrough",
        `<h1 data-testid="walkthrough-start">E2-T02 Replay walkthrough</h1><p>The walkthrough first proves browser-visible refusals and the exact authorization redirect, then completes PKCE and denied + approved device grants.</p><a data-testid="begin-login" href=${JSON.stringify(authorize.toString())}>Begin Auth0 login</a>`,
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
    authorizeUrl: `${callbackOrigin}/start`,
    directAuthorizeUrl: authorize.toString(),
    callbackOrigin,
  }),
);

async function close() {
  await emulator.close();
  await expiredEmulator.close();
  await new Promise((resolveClose) => callbackServer.close(resolveClose));
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await close();
    process.exit(0);
  });
}
