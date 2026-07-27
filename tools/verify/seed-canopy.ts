#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TASK = path.join(ROOT, ".eforest/tasks/epic-3-the-canopy/E3-T01-seed-corpus-golden-digests");
const AUTH0 = path.join(ROOT, "vendor/emulate/packages/@emulators/auth0");
const EMULATE_API = path.join(ROOT, "vendor/emulate/packages/emulate/dist/api.js");
const CLIENT_ID = "eforest-canopy";
const CLIENT_SECRET = "eforest-canopy-secret";
const AUDIENCE = "eforest-api";
const ISSUER = "http://auth0.canopy.test";
const CALLBACK = "http://client.canopy.test/callback";
const PASSWORD = "CanopyTest1234!";
const NOW_SECONDS = 1_700_000_000;
const LOGICAL_START = 1_700_000_000_000;
const VERIFIER = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const SUBJECTS = Object.freeze({
  mapleAdmin: "auth0|canopy-maple-admin",
  mapleMember: "auth0|canopy-maple-member",
  willowAdmin: "auth0|canopy-willow-admin",
  willowMember: "auth0|canopy-willow-member",
});
const USERS = Object.freeze([
  ["maple-admin", SUBJECTS.mapleAdmin],
  ["maple-member", SUBJECTS.mapleMember],
  ["willow-admin", SUBJECTS.willowAdmin],
  ["willow-member", SUBJECTS.willowMember],
]);

function option(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function manifestKey(stream) {
  return stream.replaceAll(":", "_").replaceAll("/", "_").replaceAll("@", "_");
}

function streamUrl(baseUrl, streamId) {
  return `${baseUrl.replace(/\/+$/, "")}/streams/${encodeURIComponent(streamId)}`;
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function signingConfig() {
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
    baseUrl: ISSUER,
    now: NOW_SECONDS,
    seedMaterial: "electric-forest-e3-t01-v1",
    seed: {
      auth0: {
        now: NOW_SECONDS,
        seed: "electric-forest-e3-t01-v1",
        connections: [{ name: "Username-Password-Authentication" }],
        users: USERS.map(([name]) => ({
          email: `${name}@example.test`,
          password: PASSWORD,
          user_id: `canopy-${name}`,
          email_verified: true,
          name: `Canopy ${name}`,
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
          kid: "eforest-canopy-2026",
        },
      },
    },
  };
}

async function loadModules() {
  const required = [
    EMULATE_API,
    path.join(ROOT, "packages/client/dist/src/index.js"),
    path.join(ROOT, "packages/identity/dist/src/index.js"),
    path.join(ROOT, "packages/platform/dist/src/index.js"),
    path.join(ROOT, "packages/protocol/dist/src/index.js"),
    path.join(ROOT, "packages/server/dist/src/index.js"),
    path.join(ROOT, "packages/streamfs/dist/src/index.js"),
  ];
  for (const file of required) assert.ok(fs.existsSync(file), `missing built module: ${file}`);
  return {
    emulate: await import(`${pathToFileURL(EMULATE_API).href}?e3-t01`),
    client: await import(`${pathToFileURL(required[1]).href}?e3-t01`),
    identity: await import(`${pathToFileURL(required[2]).href}?e3-t01`),
    platform: await import(`${pathToFileURL(required[3]).href}?e3-t01`),
    protocol: await import(`${pathToFileURL(required[4]).href}?e3-t01`),
    server: await import(`${pathToFileURL(required[5]).href}?e3-t01`),
    streamfs: await import(`${pathToFileURL(required[6]).href}?e3-t01`),
  };
}

async function issueToken(emulatorOrigin, name) {
  const challenge = createHash("sha256").update(VERIFIER).digest("base64url");
  const login = await fetch(`${emulatorOrigin}/authorize`, {
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
      state: `canopy-${name}`,
      nonce: `canopy-${name}`,
      email: `${name}@example.test`,
      password: PASSWORD,
    }),
  });
  assert.equal(login.status, 302, `authorize ${name}`);
  const location = login.headers.get("location");
  assert.ok(location, `authorize location ${name}`);
  const code = new URL(location).searchParams.get("code");
  assert.ok(code, `authorize code ${name}`);
  const response = await fetch(`${emulatorOrigin}/oauth/token`, {
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
  assert.equal(response.status, 200, `token ${name}`);
  const body = await response.json();
  assert.equal(typeof body.access_token, "string");
  assert.equal(body.access_token.split(".").length, 3);
  return body.access_token;
}

function canonicalDump(records, canonicalJson) {
  return `${records.map((record) => canonicalJson(record)).join("\n")}\n`;
}

function reducerFor(stream) {
  if (stream === "__identity__") return "packages/identity/reducer.mjs";
  if (stream === "__registry__") return "packages/platform/registry-reducer.mjs";
  if (stream.startsWith("ns:")) return "packages/platform/ns-reducer.mjs";
  if (/^fs:.*:file:/.test(stream)) return "tools/verify/canopy-content-reducer.mjs";
  if (/^fs:.*:meta$/.test(stream)) return "packages/streamfs/reducer.mjs";
  throw new Error(`unknown stream reducer: ${stream}`);
}

function replayDigest(dump, stream) {
  return execFileSync(
    process.execPath,
    [
      path.join(ROOT, "packages/cli/dist/src/bin.js"),
      "replay",
      dump,
      "--digest",
      "--reducer",
      path.join(ROOT, reducerFor(stream)),
    ],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

async function rawStream(baseUrl, streamId) {
  const response = await fetch(streamUrl(baseUrl, streamId));
  assert.equal(response.status, 200, `read ${streamId}`);
  return response.text();
}

async function writeCorpus(target, streamIds, adapter, canonicalJson, anchors, transcript) {
  const absolute = path.resolve(target);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  if (fs.existsSync(absolute)) {
    assert.equal(fs.readdirSync(absolute).length, 0, `OUT must be absent or empty: ${absolute}`);
    fs.rmdirSync(absolute);
  }
  const staging = fs.mkdtempSync(path.join(path.dirname(absolute), ".canopy-staging-"));
  try {
    fs.mkdirSync(path.join(staging, "dumps"), { recursive: true });
    const keys = new Map();
    const entries = {};
    for (const stream of [...streamIds].sort()) {
      const key = manifestKey(stream);
      const collision = keys.get(key);
      assert.equal(collision, undefined, `manifest key collision: ${collision} and ${stream}`);
      keys.set(key, stream);
      const records = await adapter.read(stream);
      assert.ok(records.length > 0, `seeded stream is empty: ${stream}`);
      const dumpRelative = `dumps/${key}.jsonl`;
      const dump = path.join(staging, dumpRelative);
      fs.writeFileSync(dump, canonicalDump(records, canonicalJson));
      const head = records.at(-1)?.offset;
      assert.equal(typeof head, "string", `missing head offset: ${stream}`);
      entries[key] = {
        stream,
        dump: dumpRelative,
        dump_sha256: sha256(fs.readFileSync(dump)),
        head_offset: head,
        state_digest: replayDigest(dump, stream),
      };
    }
    const manifest = {
      schema: "eforest.canopy-corpus.v1",
      streams: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))),
      anchors,
    };
    fs.writeFileSync(
      path.join(staging, "corpus-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(staging, "e3-t01-privacy-probe.txt"), transcript);
    fs.renameSync(staging, absolute);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function chapter(version) {
  const lines = [
    "# Chapter One",
    "",
    "The canopy keeps a durable account of every change.",
    "Readers can return to any offset and recover the same page.",
    "Branches inherit a common past and then make their own choices.",
    "Renames preserve intent while tombstones preserve history.",
    "Patches stay small enough to inspect and exact enough to replay.",
    "",
  ];
  for (let index = 1; index <= 32; index += 1) {
    lines.push(`Paragraph ${String(index).padStart(2, "0")}: maple leaves record line ${index}.`);
  }
  if (version >= 1) lines[2] = "The canopy keeps a deterministic account of every change.";
  if (version >= 2) lines[4] = "Branches inherit one past and then make independent choices.";
  if (version >= 3) lines[6] = "Patches stay compact, inspectable, and exact enough to replay.";
  return `${lines.join("\n")}\n`;
}

async function run() {
  const work = path.join(TASK, "work");
  fs.mkdirSync(work, { recursive: true });
  const output =
    option("--out") ?? process.env.OUT ?? fs.mkdtempSync(path.join(work, "canopy-output-"));
  const modules = await loadModules();
  const injectedFailure = option("--fail-at");
  const emulatorPort = await unusedPort();
  const emulatorOrigin = `http://127.0.0.1:${emulatorPort}`;
  const emulator = await modules.emulate.createEmulator(emulatorOptions(emulatorPort));
  const createdStreams = new Set();
  const official = modules.server.createDurableStreamTestServer({
    host: "127.0.0.1",
    port: 0,
    onStreamCreated: ({ path: streamPath }) => {
      createdStreams.add(decodeURIComponent(streamPath.replace(/^\/streams\//, "")));
    },
  });
  let platformServer;
  let namespaces;
  let projector;
  const originalDateNow = Date.now;
  let logicalTime = LOGICAL_START;
  Date.now = () => logicalTime++;
  try {
    const officialUrl = await official.start();
    const adapter = new modules.platform.OfficialStreamAdapter({ baseUrl: officialUrl });
    namespaces = new modules.platform.NamespaceDispatcher(adapter);
    const identity = new modules.platform.IdentityStore({
      baseUrl: officialUrl,
      now: () => logicalTime++,
      recoverNamespaceOperation: (operationId, operation) =>
        namespaces.recover(operationId, operation.streamId, operation.event),
    });
    await identity.ensure();
    await namespaces.reconcile();
    const issuerFetch = async (input, init) => {
      const request = input instanceof Request ? input : undefined;
      const requested = new URL(request?.url ?? String(input));
      if (requested.origin === ISSUER) {
        const rewritten = new URL(requested.pathname + requested.search, emulatorOrigin);
        return fetch(rewritten, init);
      }
      return fetch(input, init);
    };
    const bearer = new modules.platform.BearerVerifier({
      issuer: `${ISSUER}/`,
      audience: AUDIENCE,
      now: () => NOW_SECONDS * 1000,
      fetch: issuerFetch,
    });
    let operationOrdinal = 0;
    const verifier = new modules.platform.GrantAwareVerifier({
      bearer,
      identity,
      operationId: () => `canopy-operation-${String(++operationOrdinal).padStart(3, "0")}`,
    });
    projector = new modules.platform.RegistryProjector(adapter);
    const http = modules.platform.createPlatformServer(
      modules.platform.createPlatformHandler({
        verifier,
        streams: adapter,
        namespaces,
        registry: projector,
      }),
    );
    const platformUrl = await modules.platform.listenPlatformServer(http);
    platformServer = http;

    const tokens = {};
    for (const [name] of USERS) tokens[name] = await issueToken(emulatorOrigin, name);
    const scopes = {
      "maple-admin": [
        "repo:read:maple/secret-garden",
        "repo:write:maple/reading-room:feature-typography",
        "repo:write:maple/reading-room:main",
        "repo:write:maple/secret-garden:main",
      ],
      "maple-member": [],
      "willow-admin": ["repo:write:willow/field-notes:main"],
      "willow-member": [],
    };
    for (const [name, sub] of USERS) {
      await identity.ensureUser(sub, `${name}@example.test`);
      await identity.issueCliGrant({
        grantId: `canopy-grant-${name}`,
        sub,
        tokenKind: "device",
        tokenHash: modules.platform.tokenHash(tokens[name]),
        scopes: scopes[name],
        name: `canopy-${name}`,
      });
    }
    await identity.createOrg("maple", "maple", SUBJECTS.mapleAdmin);
    await identity.grantMembership("maple", SUBJECTS.mapleMember, "member");
    await identity.createOrg("willow", "willow", SUBJECTS.willowAdmin);
    await identity.grantMembership("willow", SUBJECTS.willowMember, "member");

    const post = (streamId, event, token) =>
      fetch(`${platformUrl}/api/dispatch`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify({ streamId, event }),
      });
    const beforeTokenless = await rawStream(officialUrl, "ns:root");
    const tokenless = await post(
      "ns:root",
      { type: "ns.org.create", payload: { v: 1, name: "refused" }, ts: 0 },
      undefined,
    );
    assert.equal(tokenless.status, 401);
    assert.deepEqual(await tokenless.json(), {
      error: { code: "unauthorized", reason: "missing_bearer_token" },
    });
    assert.equal(await rawStream(officialUrl, "ns:root"), beforeTokenless);

    const nsActions = [
      [
        "ns:root",
        { type: "ns.org.create", payload: { v: 1, name: "maple" }, ts: 1 },
        "maple-admin",
      ],
      [
        "ns:org:maple",
        { type: "ns.project.create", payload: { v: 1, name: "canopy" }, ts: 2 },
        "maple-admin",
      ],
      [
        "ns:org:maple",
        {
          type: "ns.repo.create",
          payload: { v: 1, name: "reading-room", project: "canopy", visibility: "public" },
          ts: 3,
        },
        "maple-admin",
      ],
      [
        "ns:org:maple",
        {
          type: "ns.repo.create",
          payload: { v: 1, name: "secret-garden", project: "canopy", visibility: "private" },
          ts: 4,
        },
        "maple-admin",
      ],
      [
        "ns:root",
        { type: "ns.org.create", payload: { v: 1, name: "willow" }, ts: 5 },
        "willow-admin",
      ],
      [
        "ns:org:willow",
        { type: "ns.project.create", payload: { v: 1, name: "canopy" }, ts: 6 },
        "willow-admin",
      ],
      [
        "ns:org:willow",
        {
          type: "ns.repo.create",
          payload: { v: 1, name: "field-notes", project: "canopy", visibility: "public" },
          ts: 7,
        },
        "willow-admin",
      ],
    ];
    for (const [streamId, event, actor] of nsActions) {
      if (injectedFailure === "namespace") throw new Error("injected namespace failure");
      const response = await post(streamId, event, tokens[actor]);
      assert.equal(response.status, 202, `${event.type} ${streamId}: ${await response.text()}`);
    }
    await projector.syncOnce();

    async function createRepo(name) {
      if (injectedFailure === "streamfs") throw new Error("injected StreamFS failure");
      await modules.client.createDurableJsonStream({
        url: streamUrl(officialUrl, `fs:${name}:main:meta`),
      });
      return new modules.streamfs.StreamFsRepo(officialUrl, fetch, name);
    }
    const reading = await createRepo("maple/reading-room");
    const secret = await createRepo("maple/secret-garden");
    const field = await createRepo("willow/field-notes");

    await reading.mkdir("docs");
    await reading.mkdir("src");
    await reading.mkdir("notes");
    const files = [
      ["README.md", "# Reading Room\n\nA deterministic library.\n"],
      ["docs/chapter-one.md", chapter(0)],
      ["docs/chapter-two.md", "# Chapter Two\n\nThe branches keep reading.\n"],
      ["src/index.ts", 'export const title = "Reading Room";\n'],
      ["src/theme.css", ":root { color: #163b2c; }\n"],
      ["notes/draft.md", "# Draft\n\nMove this directory.\n"],
      ["guide-old.md", "# Guide\n\nRename this file.\n"],
      ["obsolete.txt", "remove me\n"],
      ["LICENSE", "Seed corpus license fixture.\n"],
      ["CONTRIBUTING.md", "# Contributing\n\nAppend events carefully.\n"],
    ];
    for (const [file, content] of files) {
      await reading.createFile(file, Buffer.from(content));
    }
    await reading.rename("guide-old.md", "guide.md");
    await reading.rename("notes", "archive");
    await reading.deleteFile("obsolete.txt");
    for (let version = 1; version <= 3; version += 1) {
      await reading.writeFile("docs/chapter-one.md", Buffer.from(chapter(version)));
    }
    const beforeFork = await reading.rawDump();
    if (injectedFailure === "fork") throw new Error("injected native fork failure");
    const fork = await reading.createBranch("feature-typography");
    const feature = await reading.openBranch("feature-typography");
    await reading.writeFile(
      "README.md",
      Buffer.from("# Reading Room\n\nMain keeps the durable index current.\n"),
    );
    await feature.writeFile(
      "src/theme.css",
      Buffer.from(":root { color: #163b2c; font-family: serif; }\n"),
    );
    await secret.createFile("README.md", Buffer.from("# Secret Garden\n\nPrivate notes.\n"));
    await field.createFile("README.md", Buffer.from("# Field Notes\n\nWillow observations.\n"));

    const mainRecords = await reading.rawDump();
    const branchRecords = await feature.rawDump();
    const forkEvent = branchRecords.find(
      (record) =>
        record.type === "fs.branch.fork" &&
        record.payload?.parentStreamId === "fs:maple/reading-room:main:meta",
    );
    assert.ok(forkEvent, "fork event missing");
    const patches = mainRecords.filter(
      (record) => record.type === "fs.file.patch" && record.payload?.path === "docs/chapter-one.md",
    );
    assert.ok(patches.length >= 3, `expected three patch events, observed ${patches.length}`);
    const mainPostFork = mainRecords.at(-1);
    const branchPostFork = branchRecords.at(-1);
    assert.ok(mainPostFork && branchPostFork);
    assert.ok(beforeFork.at(-1));

    const allStreams = [...createdStreams].sort();
    const mapleStreams = allStreams.filter((stream) => stream.startsWith("fs:maple/"));
    const secretStreams = mapleStreams.filter((stream) =>
      stream.startsWith("fs:maple/secret-garden:"),
    );
    const readingStreams = mapleStreams.filter((stream) =>
      stream.startsWith("fs:maple/reading-room:"),
    );
    assert.ok(secretStreams.length >= 2);
    assert.ok(readingStreams.length >= 3);
    const transcriptLines = [
      "E3-T01 tenant-first per-stream privacy matrix",
      "ordering=tenant-isolation-before-visibility",
      "gate=BearerVerifier+GrantAwareVerifier+decideTenantAccess+decideStreamAuthorization",
      `tokenless-namespace status=${tokenless.status} class=unauthorized reason=missing_bearer_token neutral=true`,
    ];
    const namespaceViews = new modules.platform.NamespaceViewReader(adapter);
    const principals = [
      ["willow-member", tokens["willow-member"]],
      ["anonymous", undefined],
      ["maple-admin", tokens["maple-admin"]],
    ];
    for (const stream of mapleStreams) {
      const target = modules.platform.classifyDispatchTarget(stream, "application");
      assert.equal(target.kind, "repo", `privacy target grammar: ${stream}`);
      for (const [principal, token] of principals) {
        const header = token === undefined ? null : `Bearer ${token}`;
        const context = await verifier.authorizationContext(header);
        const subject = context.principal.kind === "identified" ? context.principal.sub : null;
        const before = sha256(await rawStream(officialUrl, stream));
        const tenant = modules.platform.decideTenantAccess(context.identity, subject, target.org);
        const decision = tenant.allowed
          ? modules.platform.decideStreamAuthorization({
              operation: "read",
              target,
              principal: context.principal,
              identity: context.identity,
              identityOffset: context.identityOffset,
              namespace: await namespaceViews.viewFor(target.org),
            })
          : {
              allowed: false,
              operation: "read",
              identityOffset: context.identityOffset,
              refusal: "authz/not-found",
            };
        let status;
        let body;
        if (decision.allowed) {
          const events = await adapter.read(decision.streamId);
          status = 200;
          body = {
            ok: true,
            streamId: decision.streamId,
            count: events.length,
            headOffset: events.at(-1)?.offset ?? "-1",
            identityOffset: decision.identityOffset,
            basis: decision.basis,
          };
        } else {
          status =
            decision.refusal === "authz/grant-revoked" ||
            decision.refusal === "authz/unauthenticated"
              ? 401
              : decision.refusal === "authz/write-grant-required"
                ? 403
                : 404;
          body = {
            error: {
              code: "authz_refused",
              reason: decision.refusal,
              identityOffset: decision.identityOffset,
            },
          };
        }
        const privateRepo = stream.startsWith("fs:maple/secret-garden:");
        const expected =
          principal === "willow-member" || (principal === "anonymous" && privateRepo) ? 404 : 200;
        assert.equal(status, expected, `${principal} ${stream}`);
        const after = sha256(await rawStream(officialUrl, stream));
        assert.equal(after, before, `privacy probe mutated ${stream}`);
        transcriptLines.push(
          modules.protocol.canonicalJson({
            stream,
            principal,
            status,
            body,
            neutral: true,
            beforeSha256: before,
            afterSha256: after,
          }),
        );
      }
    }
    transcriptLines.push("E3_T01_PRIVACY_OK");

    await projector.syncOnce();
    const anchors = {
      fork_offset: forkEvent.offset,
      fork_parent_offset: fork.forkOffset,
      patch_offsets: patches.map((record) => record.offset),
      tombstoned_path: "obsolete.txt",
      renamed_from: { file: "guide-old.md", directory: "notes" },
      renamed_to: { file: "guide.md", directory: "archive" },
      post_fork_offsets: {
        main: mainPostFork.offset,
        feature_typography: branchPostFork.offset,
      },
    };
    await writeCorpus(
      output,
      allStreams,
      adapter,
      modules.protocol.canonicalJson,
      anchors,
      `${transcriptLines.join("\n")}\n`,
    );
    const corpusBytes = [
      fs.readFileSync(path.join(output, "corpus-manifest.json"), "utf8"),
      fs.readFileSync(path.join(output, "e3-t01-privacy-probe.txt"), "utf8"),
      ...fs
        .readdirSync(path.join(output, "dumps"))
        .sort()
        .map((name) => fs.readFileSync(path.join(output, "dumps", name), "utf8")),
    ].join("");
    for (const token of Object.values(tokens)) {
      assert.equal(corpusBytes.includes(token), false, "raw token leaked into corpus");
    }
    assert.equal(corpusBytes.includes(emulatorOrigin), false, "emulator origin leaked into corpus");
    assert.equal(corpusBytes.includes(officialUrl), false, "server origin leaked into corpus");
    assert.equal(corpusBytes.includes(CLIENT_SECRET), false, "OAuth secret leaked into corpus");
    process.stdout.write(
      `E3_T01_SEED_OK out=${path.resolve(output)} streams=${allStreams.length} main-head=${mainPostFork.offset} branch-head=${branchPostFork.offset} fork-event=${forkEvent.offset}\n`,
    );
  } finally {
    Date.now = originalDateNow;
    if (projector) await projector.stop();
    namespaces?.terminate();
    if (platformServer) {
      await new Promise((resolve) => platformServer.close(resolve));
    }
    await Promise.allSettled([emulator.close(), official.stop()]);
  }
}

await run();
