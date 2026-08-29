import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { URLSearchParams } from "node:url";
import { promisify } from "node:util";
import {
  createDurableJsonStream,
  readDurableJson,
  readDurableJsonSnapshot,
} from "../../packages/client/dist/src/index.js";
import { createDurableStreamTestServer } from "../../packages/server/dist/src/index.js";
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
} from "../../packages/platform/dist/src/index.js";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const task = resolve(root, ".eforest/tasks/epic-2-the-gates/E2-T05-cli-device-token-flow");
const evidence = resolve(task, "evidence");
const transcriptPath = resolve(evidence, "e2-t05-transcript.txt");
const work = resolve(task, "work/transcript");
const home = resolve(work, "home");
const targetDump = resolve(work, "target.jsonl");
const update = process.env.E2_T05_UPDATE_GOLDENS === "1";
const nowSeconds = 1_800_000_000;
const nowMs = nowSeconds * 1_000;
const emulatorPort = Number(process.env.E2_T05_EMULATOR_PORT ?? 46900);
const streamPort = Number(process.env.E2_T05_STREAM_PORT ?? 46901);
const platformPort = Number(process.env.E2_T05_PLATFORM_PORT ?? 46902);
const emulatorUrl = `http://127.0.0.1:${emulatorPort}`;
const streamUrl = `http://127.0.0.1:${streamPort}`;
const platformUrl = `http://127.0.0.1:${platformPort}`;
const clientId = "eforest-e2-t05";
const user = { email: "cli@example.test", password: "CliTest1234!", id: "cli-user" };
const sessionSecret = "e2-t05-transcript-session-secret-long-enough";

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

function deterministicRandom() {
  let counter = 0;
  return (size) => {
    counter += 1;
    return Uint8Array.from({ length: size }, (_, index) => (counter * 37 + index * 19) & 0xff);
  };
}

async function closeServer(server) {
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error === undefined ? resolveClose() : reject(error))),
  );
}

function spawnCli(args, onStdout = () => {}) {
  return new Promise((resolveChild, reject) => {
    const child = spawn(
      process.execPath,
      [resolve(root, "packages/cli/dist/src/bin.js"), ...args],
      {
        cwd: root,
        env: {
          ...process.env,
          EF_HOME: home,
          EF_OIDC_ISSUER: emulatorUrl,
          EF_OIDC_CLIENT_ID: clientId,
          EF_SERVER_URL: platformUrl,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      onStdout(stdout);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => resolveChild({ code, stdout, stderr }));
  });
}

async function truth(identity) {
  const snapshot = await identity.snapshot();
  return { offset: snapshot.offset, count: snapshot.events.length, digest: snapshot.digest };
}

async function targetTruth() {
  const url = `${streamUrl}/streams/target`;
  const snapshot = await readDurableJsonSnapshot({ url });
  const items = snapshot.items;
  const records = items.map((item, index) => ({
    offset: `0000000000000000_${String(index).padStart(16, "0")}`,
    ...item,
  }));
  const head = snapshot.offset ?? "-1";
  await writeFile(targetDump, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const digest = (
    await run(
      process.execPath,
      [resolve(root, "packages/cli/dist/src/bin.js"), "replay", targetDump, "--digest"],
      {
        cwd: root,
      },
    )
  ).stdout.trim();
  return { offset: head, count: records.length, digest };
}

await rm(work, { recursive: true, force: true });
await mkdir(home, { recursive: true });
await chmod(home, 0o700);

const official = createDurableStreamTestServer({ host: "127.0.0.1", port: streamPort });
const emulator = await createEmulator({
  service: "auth0",
  port: emulatorPort,
  baseUrl: emulatorUrl,
  now: nowSeconds,
  seedMaterial: "e2-t05-transcript",
  seed: {
    auth0: {
      now: nowSeconds,
      seed: "e2-t05-transcript",
      connections: [{ name: "Username-Password-Authentication" }],
      users: [
        {
          email: user.email,
          password: user.password,
          user_id: user.id,
          email_verified: true,
          name: "CLI User",
        },
      ],
      oauth_clients: [
        {
          client_id: clientId,
          client_secret: "",
          redirect_uris: [`${platformUrl}/auth/callback`],
          grant_types: ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code"],
          audience: clientId,
        },
      ],
      signing_key: {
        private_key_pem: privatePem,
        public_key_pem: publicPem,
        kid: "e2-t05-key",
      },
    },
  },
});
await official.start();
await createDurableJsonStream({ url: `${streamUrl}/streams/target` });
const identity = new IdentityStore({ baseUrl: streamUrl, now: () => nowMs });
await identity.ensure();
const bearer = new BearerVerifier({
  issuer: emulatorUrl,
  audience: clientId,
  now: () => nowMs,
});
const gateway = new PlatformGateway({
  verifier: new GrantAwareVerifier({
    bearer,
    identity,
    operationId: (() => {
      let ordinal = 0;
      return () => `transcript-operation-${++ordinal}`;
    })(),
  }),
  streams: new OfficialStreamAdapter({ baseUrl: streamUrl }),
});
const random = deterministicRandom();
const app = new PlatformWebApp({
  oidc: new OidcClient({ issuer: emulatorUrl, clientId, now: () => nowMs }),
  transactions: new OidcTransactions(random),
  identity,
  sessionSecret,
  sessionTtlMs: 60_000,
  now: () => nowMs,
  random,
  gateway,
  deviceVerifier: bearer,
});
const platform = createPlatformServer((request) => app.handle(request));
await listenPlatformServer(platform, platformPort);

let transcript = "";
let approved = false;
try {
  const login = await spawnCli(["login", "--no-browser"], (stdout) => {
    if (approved) return;
    const match = /Verify at: (http:\/\/[^\s]+)/.exec(stdout);
    if (match === null) return;
    approved = true;
    const approval = new URL(match[1]);
    void fetch(`${emulatorUrl}/activate`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        user_code: approval.searchParams.get("user_code") ?? "",
        email: user.email,
        password: user.password,
        decision: "approve",
      }),
    });
  });
  assert.equal(login.code, 0, login.stderr);
  const credentialsPath = resolve(home, "credentials.json");
  const credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
  assert.equal((await stat(credentialsPath)).mode & 0o777, 0o600);
  const deviceSnapshot = await identity.snapshot();
  const deviceGrant = deviceSnapshot.events.find(
    (event) => event.type === "identity.grant.issued" && event.payload.tokenKind === "device",
  );
  assert.ok(deviceGrant);
  transcript += `device-login exit=0 mode=0600 grant-offset=${deviceGrant.offset} identity-offset=${deviceSnapshot.offset} identity-digest=${deviceSnapshot.digest}: OK\n`;

  const event = JSON.stringify({ type: "test.created", payload: { value: 1 }, ts: nowMs + 10 });
  const deviceAppend = await spawnCli(["dispatch", "target", event]);
  assert.equal(deviceAppend.code, 0, deviceAppend.stderr);
  const afterDeviceAppend = await targetTruth();
  transcript += `device-append exit=0 target-offset=${afterDeviceAppend.offset} target-digest=${afterDeviceAppend.digest}: OK\n`;

  const loginStart = await fetch(`${platformUrl}/auth/login`, { redirect: "manual" });
  const authorization = new URL(loginStart.headers.get("location"));
  const authorize = await fetch(`${authorization.origin}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...Object.fromEntries(authorization.searchParams),
      email: user.email,
      password: user.password,
    }),
    redirect: "manual",
  });
  const callback = await fetch(authorize.headers.get("location"), { redirect: "manual" });
  assert.equal(callback.status, 302);
  const cookie = callback.headers.get("set-cookie").split(";", 1)[0];

  const beforeMissing = await truth(identity);
  const missing = await fetch(`${platformUrl}/api/cli-tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "missing", scopes: ["repo:write"] }),
  });
  assert.equal(missing.status, 401);
  assert.deepEqual(await truth(identity), beforeMissing);
  transcript += `mint-no-session status=401 before=${JSON.stringify(beforeMissing)} after=${JSON.stringify(await truth(identity))}: OK\n`;

  const beforeMint = await truth(identity);
  const minted = await fetch(`${platformUrl}/api/cli-tokens`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "browser token", scopes: ["repo:write"] }),
  });
  assert.equal(minted.status, 201);
  const mintText = await minted.text();
  const mint = JSON.parse(mintText);
  assert.equal(mintText.split(mint.token).length, 2);
  const afterMint = await truth(identity);
  assert.equal(afterMint.count, beforeMint.count + 1);
  const listedText = await (
    await fetch(`${platformUrl}/api/cli-tokens`, { headers: { cookie } })
  ).text();
  assert.ok(!listedText.includes(mint.token));
  transcript += `web-mint status=201 before=${JSON.stringify(beforeMint)} after=${JSON.stringify(afterMint)} secret-occurrences=1 list-secret=false: OK\n`;

  await writeFile(
    credentialsPath,
    `${JSON.stringify({ ...credentials, accessToken: mint.token })}\n`,
    { mode: 0o600 },
  );
  await chmod(credentialsPath, 0o600);
  const webAppend = await spawnCli(["dispatch", "target", event]);
  assert.equal(webAppend.code, 0, webAppend.stderr);
  const beforeRevokeTarget = await targetTruth();
  const beforeRevokeIdentity = await truth(identity);
  const revoke = await fetch(`${platformUrl}/api/cli-tokens/${mint.grantId}`, {
    method: "DELETE",
    headers: { cookie },
  });
  assert.equal(revoke.status, 200);
  const afterRevokeIdentity = await truth(identity);
  assert.equal(afterRevokeIdentity.count, beforeRevokeIdentity.count + 1);

  const refused = await spawnCli(["dispatch", "target", event]);
  assert.equal(refused.code, 13);
  assert.deepEqual(JSON.parse(refused.stderr), { error: { class: "token-revoked" } });
  const afterRefusalTarget = await targetTruth();
  assert.deepEqual(afterRefusalTarget, beforeRevokeTarget);
  transcript += `revoke status=200 identity-before=${JSON.stringify(beforeRevokeIdentity)} identity-after=${JSON.stringify(afterRevokeIdentity)} ef-dispatch-before-exit=0 ef-dispatch-after-exit=13 class=token-revoked target-before=${JSON.stringify(beforeRevokeTarget)} target-after=${JSON.stringify(afterRefusalTarget)}: OK\n`;

  const beforeRefusals = await truth(identity);
  const double = await fetch(`${platformUrl}/api/cli-tokens/${mint.grantId}`, {
    method: "DELETE",
    headers: { cookie },
  });
  const unknown = await fetch(`${platformUrl}/api/cli-tokens/grant-never-existed`, {
    method: "DELETE",
    headers: { cookie },
  });
  assert.equal(double.status, 409);
  assert.equal((await double.json()).error.class, "grant-already-revoked");
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.class, "grant-not-found");
  assert.deepEqual(await truth(identity), beforeRefusals);
  transcript += `double-revoke status=409 class=grant-already-revoked unknown-revoke status=404 class=grant-not-found before=${JSON.stringify(beforeRefusals)} after=${JSON.stringify(await truth(identity))}: OK\n`;

  const identityText = JSON.stringify((await identity.snapshot()).events);
  const targetText = JSON.stringify(await readDurableJson({ url: `${streamUrl}/streams/target` }));
  assert.ok(!identityText.includes(credentials.accessToken));
  assert.ok(!identityText.includes(mint.token));
  assert.ok(!targetText.includes(credentials.accessToken));
  assert.ok(!targetText.includes(mint.token));
  transcript += "secret-hygiene device=0 web-mint=0 across identity,target: OK\n";

  const logout = await spawnCli(["logout"]);
  assert.equal(logout.code, 0);
  const localOnline = await spawnCli(["dispatch", "target", event]);
  assert.equal(localOnline.code, 10);
  await closeServer(platform);
  const localOffline = await spawnCli(["dispatch", "target", event]);
  assert.equal(localOffline.code, 10);
  assert.equal(localOffline.stderr, localOnline.stderr);
  transcript += `logout exit=0 credentials-exists=false local-online-exit=10 local-offline-exit=10 message=${JSON.stringify(localOnline.stderr.trim())}: OK\n`;

  if (update) {
    await mkdir(evidence, { recursive: true });
    await writeFile(transcriptPath, transcript);
  } else {
    assert.equal(await readFile(transcriptPath, "utf8"), transcript);
  }
  process.stdout.write(transcript);
  process.stdout.write("E2_T05_TRANSCRIPT_OK\n");
} finally {
  if (platform.listening) await closeServer(platform);
  await emulator.close();
  await official.stop();
}
