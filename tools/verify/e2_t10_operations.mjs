#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TASK = path.join(ROOT, ".eforest/tasks/epic-2-the-gates/E2-T10-authz-conformance-matrix");
const GOLDEN = path.join(TASK, "evidence/e2-t10-http-operations.txt");
const writeGolden = process.argv.includes("--write-golden");

async function loadBuilt() {
  const platformPath = path.join(ROOT, "packages/platform/dist/src/index.js");
  const serverPath = path.join(ROOT, "packages/server/dist/src/index.js");
  assert.ok(fs.existsSync(platformPath), "build packages/platform before E2-T10 verification");
  assert.ok(fs.existsSync(serverPath), "build packages/server before E2-T10 verification");
  return {
    platform: await import(`${pathToFileURL(platformPath).href}?task=E2-T10-operations`),
    server: await import(`${pathToFileURL(serverPath).href}?task=E2-T10-operations`),
  };
}

async function runScenario(modules) {
  const official = modules.server.createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
  const officialUrl = await official.start();
  const secret = "e2-t10-session-secret-at-least-32-bytes";
  const runtime = await modules.platform.createPlatformProductionRuntime({
    EF_OIDC_ISSUER: "https://unused.e2-t10.invalid",
    EF_OIDC_CLIENT_ID: "e2-t10",
    EF_SESSION_SECRET: secret,
    EF_SESSION_TTL: "60",
    EFOREST_SERVER_URL: officialUrl,
  });
  const platformUrl = await modules.platform.listenPlatformServer(runtime.server);
  const closePlatform = () => new Promise((resolve) => runtime.server.close(() => resolve()));
  try {
    await runtime.identity.login("auth0|e2-t10-owner", "owner@example.test", "e2-t10-session");
    const cookie = modules.platform.signedSessionCookie(secret, "e2-t10-session", 60);
    const request = async (operation, route, init = {}) => {
      const response = await fetch(`${platformUrl}${route}`, init);
      return { operation, route, status: response.status, body: await response.text() };
    };

    const issued = await request("cli-token.issue", "/api/cli-tokens", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "e2-t10", scopes: ["repo:write"] }),
    });
    assert.equal(issued.status, 201);
    const token = JSON.parse(issued.body).token;
    assert.match(token, /^ef_cli_/);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const dispatch = (streamId, event) =>
      request("namespace.lookup", "/api/dispatch", {
        method: "POST",
        headers,
        body: JSON.stringify({ streamId, event }),
      });

    const namespace = await dispatch("ns:root", {
      type: "ns.org.create",
      payload: { v: 1, name: "acme" },
      ts: 1,
    });
    assert.equal(namespace.status, 202);
    assert.equal(
      (
        await dispatch("ns:org:acme", {
          type: "ns.project.create",
          payload: { v: 1, name: "trees" },
          ts: 2,
        })
      ).status,
      202,
    );
    assert.equal(
      (
        await dispatch("ns:org:acme", {
          type: "ns.repo.create",
          payload: { v: 1, name: "forest", project: "trees", visibility: "public" },
          ts: 3,
        })
      ).status,
      202,
    );

    const applicationToken = "ef_cli_e2_t10_application_writer";
    await runtime.identity.issueCliGrant({
      grantId: "e2-t10-application-grant",
      sub: "auth0|e2-t10-owner",
      tokenKind: "web-mint",
      tokenHash: modules.platform.tokenHash(applicationToken),
      scopes: ["repo:write:acme/forest:main"],
    });
    const streams = new modules.platform.OfficialStreamAdapter({ baseUrl: officialUrl });
    await streams.create("fs:acme/forest:main:meta");
    const applicationDispatch = await request("application.dispatch", "/api/dispatch", {
      method: "POST",
      headers: {
        authorization: `Bearer ${applicationToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        streamId: "fs:acme/forest:main:meta",
        event: { type: "e2-t10.seeded", payload: { v: 1 }, ts: 4 },
      }),
    });
    assert.equal(applicationDispatch.status, 202);
    const eventsRoute = "/api/repos/acme/forest/main/events";
    const applicationRead = await request("application.read", eventsRoute);
    assert.equal(applicationRead.status, 200);
    const applicationFollow = await request(
      "application.follow",
      `${eventsRoute}?live=1&waitMs=100`,
    );
    assert.equal(applicationFollow.status, 200);

    const deadline = Date.now() + 5_000;
    let registry;
    do {
      registry = await request("registry.query", "/registry/public");
      if (registry.status === 200 && JSON.parse(registry.body).entries.length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    assert.equal(registry.status, 200);
    assert.deepEqual(
      JSON.parse(registry.body).entries.map(({ org, repo }) => ({ org, repo })),
      [{ org: "acme", repo: "forest" }],
    );

    const observations = [
      namespace,
      applicationRead,
      applicationFollow,
      applicationDispatch,
      registry,
      issued,
    ];
    assert.deepEqual(
      observations.map(({ operation }) => operation),
      [
        "namespace.lookup",
        "application.read",
        "application.follow",
        "application.dispatch",
        "registry.query",
        "cli-token.issue",
      ],
    );
    return [
      "E2-T10 production operation ledger v1",
      "transport=real-tcp platform=production-runtime streams=official-durable-streams",
      ...observations.map(
        ({ operation, route, status }) =>
          `http operation=${operation} route=${route.split("?")[0]} status=${status}`,
      ),
      "E2_T10_HTTP_OPERATIONS_OK rows=6",
      "",
    ].join("\n");
  } finally {
    await Promise.allSettled([runtime.registry.stop(), closePlatform(), official.stop()]);
  }
}

const modules = await loadBuilt();
const first = await runScenario(modules);
const second = await runScenario(modules);
assert.equal(second, first, "six-operation HTTP ledger is nondeterministic");
if (writeGolden) {
  fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
  fs.writeFileSync(GOLDEN, first);
} else {
  assert.ok(fs.existsSync(GOLDEN), "committed six-operation HTTP ledger is missing");
  assert.equal(first, fs.readFileSync(GOLDEN, "utf8"), "six-operation HTTP ledger drifted");
}
console.log("E2_T10_HTTP_OPERATIONS_OK rows=6 runs=2");
