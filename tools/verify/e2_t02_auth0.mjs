import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL, URLSearchParams } from "node:url";
import {
  Agent as UndiciAgent,
  buildConnector,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";
import { inspectAndVerifyJwt, mutateSignature } from "./e2_t02_jwt_verify.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TASK = path.join(ROOT, ".eforest/tasks/epic-2-the-gates/E2-T02-oidc-emulator");
const EVIDENCE = path.join(TASK, "evidence");
const EMULATE = path.join(ROOT, "vendor/emulate");
const AUTH0 = path.join(EMULATE, "packages/@emulators/auth0");
const BASE_URL = "http://127.0.0.1:43872";
const NOW = 1_700_000_000;
const SEED = "electric-forest-e2-t02-v1";
const KID = "eforest-test-2026";
const CLIENT_ID = "eforest-client";
const CLIENT_SECRET = "eforest-secret";
const CALLBACK = "http://127.0.0.1:43873/callback";
const USER = {
  email: "alice@example.com",
  password: "Alice1234!",
  id: "alice",
  name: "Alice Example",
};
const VERIFIER = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const STATE = "state value&=%+#? hostile";
const NONCE = "e2-t02-nonce";
const EXPECTED_PIN = "82eb835947c97fcf6e0596a4377acbb01ca13ede";
const PRIVATE_JWK_SHA256 = "7ff64a83d9696aac4704c14dde2437c3da912f684919868d408d383a69b3537c";
const PUBLIC_JWK_SHA256 = "16df9f8d843e369d6f1951f9967bc834f00dca5b1a00742f902aeff1ceaa1a0a";

function writeEvidence(name, content) {
  fs.writeFileSync(path.join(EVIDENCE, name), content.endsWith("\n") ? content : `${content}\n`);
}

function s256(value) {
  return createHash("sha256").update(value).digest("base64url");
}

function normalize(value) {
  if (typeof value === "string") return value.replaceAll(BASE_URL, "{BASE_URL}");
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

function stableJsonLines(entries) {
  return `${entries.map((entry) => JSON.stringify(normalize(entry))).join("\n")}\n`;
}

function jsonBody(value) {
  return { headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}

function formBody(value) {
  return {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(value).toString(),
  };
}

async function recordedFetch(transcript, label, route, init = {}) {
  const url = new URL(route, BASE_URL);
  const response = await fetch(url, { redirect: "manual", ...init });
  const text = await response.text();
  const contentType = response.headers.get("content-type");
  const location = response.headers.get("location");
  const headers = {};
  if (contentType) headers["content-type"] = contentType;
  if (location) headers.location = location;
  transcript.push({
    label,
    request: {
      method: init.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      ...(init.headers ? { headers: Object.fromEntries(new Headers(init.headers)) } : {}),
      ...(init.body !== undefined ? { body: String(init.body) } : {}),
    },
    response: { status: response.status, headers, body: text },
  });
  return { response, text, json: contentType?.includes("json") ? JSON.parse(text) : undefined };
}

function authorizationParams(overrides = {}) {
  return {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK,
    scope: "openid profile email",
    audience: CLIENT_ID,
    code_challenge: s256(VERIFIER),
    code_challenge_method: "S256",
    state: STATE,
    nonce: NONCE,
    ...overrides,
  };
}

async function authorize(transcript, prefix = "auth") {
  const params = authorizationParams();
  const query = new URLSearchParams(params);
  const page = await recordedFetch(transcript, `${prefix}.authorize-page`, `/authorize?${query}`);
  assert.equal(page.response.status, 200);
  assert.match(page.text, /data-testid="auth0-login-form"/);
  const login = await recordedFetch(transcript, `${prefix}.authorize-submit`, "/authorize", {
    method: "POST",
    ...formBody({ ...params, email: USER.email, password: USER.password }),
  });
  assert.equal(login.response.status, 302);
  const location = new URL(login.response.headers.get("location"));
  assert.equal(location.searchParams.get("state"), STATE);
  assert.ok(location.searchParams.get("code"));
  return { code: location.searchParams.get("code"), params };
}

function tokenRequest(body) {
  return {
    method: "POST",
    ...jsonBody({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...body }),
  };
}

async function exchangeCode(transcript, label, code, overrides = {}) {
  return recordedFetch(
    transcript,
    label,
    "/oauth/token",
    tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
      ...overrides,
    }),
  );
}

async function pollDevice(transcript, label, deviceCode) {
  return recordedFetch(
    transcript,
    label,
    "/oauth/token",
    tokenRequest({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
    }),
  );
}

function signingConfig() {
  const privateBytes = fs.readFileSync(path.join(AUTH0, "fixtures/test-keypair.private.jwk.json"));
  const publicBytes = fs.readFileSync(path.join(AUTH0, "fixtures/test-keypair.public.jwk.json"));
  assert.equal(createHash("sha256").update(privateBytes).digest("hex"), PRIVATE_JWK_SHA256);
  assert.equal(createHash("sha256").update(publicBytes).digest("hex"), PUBLIC_JWK_SHA256);
  const privateJwk = JSON.parse(privateBytes);
  const publicJwk = JSON.parse(publicBytes);
  const privateKeyPem = createPrivateKey({ key: privateJwk, format: "jwk" }).export({
    format: "pem",
    type: "pkcs8",
  });
  const publicKeyPem = createPublicKey({ key: publicJwk, format: "jwk" }).export({
    format: "pem",
    type: "spki",
  });
  return {
    privateJwk,
    publicJwk,
    privateKeyPem: String(privateKeyPem),
    publicKeyPem: String(publicKeyPem),
  };
}

function emulatorOptions(ttl = {}) {
  const keys = signingConfig();
  return {
    service: "auth0",
    port: 43872,
    baseUrl: BASE_URL,
    now: NOW,
    seedMaterial: SEED,
    seed: {
      auth0: {
        now: NOW,
        seed: SEED,
        ...ttl,
        connections: [{ name: "Username-Password-Authentication" }],
        users: [
          {
            email: USER.email,
            password: USER.password,
            user_id: USER.id,
            email_verified: true,
            name: USER.name,
            given_name: "Alice",
            family_name: "Example",
          },
        ],
        oauth_clients: [
          {
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            redirect_uris: [CALLBACK],
            grant_types: ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code"],
            audience: CLIENT_ID,
          },
        ],
        signing_key: {
          private_key_pem: keys.privateKeyPem,
          public_key_pem: keys.publicKeyPem,
          kid: KID,
        },
      },
    },
  };
}

async function createEmulatorFactory() {
  const api = path.join(EMULATE, "packages/emulate/dist/api.js");
  assert.ok(fs.existsSync(api), "pinned emulate package must be built before the harness runs");
  const module = await import(`${pathToFileURL(api).href}?pin=${EXPECTED_PIN}`);
  return async (options) => {
    const emulator = await module.createEmulator(options);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return emulator;
  };
}

async function runGoldenFlows(createEmulator) {
  const emulator = await createEmulator(emulatorOptions());
  try {
    const authcode = [];
    const discovery = await recordedFetch(
      authcode,
      "auth.discovery",
      "/.well-known/openid-configuration",
    );
    assert.equal(discovery.response.status, 200);
    const jwks = await recordedFetch(authcode, "auth.jwks", "/.well-known/jwks.json");
    assert.equal(jwks.response.status, 200);
    const { code } = await authorize(authcode);
    const tokens = await exchangeCode(authcode, "auth.token", code);
    assert.equal(tokens.response.status, 200);

    emulator.reset();
    const device = [];
    const start = await recordedFetch(device, "device.start", "/oauth/device/code", {
      method: "POST",
      ...formBody({ client_id: CLIENT_ID, scope: "openid profile email", audience: CLIENT_ID }),
    });
    assert.equal(start.response.status, 200);
    const grant = start.json;
    const activationPage = await recordedFetch(
      device,
      "device.activation-page",
      grant.verification_uri_complete,
    );
    assert.equal(activationPage.response.status, 200);
    const pending = await pollDevice(device, "device.pending", grant.device_code);
    assert.equal(pending.response.status, 400);
    assert.equal(pending.json.error, "authorization_pending");
    const approval = await recordedFetch(device, "device.approve", "/activate", {
      method: "POST",
      ...formBody({
        user_code: grant.user_code,
        email: USER.email,
        password: USER.password,
        decision: "approve",
      }),
    });
    assert.equal(approval.response.status, 200);
    const deviceTokens = await pollDevice(device, "device.token", grant.device_code);
    assert.equal(deviceTokens.response.status, 200);
    return {
      authcode: stableJsonLines(authcode),
      device: stableJsonLines(device),
      tokens: tokens.json,
      deviceTokens: deviceTokens.json,
      jwks: jwks.json,
    };
  } finally {
    await emulator.close();
  }
}

function appendSecurity(entries, name, result) {
  const record = {
    case: name,
    status: result.response.status,
    body: result.json ?? result.text,
    location: result.response.headers.get("location"),
  };
  fs.appendFileSync(
    path.join(EVIDENCE, "e2-t02-security-transcript.jsonl"),
    `${JSON.stringify(record)}\n`,
  );
  entries.push(record);
  return record;
}

async function runSecurity(createEmulator) {
  fs.writeFileSync(path.join(EVIDENCE, "e2-t02-security-transcript.jsonl"), "");
  const entries = [];
  const emulator = await createEmulator(emulatorOptions());
  try {
    const plainQuery = new URLSearchParams(
      authorizationParams({ code_challenge: "plain", code_challenge_method: "plain" }),
    );
    const plain = await recordedFetch([], "security.pkce-plain", `/authorize?${plainQuery}`);
    assert.deepEqual(appendSecurity(entries, "pkce_plain", plain), {
      case: "pkce_plain",
      status: 400,
      body: { error: "invalid_request", error_description: "code_challenge_method must be S256" },
      location: null,
    });
    const missingParams = authorizationParams();
    delete missingParams.code_challenge;
    const missing = await recordedFetch(
      [],
      "security.pkce-missing",
      `/authorize?${new URLSearchParams(missingParams)}`,
    );
    assert.equal(appendSecurity(entries, "pkce_missing", missing).status, 400);
    assert.equal(missing.json.error, "invalid_request");
    assert.equal(missing.response.headers.get("location"), null);

    const wrongGrant = await authorize([], "security-wrong");
    const wrong = await exchangeCode([], "security.wrong-verifier", wrongGrant.code, {
      code_verifier: `${VERIFIER}x`,
    });
    assert.equal(appendSecurity(entries, "wrong_code_verifier", wrong).status, 400);
    assert.equal(wrong.json.error, "invalid_grant");
    assert.equal("access_token" in wrong.json, false);
    const mismatch = await exchangeCode([], "security.redirect-mismatch", wrongGrant.code, {
      redirect_uri: `${CALLBACK}/wrong`,
    });
    assert.equal(appendSecurity(entries, "redirect_uri_mismatch", mismatch).status, 400);
    assert.equal(mismatch.json.error, "invalid_grant");
    const correct = await exchangeCode([], "security.correct-exchange", wrongGrant.code);
    assert.equal(correct.response.status, 200);
    const reused = await exchangeCode([], "security.code-reuse", wrongGrant.code);
    assert.equal(appendSecurity(entries, "authorization_code_reuse", reused).status, 400);
    assert.equal(reused.json.error, "invalid_grant");

    const fabricated = await pollDevice([], "security.fabricated", "fabricated-device-code");
    assert.equal(appendSecurity(entries, "fabricated_device_code", fabricated).status, 400);
    assert.equal(fabricated.json.error, "invalid_grant");
    const start = await recordedFetch([], "security.device-start", "/oauth/device/code", {
      method: "POST",
      ...formBody({ client_id: CLIENT_ID }),
    });
    const pending = await pollDevice([], "security.device-pending", start.json.device_code);
    assert.equal(appendSecurity(entries, "device_authorization_pending", pending).status, 400);
    assert.equal(pending.json.error, "authorization_pending");
    const denied = await recordedFetch([], "security.device-deny", "/activate", {
      method: "POST",
      ...formBody({ user_code: start.json.user_code, decision: "deny" }),
    });
    assert.equal(denied.response.status, 200);
    const deniedPoll = await pollDevice([], "security.device-denied-poll", start.json.device_code);
    assert.equal(appendSecurity(entries, "device_access_denied", deniedPoll).status, 403);
    assert.equal(deniedPoll.json.error, "access_denied");
  } finally {
    await emulator.close();
  }

  const expiredEmulator = await createEmulator(
    emulatorOptions({ authorization_code_ttl_seconds: 0, device_code_ttl_seconds: 0 }),
  );
  try {
    const expiredGrant = await authorize([], "security-expired");
    const expired = await exchangeCode([], "security.expired-code", expiredGrant.code);
    assert.equal(appendSecurity(entries, "expired_authorization_code", expired).status, 400);
    assert.equal(expired.json.error, "expired_token");
    expiredEmulator.reset();
    const expiredDeviceStart = await recordedFetch(
      [],
      "security.expired-device-start",
      "/oauth/device/code",
      {
        method: "POST",
        ...formBody({ client_id: CLIENT_ID }),
      },
    );
    const expiredDevicePoll = await pollDevice(
      [],
      "security.expired-device-poll",
      expiredDeviceStart.json.device_code,
    );
    assert.equal(appendSecurity(entries, "expired_device_code", expiredDevicePoll).status, 400);
    assert.equal(expiredDevicePoll.json.error, "expired_token");
  } finally {
    await expiredEmulator.close();
  }
  return entries;
}

async function runRestartIsolation(createEmulator) {
  const first = await createEmulator(emulatorOptions());
  let deviceCode;
  try {
    const start = await recordedFetch([], "restart.device-start", "/oauth/device/code", {
      method: "POST",
      ...formBody({ client_id: CLIENT_ID }),
    });
    deviceCode = start.json.device_code;
  } finally {
    await first.close();
  }
  const second = await createEmulator(emulatorOptions());
  try {
    const stale = await pollDevice([], "restart.stale-poll", deviceCode);
    assert.equal(stale.response.status, 400);
    assert.equal(stale.json.error, "invalid_grant");
  } finally {
    await second.close();
  }
}

function installNetworkGuard() {
  const originalConnect = net.Socket.prototype.connect;
  const originalFetch = globalThis.fetch;
  const originalDispatcher = getGlobalDispatcher();
  const loopbackConnector = buildConnector({});
  let trips = 0;
  let connectorCalls = 0;
  const isLoopback = (host) => host === "127.0.0.1" || host === "::1" || host === "localhost";
  const guardedDispatcher = new UndiciAgent({
    connect(options, callback) {
      connectorCalls += 1;
      const host = options.hostname ?? options.host ?? "localhost";
      if (!isLoopback(host)) {
        trips += 1;
        callback(new Error(`external undici connection denied: ${host}`), null);
        return;
      }
      loopbackConnector(options, callback);
    },
  });
  setGlobalDispatcher(guardedDispatcher);
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const options = typeof args[0] === "object" ? args[0] : {};
    const host =
      options.host ?? options.hostname ?? (typeof args[1] === "string" ? args[1] : "localhost");
    if (!isLoopback(host)) {
      trips += 1;
      throw new Error(`external network denied: ${host}`);
    }
    return originalConnect.apply(this, args);
  };
  globalThis.fetch = function guardedFetch(input, init) {
    const url = new URL(input instanceof Request ? input.url : input);
    if (!isLoopback(url.hostname)) {
      trips += 1;
      throw new Error(`external fetch denied: ${url.hostname}`);
    }
    return originalFetch(input, init);
  };
  return {
    get trips() {
      return trips;
    },
    get connectorCalls() {
      return connectorCalls;
    },
    async restore() {
      net.Socket.prototype.connect = originalConnect;
      globalThis.fetch = originalFetch;
      setGlobalDispatcher(originalDispatcher);
      await guardedDispatcher.close();
    },
  };
}

function resolveLocalImportGraph(entry) {
  const visited = new Set();
  const pending = [path.resolve(entry)];
  while (pending.length > 0) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const source = fs.readFileSync(current, "utf8");
    const specifiers = [
      ...source.matchAll(/(?:^|\n)\s*import(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["']/g),
      ...source.matchAll(/import\(["']([^"']+)["']\)/g),
    ].map((match) => match[1]);
    for (const specifier of specifiers) {
      if (specifier.startsWith("node:")) continue;
      assert.ok(
        specifier.startsWith("."),
        `verifier import graph contains non-platform package: ${specifier}`,
      );
      const unresolved = path.resolve(path.dirname(current), specifier);
      const resolved = [unresolved, `${unresolved}.mjs`, `${unresolved}.js`].find((candidate) =>
        fs.existsSync(candidate),
      );
      assert.ok(resolved, `cannot resolve verifier import: ${specifier}`);
      pending.push(resolved);
    }
  }
  return [...visited].sort();
}

function installFsAudit() {
  const allowedExact = new Set([
    path.join(EVIDENCE, "e2-t02-security-transcript.jsonl"),
    path.join(EVIDENCE, "e2-t02-fs-audit.txt"),
  ]);
  const allowedRoots = [path.resolve(os.tmpdir()), path.join(TASK, "work")];
  let trips = 0;
  const originals = [];
  const check = (candidate) => {
    if (typeof candidate !== "string" && !Buffer.isBuffer(candidate) && !(candidate instanceof URL))
      return;
    const resolved = path.resolve(
      candidate instanceof URL ? fileURLToPath(candidate) : String(candidate),
    );
    if (
      allowedExact.has(resolved) ||
      allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))
    )
      return;
    trips += 1;
    throw new Error(`filesystem write outside E2-T02 allowlist: ${resolved}`);
  };
  const patchMethod = (object, name, position = 0) => {
    const original = object[name];
    if (typeof original !== "function") return;
    originals.push(() => {
      object[name] = original;
    });
    object[name] = function auditedWrite(...args) {
      check(args[position]);
      return original.apply(this, args);
    };
  };
  for (const name of [
    "writeFileSync",
    "appendFileSync",
    "truncateSync",
    "mkdirSync",
    "rmSync",
    "unlinkSync",
    "renameSync",
    "copyFileSync",
    "createWriteStream",
  ])
    patchMethod(fs, name);
  for (const name of [
    "writeFile",
    "appendFile",
    "truncate",
    "mkdir",
    "rm",
    "unlink",
    "rename",
    "copyFile",
  ])
    patchMethod(fs.promises, name);
  return {
    get trips() {
      return trips;
    },
    restore() {
      for (const restore of originals.reverse()) restore();
    },
  };
}

function assertGolden(name, actual) {
  const file = path.join(EVIDENCE, name);
  assert.ok(fs.existsSync(file), `committed golden missing: ${name}`);
  assert.equal(actual, fs.readFileSync(file, "utf8"), `${name} differs from the pinned transcript`);
}

function assertSubmodulePin() {
  const gitmodules = fs.readFileSync(path.join(ROOT, ".gitmodules"), "utf8");
  assert.match(gitmodules, /path = vendor\/emulate/);
  assert.match(gitmodules, /url = https:\/\/github\.com\/blamy\/emulate\.git/);
  const head = fs.readFileSync(path.join(EMULATE, ".git"), "utf8");
  assert.ok(head.includes("gitdir:"), "vendor/emulate must be an initialized submodule worktree");
  const revision = spawnSync("git", ["-C", EMULATE, "rev-parse", "HEAD"], { encoding: "utf8" });
  assert.equal(revision.status, 0);
  assert.equal(revision.stdout.trim(), EXPECTED_PIN);
}

async function main() {
  const blackholeProxy = "http://127.0.0.1:1";
  assert.equal(process.env.HTTP_PROXY, blackholeProxy);
  assert.equal(process.env.HTTPS_PROXY, blackholeProxy);
  assert.equal(process.env.http_proxy, blackholeProxy);
  assert.equal(process.env.https_proxy, blackholeProxy);
  fs.mkdirSync(EVIDENCE, { recursive: true });
  assertSubmodulePin();
  const createEmulator = await createEmulatorFactory();
  const network = installNetworkGuard();
  const audit = installFsAudit();
  let first;
  let second;
  let security;
  try {
    first = await runGoldenFlows(createEmulator);
    second = await runGoldenFlows(createEmulator);
    security = await runSecurity(createEmulator);
    await runRestartIsolation(createEmulator);
    fs.writeFileSync(
      path.join(EVIDENCE, "e2-t02-fs-audit.txt"),
      `outside_allowlist_write_count=${audit.trips}\n`,
    );
  } finally {
    audit.restore();
    await network.restore();
  }
  assert.equal(audit.trips, 0);
  assert.equal(network.trips, 0);
  assert.ok(network.connectorCalls > 0, "undici connector guard must observe loopback traffic");
  assert.deepEqual(first, second, "two fixed now/seed runs must be byte-identical");
  assertGolden("golden-authcode-transcript.jsonl", first.authcode);
  assertGolden("golden-device-transcript.jsonl", first.device);

  const committedJwk = signingConfig().publicJwk;
  assert.deepEqual(
    first.jwks.keys[0],
    committedJwk,
    "served JWKS must equal the committed public JWK",
  );
  const expected = {
    kid: KID,
    claims: {
      iss: `${BASE_URL}/`,
      sub: `auth0|${USER.id}`,
      aud: CLIENT_ID,
      iat: NOW,
      exp: NOW + 3600,
    },
  };
  const id = inspectAndVerifyJwt(first.tokens.id_token, first.jwks, expected);
  const access = inspectAndVerifyJwt(first.tokens.access_token, first.jwks, expected);
  assert.equal(id.payload.email, USER.email);
  assert.equal(id.payload.name, USER.name);
  assert.equal(id.payload.nonce, NONCE);
  assert.throws(
    () => inspectAndVerifyJwt(mutateSignature(first.tokens.id_token), first.jwks, expected),
    /signature verification failed/,
  );

  const verifierEntry = path.join(ROOT, "tools/verify/e2_t02_jwt_verify.mjs");
  const verifierGraph = resolveLocalImportGraph(verifierEntry);
  const verifierGraphRelative = verifierGraph.map((file) => path.relative(ROOT, file));
  const verifierGrepArgs = [
    "grep",
    "-n",
    "-E",
    "vendor/emulate|@emulators/auth0",
    "--",
    ...verifierGraphRelative,
  ];
  const verifierGrep = spawnSync("git", verifierGrepArgs, { cwd: ROOT, encoding: "utf8" });
  assert.equal(verifierGrep.status, 1);
  assert.equal(verifierGrep.stdout, "");
  const verifierGrepCommand = `git ${verifierGrepArgs
    .map((value) => `'${value.replaceAll("'", "'\\''")}'`)
    .join(" ")}`;

  writeEvidence(
    "e2-t02-jwt-verification.txt",
    [
      `verifier_import_graph=${verifierGraphRelative.join(",")}`,
      `grep_command=${verifierGrepCommand}`,
      `grep_exit=${verifierGrep.status}`,
      `grep_stdout_bytes=${Buffer.byteLength(verifierGrep.stdout)}`,
      `served_jwks_matches_fixture=true`,
      `kid=${KID}`,
      `id_token_rs256=valid`,
      `access_token_rs256=valid`,
      `tampered_id_token_rs256=rejected`,
      `iat=${id.payload.iat}`,
      `exp=${id.payload.exp}`,
    ].join("\n"),
  );
  writeEvidence(
    "e2-t02-determinism.txt",
    [
      "runs=2",
      "authcode_transcript_diff=empty",
      "device_transcript_diff=empty",
      "id_token_diff=empty",
      "access_token_diff=empty",
      `iat=${access.payload.iat}`,
      `exp=${access.payload.exp}`,
      `expected_iat=${NOW}`,
      `expected_exp=${NOW + 3600}`,
    ].join("\n"),
  );
  writeEvidence(
    "e2-t02-network-guard.txt",
    [
      "global_fetch_guard_installed=true",
      "undici_global_dispatcher_connector_guard_installed=true",
      "net_socket_connect_guard_installed=true",
      "whole_target_proxy_blackhole_asserted=true",
      `undici_connector_call_count=${network.connectorCalls}`,
      `external_trip_count=${network.trips}`,
    ].join("\n"),
  );
  const productionGrep = spawnSync(
    "git",
    ["grep", "-n", "-E", "vendor/emulate|@emulators/auth0", "--", "packages/*/src", "apps/*/src"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(productionGrep.status, 1);
  assert.equal(productionGrep.stdout, "");
  writeEvidence(
    "e2-t02-isolation.txt",
    [
      `expected_submodule_pin=${EXPECTED_PIN}`,
      "submodule_initialized=true",
      "production_src_grep_command=git grep -n -E 'vendor/emulate|@emulators/auth0' -- 'packages/*/src' 'apps/*/src'",
      `production_src_grep_exit=${productionGrep.status}`,
      "restart_stale_device_poll_status=400",
      "restart_stale_device_poll_error=invalid_grant",
      `security_cases=${security.length}`,
    ].join("\n"),
  );
  console.log(
    `E2_T02_AUTH0_OK authcode_lines=${first.authcode.trimEnd().split("\n").length} device_lines=${first.device.trimEnd().split("\n").length} security_cases=${security.length} network_trips=${network.trips} fs_write_trips=${audit.trips}`,
  );
}

await main();
