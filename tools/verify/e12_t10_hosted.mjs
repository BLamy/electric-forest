#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";
import { HOSTED_LIMITS } from "../../packages/platform/dist/src/hosted.js";
import { createHostedRuntime } from "../../packages/platform/dist/src/hosted.js";
import { hostedArtifact } from "../../packages/platform/dist/src/hosted-artifact.js";
import { createHostedFixture, PEOPLE, readJson, root, task } from "./e12_t10_fixture.mjs";

const output = resolve(process.argv[2] ?? resolve(task, "work/http"));
await mkdir(output, { recursive: true });
const world = await createHostedFixture(output, { requestDeadlineMs: 1000 });
const records = [];
const dumps = [];
const authority = [
  "__identity__",
  "ns:root",
  "ns:org:private-ada",
  "ns:org:private-grace",
  "chat:private-ada/welcome",
  "fs:private-ada/notebook:main:meta",
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function request(path, init = {}) {
  return fetch(`${world.baseUrl}${path}`, { redirect: "manual", ...init });
}
async function neutral(name, work, expected) {
  const before = await world.heads(authority);
  const response = await work();
  assert.ok(
    (Array.isArray(expected) ? expected : [expected]).includes(response.status),
    `${name}: ${response.status} ${await response.clone().text()}`,
  );
  const after = await world.heads(authority);
  assert.deepEqual(after, before, `${name}: refusal appended an event`);
  records.push({ name, status: response.status, before, after });
  return response;
}
async function dispatch(cookie, streamId, type, payload, extra = {}) {
  const response = await request("/api/dispatch", {
    method: "POST",
    headers: { cookie, origin: world.origin, "content-type": "application/json", ...extra },
    body: JSON.stringify({ streamId, event: { type, payload, ts: 1800000000000 } }),
  });
  assert.equal(response.status, 202, `${type}: ${await response.clone().text()}`);
  return response;
}
async function raw(data) {
  return new Promise((done, reject) => {
    const socket = connect(Number(new URL(world.baseUrl).port), "127.0.0.1");
    let bytes = "";
    socket.on("connect", () => socket.write(data));
    socket.on("data", (chunk) => {
      bytes += chunk.toString();
    });
    socket.on("end", () => done(bytes));
    socket.on("error", reject);
    socket.setTimeout(4000, () => {
      socket.destroy();
      reject(new Error("raw socket sensor timed out"));
    });
  });
}
function cookiesSafe(response) {
  const values = response.headers.getSetCookie();
  assert.ok(values.length >= 2);
  for (const value of values) {
    assert.match(value, /; HttpOnly/);
    assert.match(value, /; SameSite=Lax/);
    assert.match(value, /; Secure/);
    assert.match(value, /; Path=\/(?:auth)?;/);
    assert.doesNotMatch(value, /eyJ|fixture-provider-access-canary|code_verifier/);
  }
  return values.map((value) => ({
    name: value.split("=")[0],
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    path: /; Path=([^;]+)/.exec(value)[1],
    maxAge: /; Max-Age=([^;]+)/.exec(value)[1],
  }));
}
try {
  const startup = await mkdtemp(resolve(output, "startup-"));
  const webRoot = resolve(startup, "web");
  await cp(world.environment.EF_WEB_ROOT, webRoot, { recursive: true });
  const artifactPath = resolve(startup, "artifact.json");
  await writeFile(
    artifactPath,
    JSON.stringify(await hostedArtifact(root, webRoot, world.environment.EF_BUILD_REVISION)),
  );
  const configured = {
    ...world.environment,
    EF_WEB_ROOT: webRoot,
    EF_DATA_DIR: resolve(startup, "valid-private"),
  };
  const initialRuntime = await createHostedRuntime(configured, { artifactPath });
  await initialRuntime.start();
  assert.equal(initialRuntime.server.address().address, "0.0.0.0");
  assert.equal((await initialRuntime.identity.snapshot()).events.length, 0);
  const markerBefore = await readFile(resolve(configured.EF_DATA_DIR, "hosted-state.json"));
  const keyBefore = await readFile(resolve(configured.EF_DATA_DIR, "session.key"));
  const removed = await fetch(`${initialRuntime.streamUrl}/streams/__identity__`, {
    method: "DELETE",
  });
  assert.ok(removed.ok);
  await initialRuntime.close();
  await assert.rejects(createHostedRuntime(configured, { artifactPath }), /incomplete/);
  assert.deepEqual(
    await readFile(resolve(configured.EF_DATA_DIR, "hosted-state.json")),
    markerBefore,
  );
  assert.deepEqual(await readFile(resolve(configured.EF_DATA_DIR, "session.key")), keyBefore);
  records.push({
    name: "ready-volume-missing-authority-refuses-before-ensure",
    markerUnchanged: true,
    keyUnchanged: true,
  });
  const notCreated = resolve(startup, "refused-private");
  const refusalEnv = { ...configured, EF_DATA_DIR: notCreated };
  await assert.rejects(
    createHostedRuntime({ ...refusalEnv, EF_BUILD_REVISION: "b".repeat(40) }, { artifactPath }),
    /revision/,
  );
  const index = resolve(webRoot, "index.html");
  const indexBefore = await readFile(index);
  await writeFile(
    index,
    Buffer.concat([indexBefore, Buffer.from("\n<!-- one-byte fixture corruption -->")]),
  );
  await assert.rejects(createHostedRuntime(refusalEnv, { artifactPath }), /source\/assets/);
  await writeFile(index, indexBefore);
  await assert.rejects(
    createHostedRuntime(
      { ...refusalEnv, EF_WEB_ROOT: resolve(startup, "missing-assets") },
      { artifactPath },
    ),
  );
  await assert.rejects(stat(notCreated));
  records.push({
    name: "bad-revision-altered-missing-assets-refuse-before-store-and-listen",
    privateDirectoryCreated: false,
  });
  assert.deepEqual(await world.heads(), {
    __identity__: { count: 0, sha256: digest("") },
    "ns:root": { count: 0, sha256: digest("") },
  });
  for (const path of ["/healthz", "/readyz", "/api/build", "/api/deployment"]) {
    const body = await readJson(await request(path), 200);
    assert.equal(body.auth, "auth0");
    assert.equal(body.mode, "production");
    assert.equal(body.data, "private");
    assert.equal(body.agents, "off");
    assert.equal(body.integrations, "off");
    assert.equal(body.limits.maxBodyBytes, HOSTED_LIMITS.maxBodyBytes);
    assert.deepEqual(body.limits.http, {
      headersTimeout: 1000,
      requestTimeout: 1000,
      connectionsCheckingInterval: 100,
      keepAliveTimeout: 1000,
    });
    records.push({
      name: path,
      revision: body.revision,
      artifactDigest: body.artifactDigest,
      limits: body.limits,
    });
  }
  const deep = await request("/settings/cli-tokens");
  assert.equal(deep.status, 302);
  assert.equal(deep.headers.get("location"), "/auth/login?next=%2Fsettings%2Fcli-tokens");
  assert.equal((await request("/")).headers.get("referrer-policy"), "same-origin");
  assert.equal(deep.headers.get("referrer-policy"), "same-origin");
  assert.equal((await request("/auth/login")).headers.get("referrer-policy"), "no-referrer");
  for (const next of [
    "https://evil.invalid/",
    "//evil.invalid/auth/callback",
    "/%2f%2fevil.invalid",
    "/%252f%252fevil.invalid",
    "/\\evil.invalid",
    "/x/..//evil.invalid/auth/callback",
  ]) {
    const tx = await world.begin(next, {
      host: "evil.invalid",
      forwarded: "host=evil.invalid;proto=http",
      "x-forwarded-host": "evil.invalid",
      "x-forwarded-proto": "http",
    });
    assert.equal(
      tx.authorization.searchParams.get("redirect_uri"),
      `${world.origin}/auth/callback`,
    );
  }
  const wire = await new Promise((done, reject) => {
    httpRequest(
      world.baseUrl,
      {
        path: "/x/..//evil.invalid/auth/callback?state=x&code=y",
        headers: { host: "evil.invalid", "x-forwarded-proto": "http" },
      },
      (response) => {
        response.resume();
        response.on("end", () =>
          done({ status: response.statusCode, location: response.headers.location ?? null }),
        );
      },
    )
      .on("error", reject)
      .end();
  });
  assert.equal(wire.status, 400);
  assert.ok(wire.location === null || !wire.location.includes("evil.invalid"));
  records.push({ name: "normalized-double-slash-target", ...wire });
  for (const path of [
    "/streams/__identity__",
    "/%73treams/__identity__",
    "/%2573treams/__identity__",
    "/admin",
    "/__admin",
    "/.env",
    "/.git/config",
    "/__proof/e3-t02",
    "/auth/preview",
  ]) {
    await neutral(`private-route ${path}`, () => request(path), 404);
  }
  await neutral(
    "hosted-device-refused",
    () => request("/api/device-grants", { method: "POST", headers: { origin: world.origin } }),
    403,
  );
  const attacker = await world.begin();
  const victim = await world.begin();
  await neutral(
    "cross-browser-callback-transplant",
    async () => (await world.callback(attacker, "ada", {}, victim.binding)).response,
    400,
  );
  await neutral(
    "missing-browser-cookie",
    async () => (await world.callback(attacker, "ada", {}, "")).response,
    400,
  );
  await neutral(
    "wrong-browser-cookie",
    async () => (await world.callback(attacker, "ada", {}, "ef_login=wrong")).response,
    400,
  );
  await neutral(
    "unknown-state",
    () =>
      request("/auth/callback?state=unknown&code=unknown", {
        headers: { cookie: attacker.binding },
      }),
    400,
  );
  const expiring = await world.begin();
  world.setNow(world.now() + 600000);
  await neutral("expired-transaction", async () => (await world.callback(expiring)).response, 400);
  const invalids = [
    ["nonce", { claims: { nonce: "wrong-nonce" } }, 400],
    ["audience", { claims: { aud: "another-client" } }, 401],
    ["issuer", { claims: { iss: "https://other.invalid/" } }, 401],
    ["expiry", { claims: { exp: Math.floor(world.now() / 1000) - 1 } }, 401],
    ["signature", { wrongSignature: true }, 401],
    ["algorithm", { header: { alg: "HS256" } }, 401],
    ["unverified-email", { claims: { email_verified: false } }, 401],
    ["missing-email-verification", { claims: { email_verified: undefined } }, 401],
    ["verifier", { badVerifier: true }, 400],
  ];
  for (const [name, overrides, status] of invalids) {
    const tx = await world.begin();
    await neutral(
      `OIDC-${name}`,
      async () => (await world.callback(tx, "ada", overrides)).response,
      status,
    );
  }
  const ada = await world.login("ada", "/settings/cli-tokens");
  assert.equal(ada.response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(ada.response.headers.get("location"), "/settings/cli-tokens");
  records.push({
    name: "accepted-browser-PKCE-login",
    cookies: cookiesSafe(ada.response),
    subject: PEOPLE.ada.sub,
    identity: await world.heads(),
  });
  const code = world.issue(ada.transaction.authorization);
  await neutral(
    "reused-callback",
    () =>
      request(
        `/auth/callback?state=${ada.transaction.authorization.searchParams.get("state")}&code=${code}`,
        { headers: { cookie: ada.transaction.binding } },
      ),
    400,
  );
  const grace = await world.login("grace");
  for (const [cookie, org] of [
    [ada.cookie, "private-ada"],
    [grace.cookie, "private-grace"],
  ]) {
    await dispatch(cookie, "ns:root", "ns.org.create", { v: 1, name: org });
    await dispatch(cookie, `ns:org:${org}`, "ns.project.create", { v: 1, name: "notes" });
    await dispatch(cookie, `ns:org:${org}`, "ns.repo.create", {
      v: 1,
      name: "notebook",
      project: "notes",
      visibility: "private",
    });
    await dispatch(cookie, `fs:${org}/notebook:main:meta`, "fs.branch.genesis", {
      v: 1,
      branch: "main",
    });
    await dispatch(cookie, `chat:${org}`, "chat.channel.create", {
      v: 1,
      name: "welcome",
      topic: "Private fixture channel",
    });
  }
  await dispatch(ada.cookie, "chat:private-ada/welcome", "chat.message.post", {
    v: 1,
    id: "http-persistent-message",
    body: "A private accepted mutation survives restart.",
  });
  const chatPath = "/api/chat/private-ada/welcome?projection=1&reducer=chat-channel";
  const own = await readJson(await request(chatPath, { headers: { cookie: ada.cookie } }), 200);
  const message = own.events[0];
  assert.equal(own.events.length, 1);
  assert.equal(message.payload.actor, PEOPLE.ada.sub);
  assert.deepEqual(message, {
    offset: "0000000000000000_0000000000000000",
    type: "chat.message.post",
    ts: 1800000000000,
    payload: {
      v: 1,
      id: "http-persistent-message",
      body: "A private accepted mutation survives restart.",
      actor: PEOPLE.ada.sub,
      writer: { v: 1, seq: 1, sub: PEOPLE.ada.sub },
    },
  });
  await writeFile(
    resolve(output, "chat-before.jsonl"),
    `${own.events.map(canonicalJson).join("\n")}\n`,
  );
  const repoPath = "/api/repos/private-ada/notebook/main/events?projection=1&reducer=streamfs";
  assert.equal((await request(repoPath, { headers: { cookie: ada.cookie } })).status, 200);
  for (const [name, headers] of [
    ["other-tenant", { cookie: grace.cookie }],
    ["anonymous", {}],
  ]) {
    for (const [kind, path] of [
      ["read", repoPath],
      ["follow", `${repoPath}&live=1&checkpoint=-1&waitMs=1`],
      ["chat", chatPath],
      ["chat-follow", `${chatPath}&live=1&checkpoint=-1&waitMs=1`],
    ])
      await neutral(`${name}-${kind}`, () => request(path, { headers }), [401, 403, 404]);
    await neutral(
      `${name}-write`,
      () =>
        request("/api/dispatch", {
          method: "POST",
          headers: { origin: world.origin, "content-type": "application/json", ...headers },
          body: JSON.stringify({
            streamId: "chat:private-ada/welcome",
            event: {
              type: "chat.message.post",
              payload: { v: 1, id: "blocked", body: "never accepted" },
              ts: 1800000000000,
            },
          }),
        }),
      [401, 403, 404],
    );
  }
  for (const path of [
    "/api/dispatch",
    "/api/orgs/private-ada/invites",
    "/api/cli-tokens",
    "/api/cli-tokens/unknown",
    "/auth/logout",
  ]) {
    for (const origin of [undefined, "null", "https://evil.invalid"]) {
      await neutral(
        `origin-refusal ${path} ${origin ?? "missing"}`,
        () =>
          request(path, {
            method: path.includes("/unknown") ? "DELETE" : "POST",
            headers: {
              cookie: ada.cookie,
              "content-type": "application/json",
              ...(origin === undefined ? {} : { origin }),
            },
            body: "{}",
          }),
        403,
      );
    }
  }
  const invite = await readJson(
    await request("/api/orgs/private-ada/invites", {
      method: "POST",
      headers: {
        cookie: ada.cookie,
        origin: world.origin,
        host: "evil.invalid",
        "x-forwarded-host": "evil.invalid",
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: PEOPLE.grace.email, role: "member" }),
    }),
    201,
  );
  assert.ok(invite.link.startsWith(`${world.origin}/auth/login?next=`));
  assert.equal(invite.emailed, null);
  records.push({
    name: "canonical-invite-no-outbound",
    origin: new URL(invite.link).origin,
    emailed: invite.emailed,
  });
  for (const type of [
    "agent.register",
    "agent.run.started",
    "integration.configure",
    "webhook.configure",
    "email.send",
    "mcp.register",
  ]) {
    await neutral(
      `integration-admission ${type}`,
      () =>
        request("/api/dispatch", {
          method: "POST",
          headers: { cookie: ada.cookie, origin: world.origin, "content-type": "application/json" },
          body: JSON.stringify({
            streamId: "agents:private-ada",
            event: { type, payload: { v: 1 }, ts: world.now() },
          }),
        }),
      403,
    );
  }
  const minted = await readJson(
    await request("/api/cli-tokens", {
      method: "POST",
      headers: { cookie: ada.cookie, origin: world.origin, "content-type": "application/json" },
      body: JSON.stringify({ name: "fixture-grant", scopes: ["repo:write"] }),
    }),
    201,
  );
  assert.match(minted.token, /^ef_cli_[A-Za-z0-9_-]{43}$/);
  const bearer = { authorization: `Bearer ${minted.token}` };
  const jwt = world.token((await world.begin()).authorization);
  await neutral(
    "valid-web-ID-JWT-is-not-an-API-credential",
    () =>
      request("/api/dispatch", {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        body: JSON.stringify({
          streamId: "chat:private-ada/welcome",
          event: {
            type: "chat.message.post",
            payload: { v: 1, id: "jwt-blocked", body: "never accepted" },
            ts: world.now(),
          },
        }),
      }),
    401,
  );
  for (const path of ["/api/cli-tokens", "/api/cli-tokens/unknown", "/auth/logout"]) {
    await neutral(
      `mixed-credential-web-session-only ${path}`,
      () =>
        request(path, {
          method: path.includes("/unknown") ? "DELETE" : "POST",
          headers: {
            cookie: ada.cookie,
            origin: world.origin,
            ...bearer,
            "content-type": "application/json",
          },
          body: "{}",
        }),
      401,
    );
  }
  await neutral(
    "bad-bearer-never-falls-back-to-cookie",
    () =>
      request("/api/dispatch", {
        method: "POST",
        headers: {
          cookie: ada.cookie,
          authorization: "Bearer invalid",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    [400, 401],
  );
  await dispatch(
    "",
    "ns:org:private-ada",
    "ns.project.create",
    { v: 1, name: "grant-authenticated" },
    bearer,
  );
  assert.equal(
    (
      await request(`${chatPath}&live=1&checkpoint=-1&waitMs=10000`, {
        headers: { cookie: ada.cookie },
      })
    ).status,
    200,
  );
  await neutral(
    "hosted-follow-over-profile",
    () =>
      request(`${chatPath}&live=1&checkpoint=-1&waitMs=10001`, { headers: { cookie: ada.cookie } }),
    400,
  );
  const beforeRestart = await world.dumpIdentity("identity-before-restart");
  dumps.push(beforeRestart);
  const prefix = await world.events("chat:private-ada/welcome");
  const secretBefore = digest(await readFile(resolve(world.dataDir, "session.key")));
  assert.equal((await stat(world.dataDir)).mode & 0o777, 0o700);
  assert.equal((await stat(resolve(world.dataDir, "session.key"))).mode & 0o777, 0o600);
  const marker = JSON.parse(await readFile(resolve(world.dataDir, "hosted-state.json"), "utf8"));
  assert.deepEqual(Object.keys(marker).sort(), [
    "clientId",
    "issuer",
    "keyHash",
    "mode",
    "phase",
    "version",
  ]);
  const interrupted = await world.begin();
  const pendingFollow = request(
    `${chatPath}&live=1&checkpoint=${encodeURIComponent(prefix.at(-1).offset)}&waitMs=1500`,
    { headers: { cookie: ada.cookie } },
  )
    .then((response) => response.status)
    .catch(() => "socket-closed");
  await new Promise((done) => setTimeout(done, 50));
  await world.restart();
  records.push({ name: "drain-with-pending-follow", outcome: await pendingFollow });
  assert.equal((await request("/api/whoami", { headers: { cookie: ada.cookie } })).status, 200);
  assert.deepEqual(await world.events("chat:private-ada/welcome"), prefix);
  assert.equal(digest(await readFile(resolve(world.dataDir, "session.key"))), secretBefore);
  const afterRestart = await world.dumpIdentity("identity-after-restart");
  dumps.push(afterRestart);
  assert.equal(afterRestart.sha256, beforeRestart.sha256);
  assert.equal(afterRestart.digest, beforeRestart.digest);
  await neutral(
    "interrupted-login-fails-closed-after-restart",
    async () => (await world.callback(interrupted)).response,
    400,
  );
  const revoke = await request(`/api/cli-tokens/${minted.grantId}`, {
    method: "DELETE",
    headers: { cookie: ada.cookie, origin: world.origin },
  });
  assert.equal(revoke.status, 200);
  const logout = await request("/auth/logout", {
    method: "POST",
    headers: { cookie: grace.cookie, origin: world.origin },
  });
  assert.equal(logout.status, 302);
  cookiesSafe(logout);
  await world.restart();
  assert.equal((await request("/api/whoami", { headers: { cookie: ada.cookie } })).status, 200);
  await neutral(
    "ended-session-stays-refused-after-restart",
    () => request("/api/whoami", { headers: { cookie: grace.cookie } }),
    401,
  );
  await neutral(
    "revoked-grant-stays-refused-after-restart",
    () => request(chatPath, { headers: bearer }),
    [401, 403],
  );
  const relogin = await world.login("grace");
  assert.equal((await request("/api/whoami", { headers: { cookie: relogin.cookie } })).status, 200);
  dumps.push(await world.dumpIdentity("identity-final"));
  const headsBeforeBodies = await world.heads(authority);
  const full = Buffer.alloc(HOSTED_LIMITS.maxBodyBytes, 32);
  const boundary = await request("/api/dispatch", {
    method: "POST",
    headers: { origin: world.origin },
    body: full,
  });
  assert.notEqual(boundary.status, 413);
  records.push({ name: "body-at-supported-boundary", bytes: full.length, status: boundary.status });
  assert.match(
    await raw(
      `POST /api/dispatch HTTP/1.1\r\nHost: fixture\r\nContent-Length: ${HOSTED_LIMITS.maxBodyBytes + 1}\r\n\r\n`,
    ),
    /413 Payload Too Large/,
  );
  const chunked = await new Promise((done, reject) => {
    const req = httpRequest(
      world.baseUrl,
      { path: "/api/dispatch", method: "POST", headers: { "transfer-encoding": "chunked" } },
      (response) => {
        response.resume();
        response.on("end", () => done(response.statusCode));
      },
    );
    req.on("error", reject);
    req.write(full);
    req.end("x");
  });
  assert.equal(chunked, 413);
  const stalledAt = performance.now();
  assert.match(
    await raw("POST /api/dispatch HTTP/1.1\r\nHost: fixture\r\nContent-Length: 8\r\n\r\nx"),
    /408 Request Timeout/,
  );
  assert.ok(performance.now() - stalledAt < 3000);
  const headerAt = performance.now();
  assert.match(await raw("GET /healthz HTTP/1.1\r\nHost: fixture"), /408 Request Timeout/);
  assert.ok(performance.now() - headerAt < 3000);
  assert.deepEqual(await world.heads(authority), headsBeforeBodies);
  records.push({
    name: "bounded-socket-bodies",
    declaredOversize: 413,
    chunkedOversize: 413,
    stalled: 408,
    fixtureDeadlineMs: 1000,
    defaultDeadlineMs: HOSTED_LIMITS.requestDeadlineMs,
  });
  const finalChat = await world.events("chat:private-ada/welcome");
  for (const streamId of [
    "ns:root",
    "ns:org:private-ada",
    "ns:org:private-grace",
    "fs:private-ada/notebook:main:meta",
  ]) {
    const events = await world.events(streamId);
    const path = resolve(output, `${streamId.replaceAll(":", "-").replaceAll("/", "-")}.jsonl`);
    await writeFile(path, events.length ? `${events.map(canonicalJson).join("\n")}\n` : "");
    dumps.push({
      path,
      streamId,
      count: events.length,
      lastApplicationOffset: events.at(-1)?.offset ?? "-1",
      sha256: digest(await readFile(path)),
    });
  }
  await writeFile(
    resolve(output, "chat-final.jsonl"),
    `${finalChat.map(canonicalJson).join("\n")}\n`,
  );
  const report = {
    task: "E12-T10",
    proof: "dedicated-fixture-real-gateway-provider; not actual Auth0",
    sourceRevision: world.environment.EF_BUILD_REVISION,
    origin: world.origin,
    records,
    dumps,
    exchanges: world.exchanges,
    timings: world.timings,
    stableSecret: {
      privateDirectoryMode: "0700",
      keyMode: "0600",
      beforeSha256: secretBefore,
      afterSha256: digest(await readFile(resolve(world.dataDir, "session.key"))),
    },
    providerPubliclyReachable: false,
    publicFixtureSeam: false,
    productionCredentialsUsed: false,
  };
  await writeFile(resolve(output, "http.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `E12-T10 hosted HTTP: ${records.length} checks; PKCE/refusals/private tenants/opaque grants/restart/body bounds passed\n`,
  );
} finally {
  await world.close();
}
