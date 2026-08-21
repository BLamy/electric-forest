#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TASK = path.join(ROOT, ".eforest/tasks/epic-2-the-gates/E2-T10-authz-conformance-matrix");
const GOLDEN = path.join(TASK, "evidence/e2-t10-http-operations.txt");
const writeGolden = process.argv.includes("--write-golden");
const NOW = 1_700_000_000_000;

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

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

function deterministicRandom() {
  let ordinal = 0;
  return (size) => {
    const output = Buffer.alloc(size);
    for (let index = 0; index < size; index += 1) output[index] = (ordinal + index) % 256;
    ordinal += size;
    return output;
  };
}

async function runScenario(modules) {
  const createdStreamIds = new Set();
  const official = modules.server.createDurableStreamTestServer({
    host: "127.0.0.1",
    port: 0,
    onStreamCreated: ({ path: streamPath }) => {
      createdStreamIds.add(decodeURIComponent(streamPath.replace(/^\/streams\//, "")));
    },
  });
  const officialUrl = await official.start();
  const originalFetch = globalThis.fetch;
  const targetCalls = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === officialUrl && url.pathname.startsWith("/streams/")) {
      const streamId = decodeURIComponent(url.pathname.slice("/streams/".length));
      if (
        streamId !== "__identity__" &&
        streamId !== "__registry__" &&
        !streamId.startsWith("ns:")
      ) {
        targetCalls.push({
          method: init?.method ?? (input instanceof Request ? input.method : "GET"),
          streamId,
        });
      }
    }
    return originalFetch(input, init);
  };

  const secret = "e2-t10-session-secret-at-least-32-bytes";
  let operationOrdinal = 0;
  const runtime = await modules.platform.createPlatformProductionRuntime(
    {
      EF_OIDC_ISSUER: "https://unused.e2-t10.invalid",
      EF_OIDC_CLIENT_ID: "e2-t10",
      EF_SESSION_SECRET: secret,
      EF_SESSION_TTL: "60",
      EFOREST_SERVER_URL: officialUrl,
    },
    {
      now: () => NOW,
      random: deterministicRandom(),
      operationId: () => `e2-t10-operation-${++operationOrdinal}`,
    },
  );
  const platformUrl = await modules.platform.listenPlatformServer(runtime.server);
  const closePlatform = () =>
    new Promise((resolve) => {
      runtime.server.close(() => resolve());
      runtime.server.closeAllConnections();
    });

  try {
    const streams = new modules.platform.OfficialStreamAdapter({ baseUrl: officialUrl });
    const stateDigest = async () => {
      const states = {};
      for (const streamId of [...createdStreamIds].sort()) {
        const response = await originalFetch(
          `${officialUrl}/streams/${encodeURIComponent(streamId)}`,
        );
        states[streamId] = `${response.status}:${await response.text()}`;
      }
      return digest(JSON.stringify(states));
    };
    const rows = [];
    const observe = async ({
      operation,
      principal,
      visibility,
      grant,
      route,
      init,
      status,
      refused = false,
      validate = () => undefined,
    }) => {
      const before = await stateDigest();
      const callsBefore = targetCalls.length;
      const streamsBefore = createdStreamIds.size;
      const response = await fetch(`${platformUrl}${route}`, init);
      const body = await response.text();
      const after = await stateDigest();
      const callDelta = targetCalls.length - callsBefore;
      const createdDelta = createdStreamIds.size - streamsBefore;
      assert.equal(response.status, status, `${operation}/${principal}/${visibility}/${grant}`);
      await validate(body);
      if (refused) {
        assert.equal(callDelta, 0, `${operation}/${principal} reached an official target`);
        assert.equal(createdDelta, 0, `${operation}/${principal} created a stream`);
        assert.equal(after, before, `${operation}/${principal} changed a stream digest`);
      }
      rows.push(
        `http operation=${operation} principal=${principal} visibility=${visibility} grant=${grant} status=${response.status} outcome=${refused ? "refused" : "accepted"} target-calls=${callDelta} created-streams=${createdDelta} digest-before=${before} digest-after=${after} route=${route.split("?")[0]}`,
      );
      return body;
    };

    const subjects = ["owner", "admin", "member", "outsider", "reader", "revoked"];
    for (const name of subjects) {
      await runtime.identity.login(
        `auth0|e2-t10-${name}`,
        `${name}@example.test`,
        `session-${name}`,
      );
    }
    await runtime.identity.createOrg("acme", "acme", "auth0|e2-t10-owner");
    await runtime.identity.grantMembership("acme", "auth0|e2-t10-admin", "admin");
    await runtime.identity.grantMembership("acme", "auth0|e2-t10-member", "member");

    const tokens = Object.fromEntries(subjects.map((name) => [name, `ef_cli_e2_t10_${name}`]));
    const scopes = {
      owner: ["repo:write:acme/forest:main", "repo:write:acme/secret:main"],
      admin: [],
      member: [],
      outsider: [],
      reader: ["repo:read:acme/secret"],
      revoked: ["repo:read:acme/secret", "repo:write:acme/secret:main"],
    };
    for (const name of subjects) {
      await runtime.identity.issueCliGrant({
        grantId: `grant-${name}`,
        sub: `auth0|e2-t10-${name}`,
        tokenKind: "web-mint",
        tokenHash: modules.platform.tokenHash(tokens[name]),
        scopes: scopes[name],
      });
    }
    await runtime.identity.revokeCliGrant("grant-revoked");

    const auth = (name) => ({
      authorization: `Bearer ${tokens[name]}`,
      "content-type": "application/json",
    });
    const dispatchInit = (name, streamId, event) => ({
      method: "POST",
      headers: auth(name),
      body: JSON.stringify({ streamId, event }),
    });
    for (const [streamId, event] of [
      ["ns:root", { type: "ns.org.create", payload: { v: 1, name: "acme" }, ts: 1 }],
      ["ns:org:acme", { type: "ns.project.create", payload: { v: 1, name: "trees" }, ts: 2 }],
      [
        "ns:org:acme",
        {
          type: "ns.repo.create",
          payload: { v: 1, name: "forest", project: "trees", visibility: "public" },
          ts: 3,
        },
      ],
      [
        "ns:org:acme",
        {
          type: "ns.repo.create",
          payload: { v: 1, name: "secret", project: "trees", visibility: "private" },
          ts: 4,
        },
      ],
    ]) {
      const response = await fetch(
        `${platformUrl}/api/dispatch`,
        dispatchInit("owner", streamId, event),
      );
      assert.equal(response.status, 202, event.type);
    }
    for (const repo of ["forest", "secret"]) {
      await streams.create(`fs:acme/${repo}:main:meta`);
      await streams.append(`fs:acme/${repo}:main:meta`, {
        type: "seed",
        payload: { repo },
        ts: 5,
      });
    }

    const namespaceCases = [
      ["anonymous", "public", "none", undefined, "forest", 401, true],
      ["owner", "private", "active-write", "owner", "secret", 200, false],
      ["member", "private", "active-no-scope", "member", "secret", 200, false],
      ["admin", "public", "active-no-scope", "admin", "forest", 200, false],
      ["revoked", "private", "revoked", "revoked", "secret", 401, true],
      ["unknown", "public", "unknown", "unknown", "forest", 401, true],
    ];
    for (const [principal, visibility, grant, tokenName, repo, status, refused] of namespaceCases) {
      await observe({
        operation: "namespace.lookup",
        principal,
        visibility,
        grant,
        route: `/api/namespaces/acme/${repo}`,
        init:
          tokenName === undefined
            ? {}
            : tokenName === "unknown"
              ? { headers: { authorization: "Bearer ef_cli_unknown" } }
              : { headers: auth(tokenName) },
        status,
        refused,
        validate: (body) => {
          if (refused) return;
          const parsed = JSON.parse(body);
          assert.deepEqual(parsed, {
            ok: true,
            path: `acme/${repo}`,
            resolution: {
              repoStreamPrefix: `fs:acme/${repo}`,
              visibility,
              owner: "auth0|e2-t10-owner",
              project: "trees",
            },
          });
        },
      });
    }

    const registryCases = [
      ["anonymous", "public", "none", "/registry/public", undefined, 200, false],
      ["anonymous", "private", "none", "/registry/org/acme", undefined, 200, false],
      ["owner", "private", "active-write", "/registry/me", "owner", 200, false],
      ["member", "private", "active-no-scope", "/registry/org/acme", "member", 200, false],
      ["admin", "private", "active-no-scope", "/registry/org/acme", "admin", 200, false],
      ["outsider", "private", "active-no-scope", "/registry/org/acme", "outsider", 200, false],
      ["revoked", "private", "revoked", "/registry/me", "revoked", 401, true],
    ];
    for (const [principal, visibility, grant, route, tokenName, status, refused] of registryCases) {
      await observe({
        operation: "registry.query",
        principal,
        visibility,
        grant,
        route,
        init: tokenName === undefined ? {} : { headers: auth(tokenName) },
        status,
        refused,
      });
    }

    const cookie = (name, session = name) =>
      modules.platform.signedSessionCookie(secret, `session-${session}`, 60);
    await runtime.identity.endSession("session-outsider");
    const cliCases = [
      ["anonymous", "session-none", {}, 401, true, ["repo:write"]],
      [
        "owner-bearer",
        "bearer-not-session",
        { authorization: `Bearer ${tokens.owner}` },
        401,
        true,
        ["repo:write"],
      ],
      ["owner", "session-active", { cookie: cookie("owner") }, 201, false, ["repo:write"]],
      ["member", "session-active", { cookie: cookie("member") }, 201, false, ["repo:read"]],
      ["outsider", "session-ended", { cookie: cookie("outsider") }, 401, true, ["repo:write"]],
      ["owner", "invalid-scope", { cookie: cookie("owner") }, 400, true, ["bad scope"]],
    ];
    let cliOrdinal = 0;
    for (const [principal, grant, headers, status, refused, requestScopes] of cliCases) {
      await observe({
        operation: "cli-token.issue",
        principal,
        visibility: "n/a",
        grant,
        route: "/api/cli-tokens",
        init: {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            name: `matrix-${++cliOrdinal}`,
            scopes: requestScopes,
          }),
        },
        status,
        refused,
      });
    }

    const appCases = [
      ["anonymous", "public", "none", undefined, 200, false],
      ["anonymous", "private", "none", undefined, 404, true],
      ["member", "private", "active-no-scope", "member", 200, false],
      ["outsider", "private", "active-no-scope", "outsider", 404, true],
      ["reader", "private", "active-read", "reader", 200, false],
      ["revoked", "private", "revoked", "revoked", 401, true],
    ];
    for (const operation of ["application.read", "application.follow"]) {
      for (const [principal, visibility, grant, tokenName, status, refused] of appCases) {
        const repo = visibility === "public" ? "forest" : "secret";
        const base = `/api/repos/acme/${repo}/main/events`;
        await observe({
          operation,
          principal,
          visibility,
          grant,
          route: operation === "application.follow" ? `${base}?live=1&waitMs=100` : base,
          init: tokenName === undefined ? {} : { headers: auth(tokenName) },
          status,
          refused,
        });
      }
    }

    const dispatchCases = [
      ["owner", "public", "active-write", "owner", 202, false],
      ["owner", "private", "active-write", "owner", 202, false],
      ["member", "private", "active-no-scope", "member", 403, true],
      ["outsider", "public", "active-no-scope", "outsider", 403, true],
      ["reader", "private", "active-read", "reader", 403, true],
      ["revoked", "private", "revoked", "revoked", 401, true],
    ];
    let dispatchOrdinal = 0;
    for (const [principal, visibility, grant, tokenName, status, refused] of dispatchCases) {
      const repo = visibility === "public" ? "forest" : "secret";
      await observe({
        operation: "application.dispatch",
        principal,
        visibility,
        grant,
        route: "/api/dispatch",
        init: dispatchInit(tokenName, `fs:acme/${repo}:main:meta`, {
          type: "matrix.write",
          payload: { ordinal: ++dispatchOrdinal },
          ts: 30 + dispatchOrdinal,
        }),
        status,
        refused,
      });
    }

    const refusedRows = rows.filter((line) => line.includes(" outcome=refused "));
    assert.ok(refusedRows.length >= 1, "operation table must contain refusals");
    assert.ok(
      refusedRows.every(
        (line) =>
          line.includes(" target-calls=0 ") &&
          line.includes(" created-streams=0 ") &&
          /digest-before=([a-f0-9]{64}) digest-after=\1 /.test(line),
      ),
      "every refused operation row must prove target-call and digest neutrality",
    );
    return [
      "E2-T10 production operation matrix v2",
      "transport=real-tcp platform=production-runtime streams=official-durable-streams",
      "dimensions=operation x applicable-principal x applicable-visibility x applicable-grant-state",
      ...rows,
      `E2_T10_HTTP_OPERATIONS_OK rows=${rows.length} refused=${refusedRows.length} operations=6`,
      "",
    ].join("\n");
  } finally {
    globalThis.fetch = originalFetch;
    // The projector must finish its in-flight source read while the durable
    // stream server is still alive. Closing the store concurrently sends the
    // client into its unbounded reconnect loop and pins this verifier forever.
    await runtime.registry.stop();
    await closePlatform();
    runtime.gateway.terminate();
    runtime.namespaces.terminate();
    await official.stop();
  }
}

const modules = await loadBuilt();
const first = await runScenario(modules);
const second = await runScenario(modules);
assert.equal(second, first, "six-operation HTTP matrix is nondeterministic");
if (writeGolden) {
  fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
  fs.writeFileSync(GOLDEN, first);
} else {
  assert.ok(fs.existsSync(GOLDEN), "committed six-operation HTTP matrix is missing");
  assert.equal(first, fs.readFileSync(GOLDEN, "utf8"), "six-operation HTTP matrix drifted");
}
const summary = /E2_T10_HTTP_OPERATIONS_OK rows=(\d+) refused=(\d+) operations=6/.exec(first);
assert.ok(summary);
console.log(`E2_T10_HTTP_OPERATIONS_OK rows=${summary[1]} refused=${summary[2]} runs=2`);
