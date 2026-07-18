import { createHmac, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDurableStreamTestServer } from "@eforest/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  IdentityStore,
  IdentityDispatchRefusedError,
  OidcClient,
  OidcTransactions,
  PlatformWebApp,
  createPlatformServer,
  listenPlatformServer,
  pkceChallenge,
  sessionIsValid,
} from "../src/index.js";

const ISSUER = "https://issuer.example.test/";
const CLIENT_ID = "eforest-web";
const SECRET = "e2-t04-session-secret-is-long-enough-for-hmac";
const NOW = 1_800_000_000_000;

interface CodeGrant {
  readonly challenge: string;
  readonly nonce: string;
  readonly sub: string;
  readonly email: string;
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly header?: Readonly<Record<string, unknown>>;
  readonly signingKey?: KeyObject;
  readonly token?: string;
  used: boolean;
}

class IssuerFixture {
  private readonly keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  private readonly grants = new Map<string, CodeGrant>();
  jwksRequests = 0;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.href === `${ISSUER}.well-known/openid-configuration`) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}authorize`,
        token_endpoint: `${ISSUER}oauth/token`,
        jwks_uri: `${ISSUER}.well-known/jwks.json`,
      });
    }
    if (url.href === `${ISSUER}.well-known/jwks.json`) {
      this.jwksRequests += 1;
      const jwk = this.keyPair.publicKey.export({ format: "jwk" });
      return Response.json({ keys: [{ ...jwk, alg: "RS256", kid: "fixture", use: "sig" }] });
    }
    if (url.href === `${ISSUER}oauth/token`) {
      const parameters = new URLSearchParams(String(init?.body ?? ""));
      const grant = this.grants.get(parameters.get("code") ?? "");
      if (grant === undefined || grant.used) {
        return Response.json(
          {
            error: "invalid_grant",
            error_description: "Unknown or already used authorization code.",
          },
          { status: 400 },
        );
      }
      if (pkceChallenge(parameters.get("code_verifier") ?? "") !== grant.challenge) {
        return Response.json(
          { error: "invalid_grant", error_description: "Invalid code_verifier." },
          { status: 400 },
        );
      }
      grant.used = true;
      return Response.json({ id_token: this.token(grant) });
    }
    throw new Error(`unexpected issuer request ${url.href}`);
  };

  issue(code: string, authorization: URL, overrides: Partial<CodeGrant> = {}): void {
    this.grants.set(code, {
      challenge: authorization.searchParams.get("code_challenge")!,
      nonce: authorization.searchParams.get("nonce")!,
      sub: "auth0|web-user",
      email: "web-user@example.com",
      used: false,
      ...overrides,
    });
  }

  private token(grant: CodeGrant): string {
    if (grant.token !== undefined) return grant.token;
    const header = Buffer.from(
      JSON.stringify(grant.header ?? { alg: "RS256", kid: "fixture" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: ISSUER,
        aud: CLIENT_ID,
        sub: grant.sub,
        email: grant.email,
        nonce: grant.nonce,
        iat: NOW / 1_000,
        exp: NOW / 1_000 + 300,
        ...grant.claims,
      }),
    ).toString("base64url");
    const input = `${header}.${payload}`;
    return `${input}.${sign(
      "RSA-SHA256",
      Buffer.from(input),
      grant.signingKey ?? this.keyPair.privateKey,
    ).toString("base64url")}`;
  }
}

function tokenWithAlgorithm(
  algorithm: "none" | "HS256",
  authorization: URL,
  claims: Readonly<Record<string, unknown>> = {},
): string {
  const header = Buffer.from(JSON.stringify({ alg: algorithm, kid: "fixture" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: "auth0|web-user",
      email: "web-user@example.com",
      nonce: authorization.searchParams.get("nonce"),
      exp: NOW / 1_000 + 300,
      ...claims,
    }),
  ).toString("base64url");
  const input = `${header}.${payload}`;
  const signature =
    algorithm === "none"
      ? "unsigned"
      : createHmac("sha256", "public-key-confusion-probe").update(input).digest("base64url");
  return `${input}.${signature}`;
}

async function runtimeFiles(root: string, relative = ""): Promise<readonly string[]> {
  const directory = join(root, relative);
  const entries = await readdir(directory);
  const files: string[] = [];
  for (const entry of entries) {
    const child = join(relative, entry);
    if ((await stat(join(root, child))).isDirectory())
      files.push(...(await runtimeFiles(root, child)));
    else files.push(child);
  }
  return files.sort();
}

async function startProductionChild(
  runtimeDirectory: string,
  officialUrl: string,
): Promise<{ readonly child: ChildProcess; readonly baseUrl: string }> {
  const child = spawn(process.execPath, [resolve("packages/platform/dist/src/bin.js")], {
    cwd: runtimeDirectory,
    env: {
      ...process.env,
      EF_OIDC_ISSUER: ISSUER,
      EF_OIDC_CLIENT_ID: CLIENT_ID,
      EF_SESSION_SECRET: SECRET,
      EF_SESSION_TTL: "60",
      EFOREST_SERVER_URL: officialUrl,
      PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const baseUrl = await new Promise<string>((resolveUrl, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`platform startup timed out: ${stderr}`)),
      10_000,
    );
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`platform exited before listen (${String(code)}): ${stderr}`));
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      const match = /LISTENING (http:\/\/[^\s]+)/.exec(chunk.toString("utf8"));
      if (match !== null) {
        clearTimeout(timeout);
        resolveUrl(match[1]!);
      }
    });
  });
  return { child, baseUrl };
}

async function sigkill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGKILL");
  await exited;
}

const officialServers: Array<ReturnType<typeof createDurableStreamTestServer>> = [];
const platformServers: Array<ReturnType<typeof createPlatformServer>> = [];

afterEach(async () => {
  await Promise.all(
    platformServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(officialServers.splice(0).map((server) => server.stop()));
});

function deterministicRandom(): (size: number) => Uint8Array {
  let counter = 0;
  return (size) => {
    counter += 1;
    return Uint8Array.from({ length: size }, (_, index) => (counter * 31 + index * 17) & 0xff);
  };
}

async function setup(
  now = NOW,
  streamFetch?: typeof fetch,
): Promise<{
  readonly baseUrl: string;
  readonly officialUrl: string;
  readonly fixture: IssuerFixture;
  readonly identity: IdentityStore;
  readonly app: PlatformWebApp;
}> {
  const official = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
  officialServers.push(official);
  const officialUrl = await official.start();
  const identity = new IdentityStore({
    baseUrl: officialUrl,
    now: () => now,
    ...(streamFetch === undefined ? {} : { fetch: streamFetch }),
  });
  await identity.ensure();
  const fixture = new IssuerFixture();
  const random = deterministicRandom();
  const app = new PlatformWebApp({
    oidc: new OidcClient({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      fetch: fixture.fetch,
      now: () => now,
    }),
    transactions: new OidcTransactions(random),
    identity,
    sessionSecret: SECRET,
    sessionTtlMs: 60_000,
    now: () => now,
    random,
  });
  const server = createPlatformServer((request) => app.handle(request));
  platformServers.push(server);
  return { baseUrl: await listenPlatformServer(server), officialUrl, fixture, identity, app };
}

function cookie(response: Response): string {
  return response.headers.get("set-cookie")!.split(";", 1)[0]!;
}

async function begin(
  baseUrl: string,
): Promise<{ readonly state: string; readonly authorization: URL }> {
  const response = await fetch(`${baseUrl}/auth/login`, { redirect: "manual" });
  expect(response.status).toBe(302);
  const authorization = new URL(response.headers.get("location")!);
  return { state: authorization.searchParams.get("state")!, authorization };
}

async function complete(
  baseUrl: string,
  fixture: IssuerFixture,
  code: string,
  overrides: Partial<CodeGrant> = {},
): Promise<{ readonly response: Response; readonly state: string; readonly authorization: URL }> {
  const login = await begin(baseUrl);
  fixture.issue(code, login.authorization, overrides);
  const response = await fetch(
    `${baseUrl}/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(login.state)}`,
    { redirect: "manual" },
  );
  return { response, ...login };
}

async function triple(identity: IdentityStore): Promise<{
  readonly offset: string;
  readonly count: number;
  readonly digest: string;
}> {
  const snapshot = await identity.snapshot();
  return { offset: snapshot.offset, count: snapshot.events.length, digest: snapshot.digest };
}

describe("event-backed web login and sessions", () => {
  it("runs two PKCE logins, one logout, DOM truth, and restart survival over a real stream", async () => {
    const dispatchPosts: string[] = [];
    const loggingFetch: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      if (method === "POST" && url.includes("/streams/__identity__")) dispatchPosts.push(url);
      return fetch(input, init);
    };
    const { baseUrl, fixture, identity } = await setup(NOW, loggingFetch);
    const first = await complete(baseUrl, fixture, "first-code");
    expect(first.response.status).toBe(302);
    const firstCookie = cookie(first.response);
    expect(firstCookie).toMatch(/^ef_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(firstCookie).not.toContain("auth0");
    expect(firstCookie).not.toContain("example.com");

    const home = await fetch(`${baseUrl}/`, { headers: { cookie: firstCookie } });
    const homeBody = await home.text();
    const snapshot = await identity.snapshot();
    expect(homeBody).toContain('data-auth-state="logged-in"');
    expect(homeBody).toContain(`data-identity-offset="${snapshot.offset}"`);
    expect(homeBody).toContain(`data-identity-digest="${snapshot.digest}"`);
    expect(homeBody).toContain("auth0|web-user");
    expect(homeBody).toContain("web-user@example.com");

    const restarted = new PlatformWebApp({
      oidc: new OidcClient({
        issuer: ISSUER,
        clientId: CLIENT_ID,
        fetch: fixture.fetch,
        now: () => NOW,
      }),
      transactions: new OidcTransactions(deterministicRandom()),
      identity,
      sessionSecret: SECRET,
      sessionTtlMs: 60_000,
      now: () => NOW,
    });
    expect(
      await (
        await restarted.handle(new Request(`${baseUrl}/`, { headers: { cookie: firstCookie } }))
      ).text(),
    ).toContain('data-auth-state="logged-in"');

    const logout = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { cookie: firstCookie },
      redirect: "manual",
    });
    expect(logout.status).toBe(302);
    const afterLogout = await identity.snapshot();
    const postsAfterLogout = dispatchPosts.length;
    const secondLogout = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { cookie: firstCookie },
      redirect: "manual",
    });
    expect(secondLogout.status).toBe(302);
    expect((await identity.snapshot()).digest).toBe(afterLogout.digest);
    expect(dispatchPosts).toHaveLength(postsAfterLogout);

    const second = await complete(baseUrl, fixture, "second-code");
    expect(second.response.status).toBe(302);
    expect(fixture.jwksRequests).toBe(1);
    const final = await identity.snapshot();
    expect(final.events.filter((event) => event.type === "identity.user.created")).toHaveLength(1);
    expect(final.events.filter((event) => event.type === "identity.session.started")).toHaveLength(
      2,
    );
    expect(final.events.filter((event) => event.type === "identity.session.ended")).toHaveLength(1);
  });

  it("fences concurrent first-login provisioning at the identity dispatch door", async () => {
    const { identity } = await setup();
    for (let trial = 0; trial < 20; trial += 1) {
      const sub = `auth0|race-${String(trial)}`;
      await Promise.all([
        identity.login(sub, `${String(trial)}@example.com`, `race-${String(trial)}-a`),
        identity.login(sub, `${String(trial)}@example.com`, `race-${String(trial)}-b`),
      ]);
    }
    const snapshot = await identity.snapshot();
    expect(snapshot.events.filter((event) => event.type === "identity.user.created")).toHaveLength(
      20,
    );
    expect(
      snapshot.events.filter((event) => event.type === "identity.session.started"),
    ).toHaveLength(40);
  });

  it("surfaces typed reducer refusals and ends a concurrent session exactly once", async () => {
    const { identity } = await setup();
    await identity.login("auth0|dispatch", "dispatch@example.com", "shared-session");

    await expect(
      identity.login("auth0|dispatch", "dispatch@example.com", "shared-session"),
    ).rejects.toEqual(
      expect.objectContaining<Partial<IdentityDispatchRefusedError>>({
        name: "IdentityDispatchRefusedError",
        code: "identity/duplicate-session",
      }),
    );

    await Promise.all([
      identity.endSession("shared-session"),
      identity.endSession("shared-session"),
    ]);
    const snapshot = await identity.snapshot();
    expect(
      snapshot.events.filter(
        (event) =>
          event.type === "identity.session.ended" &&
          (event.payload as { sessionId?: unknown }).sessionId === "shared-session",
      ),
    ).toHaveLength(1);
  });

  it("returns frozen typed refusals log-neutrally for state, verifier, reuse, expiry, and nonce", async () => {
    const { baseUrl, fixture, identity } = await setup();
    const before = await identity.snapshot();

    const badState = await fetch(`${baseUrl}/auth/callback?code=x&state=missing`, {
      redirect: "manual",
    });
    expect(badState.status).toBe(400);
    expect(await badState.json()).toEqual({
      error: { class: "auth-refused", reason: "bad-state" },
    });

    const wrongVerifier = await begin(baseUrl);
    fixture.issue("wrong-verifier", wrongVerifier.authorization, { challenge: "wrong" });
    const badVerifier = await fetch(
      `${baseUrl}/auth/callback?code=wrong-verifier&state=${wrongVerifier.state}`,
      { redirect: "manual" },
    );
    expect(badVerifier.status).toBe(400);
    expect(await badVerifier.json()).toEqual({
      error: { class: "auth-refused", reason: "bad-verifier" },
    });

    const reused = await begin(baseUrl);
    fixture.issue("reused", reused.authorization);
    const callback = `${baseUrl}/auth/callback?code=reused&state=${reused.state}`;
    expect((await fetch(callback, { redirect: "manual" })).status).toBe(302);
    const afterSuccess = await identity.snapshot();
    const reusedResponse = await fetch(callback, { redirect: "manual" });
    expect(reusedResponse.status).toBe(400);
    expect(await reusedResponse.json()).toEqual({
      error: { class: "auth-refused", reason: "reused-code" },
    });
    expect((await identity.snapshot()).digest).toBe(afterSuccess.digest);

    const expired = await complete(baseUrl, fixture, "expired", {
      claims: { exp: NOW / 1_000 - 1 },
    });
    expect(expired.response.status).toBe(401);
    expect(await expired.response.json()).toEqual({
      error: { class: "auth-refused", reason: "expired-token" },
    });
    const nonce = await complete(baseUrl, fixture, "bad-nonce", { claims: { nonce: "wrong" } });
    expect(nonce.response.status).toBe(400);
    expect(await nonce.response.json()).toEqual({
      error: { class: "auth-refused", reason: "bad-nonce" },
    });

    const final = await identity.snapshot();
    expect(final.events.slice(afterSuccess.events.length)).toHaveLength(0);
    expect(before.events).toHaveLength(0);
  });

  it("refuses the full cryptographic confusion matrix without touching the identity log", async () => {
    const { baseUrl, fixture, identity } = await setup();
    const wrongKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly overrides: (authorization: URL) => Partial<CodeGrant>;
    }> = [
      { label: "wrong-key", overrides: () => ({ signingKey: wrongKey }) },
      {
        label: "unknown-kid",
        overrides: () => ({ header: { alg: "RS256", kid: "missing-key" } }),
      },
      {
        label: "alg-none",
        overrides: (authorization) => ({ token: tokenWithAlgorithm("none", authorization) }),
      },
      {
        label: "hs256-public-key-confusion",
        overrides: (authorization) => ({ token: tokenWithAlgorithm("HS256", authorization) }),
      },
      { label: "wrong-issuer", overrides: () => ({ claims: { iss: "https://other.test/" } }) },
      { label: "wrong-audience", overrides: () => ({ claims: { aud: "other-client" } }) },
    ];
    const before = await triple(identity);
    for (const item of cases) {
      const login = await begin(baseUrl);
      fixture.issue(item.label, login.authorization, item.overrides(login.authorization));
      const response = await fetch(
        `${baseUrl}/auth/callback?code=${item.label}&state=${login.state}`,
        { redirect: "manual" },
      );
      expect(response.status, item.label).toBe(401);
      expect(await response.json(), item.label).toEqual({
        error: { class: "auth-refused", reason: "bad-token" },
      });
      expect(await triple(identity), item.label).toEqual(before);
    }
  });

  it("fuzzes callback, token, and cookie parsers without a 5xx or log mutation", async () => {
    const { baseUrl, fixture, identity } = await setup();
    const before = await triple(identity);
    for (let index = 0; index < 80; index += 1) {
      const response = await fetch(
        `${baseUrl}/auth/callback?code=${encodeURIComponent(`%${String(index)}<>`)}&state=${encodeURIComponent(`missing-${String(index)}`)}`,
        { redirect: "manual" },
      );
      expect(response.status).toBe(400);
    }
    for (let index = 0; index < 80; index += 1) {
      const response = await fetch(`${baseUrl}/`, {
        headers: { cookie: `ef_session=${"x".repeat(index % 7)}.${"!".repeat((index % 11) + 1)}` },
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    for (let index = 0; index < 40; index += 1) {
      const login = await begin(baseUrl);
      const code = `malformed-token-${String(index)}`;
      fixture.issue(code, login.authorization, { token: `${"a".repeat(index % 5)}.bad` });
      const response = await fetch(`${baseUrl}/auth/callback?code=${code}&state=${login.state}`, {
        redirect: "manual",
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: { class: "auth-refused", reason: "bad-token" },
      });
    }
    expect(await triple(identity)).toEqual(before);
  });

  it("treats malformed cookies as typed refusals and forged cookies as logged out", async () => {
    const { baseUrl, identity } = await setup();
    const malformed = await fetch(`${baseUrl}/`, {
      headers: { cookie: "ef_session=bad.parts.extra" },
    });
    expect(malformed.status).toBe(401);
    expect(await malformed.json()).toEqual({
      error: { class: "auth-refused", reason: "bad-token" },
    });
    const forged = await fetch(`${baseUrl}/`, {
      headers: { cookie: "ef_session=fabricated.invalidsig" },
    });
    expect(forged.status).toBe(200);
    expect(await forged.text()).toContain('data-auth-state="logged-out"');
    expect((await identity.snapshot()).events).toHaveLength(0);
  });

  it("expires session validity from the event timestamp without appending", async () => {
    const { identity } = await setup();
    const snapshot = await identity.login("auth0|ttl", "ttl@example.com", "ttl-session");
    expect(sessionIsValid(snapshot, "ttl-session", NOW, 60_000)).toBe(true);
    expect(sessionIsValid(snapshot, "ttl-session", NOW + 60_000, 60_000)).toBe(false);
    expect((await identity.snapshot()).digest).toBe(snapshot.digest);
  });

  it("survives SIGKILL from stream replay without writing platform-local state", async () => {
    const { baseUrl, officialUrl, fixture, identity } = await setup(Date.now());
    const login = await complete(baseUrl, fixture, "restart-code");
    const sessionCookie = cookie(login.response);
    const expectedOffset = (await identity.snapshot()).offset;
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "e2-t04-platform-runtime-"));
    const beforeFiles = await runtimeFiles(runtimeDirectory);

    let running = await startProductionChild(runtimeDirectory, officialUrl);
    try {
      let response = await fetch(`${running.baseUrl}/`, { headers: { cookie: sessionCookie } });
      let body = await response.text();
      expect(body).toContain('data-auth-state="logged-in"');
      expect(body).toContain(`data-identity-offset="${expectedOffset}"`);

      await sigkill(running.child);
      expect(await runtimeFiles(runtimeDirectory)).toEqual(beforeFiles);

      running = await startProductionChild(runtimeDirectory, officialUrl);
      response = await fetch(`${running.baseUrl}/`, { headers: { cookie: sessionCookie } });
      expect(await response.text()).toContain('data-auth-state="logged-in"');
      const logout = await fetch(`${running.baseUrl}/auth/logout`, {
        method: "POST",
        headers: { cookie: sessionCookie },
        redirect: "manual",
      });
      expect(logout.status).toBe(302);
      await sigkill(running.child);

      running = await startProductionChild(runtimeDirectory, officialUrl);
      response = await fetch(`${running.baseUrl}/`, { headers: { cookie: sessionCookie } });
      body = await response.text();
      expect(body).toContain('data-auth-state="logged-out"');
      expect(await runtimeFiles(runtimeDirectory)).toEqual(beforeFiles);
    } finally {
      await sigkill(running.child);
    }
  });
});
