/* global Response, AbortController */
// Shared machinery for the E2-T08 verify scripts: a production-shaped
// platform fixture (official store + IdentityStore + NamespaceDispatcher +
// RegistryProjector + gateway) with DETERMINISTIC token material so restart
// proofs can present byte-identical credentials across processes.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createDurableStreamTestServer } from "../../packages/server/dist/src/index.js";
import {
  BearerVerifier,
  createPlatformHandler,
  createPlatformServer,
  GrantAwareVerifier,
  IdentityStore,
  listenPlatformServer,
  NamespaceDispatcher,
  OfficialStreamAdapter,
  RegistryProjector,
  tokenHash,
} from "../../packages/platform/dist/src/index.js";

export const ISSUER = "https://e2-t08.verify/";
export const AUDIENCE = "eforest-api";
export const NOW_MS = 1_700_000_000_000;
const KID = "e2-t08-key";

export const SUBJECTS = {
  alice: "auth0|alice",
  bob: "auth0|bob",
  carol: "auth0|carol",
  dave: "auth0|dave",
};

/** Load (or mint and persist) a deterministic RSA keypair for the fixture. */
export function keyMaterial(keyFile) {
  if (keyFile !== undefined && existsSync(keyFile)) {
    const stored = JSON.parse(readFileSync(keyFile, "utf8"));
    return {
      privateKey: createPrivateKey({ key: stored.privateJwk, format: "jwk" }),
      publicJwk: stored.publicJwk,
    };
  }
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const material = {
    privateKey: pair.privateKey,
    publicJwk: {
      ...createPublicKey(pair.privateKey).export({ format: "jwk" }),
      kid: KID,
      alg: "RS256",
      use: "sig",
    },
  };
  if (keyFile !== undefined) {
    writeFileSync(
      keyFile,
      JSON.stringify({
        privateJwk: pair.privateKey.export({ format: "jwk" }),
        publicJwk: material.publicJwk,
      }),
    );
  }
  return material;
}

export function signedToken(material, sub) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: KID })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: ISSUER,
      aud: AUDIENCE,
      sub,
      iat: NOW_MS / 1000,
      exp: NOW_MS / 1000 + 300,
    }),
  ).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), material.privateKey).toString("base64url")}`;
}

export async function startPlatformFixture({ dataDir, keyFile, pollMs = 100 } = {}) {
  const official = createDurableStreamTestServer({
    host: "127.0.0.1",
    port: 0,
    ...(dataDir === undefined ? {} : { dataDir }),
  });
  const officialUrl = await official.start();
  const material = keyMaterial(keyFile);
  const streams = new OfficialStreamAdapter({ baseUrl: officialUrl });
  const namespaces = new NamespaceDispatcher(streams);
  const identity = new IdentityStore({
    baseUrl: officialUrl,
    now: () => NOW_MS,
    recoverNamespaceOperation: (operationId, operation) =>
      namespaces.recover(operationId, operation.streamId, operation.event),
  });
  await identity.ensure();
  const bearer = new BearerVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    now: () => NOW_MS,
    fetch: async () => Response.json({ keys: [material.publicJwk] }),
  });
  const verifier = new GrantAwareVerifier({ bearer, identity });
  const projector = new RegistryProjector(streams, { pollMs });
  projector.start();
  const server = createPlatformServer(
    createPlatformHandler({ verifier, streams, namespaces, registry: projector }),
  );
  const baseUrl = await listenPlatformServer(server);
  const issued = new Map();
  const token = async (sub) => {
    if (issued.has(sub)) return issued.get(sub);
    const value = signedToken(material, sub);
    await identity.ensureUser(sub, `${sub.replace(/[^a-z0-9]/gi, "-")}@example.test`);
    // Deterministic grant id: the token hash is itself deterministic.
    await identity.issueCliGrant({
      grantId: `e2-t08-${tokenHash(value).slice(0, 16)}`,
      sub,
      tokenKind: "device",
      tokenHash: tokenHash(value),
      scopes: ["repo:write"],
    });
    issued.set(sub, value);
    return value;
  };
  /** Reconnect to grants already persisted in the store (restart path). */
  const restoredToken = (sub) => signedToken(material, sub);
  return {
    baseUrl,
    officialUrl,
    streams,
    identity,
    namespaces,
    projector,
    token,
    restoredToken,
    material,
    async stop() {
      projector.stop();
      await new Promise((resolve) => server.close(resolve));
      await official.stop();
      // Terminate the permission-denied namespace runtime child explicitly so
      // the harness process exits as soon as its work is done (run-3 verdict:
      // e2_t08_refusals.mjs printed OK then stalled until SIGTERM).
      namespaces.terminate();
    },
  };
}

export async function dispatchHttp(fixture, streamId, type, payload, ts, sub) {
  const response = await fetch(`${fixture.baseUrl}/api/dispatch`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(sub === undefined ? {} : { authorization: `Bearer ${await fixture.token(sub)}` }),
    },
    body: JSON.stringify({ streamId, event: { type, payload, ts } }),
  });
  return response;
}

export async function seedIdentities(fixture) {
  const { alice, bob, carol, dave } = SUBJECTS;
  for (const sub of [alice, bob, carol, dave]) {
    await fixture.identity.ensureUser(sub, `${sub.replace(/[^a-z0-9]/gi, "-")}@example.test`);
  }
  await fixture.identity.createOrg("acme", "acme", alice);
  await fixture.identity.createOrg("beta", "beta", bob);
  await fixture.identity.grantMembership("acme", carol, "member");
}

/** The golden (a) lifecycle over the real dispatch door. */
export async function buildLifecycleTree(fixture) {
  const { alice, bob } = SUBJECTS;
  await seedIdentities(fixture);
  const steps = [
    [alice, "ns:root", "ns.org.create", { v: 1, name: "acme" }],
    [alice, "ns:org:acme", "ns.project.create", { v: 1, name: "web" }],
    [
      alice,
      "ns:org:acme",
      "ns.repo.create",
      { v: 1, name: "forest", project: "web", visibility: "public" },
    ],
    [
      alice,
      "ns:org:acme",
      "ns.repo.create",
      { v: 1, name: "secret", project: "web", visibility: "private" },
    ],
    [bob, "ns:root", "ns.org.create", { v: 1, name: "beta" }],
    [bob, "ns:org:beta", "ns.project.create", { v: 1, name: "api" }],
    [
      bob,
      "ns:org:beta",
      "ns.repo.create",
      { v: 1, name: "edge", project: "api", visibility: "private" },
    ],
    [
      bob,
      "ns:org:beta",
      "ns.repo.create",
      { v: 1, name: "open", project: "api", visibility: "public" },
    ],
    [alice, "ns:org:acme", "ns.repo.rename", { v: 1, name: "forest", newName: "grove" }],
    [bob, "ns:org:beta", "ns.repo.set-visibility", { v: 1, name: "edge", visibility: "public" }],
    [
      alice,
      "ns:org:acme",
      "ns.repo.set-visibility",
      { v: 1, name: "grove", visibility: "private" },
    ],
  ];
  for (const [index, [sub, streamId, type, payload]] of steps.entries()) {
    const response = await dispatchHttp(fixture, streamId, type, payload, index + 1, sub);
    if (response.status !== 202) {
      throw new Error(`lifecycle dispatch refused: ${response.status} ${await response.text()}`);
    }
  }
  await awaitRegistryLength(fixture, steps.length);
  return steps.length;
}

// 15s default, matching the vitest twin in registry.helpers.ts — the run-3
// verdict flagged the 5s lib default as an unrecorded budget of the exact
// load-starvation class that refuted run 2.
export async function awaitRegistryLength(fixture, count, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const records = await fixture.streams.read("__registry__");
      if (records.length >= count) return records;
    } catch {
      // not created yet
    }
    if (Date.now() > deadline) {
      throw new Error(`__registry__ did not reach ${count} events in time`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Raw-text SSE tail — no SSE library on the assertion path. Senses tail
 * LIVENESS, not just frames (run-3 verdict: a tail the server closed early is
 * otherwise indistinguishable from a connected suppressed one): every `:`
 * keep-alive heartbeat block's receipt time is recorded, and a stream the
 * server ends (reader `done`) or errors without a local close() marks
 * `closedByServer`. `assertAliveSince(sinceMs, label)` is the hold-instant
 * sensor: the stream must still be open AND a heartbeat (or frame) must have
 * arrived at-or-after `sinceMs` — a dead connection fails both ways.
 */
export async function openSseTail(url, headers) {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  if (response.status !== 200 || response.body === null) {
    controller.abort();
    throw new Error(`SSE tail failed: ${response.status}`);
  }
  const frames = [];
  const heartbeats = [];
  let locallyClosed = false;
  let closedByServer = false;
  const decoder = new TextDecoder();
  let buffered = "";
  const reader = response.body.getReader();
  (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        if (!locallyClosed) closedByServer = true;
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = buffered.indexOf("\n\n");
        if (boundary < 0) break;
        const block = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        if (block.startsWith(":")) {
          heartbeats.push(Date.now());
          continue;
        }
        const lines = block.split("\n");
        const id = lines.find((line) => line.startsWith("id: "))?.slice(4);
        const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
        if (id !== undefined && data !== undefined) frames.push({ id, data, atMs: Date.now() });
      }
    }
  })().catch(() => {
    if (!locallyClosed) closedByServer = true;
  });
  return {
    frames,
    heartbeats,
    get closedByServer() {
      return closedByServer;
    },
    assertAliveSince(sinceMs, label) {
      if (closedByServer) {
        throw new Error(`${label} not alive at the held instant (stream closed by server)`);
      }
      const activity = [...heartbeats, ...frames.map((frame) => frame.atMs)];
      if (!activity.some((atMs) => atMs >= sinceMs)) {
        throw new Error(
          `${label} not alive at the held instant (no heartbeat or frame received since ${sinceMs})`,
        );
      }
    },
    close: () => {
      locallyClosed = true;
      controller.abort();
    },
    async waitForFrame(count, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (frames.length < count) {
        if (Date.now() > deadline) throw new Error(`no SSE frame ${count} in ${timeoutMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}
