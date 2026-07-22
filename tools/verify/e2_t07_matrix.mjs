#!/usr/bin/env node
// E2-T07: the real-HTTP authorization matrix.
//
// Drives the production wiring (GrantAwareVerifier over a replayed
// IdentityStore, NamespaceDispatcher, PlatformGateway) over real HTTP against
// Auth0-emulator-issued identities and the published Durable Streams
// reference server, and holds three committed goldens:
//
//   evidence/e2-t07-decision-matrix.txt   the pure decision for every
//                                         principal x visibility x operation
//                                         combination, computed from the
//                                         replayed identity + namespace views
//   evidence/e2-t07-http-matrix.txt       the observed HTTP door behavior for
//                                         the same combinations, plus the
//                                         revocation-at-offset sequence
//   evidence/e2-t07-no-side-effect.txt    per-stream SHA-256 digests proving
//                                         every refused operation left every
//                                         log byte-identical and minted no
//                                         stream
//
// The whole scenario runs TWICE against fresh servers and both transcripts
// must be byte-identical before either is compared to the committed golden —
// nondeterministic evidence never reaches the goldens.
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL, URLSearchParams } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TASK = path.join(ROOT, ".eforest/tasks/epic-2-the-gates/E2-T07-per-stream-authorization");
const EVIDENCE = path.join(TASK, "evidence");
const EMULATE = path.join(ROOT, "vendor/emulate");
const AUTH0 = path.join(EMULATE, "packages/@emulators/auth0");
const BASE_URL = "http://127.0.0.1:43884";
const CALLBACK = "http://127.0.0.1:43885/callback";
const NOW = 1_700_000_000;
const CLIENT_ID = "eforest-platform";
const CLIENT_SECRET = "eforest-platform-secret";
const AUDIENCE = "eforest-api";
const KID = "eforest-test-2026";
const VERIFIER = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const EXPECTED_PIN = "82eb835947c97fcf6e0596a4377acbb01ca13ede";
const PASSWORD = "MatrixTest1234!";
const USERS = ["owner", "admin", "member", "outsider", "reader", "writer", "revoked", "badscope"];

const writeGolden = process.argv.includes("--write-golden");

function readSigningConfig() {
  const privateJwk = JSON.parse(
    fs.readFileSync(path.join(AUTH0, "fixtures/test-keypair.private.jwk.json"), "utf8"),
  );
  const publicJwk = JSON.parse(
    fs.readFileSync(path.join(AUTH0, "fixtures/test-keypair.public.jwk.json"), "utf8"),
  );
  const privateKey = createPrivateKey({ key: privateJwk, format: "jwk" });
  return {
    privateKeyPem: String(privateKey.export({ format: "pem", type: "pkcs8" })),
    publicKeyPem: String(
      createPublicKey({ key: publicJwk, format: "jwk" }).export({ format: "pem", type: "spki" }),
    ),
  };
}

function emulatorOptions() {
  const signing = readSigningConfig();
  return {
    service: "auth0",
    port: 43884,
    baseUrl: BASE_URL,
    now: NOW,
    seedMaterial: "electric-forest-e2-t07-v1",
    seed: {
      auth0: {
        now: NOW,
        seed: "electric-forest-e2-t07-v1",
        connections: [{ name: "Username-Password-Authentication" }],
        users: USERS.map((name) => ({
          email: `${name}@example.test`,
          password: PASSWORD,
          user_id: `e2-t07-${name}`,
          email_verified: true,
          name: `E2-T07 ${name}`,
        })),
        oauth_clients: [
          {
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            redirect_uris: [CALLBACK],
            grant_types: ["authorization_code"],
            audience: AUDIENCE,
          },
        ],
        signing_key: {
          private_key_pem: signing.privateKeyPem,
          public_key_pem: signing.publicKeyPem,
          kid: KID,
        },
      },
    },
  };
}

async function loadModules() {
  const emulateApi = path.join(EMULATE, "packages/emulate/dist/api.js");
  const platformApi = path.join(ROOT, "packages/platform/dist/src/index.js");
  const serverApi = path.join(ROOT, "packages/server/dist/src/index.js");
  const identityApi = path.join(ROOT, "packages/identity/dist/src/index.js");
  const clientApi = path.join(ROOT, "packages/client/dist/src/index.js");
  for (const file of [emulateApi, platformApi, serverApi, identityApi, clientApi]) {
    assert.ok(
      fs.existsSync(file),
      `required built module is missing: ${path.relative(ROOT, file)}`,
    );
  }
  return {
    emulate: await import(`${pathToFileURL(emulateApi).href}?pin=${EXPECTED_PIN}`),
    platform: await import(`${pathToFileURL(platformApi).href}?task=E2-T07`),
    server: await import(`${pathToFileURL(serverApi).href}?task=E2-T07`),
    identity: await import(`${pathToFileURL(identityApi).href}?task=E2-T07`),
    client: await import(`${pathToFileURL(clientApi).href}?task=E2-T07`),
  };
}

async function issueToken(email) {
  const challenge = createHash("sha256").update(VERIFIER).digest("base64url");
  const login = await fetch(`${BASE_URL}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
      scope: "openid profile email",
      audience: AUDIENCE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "e2-t07-state",
      nonce: "e2-t07-nonce",
      email,
      password: PASSWORD,
    }),
  });
  assert.equal(login.status, 302, `authorize for ${email}`);
  const code = new URL(login.headers.get("location")).searchParams.get("code");
  assert.ok(code, `code for ${email}`);
  const response = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: CALLBACK,
      code_verifier: VERIFIER,
    }),
  });
  assert.equal(response.status, 200, `token for ${email}`);
  const body = await response.json();
  assert.equal(body.access_token.split(".").length, 3);
  return body.access_token;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function runScenario(modules) {
  const lines = { decision: [], http: [], sideEffect: [] };
  const emulator = await modules.emulate.createEmulator(emulatorOptions());
  const createdStreamIds = [];
  const official = modules.server.createDurableStreamTestServer({
    host: "127.0.0.1",
    port: 0,
    onStreamCreated: ({ path: streamPath }) => createdStreamIds.push(streamPath),
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const officialUrl = await official.start();
    const {
      BearerVerifier,
      GrantAwareVerifier,
      IdentityStore,
      NamespaceDispatcher,
      OfficialStreamAdapter,
      createPlatformHandler,
      createPlatformServer,
      listenPlatformServer,
      composeNamespaceView,
      decideStreamAuthorization,
      repoTargetFromPath,
      classifyDispatchTarget,
      tokenHash,
    } = modules.platform;
    const { identityReducer, emptyView } = modules.identity;

    const adapter = new OfficialStreamAdapter({ baseUrl: officialUrl });
    const namespaces = new NamespaceDispatcher(adapter);
    const identity = new IdentityStore({
      baseUrl: officialUrl,
      now: () => NOW * 1000,
      recoverNamespaceOperation: (operationId, operation) =>
        namespaces.recover(operationId, operation.streamId, operation.event),
    });
    await identity.ensure();
    await namespaces.reconcile();
    const bearer = new BearerVerifier({
      issuer: BASE_URL,
      audience: AUDIENCE,
      now: () => NOW * 1000,
    });
    let operationOrdinal = 0;
    const verifier = new GrantAwareVerifier({
      bearer,
      identity,
      operationId: () => `e2-t07-operation-${++operationOrdinal}`,
    });
    const server = createPlatformServer(
      createPlatformHandler({ verifier, streams: adapter, namespaces }),
    );
    const platformUrl = await listenPlatformServer(server);
    const stop = () => new Promise((resolve) => server.close(() => resolve()));

    try {
      // --- Auth0 emulator identities ---------------------------------------
      const tokens = {};
      for (const name of USERS) tokens[name] = await issueToken(`${name}@example.test`);
      const subs = Object.fromEntries(USERS.map((name) => [name, `auth0|e2-t07-${name}`]));

      // --- grants (the capability join key is the presented grant) ---------
      const scopes = {
        owner: ["repo:write:acme/forest:main", "repo:write:acme/secret:main"],
        admin: [],
        member: [],
        outsider: [],
        reader: ["repo:read:acme/secret"],
        writer: ["repo:write:acme/secret:main"],
        revoked: ["repo:read:acme/secret", "repo:write:acme/secret:main"],
        // A write scope whose branch segment is empty or malformed is not a
        // capability: it must neither write nor confer the private read.
        badscope: ["repo:write:acme/secret:", "repo:write:acme/secret:bad branch"],
      };
      const grants = {};
      for (const name of USERS) {
        await identity.ensureUser(subs[name], `${name}@example.test`);
        grants[name] = `e2-t07-grant-${name}`;
        await identity.issueCliGrant({
          grantId: grants[name],
          sub: subs[name],
          tokenKind: "device",
          tokenHash: tokenHash(tokens[name]),
          scopes: [...scopes[name]].sort(),
        });
      }
      await identity.createOrg("acme", "acme", subs.owner);
      await identity.grantMembership("acme", subs.admin, "admin");
      await identity.grantMembership("acme", subs.member, "member");

      // --- namespace + branch streams, seeded through the door -------------
      const post = (streamId, event, token) =>
        fetch(`${platformUrl}/api/dispatch`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          },
          body: JSON.stringify({ streamId, event }),
        });
      const get = (route, token) =>
        fetch(`${platformUrl}${route}`, {
          headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
        });
      const getRawAuth = (route, header) =>
        fetch(`${platformUrl}${route}`, { headers: { authorization: header } });
      const nsEvents = [
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
      ];
      for (const [streamId, event] of nsEvents) {
        assert.equal((await post(streamId, event, tokens.owner)).status, 202, event.type);
      }
      await adapter.create("fs:acme/forest:main:meta");
      await adapter.create("fs:acme/secret:main:meta");
      for (const repo of ["forest", "secret"]) {
        const seeded = await post(
          `fs:acme/${repo}:main:meta`,
          { type: "repo.seeded", payload: { repo }, ts: 10 },
          tokens.owner,
        );
        assert.equal(seeded.status, 202, `seed ${repo}`);
      }
      await identity.revokeCliGrant(grants.revoked);

      // --- the pure decision matrix from the replayed views ----------------
      // The offset cited is the durable identity stream's transport head —
      // the same domain IdentitySnapshot.offset (and therefore every HTTP
      // response) cites.
      const identitySnapshot = await modules.client.readDurableJsonSnapshot({
        url: `${officialUrl}/streams/${encodeURIComponent("__identity__")}`,
      });
      const identityView = identitySnapshot.items.reduce(
        (view, record) =>
          identityReducer(view, { type: record.type, payload: record.payload, ts: record.ts }),
        emptyView(),
      );
      const identityOffset = identitySnapshot.offset;
      const namespaceView = composeNamespaceView(await adapter.read("ns:root"), {
        "ns:org:acme": await adapter.read("ns:org:acme"),
      });
      const principals = {
        anonymous: { kind: "anonymous" },
        owner: { kind: "identified", sub: subs.owner, grantId: grants.owner },
        admin: { kind: "identified", sub: subs.admin, grantId: grants.admin },
        member: { kind: "identified", sub: subs.member, grantId: grants.member },
        outsider: { kind: "identified", sub: subs.outsider, grantId: grants.outsider },
        reader: { kind: "identified", sub: subs.reader, grantId: grants.reader },
        writer: { kind: "identified", sub: subs.writer, grantId: grants.writer },
        revoked: { kind: "identified", sub: subs.revoked, grantId: grants.revoked },
        badscope: { kind: "identified", sub: subs.badscope, grantId: grants.badscope },
      };
      const repoTargets = {
        public: repoTargetFromPath("acme", "forest", "main"),
        private: repoTargetFromPath("acme", "secret", "main"),
        "missing-repo": repoTargetFromPath("acme", "ghost", "main"),
        "missing-org": repoTargetFromPath("nowhere", "ghost", "main"),
        malformed: repoTargetFromPath("ACME", "forest", "ma in"),
        internal: classifyDispatchTarget("__identity__", "application"),
        "ns-internal": classifyDispatchTarget("ns:org:acme", "application"),
        sandbox: classifyDispatchTarget("e2-t07-sandbox", "application"),
      };
      lines.decision.push(
        "E2-T07 pure decision matrix",
        `identity-offset=${identityOffset}`,
        "principal x target x operation -> decideStreamAuthorization",
      );
      for (const [principalName, principal] of Object.entries(principals)) {
        for (const [targetName, target] of Object.entries(repoTargets)) {
          for (const operation of ["read", "follow", "dispatch"]) {
            const decision = decideStreamAuthorization({
              operation,
              target,
              principal,
              ...(operation === "dispatch" ? { eventKind: "application" } : {}),
              identity: identityView,
              identityOffset,
              namespace: namespaceView,
            });
            lines.decision.push(
              `decision principal=${principalName} target=${targetName} op=${operation} -> ${JSON.stringify(decision)}`,
            );
          }
        }
      }
      // The load-bearing invariant, asserted over the emitted matrix:
      // private-unauthorized === nonexistent, byte for byte.
      for (const principalName of ["anonymous", "outsider", "badscope"]) {
        for (const operation of ["read", "follow", "dispatch"]) {
          const decisionFor = (targetName) =>
            JSON.stringify(
              decideStreamAuthorization({
                operation,
                target: repoTargets[targetName],
                principal: principals[principalName],
                ...(operation === "dispatch" ? { eventKind: "application" } : {}),
                identity: identityView,
                identityOffset,
                namespace: namespaceView,
              }),
            );
          assert.equal(decisionFor("private"), decisionFor("missing-repo"));
          assert.equal(decisionFor("private"), decisionFor("missing-org"));
        }
      }
      lines.decision.push("private-vs-nonexistent=byte-identical", "E2_T07_DECISION_MATRIX_OK", "");

      // --- the refused HTTP phase, with per-stream no-side-effect digests --
      const streamIds = () =>
        [...createdStreamIds].sort().map((p) => decodeURIComponent(p.replace(/^\/streams\//, "")));
      const streamStates = async () => {
        const states = {};
        for (const id of streamIds()) {
          const response = await fetch(`${officialUrl}/streams/${encodeURIComponent(id)}`);
          states[id] = digest(`${response.status}:${await response.text()}`);
        }
        return states;
      };
      const record = async (label, responsePromise) => {
        const response = await responsePromise;
        const body = await response.text();
        lines.http.push(`http case=${label} status=${response.status} body=${body}`);
        return { status: response.status, body };
      };

      lines.http.push(
        "E2-T07 real-HTTP authorization matrix",
        `platform=production-wiring official=durable-streams-reference auth0=emulator-pin-${EXPECTED_PIN.slice(0, 12)}`,
      );
      const before = await streamStates();
      const createdBefore = createdStreamIds.length;
      const refusedCases = [];
      const repoRoutes = {
        public: "/api/repos/acme/forest/main/events",
        private: "/api/repos/acme/secret/main/events",
        "missing-repo": "/api/repos/acme/ghost/main/events",
        "missing-org": "/api/repos/nowhere/ghost/main/events",
      };
      const dispatchStreams = {
        public: "fs:acme/forest:main:meta",
        private: "fs:acme/secret:main:meta",
        "missing-repo": "fs:acme/ghost:main:meta",
        "missing-org": "fs:nowhere/ghost:main:meta",
      };
      const principalTokens = {
        anonymous: undefined,
        owner: tokens.owner,
        admin: tokens.admin,
        member: tokens.member,
        outsider: tokens.outsider,
        reader: tokens.reader,
        writer: tokens.writer,
        revoked: tokens.revoked,
        badscope: tokens.badscope,
      };
      for (const [principalName, token] of Object.entries(principalTokens)) {
        for (const [targetName, route] of Object.entries(repoRoutes)) {
          const read = await record(`read.${principalName}.${targetName}`, get(route, token));
          const follow = await record(
            `follow.${principalName}.${targetName}`,
            get(`${route}?live=1&waitMs=100`, token),
          );
          for (const result of [read, follow]) {
            if (result.status !== 200) refusedCases.push(result);
          }
          // Dispatches in the refused phase: every combination EXCEPT the
          // grants that would be accepted (owner->public, writer/owner->private),
          // which run in the accepted phase below.
          const accepted =
            (principalName === "owner" && (targetName === "public" || targetName === "private")) ||
            (principalName === "writer" && targetName === "private");
          if (!accepted) {
            const dispatch = await record(
              `dispatch.${principalName}.${targetName}`,
              post(
                dispatchStreams[targetName],
                { type: "matrix.write", payload: { by: principalName }, ts: 100 },
                token,
              ),
            );
            assert.notEqual(dispatch.status, 202, `dispatch.${principalName}.${targetName}`);
            refusedCases.push(dispatch);
          }
        }
      }
      // Encoded separators, malformed ids, internal streams, bad routes.
      const probes = [
        ["probe.encoded-org", get("/api/repos/acme%2Fsecret/x/main/events", tokens.outsider)],
        ["probe.encoded-branch", get("/api/repos/acme/secret/main%2Fevil/events")],
        ["probe.uppercase", get("/api/repos/ACME/secret/main/events")],
        ["probe.double-encoded", get("/api/repos/acme%252Fsecret/x/main/events")],
        ["probe.route-shape", get("/api/repos/acme/secret/main")],
        [
          "probe.internal-identity",
          post("__identity__", { type: "x", payload: {}, ts: 1 }, tokens.outsider),
        ],
        [
          "probe.internal-ns",
          post("ns:org:acme", { type: "x", payload: {}, ts: 1 }, tokens.outsider),
        ],
        [
          "probe.fs-malformed",
          post("fs:acme/secret:main:journal", { type: "x", payload: {}, ts: 1 }, tokens.outsider),
        ],
        [
          "probe.fs-traversal",
          post("fs:acme/../evil:main:meta", { type: "x", payload: {}, ts: 1 }, tokens.outsider),
        ],
        ["probe.revoked-read", get("/api/repos/acme/secret/main/events", tokens.revoked)],
        // Undecodable percent-escapes: refused as malformed from the request
        // text alone, before any view or stream is consulted.
        ["probe.undecodable-org", get("/api/repos/%zz/x/main/events")],
        ["probe.undecodable-overlong", get("/api/repos/%c0%af/x/main/events")],
        ["probe.truncated-escape", get("/api/repos/acme/x/%/events")],
        // Credential failures on the read route map through the same taxonomy.
        [
          "probe.basic-authorization",
          getRawAuth("/api/repos/acme/forest/main/events", "Basic dXNlcjpwYXNz"),
        ],
        ["probe.garbage-bearer", get("/api/repos/acme/forest/main/events", "aaaa.bbbb.cccc")],
        // Degenerate follow parameters are bounded before any stream access.
        ["probe.follow-negative-after", get("/api/repos/acme/forest/main/events?live=1&after=-1")],
        [
          "probe.follow-oversized-wait",
          get("/api/repos/acme/forest/main/events?live=1&waitMs=20001"),
        ],
      ];
      for (const [label, responsePromise] of probes) {
        const result = await record(label, responsePromise);
        assert.ok(result.status >= 400, label);
        refusedCases.push(result);
      }
      const after = await streamStates();
      assert.equal(createdStreamIds.length, createdBefore, "a refused operation minted a stream");
      assert.deepEqual(after, before, "a refused operation moved a log byte");
      lines.sideEffect.push(
        "E2-T07 no-side-effect proof",
        `refused-cases=${refusedCases.length}`,
        `streams=${Object.keys(before).length}`,
        "per-stream SHA-256 digests captured before and after every refused case:",
        ...Object.entries(before).map(
          ([id, value]) => `stream ${id} digest=${value} unchanged=${after[id] === value}`,
        ),
        `created-streams-delta=${createdStreamIds.length - createdBefore}`,
        "E2_T07_NO_SIDE_EFFECT_OK",
        "",
      );

      // --- accepted dispatches + the revocation-at-offset sequence ---------
      const acceptedOwner = await record(
        "accepted.owner.public",
        post(
          "fs:acme/forest:main:meta",
          { type: "matrix.write", payload: { by: "owner" }, ts: 101 },
          tokens.owner,
        ),
      );
      assert.equal(acceptedOwner.status, 202);
      const ownerOffset = JSON.parse(acceptedOwner.body).identityOffset;
      assert.match(ownerOffset, /^\d{16}_\d{16}$/);
      const acceptedWriter = await record(
        "accepted.writer.private",
        post(
          "fs:acme/secret:main:meta",
          { type: "matrix.write", payload: { by: "writer" }, ts: 102 },
          tokens.writer,
        ),
      );
      assert.equal(acceptedWriter.status, 202);

      // Live follow through the door: subscribe past the current events,
      // then dispatch, and the follow returns exactly the new event.
      const followPromise = get(
        "/api/repos/acme/forest/main/events?live=1&after=2&waitMs=8000",
        undefined,
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      const liveDispatch = await record(
        "accepted.owner.live",
        post(
          "fs:acme/forest:main:meta",
          { type: "matrix.live", payload: { by: "owner" }, ts: 103 },
          tokens.owner,
        ),
      );
      assert.equal(liveDispatch.status, 202);
      const followResult = await record("follow.live.public", followPromise);
      assert.equal(followResult.status, 200);
      const followBody = JSON.parse(followResult.body);
      assert.deepEqual(
        followBody.events.map((event) => event.type),
        ["matrix.live"],
      );

      // Revocation takes effect at the next replayed offset, no restart:
      // writer dispatched at an offset BEFORE this revocation...
      const writerRevocation = await identity.revokeCliGrant(grants.writer);
      lines.http.push(`revocation grant=${grants.writer} offset=${writerRevocation.offset}`);
      const refusedWriter = await record(
        "revoked.writer.private",
        post(
          "fs:acme/secret:main:meta",
          { type: "matrix.write", payload: { by: "writer" }, ts: 104 },
          tokens.writer,
        ),
      );
      assert.equal(refusedWriter.status, 401);
      const refusedBody = JSON.parse(refusedWriter.body);
      assert.equal(refusedBody.error.reason, "authz/grant-revoked");
      assert.ok(
        refusedBody.error.identityOffset >= writerRevocation.offset,
        "refusal must cite an offset at or after the revocation",
      );
      const writerAccepted = JSON.parse(acceptedWriter.body);
      assert.ok(
        writerAccepted.identityOffset < writerRevocation.offset,
        "acceptance must cite an offset before the revocation",
      );
      lines.http.push(
        `revocation-ordering accepted-offset=${writerAccepted.identityOffset} < revocation-offset=${writerRevocation.offset} <= refused-offset=${refusedBody.error.identityOffset}`,
        "E2_T07_HTTP_MATRIX_OK",
        "",
      );
    } finally {
      await stop();
    }
  } finally {
    await Promise.allSettled([emulator.close(), official.stop()]);
  }
  return {
    decision: `${lines.decision.join("\n")}\n`,
    http: `${lines.http.join("\n")}\n`,
    sideEffect: `${lines.sideEffect.join("\n")}\n`,
  };
}

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const modules = await loadModules();
  const first = await runScenario(modules);
  const second = await runScenario(modules);
  assert.deepEqual(second, first, "the matrix is nondeterministic across fresh servers");

  const goldens = [
    ["e2-t07-decision-matrix.txt", first.decision],
    ["e2-t07-http-matrix.txt", first.http],
    ["e2-t07-no-side-effect.txt", first.sideEffect],
  ];
  for (const [name, transcript] of goldens) {
    const file = path.join(EVIDENCE, name);
    if (writeGolden) {
      fs.writeFileSync(file, transcript);
    } else {
      assert.ok(fs.existsSync(file), `committed golden is missing: ${name}`);
      assert.equal(transcript, fs.readFileSync(file, "utf8"), `${name} drifted from the golden`);
    }
  }
  console.log(
    JSON.stringify({
      status: "E2_T07_MATRIX_OK",
      runs: 2,
      deterministic: true,
      goldens: goldens.map(([name]) => name),
    }),
  );
}

await main();
