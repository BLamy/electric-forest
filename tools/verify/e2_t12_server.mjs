#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Response } from "undici";
import {
  createDurableJsonStream,
  headDurableJsonStream,
  readDurableJson,
} from "../../packages/client/dist/src/index.js";
import { canonicalJson, stateDigest } from "../../packages/protocol/dist/src/index.js";
import { createDurableStreamTestServer } from "../../packages/server/dist/src/index.js";
import {
  createPlatformProductionRuntime,
  createPlatformServer,
  listenPlatformServer,
} from "../../packages/platform/dist/src/index.js";
import { reducer, initialState } from "./e2_t12_reducer.mjs";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const taskRoot = resolve(root, ".eforest/tasks/epic-2-the-gates/E2-T12-the-locked-gate");
const workRoot = resolve(taskRoot, "work/runtime");
const streamPort = Number(process.env.E2_T12_STREAM_PORT ?? 47120);
const emulatorPort = Number(process.env.E2_T12_EMULATOR_PORT ?? 47121);
const platformPort = Number(process.env.E2_T12_PLATFORM_PORT ?? 47122);
const streamUrl = `http://127.0.0.1:${streamPort}`;
const emulatorUrl = `http://127.0.0.1:${emulatorPort}`;
const platformUrl = `http://127.0.0.1:${platformPort}`;
const targetStreamId = "target";
const targetUrl = `${streamUrl}/streams/${targetStreamId}`;
const clientId = "eforest-e2-t12-capstone";
const nowSeconds = 1_800_000_000;
const nowMs = nowSeconds * 1_000;
const nativeFetch = globalThis.fetch;
const network = [];

function isLoopback(url) {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
}

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!isLoopback(url)) throw new TypeError(`E2-T12 network guard refused ${url.hostname}`);
  network.push(`${init?.method ?? (input instanceof Request ? input.method : "GET")} ${url.href}`);
  return nativeFetch(input, init);
};

function deterministicRandom() {
  let counter = 0;
  return (size) => {
    counter += 1;
    return Uint8Array.from({ length: size }, (_, index) => (counter * 47 + index * 19) & 0xff);
  };
}

function html(body) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>E2-T12 locked gate proof</title><style>
body{font:16px ui-monospace,monospace;background:#07120c;color:#e2ffea;margin:0;min-height:100vh;display:grid;place-items:center}main{width:min(900px,90vw);padding:32px;border:1px solid #4ba86a;border-radius:16px;background:#0d1e14}button,input{font:inherit;padding:10px;margin:6px;border-radius:7px;border:1px solid #4ba86a}button{background:#8dffb0;color:#07120c;font-weight:700;cursor:pointer}pre{background:#050b07;padding:16px;max-height:360px;overflow:auto;white-space:pre-wrap}.ok{color:#8dffb0}</style></head><body>${body}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

function proofPage() {
  return html(`<main data-testid="gate-proof"><h1>The locked gate</h1>
<p>This controller drives the built <code>ef dispatch</code> CLI against the same production platform app used for login and token management.</p>
<label>Grant id <input data-testid="grant-id"></label><label>One-time token <input data-testid="cli-token"></label>
<p><button data-testid="register-token">Register minted credential</button><button data-testid="authorized-cli">Authorized CLI dispatch</button><button data-testid="tokenless">Tokenless refusal</button><button data-testid="revoked-cli">Revoked CLI dispatch</button><button data-testid="refresh-proof">Refresh proof</button></p>
<p><a data-testid="tokens-link" href="/settings/cli-tokens">Return to CLI tokens</a></p>
<pre data-testid="proof-log">Ready.</pre>
<script>
const log=document.querySelector('[data-testid="proof-log"]');
async function post(path,body){const response=await fetch('/__e2_t12/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});const value=await response.json();log.textContent=JSON.stringify(value,null,2);if(!response.ok)throw new Error(path+' failed');return value}
document.querySelector('[data-testid="register-token"]').onclick=()=>post('register',{grantId:document.querySelector('[data-testid="grant-id"]').value,token:document.querySelector('[data-testid="cli-token"]').value});
document.querySelector('[data-testid="authorized-cli"]').onclick=()=>post('authorized');
document.querySelector('[data-testid="tokenless"]').onclick=()=>post('tokenless');
document.querySelector('[data-testid="revoked-cli"]').onclick=()=>post('revoked');
document.querySelector('[data-testid="refresh-proof"]').onclick=async()=>{const response=await fetch('/__e2_t12/state');log.textContent=JSON.stringify(await response.json(),null,2)};
</script></main>`);
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

await mkdir(workRoot, { recursive: true });
const official = createDurableStreamTestServer({ host: "127.0.0.1", port: streamPort });
await official.start();
await createDurableJsonStream({ url: targetUrl });

const emulator = await createEmulator({
  service: "auth0",
  port: emulatorPort,
  baseUrl: emulatorUrl,
  now: nowSeconds,
  seedMaterial: "e2-t12-capstone",
  seed: {
    auth0: {
      now: nowSeconds,
      seed: "e2-t12-capstone",
      connections: [{ name: "Username-Password-Authentication" }],
      users: [
        {
          email: "gate@example.test",
          password: "LockedGate1234!",
          user_id: "locked-gate-user",
          email_verified: true,
          name: "Locked Gate User",
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
        kid: "e2-t12-capstone-key",
      },
    },
  },
});

const random = deterministicRandom();
let operation = 0;
const runtime = await createPlatformProductionRuntime(
  {
    EF_OIDC_ISSUER: emulatorUrl,
    EF_OIDC_CLIENT_ID: clientId,
    EF_SESSION_SECRET: "e2-t12-session-secret-at-least-thirty-two-bytes",
    EF_SESSION_TTL: "600",
    EFOREST_SERVER_URL: streamUrl,
  },
  {
    now: () => nowMs,
    random,
    operationId: () => `e2-t12-operation-${String(++operation).padStart(4, "0")}`,
    rateLimit: { windowMs: 60_000, max: 100 },
  },
);

let credential;
const results = {
  ...(process.env.E2_T12_PROOF_SHA
    ? { proof: { sha: process.env.E2_T12_PROOF_SHA, source: "git-head" } }
    : {}),
  provider: {
    auth0: { kind: "pinned-emulator", url: emulatorUrl },
    streams: {
      kind: "DurableStreamTestServer",
      package: "@durable-streams/server",
      url: streamUrl,
    },
    platform: { composition: "createPlatformProductionRuntime", url: platformUrl },
  },
  network: { nonLoopback: 0, observations: network },
  steps: {},
};

async function targetTruth() {
  const response = await fetch(targetUrl);
  assert.ok(response.ok);
  const bytes = await response.text();
  const events = await readDurableJson({ url: targetUrl });
  const head = await headDurableJsonStream({ url: targetUrl });
  assert.ok(events.length <= 1, "E2-T12 target must contain at most the one accepted event");
  let state = initialState;
  for (const event of events) state = reducer(state, event);
  return {
    bytes,
    dump: events.length === 0 ? "" : `${canonicalJson({ offset: head.offset, ...events[0] })}\n`,
    byteLength: Buffer.byteLength(bytes),
    count: events.length,
    offset: head.offset ?? "-1",
    digest: stateDigest(state),
  };
}

async function runCli(token) {
  const home = resolve(workRoot, "cli-home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = resolve(home, "credentials.json");
  await writeFile(
    path,
    `${JSON.stringify({
      accessToken: token,
      tokenType: "Bearer",
      issuer: emulatorUrl,
      clientId,
      scopes: ["repo:write"],
    })}\n`,
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
  try {
    const completed = await run(
      process.execPath,
      [
        resolve(root, "packages/cli/dist/src/bin.js"),
        "dispatch",
        targetStreamId,
        JSON.stringify({
          type: "gate.opened",
          payload: { v: 1, path: "locked-gate" },
          ts: nowMs,
        }),
      ],
      { cwd: root, env: { ...process.env, EF_HOME: home, EF_SERVER_URL: platformUrl } },
    );
    return { exitCode: 0, stdout: completed.stdout.trim(), stderr: completed.stderr.trim() };
  } catch (error) {
    return {
      exitCode: error.code ?? 1,
      stdout: String(error.stdout ?? "").trim(),
      stderr: String(error.stderr ?? "").trim(),
    };
  }
}

async function jsonBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

const platform = createPlatformServer(async (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return Response.json({ ok: true, platformUrl, streamUrl, emulatorUrl });
  }
  if (url.pathname === "/__e2_t12") return proofPage();
  if (url.pathname === "/__e2_t12/state") return Response.json(results);
  if (url.pathname === "/__e2_t12/register" && request.method === "POST") {
    const body = await jsonBody(request);
    if (
      typeof body.grantId !== "string" ||
      !body.grantId.startsWith("grant_") ||
      typeof body.token !== "string" ||
      !body.token.startsWith("ef_cli_")
    ) {
      return Response.json({ error: "invalid credential" }, { status: 400 });
    }
    credential = { grantId: body.grantId, token: body.token };
    const identity = await runtime.identity.snapshot();
    const issued = identity.events.find(
      (event) =>
        event.type === "identity.grant.issued" && event.payload.grantId === credential.grantId,
    );
    assert.ok(issued, "minted grant is absent from identity stream");
    results.steps.mint = {
      grantId: credential.grantId,
      identityOffset: identity.offset,
      identityDigest: identity.digest,
      issueEventOffset: issued.offset,
      issueEvent: issued,
      rawSecretStored: JSON.stringify(identity.events).includes(credential.token),
    };
    return Response.json(results.steps.mint);
  }
  if (url.pathname === "/__e2_t12/authorized" && request.method === "POST") {
    assert.ok(credential, "register credential first");
    const before = await targetTruth();
    const cli = await runCli(credential.token);
    const after = await targetTruth();
    assert.equal(cli.exitCode, 0);
    assert.equal(after.count, before.count + 1);
    assert.notEqual(after.offset, before.offset);
    assert.notEqual(after.digest, before.digest);
    results.steps.authorized = { before, after, cli };
    return Response.json(results.steps.authorized);
  }
  if (url.pathname === "/__e2_t12/tokenless" && request.method === "POST") {
    const before = await targetTruth();
    const response = await fetch(`${platformUrl}/api/dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        streamId: targetStreamId,
        event: { type: "gate.opened", payload: { v: 1, path: "tokenless" }, ts: nowMs + 1 },
      }),
    });
    const body = await response.json();
    const after = await targetTruth();
    assert.equal(response.status, 401);
    assert.equal(after.bytes, before.bytes);
    results.steps.tokenless = { status: response.status, body, before, after, byteIdentical: true };
    return Response.json(results.steps.tokenless);
  }
  if (url.pathname === "/__e2_t12/revoked" && request.method === "POST") {
    assert.ok(credential, "register credential first");
    const identity = await runtime.identity.snapshot();
    const revoked = identity.events.find(
      (event) =>
        event.type === "identity.grant.revoked" && event.payload.grantId === credential.grantId,
    );
    assert.ok(revoked, "grant has not been revoked");
    const before = await targetTruth();
    const cli = await runCli(credential.token);
    const after = await targetTruth();
    assert.equal(cli.exitCode, 13);
    assert.match(cli.stderr, /token-revoked/);
    assert.equal(after.bytes, before.bytes);
    results.steps.revoked = {
      revokeEventOffset: revoked.offset,
      identityOffset: identity.offset,
      identityDigest: identity.digest,
      before,
      after,
      cli,
      byteIdentical: true,
    };
    return Response.json(results.steps.revoked);
  }
  return runtime.app.handle(request);
});

await listenPlatformServer(platform, platformPort);
process.stdout.write(
  `${JSON.stringify({
    status: "E2_T12_READY",
    platformUrl,
    streamUrl,
    emulatorUrl,
    username: "gate@example.test",
    password: "LockedGate1234!",
    proofSha: process.env.E2_T12_PROOF_SHA ?? null,
  })}\n`,
);

async function close() {
  await new Promise((resolveClose) => platform.close(resolveClose));
  await runtime.registry.stop();
  await emulator.close();
  await official.stop();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await close();
    process.exit(0);
  });
}
