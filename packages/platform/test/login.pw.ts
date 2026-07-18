import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { headDurableJsonStream, readDurableJson, type StreamRecord } from "@eforest/client";
import { emptyView, viewDigest } from "@eforest/identity";
import { createDurableStreamTestServer } from "@eforest/server";
import { canonicalJson } from "@eforest/protocol";
import {
  IdentityStore,
  OidcClient,
  OidcTransactions,
  PlatformWebApp,
  createPlatformServer,
  listenPlatformServer,
} from "@eforest/platform";
import { chromium, type BrowserContext, type Page } from "playwright-core";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
const task = resolve(root, ".eforest/tasks/epic-2-the-gates/E2-T04-web-login-sessions");
const evidence = resolve(task, "evidence");
const dumpPath = resolve(evidence, "e2-t04-two-logins.events.jsonl");
const digestPath = resolve(evidence, "e2-t04-two-logins.digest");
const transcriptPath = resolve(evidence, "e2-t04-playwright.txt");
const guardPath = resolve(evidence, "e2-t04-network-guard.txt");
const tracePath = resolve(evidence, "e2-t04-playwright-trace.zip");
const artifactManifestPath = resolve(evidence, "e2-t04-browser-artifacts.json");
const update = process.env.E2_T04_UPDATE_GOLDENS === "1";
const captureVideo = process.env.E2_T04_CAPTURE_VIDEO === "1";
const mp4Path = resolve(root, "recordings/e2-t04-final.mp4");
const activeTracePath = captureVideo ? tracePath : resolve(task, "work/e2-t04-latest-trace.zip");

const nowSeconds = 1_700_000_000;
const nowMs = nowSeconds * 1_000;
const mainEmulatorPort = Number(process.env.E2_T04_EMULATOR_PORT ?? 46840);
const platformPort = Number(process.env.E2_T04_PLATFORM_PORT ?? 46841);
const streamPort = Number(process.env.E2_T04_STREAM_PORT ?? 46842);
const expiredEmulatorPort = Number(process.env.E2_T04_EXPIRED_EMULATOR_PORT ?? 46843);
const expiredPlatformPort = Number(process.env.E2_T04_EXPIRED_PLATFORM_PORT ?? 46844);
const parityEmulatorPort = Number(process.env.E2_T04_PARITY_EMULATOR_PORT ?? 46845);
const parityPlatformPort = Number(process.env.E2_T04_PARITY_PLATFORM_PORT ?? 46846);
const parityExpiredEmulatorPort = Number(process.env.E2_T04_PARITY_EXPIRED_EMULATOR_PORT ?? 46847);
const parityExpiredPlatformPort = Number(process.env.E2_T04_PARITY_EXPIRED_PLATFORM_PORT ?? 46848);
const emulatorUrl = `http://127.0.0.1:${String(mainEmulatorPort)}`;
const platformUrl = `http://127.0.0.1:${String(platformPort)}`;
const streamUrl = `http://127.0.0.1:${String(streamPort)}`;
const expiredEmulatorUrl = `http://127.0.0.1:${String(expiredEmulatorPort)}`;
const expiredPlatformUrl = `http://127.0.0.1:${String(expiredPlatformPort)}`;
const parityEmulatorUrl = `http://127.0.0.1:${String(parityEmulatorPort)}`;
const parityPlatformUrl = `http://127.0.0.1:${String(parityPlatformPort)}`;
const parityExpiredEmulatorUrl = `http://127.0.0.1:${String(parityExpiredEmulatorPort)}`;
const parityExpiredPlatformUrl = `http://127.0.0.1:${String(parityExpiredPlatformPort)}`;
const identityUrl = `${streamUrl}/streams/__identity__`;
const parityIdentityUrl = `${streamUrl}/streams/__identity_parity__`;
const parityExpiredIdentityUrl = `${streamUrl}/streams/__identity_parity_expired__`;
const clientId = "eforest-e2-t04-browser";
const sessionSecret = "e2-t04-browser-session-secret-with-32-bytes";
const user = {
  email: "ada@example.test",
  password: "AdaTest1234!",
  id: "ada",
};
const parityUser = {
  email: "grace@example.test",
  password: "GraceTest1234!",
  id: "grace",
};

const privateJwk = JSON.parse(
  await readFile(
    resolve(
      root,
      "vendor/emulate/packages/@emulators/auth0/fixtures/test-keypair.private.jwk.json",
    ),
    "utf8",
  ),
);
const publicJwk = JSON.parse(
  await readFile(
    resolve(root, "vendor/emulate/packages/@emulators/auth0/fixtures/test-keypair.public.jwk.json"),
    "utf8",
  ),
);
const privatePem = createPrivateKey({ key: privateJwk, format: "jwk" })
  .export({ format: "pem", type: "pkcs8" })
  .toString();
const publicPem = createPublicKey({ key: publicJwk, format: "jwk" })
  .export({ format: "pem", type: "spki" })
  .toString();
const wrongPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;

const { createEmulator } = await import(
  resolve(root, "vendor/emulate/packages/emulate/dist/api.js")
);

const networkLog: string[] = [];
let pendingTokenMutation: ((token: string) => string) | undefined;
function loopback(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
}

const guardedFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (!loopback(url)) {
    networkLog.push(`REFUSED ${url.origin}${url.pathname}`);
    throw new TypeError(`network guard refused ${url.hostname}`);
  }
  networkLog.push(`ALLOWED ${url.origin}${url.pathname}`);
  const response = await fetch(input, init);
  networkLog.push(`RESPONSE ${String(response.status)} ${url.origin}${url.pathname}`);
  if (url.pathname === "/oauth/token" && pendingTokenMutation !== undefined && response.ok) {
    const mutate = pendingTokenMutation;
    pendingTokenMutation = undefined;
    const body = (await response.json()) as Record<string, unknown>;
    const idToken = body.id_token;
    if (typeof idToken !== "string") throw new TypeError("token response has no id_token");
    return Response.json({ ...body, id_token: mutate(idToken) }, { status: response.status });
  }
  return response;
};

function tokenPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function mutateSignedToken(
  token: string,
  options: {
    readonly header?: Record<string, unknown>;
    readonly claims?: Record<string, unknown>;
    readonly signingKey?: Parameters<typeof sign>[2];
    readonly hmacKey?: string;
  },
): string {
  const [encodedHeader, encodedClaims] = token.split(".");
  assert.ok(encodedHeader && encodedClaims);
  const header = {
    ...(JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as object),
    ...options.header,
  };
  const claims = {
    ...(JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8")) as object),
    ...options.claims,
  };
  const signingInput = `${tokenPart(header)}.${tokenPart(claims)}`;
  if (header.alg === "none") return `${signingInput}.`;
  const signature =
    header.alg === "HS256"
      ? createHmac("sha256", options.hmacKey ?? publicPem)
          .update(signingInput)
          .digest()
      : sign("RSA-SHA256", Buffer.from(signingInput), options.signingKey ?? privatePem);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function deterministicRandom(seed: number): (size: number) => Uint8Array {
  let counter = seed;
  return (size) => {
    counter += 1;
    return Uint8Array.from({ length: size }, (_, index) => (counter * 31 + index * 17) & 0xff);
  };
}

function emulatorOptions(
  port: number,
  baseUrl: string,
  redirectUri: string,
  seedMaterial: string,
  emulatorNow = nowSeconds,
  subject = user,
) {
  return {
    service: "auth0",
    port,
    baseUrl,
    now: emulatorNow,
    seedMaterial,
    seed: {
      auth0: {
        now: emulatorNow,
        seed: seedMaterial,
        connections: [{ name: "Username-Password-Authentication" }],
        users: [
          {
            email: subject.email,
            password: subject.password,
            user_id: subject.id,
            email_verified: true,
            name: "Ada Lovelace",
          },
        ],
        oauth_clients: [
          {
            client_id: clientId,
            client_secret: "",
            redirect_uris: [redirectUri],
            grant_types: ["authorization_code"],
            audience: clientId,
          },
        ],
        signing_key: {
          private_key_pem: privatePem,
          public_key_pem: publicPem,
          kid: "e2-t04-browser-key",
        },
      },
    },
  };
}

function app(identity: IdentityStore, issuer: string, randomSeed: number): PlatformWebApp {
  const random = deterministicRandom(randomSeed);
  return new PlatformWebApp({
    oidc: new OidcClient({ issuer, clientId, fetch: guardedFetch, now: () => nowMs }),
    transactions: new OidcTransactions(random),
    identity,
    sessionSecret,
    sessionTtlMs: 60_000,
    now: () => nowMs,
    random,
  });
}

async function closeServer(server: ReturnType<typeof createPlatformServer>): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error === undefined ? resolveClose() : reject(error)));
  });
}

async function enter(page: Page, testId: string, value: string): Promise<void> {
  const field = page.getByTestId(testId);
  await field.click();
  await field.fill(value);
}

async function login(page: Page, expectedPlatformUrl = platformUrl, subject = user): Promise<void> {
  await page.getByTestId("login").click();
  await page.getByTestId("auth0-login-form").waitFor();
  await enter(page, "auth0-login-email", subject.email);
  await enter(page, "auth0-login-password", subject.password);
  await Promise.all([
    page.waitForURL((url) => url.origin === expectedPlatformUrl && url.pathname === "/"),
    page.getByTestId("auth0-login-submit").click(),
  ]);
  await page.locator('[data-auth-state="logged-in"]').waitFor();
}

async function installBrowserGuard(context: BrowserContext): Promise<void> {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (loopback(url)) {
      networkLog.push(`BROWSER_ALLOWED ${url.origin}${url.pathname}`);
      await route.continue();
    } else {
      networkLog.push(`BROWSER_REFUSED ${url.origin}${url.pathname}`);
      await route.abort("blockedbyclient");
    }
  });
}

async function cliDigest(records: readonly StreamRecord[]): Promise<string> {
  if (records.length === 0) return viewDigest(emptyView());
  const temporary = resolve(task, "work/e2-t04-browser-dump.jsonl");
  await mkdir(resolve(task, "work"), { recursive: true });
  await writeFile(temporary, `${records.map((record) => canonicalJson(record)).join("\n")}\n`);
  const result = await run(
    process.execPath,
    [
      resolve(root, "packages/cli/dist/src/bin.js"),
      "replay",
      temporary,
      "--digest",
      "--reducer",
      resolve(root, "packages/identity/reducer.mjs"),
    ],
    { cwd: root },
  );
  return result.stdout.trim();
}

async function independentlyAssertDom(page: Page): Promise<{
  readonly offset: string;
  readonly digest: string;
  readonly records: readonly StreamRecord[];
}> {
  const records = await readDurableJson<StreamRecord>({ url: identityUrl, fetch: guardedFetch });
  const head = await headDurableJsonStream({ url: identityUrl, fetch: guardedFetch });
  const digest = await cliDigest(records);
  const offset = head.offset ?? "-1";
  assert.equal(await page.locator("main").getAttribute("data-identity-offset"), offset);
  assert.equal(await page.locator("main").getAttribute("data-identity-digest"), digest);
  return { offset, digest, records };
}

async function streamTruth(url: string): Promise<{
  readonly offset: string;
  readonly count: number;
  readonly digest: string;
  readonly records: readonly StreamRecord[];
}> {
  const records = await readDurableJson<StreamRecord>({ url, fetch: guardedFetch });
  const offset = (await headDurableJsonStream({ url, fetch: guardedFetch })).offset ?? "-1";
  return { offset, count: records.length, digest: await cliDigest(records), records };
}

async function authorizeCallback(
  targetPlatformUrl: string,
  subject: typeof user,
  mutate: (parameters: URLSearchParams) => void = () => undefined,
  mutateToken?: (token: string) => string,
): Promise<{ readonly callback: string; readonly response: Response }> {
  const loginResponse = await guardedFetch(`${targetPlatformUrl}/auth/login`, {
    redirect: "manual",
  });
  assert.equal(loginResponse.status, 302);
  const authorization = new URL(loginResponse.headers.get("location")!);
  const parameters = new URLSearchParams(authorization.searchParams);
  parameters.set("email", subject.email);
  parameters.set("password", subject.password);
  mutate(parameters);
  const authorizationResponse = await guardedFetch(`${authorization.origin}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: parameters,
    redirect: "manual",
  });
  assert.equal(authorizationResponse.status, 302);
  const callback = authorizationResponse.headers.get("location")!;
  pendingTokenMutation = mutateToken;
  try {
    return { callback, response: await guardedFetch(callback, { redirect: "manual" }) };
  } finally {
    pendingTokenMutation = undefined;
  }
}

async function issuerRefusalMatrix(
  targetPlatformUrl: string,
  targetIdentityUrl: string,
  subject: typeof user,
): Promise<Readonly<Record<string, { readonly status: number; readonly body: unknown }>>> {
  const results: Record<string, { readonly status: number; readonly body: unknown }> = {};
  const assertNeutral = async (
    label: string,
    before: Awaited<ReturnType<typeof streamTruth>>,
    response: Response,
    expectedStatus: number,
    expectedReason: string,
  ) => {
    results[label] = { status: response.status, body: await response.json() };
    assert.deepEqual(results[label], {
      status: expectedStatus,
      body: { error: { class: "auth-refused", reason: expectedReason } },
    });
    assert.deepEqual(await streamTruth(targetIdentityUrl), before);
  };

  let before = await streamTruth(targetIdentityUrl);
  await assertNeutral(
    "bad-state",
    before,
    await guardedFetch(`${targetPlatformUrl}/auth/callback?code=x&state=missing`),
    400,
    "bad-state",
  );

  before = await streamTruth(targetIdentityUrl);
  const badVerifier = await authorizeCallback(targetPlatformUrl, subject, (parameters) =>
    parameters.set("code_challenge", "wrong-challenge"),
  );
  await assertNeutral("bad-verifier", before, badVerifier.response, 400, "bad-verifier");

  before = await streamTruth(targetIdentityUrl);
  const badNonce = await authorizeCallback(targetPlatformUrl, subject, (parameters) =>
    parameters.set("nonce", "wrong-nonce"),
  );
  await assertNeutral("bad-nonce", before, badNonce.response, 400, "bad-nonce");

  const reusable = await authorizeCallback(targetPlatformUrl, subject);
  assert.equal(reusable.response.status, 302);
  before = await streamTruth(targetIdentityUrl);
  await assertNeutral(
    "reused-code",
    before,
    await guardedFetch(reusable.callback, { redirect: "manual" }),
    400,
    "reused-code",
  );

  const badTokens: ReadonlyArray<{
    readonly label: string;
    readonly mutate: (token: string) => string;
  }> = [
    {
      label: "wrong-key",
      mutate: (token) => mutateSignedToken(token, { signingKey: wrongPrivateKey }),
    },
    {
      label: "unknown-kid",
      mutate: (token) => mutateSignedToken(token, { header: { alg: "RS256", kid: "missing-key" } }),
    },
    {
      label: "alg-none",
      mutate: (token) => mutateSignedToken(token, { header: { alg: "none" } }),
    },
    {
      label: "hs256-public-key-confusion",
      mutate: (token) => mutateSignedToken(token, { header: { alg: "HS256" } }),
    },
    {
      label: "wrong-issuer",
      mutate: (token) => mutateSignedToken(token, { claims: { iss: "https://other.test/" } }),
    },
    {
      label: "wrong-audience",
      mutate: (token) => mutateSignedToken(token, { claims: { aud: "other-client" } }),
    },
  ];
  for (const item of badTokens) {
    before = await streamTruth(targetIdentityUrl);
    const attempt = await authorizeCallback(targetPlatformUrl, subject, undefined, item.mutate);
    await assertNeutral(`bad-token/${item.label}`, before, attempt.response, 401, "bad-token");
  }
  return results;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

await guardedFetch("https://auth0.com/.well-known/openid-configuration").then(
  () => assert.fail("network guard canary unexpectedly connected"),
  () => undefined,
);

const official = createDurableStreamTestServer({ host: "127.0.0.1", port: streamPort });
const emulator = await createEmulator(
  emulatorOptions(
    mainEmulatorPort,
    emulatorUrl,
    `${platformUrl}/auth/callback`,
    "e2-t04-browser-main",
  ),
);
const expiredEmulator = await createEmulator(
  emulatorOptions(
    expiredEmulatorPort,
    expiredEmulatorUrl,
    `${expiredPlatformUrl}/auth/callback`,
    "e2-t04-browser-expired",
    nowSeconds - 7_200,
  ),
);
const parityEmulator = await createEmulator(
  emulatorOptions(
    parityEmulatorPort,
    parityEmulatorUrl,
    `${parityPlatformUrl}/auth/callback`,
    "e2-t04-browser-parity",
    nowSeconds,
    parityUser,
  ),
);
const parityExpiredEmulator = await createEmulator(
  emulatorOptions(
    parityExpiredEmulatorPort,
    parityExpiredEmulatorUrl,
    `${parityExpiredPlatformUrl}/auth/callback`,
    "e2-t04-browser-parity-expired",
    nowSeconds - 7_200,
    parityUser,
  ),
);
await official.start();
const identity = new IdentityStore({ baseUrl: streamUrl, fetch: guardedFetch, now: () => nowMs });
await identity.ensure();
const parityIdentity = new IdentityStore({
  baseUrl: streamUrl,
  streamId: "__identity_parity__",
  fetch: guardedFetch,
  now: () => nowMs,
});
await parityIdentity.ensure();
const parityExpiredIdentity = new IdentityStore({
  baseUrl: streamUrl,
  streamId: "__identity_parity_expired__",
  fetch: guardedFetch,
  now: () => nowMs,
});
await parityExpiredIdentity.ensure();
const mainApp = app(identity, emulatorUrl, 1);
const mainServer = createPlatformServer((request) => mainApp.handle(request));
await listenPlatformServer(mainServer, platformPort);
const expiredApp = app(identity, expiredEmulatorUrl, 101);
const expiredServer = createPlatformServer((request) => expiredApp.handle(request));
await listenPlatformServer(expiredServer, expiredPlatformPort);
const parityApp = app(parityIdentity, parityEmulatorUrl, 201);
const parityServer = createPlatformServer((request) => parityApp.handle(request));
await listenPlatformServer(parityServer, parityPlatformPort);
const parityExpiredApp = app(parityExpiredIdentity, parityExpiredEmulatorUrl, 301);
const parityExpiredServer = createPlatformServer((request) => parityExpiredApp.handle(request));
await listenPlatformServer(parityExpiredServer, parityExpiredPlatformPort);

const replayChromium = resolve(
  homedir(),
  ".replay/runtimes/Replay-Chromium.app/Contents/MacOS/Chromium",
);
const executablePath = process.env.AGENT_BROWSER_EXECUTABLE_PATH ?? replayChromium;
assert.ok(existsSync(executablePath), `browser executable missing: ${executablePath}`);
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext(
  captureVideo ? { recordVideo: { dir: resolve(task, "work/browser-video") } } : {},
);
await installBrowserGuard(context);
await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
const page = await context.newPage();
const video = page.video();
const consoleFailures: string[] = [];
page.on("console", (message) => {
  if (message.type() === "error" || message.type() === "warning") {
    consoleFailures.push(`${message.type()}: ${message.text()}`);
  }
});
page.on("pageerror", (error) => consoleFailures.push(`pageerror: ${error.message}`));

let transcript = "";
try {
  await page.goto(platformUrl);
  await page.locator('[data-auth-state="logged-out"]').waitFor();
  transcript += "logged-out: OK\n";

  await login(page);
  const firstTruth = await independentlyAssertDom(page);
  transcript += `first-login offset=${firstTruth.offset} digest=${firstTruth.digest}: OK\n`;

  const cookies = await context.cookies(platformUrl);
  const sessionCookie = cookies.find((cookie) => cookie.name === "ef_session");
  assert.ok(sessionCookie);
  assert.equal(sessionCookie.httpOnly, true);
  assert.equal(sessionCookie.sameSite, "Lax");
  assert.equal(sessionCookie.value.split(".").length, 2);
  assert.ok(!sessionCookie.value.includes("auth0"));
  assert.ok(!sessionCookie.value.includes(user.email));
  transcript += "cookie=id-plus-hmac HttpOnly SameSite=Lax: OK\n";

  await page.getByRole("button", { name: "Log out" }).click();
  await page.locator('[data-auth-state="logged-out"]').waitFor();
  transcript += "logout: OK\n";

  await login(page);
  const secondTruth = await independentlyAssertDom(page);
  const counts = Object.fromEntries(
    ["identity.user.created", "identity.session.started", "identity.session.ended"].map((type) => [
      type,
      secondTruth.records.filter((record) => record.type === type).length,
    ]),
  );
  assert.deepEqual(counts, {
    "identity.user.created": 1,
    "identity.session.started": 2,
    "identity.session.ended": 1,
  });
  transcript += `second-login offset=${secondTruth.offset} digest=${secondTruth.digest} counts=1/2/1: OK\n`;

  const beforeExpired = {
    offset: secondTruth.offset,
    count: secondTruth.records.length,
    digest: secondTruth.digest,
  };
  await context.clearCookies();
  await page.goto(expiredPlatformUrl);
  await page.getByTestId("login").click();
  await enter(page, "auth0-login-email", user.email);
  await enter(page, "auth0-login-password", user.password);
  const expiredForm = await page.getByTestId("auth0-login-form").evaluate((form) => {
    const htmlForm = form as HTMLFormElement;
    htmlForm.addEventListener("submit", (event) => event.preventDefault(), { once: true });
    return {
      action: htmlForm.action,
      fields: [...new FormData(htmlForm).entries()].map(([name, value]) => [name, String(value)]),
    };
  });
  await page.getByTestId("auth0-login-submit").click();
  const authorizationResponse = await guardedFetch(expiredForm.action, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(expiredForm.fields),
    redirect: "manual",
  });
  assert.equal(authorizationResponse.status, 302);
  const expiredCallback = authorizationResponse.headers.get("location") ?? undefined;
  assert.ok(expiredCallback);
  const expiredResponse = await guardedFetch(expiredCallback, { redirect: "manual" });
  assert.equal(expiredResponse.status, 401);
  const refusal = await expiredResponse.json();
  assert.deepEqual(refusal, { error: { class: "auth-refused", reason: "expired-token" } });
  await page.setContent(
    `<main data-testid="expired-callback-result" data-status="401"><pre>${JSON.stringify(refusal)}</pre></main>`,
  );
  const afterExpiredRecords = await readDurableJson<StreamRecord>({
    url: identityUrl,
    fetch: guardedFetch,
  });
  const afterExpired = {
    offset: (await headDurableJsonStream({ url: identityUrl, fetch: guardedFetch })).offset ?? "-1",
    count: afterExpiredRecords.length,
    digest: await cliDigest(afterExpiredRecords),
  };
  assert.deepEqual(afterExpired, beforeExpired);
  transcript += `expired-token refusal log-neutral=${JSON.stringify(afterExpired)}: OK\n`;

  const mainRefusals = await issuerRefusalMatrix(platformUrl, identityUrl, user);

  await context.clearCookies();
  await page.goto(parityPlatformUrl);
  await page.locator('[data-auth-state="logged-out"]').waitFor();
  await login(page, parityPlatformUrl, parityUser);
  await page.getByRole("button", { name: "Log out" }).click();
  await page.locator('[data-auth-state="logged-out"]').waitFor();
  const parityRecords = await readDurableJson<StreamRecord>({
    url: parityIdentityUrl,
    fetch: guardedFetch,
  });
  assert.deepEqual(
    parityRecords.map((record) => record.type),
    ["identity.user.created", "identity.session.started", "identity.session.ended"],
  );
  assert.deepEqual(
    parityRecords.map((record) => Object.keys(record.payload as object).sort()),
    secondTruth.records.slice(0, 3).map((record) => Object.keys(record.payload as object).sort()),
  );
  const parityDigest = await cliDigest(parityRecords);
  const [parityUserRecord, parityStartedRecord, parityEndedRecord] = parityRecords;
  assert.ok(parityUserRecord && parityStartedRecord && parityEndedRecord);
  const paritySessionId = (parityStartedRecord.payload as { sessionId: string }).sessionId;
  const parityReference: readonly StreamRecord[] = [
    {
      offset: parityUserRecord.offset,
      type: "identity.user.created",
      payload: { v: 1, sub: "auth0|grace", email: parityUser.email },
      ts: parityUserRecord.ts,
    },
    {
      offset: parityStartedRecord.offset,
      type: "identity.session.started",
      payload: { v: 1, sessionId: paritySessionId, sub: "auth0|grace" },
      ts: parityStartedRecord.ts,
    },
    {
      offset: parityEndedRecord.offset,
      type: "identity.session.ended",
      payload: { v: 1, sessionId: paritySessionId },
      ts: parityEndedRecord.ts,
    },
  ];
  assert.equal(parityDigest, await cliDigest(parityReference));
  const parityOffset =
    (await headDurableJsonStream({ url: parityIdentityUrl, fetch: guardedFetch })).offset ?? "-1";
  const parityRefusals = await issuerRefusalMatrix(
    parityPlatformUrl,
    parityIdentityUrl,
    parityUser,
  );
  assert.deepEqual(parityRefusals, mainRefusals);
  const parityExpiredBefore = await streamTruth(parityExpiredIdentityUrl);
  const parityExpired = await authorizeCallback(parityExpiredPlatformUrl, parityUser);
  assert.equal(parityExpired.response.status, 401);
  assert.deepEqual(await parityExpired.response.json(), refusal);
  assert.deepEqual(await streamTruth(parityExpiredIdentityUrl), parityExpiredBefore);
  transcript += `second-issuer subject=auth0|grace offset=${parityOffset} digest=${parityDigest} shapes=user/session/session-ended: OK\n`;
  transcript +=
    "issuer-parity bad-state/bad-verifier/reused-code/bad-nonce/bad-token(wrong-key,unknown-kid,alg-none,hs256-public-key-confusion,wrong-issuer,wrong-audience)/expired-token status-body-log-neutral=true independent-reference=true: OK\n";

  await page.goto("https://auth0.com/e2-t04-network-canary").then(
    () => assert.fail("browser network canary unexpectedly connected"),
    () => undefined,
  );
  assert.equal(consoleFailures.length, 0, consoleFailures.join("\n"));
  transcript += "console-errors=0 console-warnings=0 uncaught-exceptions=0: OK\n";

  const dump = `${secondTruth.records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const digest = `${secondTruth.digest}\n`;
  const processLogPath = process.env.E2_T04_PROCESS_NETWORK_LOG;
  const processLines =
    processLogPath === undefined
      ? []
      : [...new Set((await readFile(processLogPath, "utf8")).trim().split("\n"))].sort();
  if (processLogPath !== undefined) {
    assert.ok(processLines.includes("PROCESS_REFUSED GET https://auth0.com/e2-t04-process-canary"));
  }
  // Concurrent identity reads may complete in either order. The guard proves the
  // observed request/response multiset, so canonicalize it before freezing evidence.
  const guard = `${[...new Set([...networkLog, ...processLines])].sort().join("\n")}\nNETWORK_GUARD_OK canary=auth0.com refused=true process-wide=${String(processLogPath !== undefined)} all-observed-application-hosts=loopback\n`;
  if (update) {
    await mkdir(evidence, { recursive: true });
    await Promise.all([
      writeFile(dumpPath, dump),
      writeFile(digestPath, digest),
      writeFile(transcriptPath, transcript),
      writeFile(guardPath, guard),
    ]);
  } else {
    assert.equal(await readFile(dumpPath, "utf8"), dump);
    assert.equal(await readFile(digestPath, "utf8"), digest);
    assert.equal(await readFile(transcriptPath, "utf8"), transcript);
    assert.equal(await readFile(guardPath, "utf8"), guard);
  }
  process.stdout.write(transcript);
  process.stdout.write("E2_T04_BROWSER_OK\n");
} finally {
  await mkdir(resolve(task, "work"), { recursive: true });
  await context.tracing.stop({ path: activeTracePath }).catch(() => undefined);
  await context.close();
  if (captureVideo && video !== null) {
    const webmPath = await video.path();
    await mkdir(resolve(root, "recordings"), { recursive: true });
    await run("ffmpeg", [
      "-y",
      "-i",
      webmPath,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      mp4Path,
    ]);
    await run("ffprobe", ["-v", "error", "-show_entries", "format=duration,size", mp4Path]);
    const [traceBytes, mp4Bytes] = await Promise.all([readFile(tracePath), readFile(mp4Path)]);
    await writeFile(
      artifactManifestPath,
      `${JSON.stringify(
        {
          capturedTogether: true,
          trace: { path: "evidence/e2-t04-playwright-trace.zip", sha256: sha256(traceBytes) },
          video: { path: "recordings/e2-t04-final.mp4", sha256: sha256(mp4Bytes) },
        },
        null,
        2,
      )}\n`,
    );
    process.stdout.write(`E2_T04_MP4_OK ${mp4Path}\n`);
  }
  await browser.close();
  await Promise.all([
    closeServer(mainServer),
    closeServer(expiredServer),
    closeServer(parityServer),
    closeServer(parityExpiredServer),
  ]);
  await Promise.all([
    emulator.close(),
    expiredEmulator.close(),
    parityEmulator.close(),
    parityExpiredEmulator.close(),
    official.stop(),
  ]);
}
