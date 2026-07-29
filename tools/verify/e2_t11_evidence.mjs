#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TASK = path.join(ROOT, ".eforest/tasks/epic-2-the-gates/E2-T11-rate-limits-tenant-isolation");
const GOLDEN =
  process.env.E2_T11_GOLDEN ?? path.join(TASK, "evidence/e2-t11-rate-tenant.golden.txt");
const WRITE = process.argv.includes("--write-golden");
let now = 1_700_000_000_000;

const digest = (value) => createHash("sha256").update(value).digest("hex");

async function loadBuilt() {
  const platformPath = path.join(ROOT, "packages/platform/dist/src/index.js");
  const serverPath = path.join(ROOT, "packages/server/dist/src/index.js");
  assert.ok(fs.existsSync(platformPath), "build @eforest/platform before E2-T11 evidence");
  assert.ok(fs.existsSync(serverPath), "build @eforest/server before E2-T11 evidence");
  return {
    platform: await import(`${pathToFileURL(platformPath).href}?e2-t11`),
    server: await import(`${pathToFileURL(serverPath).href}?e2-t11`),
  };
}

async function scenario(modules) {
  const created = new Set();
  const official = modules.server.createDurableStreamTestServer({
    host: "127.0.0.1",
    port: 0,
    onStreamCreated: ({ path: streamPath }) => {
      created.add(decodeURIComponent(streamPath.replace(/^\/streams\//, "")));
    },
  });
  const officialUrl = await official.start();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input));
    if (url.origin === officialUrl && url.pathname.startsWith("/streams/")) {
      calls.push({
        method: init?.method ?? request?.method ?? "GET",
        streamId: decodeURIComponent(url.pathname.slice("/streams/".length)),
      });
    }
    return originalFetch(input, init);
  };

  const secret = "e2-t11-session-secret-at-least-32-bytes";
  const runtime = await modules.platform.createPlatformProductionRuntime(
    {
      EF_OIDC_ISSUER: "https://unused.e2-t11.invalid",
      EF_OIDC_CLIENT_ID: "e2-t11",
      EF_SESSION_SECRET: secret,
      EF_SESSION_TTL: "60",
      EFOREST_SERVER_URL: officialUrl,
    },
    { now: () => now, rateLimit: { max: 2, windowMs: 1_000 } },
  );
  await runtime.registry.stop();
  const platformUrl = await modules.platform.listenPlatformServer(runtime.server);
  const streams = new modules.platform.OfficialStreamAdapter({ baseUrl: officialUrl });
  const rows = [];

  const stateDigest = async () => {
    const state = {};
    for (const streamId of [...created].sort()) {
      const response = await originalFetch(
        `${officialUrl}/streams/${encodeURIComponent(streamId)}`,
      );
      state[streamId] = `${response.status}:${await response.text()}`;
    }
    return digest(JSON.stringify(state));
  };

  const observe = async (name, route, init, expected, refused = false) => {
    const before = await stateDigest();
    const callStart = calls.length;
    const response = await fetch(`${platformUrl}${route}`, init);
    const body = await response.text();
    const after = await stateDigest();
    const delta = calls.slice(callStart);
    const privateCalls = delta.filter(
      ({ streamId }) => streamId.startsWith("ns:org:") || streamId.startsWith("fs:"),
    );
    assert.equal(response.status, expected, name);
    if (refused) {
      assert.equal(privateCalls.length, 0, `${name} touched private/target stream`);
      assert.equal(after, before, `${name} changed stream state`);
    }
    rows.push(
      [
        `case=${name}`,
        `status=${response.status}`,
        `private-calls=${privateCalls.length}`,
        `digest-before=${before}`,
        `digest-after=${after}`,
        `body-sha256=${digest(body)}`,
      ].join(" "),
    );
    return { response, body, before, after };
  };

  const opaque = { acme: "ef_cli_e2_t11_acme", beta: "ef_cli_e2_t11_beta" };
  const subjects = { acme: "auth0|e2-t11-acme", beta: "auth0|e2-t11-beta" };
  const sessions = { acme: "session-acme", beta: "session-beta" };
  const auth = (tenant) => ({ authorization: `Bearer ${opaque[tenant]}` });
  try {
    await runtime.identity.login(subjects.acme, "acme@example.test", sessions.acme);
    await runtime.identity.login(subjects.beta, "beta@example.test", sessions.beta);
    await runtime.identity.createOrg("acme", "acme", subjects.acme);
    await runtime.identity.createOrg("beta", "beta", subjects.beta);
    for (const tenant of ["acme", "beta"]) {
      await runtime.identity.issueCliGrant({
        grantId: `grant-${tenant}`,
        sub: subjects[tenant],
        tokenKind: "web-mint",
        tokenHash: modules.platform.tokenHash(opaque[tenant]),
        scopes: [`repo:read:${tenant}/secret`, `repo:write:${tenant}/secret:main`],
      });
    }
    for (const [streamId, event, actor] of [
      ["ns:root", { type: "ns.org.create", payload: { v: 1, name: "acme" }, ts: 1 }, subjects.acme],
      ["ns:root", { type: "ns.org.create", payload: { v: 1, name: "beta" }, ts: 2 }, subjects.beta],
      [
        "ns:org:acme",
        { type: "ns.project.create", payload: { v: 1, name: "trees" }, ts: 3 },
        subjects.acme,
      ],
      [
        "ns:org:acme",
        {
          type: "ns.repo.create",
          payload: { v: 1, name: "forest", project: "trees", visibility: "public" },
          ts: 4,
        },
        subjects.acme,
      ],
      [
        "ns:org:acme",
        {
          type: "ns.repo.create",
          payload: { v: 1, name: "secret", project: "trees", visibility: "private" },
          ts: 5,
        },
        subjects.acme,
      ],
    ]) {
      await runtime.namespaces.dispatch(streamId, event, actor);
    }
    for (const repo of ["forest", "secret"]) {
      await streams.create(`fs:acme/${repo}:main:meta`);
      await streams.append(`fs:acme/${repo}:main:meta`, {
        type: "seed",
        payload: { repo },
        ts: 6,
      });
    }

    const rateRoute = "/api/namespaces/acme/secret";
    await observe("rate-max-1", rateRoute, { headers: auth("acme") }, 200);
    await observe("rate-max-2", rateRoute, { headers: auth("acme") }, 200);
    const over = await observe("rate-max-plus-1", rateRoute, { headers: auth("acme") }, 429, true);
    assert.deepEqual(JSON.parse(over.body), {
      error: {
        code: "rate_limited",
        reason: "fixed_window_exhausted",
        operation: "namespace.lookup",
        limit: 2,
        retryAfterMs: 1_000,
        windowResetAt: 1_700_000_001_000,
      },
    });
    assert.equal(over.response.headers.get("retry-after"), "1");
    now += 1_000;
    await observe("rate-next-window", rateRoute, { headers: auth("acme") }, 200);

    const foreignCases = [
      ["foreign-read", "/api/repos/acme/secret/main/events", { headers: auth("beta") }],
      [
        "foreign-follow",
        "/api/repos/acme/secret/main/events?live=1&waitMs=0",
        { headers: auth("beta") },
      ],
      [
        "foreign-dispatch",
        "/api/dispatch",
        {
          method: "POST",
          headers: { ...auth("beta"), "content-type": "application/json" },
          body: JSON.stringify({
            streamId: "fs:acme/secret:main:meta",
            event: { type: "probe", payload: {}, ts: 7 },
          }),
        },
      ],
      ["foreign-registry", "/registry/org/acme", { headers: auth("beta") }],
      ["foreign-namespace-alias", "/api/namespaces/%61cme/secret", { headers: auth("beta") }],
      ["foreign-encoded-read", "/api/repos/%61cme/secret/main/events", { headers: auth("beta") }],
    ];
    const foreignBodies = [];
    for (const [name, route, init] of foreignCases) {
      const result = await observe(name, route, init, 404, true);
      foreignBodies.push(result.body);
    }
    const missing = await observe(
      "foreign-nonexistent",
      "/api/repos/acme/does-not-exist/main/events",
      { headers: auth("beta") },
      404,
      true,
    );
    assert.equal(foreignBodies[0], missing.body, "private and nonexistent bodies differ");

    const cookie = modules.platform.signedSessionCookie(secret, sessions.acme, 60).split(";", 1)[0];
    await observe(
      "foreign-token-item",
      "/api/cli-tokens/grant-beta",
      { method: "DELETE", headers: { cookie } },
      404,
      true,
    );
    assert.equal(
      runtime.rateLimiter.count({
        tenant: `subject:${subjects.beta}`,
        subject: subjects.beta,
        operation: "cli-token.issue",
      }),
      0,
      "cross-tenant token probe consumed beta quota",
    );
    assert.equal(
      runtime.rateLimiter.count({
        tenant: "acme",
        subject: subjects.beta,
        operation: "application.read",
      }),
      0,
      "foreign reads consumed the target tenant quota",
    );

    await observe("anonymous-public-read", "/api/repos/acme/forest/main/events", undefined, 200);
    await observe(
      "subject-public-read",
      "/api/repos/acme/forest/main/events",
      { headers: auth("acme") },
      200,
    );
    assert.equal(
      runtime.rateLimiter.count({
        tenant: "acme",
        subject: "anonymous",
        operation: "application.read",
      }),
      1,
    );
    assert.equal(
      runtime.rateLimiter.count({
        tenant: "acme",
        subject: subjects.acme,
        operation: "application.read",
      }),
      1,
    );

    await runtime.identity.revokeCliGrant("grant-beta");
    const revoked = await observe(
      "revoked-before-rate-limit",
      "/api/repos/acme/secret/main/events",
      { headers: auth("beta") },
      401,
      true,
    );
    assert.equal(JSON.parse(revoked.body).error.reason, "authz/grant-revoked");
    assert.equal(
      runtime.rateLimiter.count({
        tenant: "acme",
        subject: subjects.beta,
        operation: "application.read",
      }),
      0,
      "revoked credential consumed tenant quota",
    );
    return `${rows.join("\n")}\n`;
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => runtime.server.close(() => resolve()));
    runtime.namespaces.terminate();
    await official.stop();
  }
}

const modules = await loadBuilt();
const first = await scenario(modules);
now = 1_700_000_000_000;
const second = await scenario(modules);
assert.equal(second, first, "E2-T11 scenario was not byte-deterministic");
if (WRITE) {
  fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
  fs.writeFileSync(GOLDEN, first);
}
assert.ok(fs.existsSync(GOLDEN), "missing E2-T11 golden; use --write-golden intentionally");
assert.equal(fs.readFileSync(GOLDEN, "utf8"), first, "E2-T11 golden mismatch");
process.stdout.write(
  `E2_T11_EVIDENCE_OK rows=${first.trim().split("\n").length} runs=2 sha256=${digest(first)}\n`,
);
