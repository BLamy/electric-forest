#!/usr/bin/env node
// E2-T07 sensitivity probe: a minimal end-to-end drive of the authorization
// door against a platform built from the dist tree named on the command line.
// The sensitivity harness runs it once against a pristine copy (must pass)
// and once per sabotaged copy (must fail with the sabotaged case named).
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Response } from "undici";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distIndex = process.argv[2];
assert.ok(
  distIndex !== undefined && fs.existsSync(distIndex),
  "usage: e2_t07_probe.mjs <path-to-platform-dist-index.js>",
);

const platform = await import(pathToFileURL(distIndex).href);
const server = await import(
  pathToFileURL(path.join(ROOT, "packages/server/dist/src/index.js")).href
);

const ISSUER = "https://probe.test/";
const AUDIENCE = "eforest-api";
const NOW = 1_700_000_000_000;
const OWNER = "auth0|probe-owner";
const ADMIN = "auth0|probe-admin";
const OUTSIDER = "auth0|probe-outsider";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = {
  ...pair.publicKey.export({ format: "jwk" }),
  kid: "probe-key",
  alg: "RS256",
  use: "sig",
};

function token(sub, nonce) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "probe-key" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({ iss: ISSUER, aud: AUDIENCE, sub, exp: NOW / 1000 + 300, nonce }),
  ).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), pair.privateKey).toString("base64url")}`;
}

const official = server.createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
const officialUrl = await official.start();
try {
  const adapter = new platform.OfficialStreamAdapter({ baseUrl: officialUrl });
  const namespaces = new platform.NamespaceDispatcher(adapter);
  const identity = new platform.IdentityStore({ baseUrl: officialUrl, now: () => NOW });
  await identity.ensure();
  const bearer = new platform.BearerVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    now: () => NOW,
    fetch: async () => Response.json({ keys: [publicJwk] }),
  });
  const verifier = new platform.GrantAwareVerifier({ bearer, identity });
  const httpServer = platform.createPlatformServer(
    platform.createPlatformHandler({ verifier, streams: adapter, namespaces }),
  );
  const baseUrl = await platform.listenPlatformServer(httpServer);
  try {
    let ordinal = 0;
    const grantToken = async (sub, scopes) => {
      ordinal += 1;
      const value = token(sub, `probe-${ordinal}`);
      await identity.ensureUser(sub, `probe-${ordinal}@example.test`);
      await identity.issueCliGrant({
        grantId: `probe-grant-${ordinal}`,
        sub,
        tokenKind: "device",
        tokenHash: platform.tokenHash(value),
        scopes: [...scopes].sort(),
      });
      return value;
    };
    const post = (streamId, event, auth) =>
      fetch(`${baseUrl}/api/dispatch`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(auth === undefined ? {} : { authorization: `Bearer ${auth}` }),
        },
        body: JSON.stringify({ streamId, event }),
      });
    const get = (route, auth) =>
      fetch(`${baseUrl}${route}`, {
        headers: auth === undefined ? {} : { authorization: `Bearer ${auth}` },
      });

    const owner = await grantToken(OWNER, ["repo:write:acme/forest:main"]);
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
      assert.equal((await post(streamId, event, owner)).status, 202, event.type);
    }
    await adapter.create("fs:acme/forest:main:meta");
    await identity.createOrg("acme", "acme", OWNER);
    await identity.ensureUser(ADMIN, "probe-admin@example.test");
    await identity.grantMembership("acme", ADMIN, "admin");

    // case=private-anonymous-read — a private repo is invisible without access.
    const anonymousPrivate = await get("/api/repos/acme/secret/main/events");
    assert.equal(anonymousPrivate.status, 404, "case=private-anonymous-read");

    // case=write-grant-required — a role without a branch-scoped write grant
    // never dispatches.
    const admin = await grantToken(ADMIN, []);
    const adminWrite = await post(
      "fs:acme/forest:main:meta",
      { type: "probe.write", payload: {}, ts: 5 },
      admin,
    );
    assert.equal(adminWrite.status, 403, "case=write-grant-required");

    // case=not-found-indistinguishable — private-unauthorized and nonexistent
    // answer byte-identically.
    const outsider = await grantToken(OUTSIDER, []);
    const privateBody = await (await get("/api/repos/acme/secret/main/events", outsider)).text();
    const missingBody = await (await get("/api/repos/acme/ghost/main/events", outsider)).text();
    assert.equal(privateBody, missingBody, "case=not-found-indistinguishable");

    // Control sanity: the authorized paths still work.
    const publicRead = await get("/api/repos/acme/forest/main/events");
    assert.equal(publicRead.status, 200, "case=public-read");
    const ownerWrite = await post(
      "fs:acme/forest:main:meta",
      { type: "probe.write", payload: {}, ts: 6 },
      owner,
    );
    assert.equal(ownerWrite.status, 202, "case=owner-write");
    console.log("PROBE_OK cases=5");
  } finally {
    await new Promise((resolve) => httpServer.close(() => resolve()));
  }
} finally {
  await official.stop();
}
