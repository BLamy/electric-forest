import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL, URLSearchParams } from "node:url";
import { Response } from "undici";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TASK = path.join(ROOT, ".eforest/tasks/epic-2-the-gates/E2-T03-bearer-token-verification");
const EVIDENCE = path.join(TASK, "evidence");
const EMULATE = path.join(ROOT, "vendor/emulate");
const AUTH0 = path.join(EMULATE, "packages/@emulators/auth0");
const BASE_URL = "http://127.0.0.1:43882";
const NOW = 1_700_000_000;
const CLIENT_ID = "eforest-platform";
const CLIENT_SECRET = "eforest-platform-secret";
const AUDIENCE = "eforest-api";
const KID = "eforest-test-2026";
const STREAM_ID = "e2-t03-gateway";
const CALLBACK = "http://127.0.0.1:43883/callback";
const VERIFIER = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const USER = { email: "gateway@example.test", password: "GatewayTest1234!" };
const EXPECTED_PIN = "82eb835947c97fcf6e0596a4377acbb01ca13ede";

function readSigningConfig() {
  const privateJwk = JSON.parse(
    fs.readFileSync(path.join(AUTH0, "fixtures/test-keypair.private.jwk.json"), "utf8"),
  );
  const publicJwk = JSON.parse(
    fs.readFileSync(path.join(AUTH0, "fixtures/test-keypair.public.jwk.json"), "utf8"),
  );
  const privateKey = createPrivateKey({ key: privateJwk, format: "jwk" });
  return {
    privateKey,
    privateKeyPem: String(privateKey.export({ format: "pem", type: "pkcs8" })),
    publicJwk,
    publicKeyPem: String(
      createPublicKey({ key: publicJwk, format: "jwk" }).export({
        format: "pem",
        type: "spki",
      }),
    ),
  };
}

function emulatorOptions() {
  const signing = readSigningConfig();
  return {
    service: "auth0",
    port: 43882,
    baseUrl: BASE_URL,
    now: NOW,
    seedMaterial: "electric-forest-e2-t03-v1",
    seed: {
      auth0: {
        now: NOW,
        seed: "electric-forest-e2-t03-v1",
        connections: [{ name: "Username-Password-Authentication" }],
        users: [
          {
            email: USER.email,
            password: USER.password,
            user_id: "gateway-user",
            email_verified: true,
            name: "Gateway User",
          },
        ],
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
  const clientApi = path.join(ROOT, "packages/client/dist/src/index.js");
  for (const file of [emulateApi, platformApi, serverApi, clientApi]) {
    assert.ok(
      fs.existsSync(file),
      `required built module is missing: ${path.relative(ROOT, file)}`,
    );
  }
  return {
    emulate: await import(`${pathToFileURL(emulateApi).href}?pin=${EXPECTED_PIN}`),
    platform: await import(`${pathToFileURL(platformApi).href}?task=E2-T03`),
    server: await import(`${pathToFileURL(serverApi).href}?task=E2-T03`),
    client: await import(`${pathToFileURL(clientApi).href}?task=E2-T03`),
  };
}

function jwt(privateKey, payload, header = {}) {
  const encodedHeader = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT", ...header }),
  ).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const input = `${encodedHeader}.${encodedPayload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}

function decodePayload(token) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

function mutateSignature(token) {
  const parts = token.split(".");
  const signature = Buffer.from(parts[2], "base64url");
  signature[0] ^= 1;
  return `${parts[0]}.${parts[1]}.${signature.toString("base64url")}`;
}

async function issueToken() {
  const challenge = createHash("sha256").update(VERIFIER).digest("base64url");
  const authorization = {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK,
    scope: "openid profile email",
    audience: AUDIENCE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "e2-t03-state",
    nonce: "e2-t03-nonce",
  };
  const login = await fetch(`${BASE_URL}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...authorization, email: USER.email, password: USER.password }),
  });
  assert.equal(login.status, 302);
  const location = new URL(login.headers.get("location"));
  assert.equal(location.searchParams.get("state"), authorization.state);
  const code = location.searchParams.get("code");
  assert.ok(code);
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
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.token_type, "Bearer");
  assert.equal(body.access_token.split(".").length, 3);
  return body.access_token;
}

class CountingAdapter {
  constructor(delegate) {
    this.delegate = delegate;
    this.calls = { create: 0, append: 0, read: 0, follow: 0 };
  }

  async create(streamId) {
    this.calls.create += 1;
    return this.delegate.create(streamId);
  }

  async append(streamId, event) {
    this.calls.append += 1;
    return this.delegate.append(streamId, event);
  }

  async read(streamId) {
    this.calls.read += 1;
    return this.delegate.read(streamId);
  }

  follow(streamId, signal) {
    this.calls.follow += 1;
    return this.delegate.follow(streamId, signal);
  }
}

function dispatchRequest(authorization, payload = { value: "accepted" }) {
  return new Request("http://platform.local/api/dispatch", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: JSON.stringify({
      streamId: STREAM_ID,
      event: { type: "gateway.test", payload, ts: 1 },
    }),
  });
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeTranscript(entries) {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function within(promise, label, milliseconds = 5_000) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = globalThis.setTimeout(
          () => reject(new Error(`${label} timed out`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function verifyRotation(BearerVerifier) {
  const pairs = [
    generateKeyPairSync("rsa", { modulusLength: 2048 }),
    generateKeyPairSync("rsa", { modulusLength: 2048 }),
  ];
  let active = 0;
  let fetches = 0;
  const publicJwk = (index) => ({
    ...pairs[index].publicKey.export({ format: "jwk" }),
    kid: "rotating-kid",
    alg: "RS256",
    use: "sig",
  });
  const rotationToken = (index) =>
    jwt(
      pairs[index].privateKey,
      { iss: `${BASE_URL}/`, aud: AUDIENCE, sub: "rotation-sub", iat: NOW, exp: NOW + 300 },
      { kid: "rotating-kid" },
    );
  const verifier = new BearerVerifier({
    issuer: BASE_URL,
    audience: AUDIENCE,
    now: () => NOW * 1000,
    fetch: async () => {
      fetches += 1;
      return Response.json({ keys: [publicJwk(active)] });
    },
  });
  assert.equal(
    (await verifier.verifyAuthorization(`Bearer ${rotationToken(0)}`)).sub,
    "rotation-sub",
  );
  active = 1;
  assert.equal(
    (await verifier.verifyAuthorization(`Bearer ${rotationToken(1)}`)).sub,
    "rotation-sub",
  );
  await assert.rejects(
    verifier.verifyAuthorization(`Bearer ${rotationToken(0)}`),
    (error) => error?.reason === "invalid_signature",
  );
  assert.equal(fetches, 3);
  return "same_kid_rotation=new_key_accepted_after_refresh\nretired_key_rejected_after_refresh=true\njwks_fetches=3\n";
}

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const modules = await loadModules();
  const emulator = await modules.emulate.createEmulator(emulatorOptions());
  const officialServer = modules.server.createDurableStreamTestServer({
    host: "127.0.0.1",
    port: 0,
  });
  let officialBaseUrl;
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    officialBaseUrl = await officialServer.start();
    const direct = new modules.platform.OfficialStreamAdapter({ baseUrl: officialBaseUrl });
    await direct.create(STREAM_ID);
    const adapterStreamId = `${STREAM_ID}-adapter-proof`;
    const observedHeaders = [];
    const fallbackFollowAbort = new globalThis.AbortController();
    const instrumentedFetch = async (input, init) => {
      const request = new Request(input, init);
      observedHeaders.push(request.headers.get("x-e2-t03-proof"));
      return fetch(
        input,
        request.url.includes("live=") && init?.signal === undefined
          ? { ...init, signal: fallbackFollowAbort.signal }
          : init,
      );
    };
    const instrumented = new modules.platform.OfficialStreamAdapter({
      baseUrl: `${officialBaseUrl}/`,
      fetch: instrumentedFetch,
      headers: { "x-e2-t03-proof": "official-adapter" },
    });
    await instrumented.create(adapterStreamId);
    const adapterEvent = { type: "gateway.adapter.proof", payload: { value: 1 }, ts: 1 };
    await instrumented.append(adapterStreamId, adapterEvent);
    assert.deepEqual(await instrumented.read(adapterStreamId), [adapterEvent]);
    const followStreamId = `${adapterStreamId}-follow`;
    await instrumented.create(followStreamId);
    const followed = instrumented.follow(followStreamId)[Symbol.asyncIterator]();
    const nextFollowed = followed.next();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await instrumented.append(followStreamId, adapterEvent);
    let followedResult;
    try {
      followedResult = await within(nextFollowed, "official follow without signal");
    } finally {
      fallbackFollowAbort.abort();
    }
    assert.deepEqual(followedResult, {
      done: false,
      value: adapterEvent,
    });
    await within(followed.return(), "official follow return");
    const abortStreamId = `${adapterStreamId}-abort`;
    await direct.create(abortStreamId);
    const aborted = new globalThis.AbortController();
    const abortedFollow = direct.follow(abortStreamId, aborted.signal)[Symbol.asyncIterator]();
    const abortedNext = abortedFollow.next();
    await new Promise((resolve) => setTimeout(resolve, 100));
    aborted.abort();
    assert.deepEqual(await within(abortedNext, "official follow aborted signal"), {
      done: true,
      value: undefined,
    });
    assert.ok(observedHeaders.length >= 5);
    assert.equal(
      observedHeaders.every((value) => value === "official-adapter"),
      true,
    );
    fs.writeFileSync(
      path.join(EVIDENCE, "e2-t03-coverage.txt"),
      `official_adapter_create=true\nofficial_adapter_append=true\nofficial_adapter_read=true\nofficial_adapter_follow_no_signal=true\nofficial_adapter_follow_abort_signal=true\ninjected_fetch_calls=${observedHeaders.length}\ninjected_headers_all_present=true\nhandler_and_jwks_edge_tests=packages/platform/test/gateway.test.ts\n`,
    );
    const counting = new CountingAdapter(direct);
    const gateway = new modules.platform.PlatformGateway({
      verifier: new modules.platform.BearerVerifier({
        issuer: BASE_URL,
        audience: AUDIENCE,
        now: () => NOW * 1000,
      }),
      streams: counting,
    });

    const valid = await issueToken();
    const claims = decodePayload(valid);
    assert.equal(claims.iss, `${BASE_URL}/`);
    assert.equal(claims.aud, AUDIENCE);
    assert.equal(typeof claims.sub, "string");
    const signing = readSigningConfig();
    const baseClaims = {
      iss: claims.iss,
      aud: AUDIENCE,
      sub: claims.sub,
      iat: NOW,
      exp: NOW + 300,
    };
    const refusalCases = [
      ["missing", undefined, "missing_bearer_token"],
      ["malformed_header", valid, "malformed_authorization"],
      ["malformed_token", "Bearer not.a.jwt.extra", "malformed_token"],
      ["forged", `Bearer ${mutateSignature(valid)}`, "invalid_signature"],
      [
        "wrong_issuer",
        `Bearer ${jwt(signing.privateKey, { ...baseClaims, iss: "https://wrong.example" })}`,
        "wrong_issuer",
      ],
      [
        "wrong_audience",
        `Bearer ${jwt(signing.privateKey, { ...baseClaims, aud: "wrong-api" })}`,
        "wrong_audience",
      ],
      [
        "expired",
        `Bearer ${jwt(signing.privateKey, { ...baseClaims, exp: NOW })}`,
        "expired_token",
      ],
      [
        "unknown_kid",
        `Bearer ${jwt(signing.privateKey, baseClaims, { kid: "unknown-kid" })}`,
        "unknown_kid",
      ],
    ];

    const transcript = [];
    const initial = await direct.read(STREAM_ID);
    const initialDigest = digest(initial);
    for (const [name, authorization, reason] of refusalCases) {
      const callsBefore = { ...counting.calls };
      const streamBefore = await direct.read(STREAM_ID);
      const response = await gateway.handle(dispatchRequest(authorization));
      const responseBody = await response.json();
      const streamAfter = await direct.read(STREAM_ID);
      assert.equal(response.status, 401, name);
      assert.deepEqual(responseBody, { error: { code: "unauthorized", reason } }, name);
      assert.deepEqual(counting.calls, callsBefore, `${name} reached the stream adapter`);
      assert.deepEqual(streamAfter, streamBefore, `${name} changed the target stream`);
      transcript.push({
        case: name,
        status: response.status,
        body: responseBody,
        streamDigest: digest(streamAfter),
        adapterDelta: { create: 0, append: 0, read: 0, follow: 0 },
      });
    }

    const actorCallsBefore = { ...counting.calls };
    const actorResponse = await gateway.handle(
      dispatchRequest(`Bearer ${valid}`, { value: "rejected", actor: "client|mallory" }),
    );
    const actorBody = await actorResponse.json();
    assert.equal(actorResponse.status, 400);
    assert.deepEqual(actorBody, {
      error: { code: "invalid_request", reason: "client_actor_forbidden" },
    });
    assert.deepEqual(counting.calls, actorCallsBefore);
    assert.equal(digest(await direct.read(STREAM_ID)), initialDigest);
    transcript.push({
      case: "client_actor",
      status: actorResponse.status,
      body: actorBody,
      streamDigest: initialDigest,
      adapterDelta: { create: 0, append: 0, read: 0, follow: 0 },
    });

    const golden = normalizeTranscript(transcript);
    const goldenPath = path.join(EVIDENCE, "e2-t03-refusal-transcript.jsonl");
    if (process.argv.includes("--write-golden")) {
      fs.writeFileSync(goldenPath, golden);
    } else {
      assert.ok(fs.existsSync(goldenPath), "committed refusal golden is missing");
      assert.equal(
        golden,
        fs.readFileSync(goldenPath, "utf8"),
        "refusal transcript differs from golden",
      );
    }

    const accepted = await gateway.handle(dispatchRequest(`Bearer ${valid}`));
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { ok: true, actor: claims.sub });
    // Accepted writes replay the stream once so the server can derive and enforce the
    // authenticated writer's next sequence. Refusals above must still perform no I/O.
    assert.deepEqual(counting.calls, { create: 0, append: 1, read: 1, follow: 0 });
    const dump = await direct.read(STREAM_ID);
    assert.deepEqual(dump, [
      {
        type: "gateway.test",
        payload: {
          value: "accepted",
          actor: claims.sub,
          writer: { v: 1, sub: claims.sub, seq: 1 },
        },
        ts: 1,
      },
    ]);
    fs.writeFileSync(
      path.join(EVIDENCE, "e2-t03-stream-dump.jsonl"),
      `${dump.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    fs.writeFileSync(
      path.join(EVIDENCE, "e2-t03-adapter-calls.json"),
      `${JSON.stringify({ refusals: refusalCases.length + 1, refusalCalls: { create: 0, append: 0, read: 0, follow: 0 }, finalCalls: counting.calls, initialStreamDigest: initialDigest, finalStreamDigest: digest(dump) }, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(EVIDENCE, "e2-t03-key-rotation.txt"),
      await verifyRotation(modules.platform.BearerVerifier),
    );
    console.log(
      JSON.stringify({
        status: "E2_T03_GATEWAY_OK",
        refusals: refusalCases.length + 1,
        actor: claims.sub,
        finalCalls: counting.calls,
        streamDigest: digest(dump),
      }),
    );
  } finally {
    await Promise.allSettled([emulator.close(), officialServer.stop()]);
  }
}

await main();
