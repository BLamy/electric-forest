#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URLSearchParams } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(root, "packages/cli/dist/src/bin.js");
const emulateCorePath = join(root, "vendor/emulate/packages/@emulators/core/dist/index.js");
const auth0Root = join(root, "vendor/emulate/packages/@emulators/auth0");
const auth0Path = join(auth0Root, "dist/index.js");
const platformPath = join(root, "packages/platform/dist/src/index.js");
const serverPath = join(root, "packages/server/dist/src/index.js");
const streamFsPath = join(root, "packages/streamfs/dist/src/index.js");

const issuer = "http://auth0.e4-t03.test";
const audience = "eforest-api";
const clientId = "eforest-e4-t03";
const clientSecret = "eforest-e4-t03-secret";
const callback = "http://client.e4-t03.test/callback";
const password = "E4T03Auth1234!";
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const nowSeconds = 1_700_000_000;
const users = [
  ["maple-admin", "auth0|e4-t03-maple-admin"],
  ["maple-member", "auth0|e4-t03-maple-member"],
  ["willow-member", "auth0|e4-t03-willow-member"],
];

function streamUrl(baseUrl, streamId, suffix = "") {
  return `${baseUrl}/streams/${encodeURIComponent(streamId)}${suffix}`;
}

function signingConfig() {
  const privateJwk = JSON.parse(
    readFileSync(join(auth0Root, "fixtures/test-keypair.private.jwk.json"), "utf8"),
  );
  const publicJwk = JSON.parse(
    readFileSync(join(auth0Root, "fixtures/test-keypair.public.jwk.json"), "utf8"),
  );
  const privateKey = createPrivateKey({ key: privateJwk, format: "jwk" });
  return {
    privateKeyPem: String(privateKey.export({ format: "pem", type: "pkcs8" })),
    publicKeyPem: String(
      createPublicKey({ key: publicJwk, format: "jwk" }).export({
        format: "pem",
        type: "spki",
      }),
    ),
  };
}

function emulatorOptions(port) {
  const signing = signingConfig();
  return {
    service: "auth0",
    port,
    baseUrl: issuer,
    now: nowSeconds,
    seedMaterial: "electric-forest-e4-t03-auth-v1",
    seed: {
      auth0: {
        now: nowSeconds,
        seed: "electric-forest-e4-t03-auth-v1",
        connections: [{ name: "Username-Password-Authentication" }],
        users: users.map(([name, userId]) => ({
          email: `${name}@example.test`,
          password,
          user_id: userId.replace(/^auth0\|/, ""),
          email_verified: true,
          name: `E4-T03 ${name}`,
        })),
        oauth_clients: [
          {
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uris: [callback],
            grant_types: ["authorization_code"],
            audience,
          },
        ],
        signing_key: {
          private_key_pem: signing.privateKeyPem,
          public_key_pem: signing.publicKeyPem,
          kid: "eforest-e4-t03-2026",
        },
      },
    },
  };
}

async function issueToken(emulatorUrl, name) {
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const login = await fetch(`${emulatorUrl}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: callback,
      scope: "openid profile email",
      audience,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: `e4-t03-${name}`,
      nonce: `e4-t03-${name}`,
      email: `${name}@example.test`,
      password,
    }),
  });
  assert.equal(login.status, 302, `authorize ${name}`);
  const location = login.headers.get("location");
  assert.ok(location, `authorize redirect ${name}`);
  const code = new URL(location).searchParams.get("code");
  assert.ok(code, `authorize code ${name}`);
  const response = await fetch(`${emulatorUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: callback,
      code_verifier: verifier,
    }),
  });
  assert.equal(response.status, 200, `token ${name}`);
  const body = await response.json();
  assert.equal(typeof body.access_token, "string");
  return body.access_token;
}

function runEf(args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

async function writeCredentials(home, accessToken) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(
    join(home, "credentials.json"),
    `${JSON.stringify({
      accessToken,
      tokenType: "Bearer",
      issuer: `${issuer}/`,
      clientId,
      scopes: [],
    })}\n`,
    { mode: 0o600 },
  );
}

async function listenProxy(handler) {
  const server = createServer((request, response) => {
    void handler(request, response).catch((error) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function proxyStreamRequest(request, response, platformUrl, officialUrl) {
  const url = new URL(request.url ?? "/", "http://proxy.e4-t03.test");
  if (request.method !== "GET" || !url.pathname.startsWith("/streams/")) {
    response.writeHead(404);
    response.end();
    return;
  }
  const encoded = url.pathname.slice("/streams/".length).replace(/\/dump$/, "");
  const streamId = decodeURIComponent(encoded);
  const match = /^fs:([^/]+)\/([^:]+):([^:]+)(?::.*)?$/.exec(streamId);
  if (match === null) {
    response.writeHead(404);
    response.end();
    return;
  }
  const [, org, repo, branch] = match;
  const authorization = request.headers.authorization;
  const auth = await fetch(
    `${platformUrl}/api/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/events`,
    { headers: authorization === undefined ? {} : { authorization } },
  );
  if (!auth.ok) {
    const body = Buffer.from(await auth.arrayBuffer());
    response.writeHead(auth.status, {
      "content-type": auth.headers.get("content-type") ?? "application/json",
    });
    response.end(body);
    return;
  }
  const upstream = await fetch(
    `${officialUrl}/streams/${encodeURIComponent(streamId)}${url.search}`,
  );
  const body = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
  });
  response.end(body);
}

async function streamBodies(baseUrl, streamIds) {
  const result = [];
  for (const streamId of [...new Set(streamIds)].sort()) {
    const response = await fetch(streamUrl(baseUrl, streamId));
    assert.equal(response.status, 200, `read-only auth probe ${streamId}`);
    result.push([streamId, await response.text()]);
  }
  return result;
}

const emulateCore = await import(`${pathToFileURL(emulateCorePath).href}?e4-t03-auth`);
const auth0 = await import(`${pathToFileURL(auth0Path).href}?e4-t03-auth`);
const platform = await import(`${pathToFileURL(platformPath).href}?e4-t03-auth`);
const serverModule = await import(`${pathToFileURL(serverPath).href}?e4-t03-auth`);
const streamFs = await import(`${pathToFileURL(streamFsPath).href}?e4-t03-auth`);

const work = mkdtempSync(join(tmpdir(), "eforest-e4-t03-auth-"));
const emulatorPort = await new Promise((resolvePort, rejectPort) => {
  const probe = createServer();
  probe.once("error", rejectPort);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    assert.ok(address && typeof address === "object");
    const port = address.port;
    probe.close(() => resolvePort(port));
  });
});
const emulatorUrl = `http://127.0.0.1:${emulatorPort}`;
const auth0Options = emulatorOptions(emulatorPort);
const emulator = emulateCore.createServer(auth0.auth0Plugin, {
  port: emulatorPort,
  baseUrl: issuer,
});
auth0.auth0Plugin.seed?.(emulator.store, issuer);
auth0.seedFromConfig(emulator.store, issuer, auth0Options.seed.auth0);
const emulatorServer = emulateCore.serve({
  fetch: emulator.app.fetch,
  port: emulatorPort,
  hostname: "127.0.0.1",
});
const createdStreams = new Set();
const official = serverModule.createDurableStreamTestServer({
  host: "127.0.0.1",
  port: 0,
  onStreamCreated: ({ path }) =>
    createdStreams.add(decodeURIComponent(path.replace(/^\/streams\//, ""))),
});
let platformServer;
let namespaces;
let proxy;
try {
  const officialUrl = await official.start();
  const streams = new platform.OfficialStreamAdapter({ baseUrl: officialUrl });
  namespaces = new platform.NamespaceDispatcher(streams);
  const identity = new platform.IdentityStore({
    baseUrl: officialUrl,
    now: () => nowSeconds * 1000,
    recoverNamespaceOperation: (operationId, operation) =>
      namespaces.recover(operationId, operation.streamId, operation.event),
  });
  await identity.ensure();
  await namespaces.reconcile();
  const issuerFetch = async (input, init) => {
    const requested = new URL(input instanceof Request ? input.url : String(input));
    if (requested.origin === issuer) {
      return fetch(new URL(requested.pathname + requested.search, emulatorUrl), init);
    }
    return fetch(input, init);
  };
  const bearer = new platform.BearerVerifier({
    issuer: `${issuer}/`,
    audience,
    now: () => nowSeconds * 1000,
    fetch: issuerFetch,
  });
  const verifier = new platform.GrantAwareVerifier({ bearer, identity });
  const handler = platform.createPlatformHandler({ verifier, streams, namespaces });
  platformServer = platform.createPlatformServer(handler);
  const platformUrl = await platform.listenPlatformServer(platformServer);

  const tokens = Object.fromEntries(
    await Promise.all(users.map(async ([name]) => [name, await issueToken(emulatorUrl, name)])),
  );
  const subjects = Object.fromEntries(users);
  for (const [name, sub] of users) {
    await identity.ensureUser(sub, `${name}@example.test`);
    await identity.issueCliGrant({
      grantId: `e4-t03-grant-${name}`,
      sub,
      tokenKind: "device",
      tokenHash: platform.tokenHash(tokens[name]),
      scopes:
        name === "maple-member"
          ? ["repo:read:maple/secret-garden"]
          : name === "maple-admin"
            ? ["repo:write:maple/secret-garden:main"]
            : [],
    });
  }
  await identity.createOrg("maple", "maple", subjects["maple-admin"]);
  await identity.createOrg("willow", "willow", subjects["willow-member"]);
  await identity.grantMembership("maple", subjects["maple-member"], "member");

  async function dispatch(streamId, event, token) {
    const result = await fetch(`${platformUrl}/api/dispatch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ streamId, event }),
    });
    assert.equal(result.status, 202, `${event.type}: ${await result.text()}`);
  }
  await dispatch(
    "ns:root",
    { type: "ns.org.create", payload: { v: 1, name: "maple" }, ts: 1 },
    tokens["maple-admin"],
  );
  await dispatch(
    "ns:org:maple",
    { type: "ns.project.create", payload: { v: 1, name: "canopy" }, ts: 2 },
    tokens["maple-admin"],
  );
  await dispatch(
    "ns:org:maple",
    {
      type: "ns.repo.create",
      payload: { v: 1, name: "reading-room", project: "canopy", visibility: "public" },
      ts: 3,
    },
    tokens["maple-admin"],
  );
  await dispatch(
    "ns:org:maple",
    {
      type: "ns.repo.create",
      payload: { v: 1, name: "secret-garden", project: "canopy", visibility: "private" },
      ts: 4,
    },
    tokens["maple-admin"],
  );
  await namespaces.reconcile();

  const publicMetadata = "fs:maple/reading-room:main:meta";
  const privateMetadata = "fs:maple/secret-garden:main:meta";
  await streams.create(publicMetadata);
  await streams.create(privateMetadata);
  const publicRepo = new streamFs.StreamFsRepo(officialUrl, fetch, "maple/reading-room");
  const privateRepo = new streamFs.StreamFsRepo(officialUrl, fetch, "maple/secret-garden");
  await publicRepo.createFile("README.md", Buffer.from("public through the real auth door\n"));
  await privateRepo.createFile("README.md", Buffer.from("private through the real auth door\n"));
  await namespaces.reconcile();

  proxy = await listenProxy((request, response) =>
    proxyStreamRequest(request, response, platformUrl, officialUrl),
  );
  const baseEnv = {
    EF_SERVER: platformUrl,
    EF_STREAM_SERVER_URL: proxy.url,
  };
  const publicHome = join(work, "public-home");
  const publicTarget = join(work, "public");
  const publicResult = await runEf(["clone", "maple/reading-room", "main", publicTarget], {
    ...baseEnv,
    EF_HOME: publicHome,
  });
  assert.equal(publicResult.status, 0, publicResult.stderr);
  assert.match(publicResult.stdout, /^checkpoint [0-9]+_[0-9]+\n[0-9a-f]{64}\n$/);

  const willowHome = join(work, "willow-home");
  await writeCredentials(willowHome, tokens["willow-member"]);
  const willowTarget = join(work, "willow-private");
  const willowResult = await runEf(["clone", "maple/secret-garden", "main", willowTarget], {
    ...baseEnv,
    EF_HOME: willowHome,
  });
  assert.equal(willowResult.status, 1);
  assert.match(willowResult.stderr, /^EREFUSED:/);
  assert.equal(willowResult.stdout, "");
  assert.equal((await import("node:fs")).existsSync(willowTarget), false);

  const mapleHome = join(work, "maple-home");
  await writeCredentials(mapleHome, tokens["maple-member"]);
  const mapleTarget = join(work, "maple-private");
  const before = await streamBodies(
    officialUrl,
    [...createdStreams].filter((id) => id.startsWith("fs:maple/")),
  );
  const mapleResult = await runEf(["clone", "maple/secret-garden", "main", mapleTarget], {
    ...baseEnv,
    EF_HOME: mapleHome,
  });
  assert.equal(mapleResult.status, 0, mapleResult.stderr);
  assert.deepEqual(
    await readFile(join(mapleTarget, "README.md")),
    Buffer.from("private through the real auth door\n"),
  );
  const after = await streamBodies(
    officialUrl,
    [...createdStreams].filter((id) => id.startsWith("fs:maple/")),
  );
  assert.deepEqual(after, before, "authorized/refused clones changed the source streams");

  process.stdout.write(
    `E4_T03_AUTH_OK public=tokenless private=maple-member refused=willow-member streams=${createdStreams.size}\n`,
  );
} finally {
  if (proxy !== undefined) await new Promise((resolveClose) => proxy.server.close(resolveClose));
  namespaces?.terminate();
  if (platformServer !== undefined) {
    await new Promise((resolveClose) => platformServer.close(resolveClose));
  }
  await Promise.allSettled([
    new Promise((resolveClose) => emulatorServer.close(resolveClose)),
    official.stop(),
  ]);
  await rm(work, { recursive: true, force: true });
}
