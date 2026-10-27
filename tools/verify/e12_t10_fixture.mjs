import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHostedRuntime } from "../../packages/platform/dist/src/hosted.js";
import { hostedArtifact } from "../../packages/platform/dist/src/hosted-artifact.js";
import {
  createPlatformServer,
  listenPlatformServer,
} from "../../packages/platform/dist/src/server.js";
import { OfficialStreamAdapter } from "../../packages/platform/dist/src/official.js";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";

const { Response, URLSearchParams } = globalThis;

export const root = resolve(import.meta.dirname, "../..");
export const task = resolve(
  root,
  ".eforest/tasks/epic-12-first-light/E12-T10-real-auth0-private-railway",
);
export const CLIENT_ID = "e12-t10-dedicated-web-fixture";
export const PEOPLE = Object.freeze({
  ada: { sub: "auth0|e12-t10-fixture-ada", email: "ada-fixture@replay.io" },
  grace: { sub: "auth0|e12-t10-fixture-grace", email: "grace-fixture@reloulexei.resend.app" },
  outsider: { sub: "auth0|e12-t10-fixture-outsider", email: "outsider@example.com" },
});
const sha = (value) => createHash("sha256").update(value).digest("hex");
const challenge = (value) => createHash("sha256").update(value).digest("base64url");
export const cookiePair = (response, name) =>
  response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`))
    ?.split(";")[0];
export const readJson = async (response, status) => {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
};

async function proxy(credentials, backend) {
  const server = createHttpsServer(credentials, (incoming, outgoing) => {
    const destination = backend();
    if (!destination) {
      outgoing.writeHead(503);
      outgoing.end();
      return;
    }
    const upstream = httpRequest(
      new URL(incoming.url, destination),
      { method: incoming.method, headers: incoming.headers },
      (response) => {
        outgoing.writeHead(response.statusCode, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(503);
      outgoing.end();
    });
    outgoing.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { server, origin: `https://127.0.0.1:${server.address().port}` };
}
async function closeServer(server) {
  if (server.listening)
    await new Promise((done) => {
      server.close(done);
      server.closeAllConnections();
    });
}

/** A dedicated issuer lives outside the application. No fixture route exists in the hosted runtime. */
export async function createHostedFixture(output, options = {}) {
  await mkdir(output, { recursive: true });
  const workshop = await mkdtemp(resolve(output, "fixture-"));
  const cert = resolve(workshop, "tls-cert.pem");
  const key = resolve(workshop, "tls-key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const credentials = { cert: await readFile(cert), key: await readFile(key) };
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const wrongPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let time = options.now ?? 1_800_000_000_000;
  const now = () => time;
  const grants = new Map();
  const exchanges = [];
  let issuerOrigin;
  let issued = 0;
  function token(authorization, role = "ada", overrides = {}) {
    const person = PEOPLE[role];
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", kid: "e12-t10-fixture", ...overrides.header }),
    ).toString("base64url");
    const claims = {
      iss: `${issuerOrigin}/`,
      aud: CLIENT_ID,
      sub: person.sub,
      email: person.email,
      email_verified: true,
      nonce: authorization.searchParams.get("nonce"),
      iat: Math.floor(now() / 1000),
      exp: Math.floor(now() / 1000) + 300,
      ...overrides.claims,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const content = `${header}.${payload}`;
    return `${content}.${sign("RSA-SHA256", Buffer.from(content), overrides.wrongSignature ? wrongPair.privateKey : pair.privateKey).toString("base64url")}`;
  }
  function issue(authorization, role = "ada", overrides = {}) {
    const code = `fixture_${String(++issued)}_${randomBytes(12).toString("base64url")}`;
    grants.set(code, { authorization, role, overrides, used: false });
    return code;
  }
  const issuerServer = createPlatformServer(async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    if (url.pathname === "/.well-known/openid-configuration")
      return Response.json({
        issuer: `${issuerOrigin}/`,
        authorization_endpoint: `${issuerOrigin}/authorize`,
        token_endpoint: `${issuerOrigin}/oauth/token`,
        jwks_uri: `${issuerOrigin}/.well-known/jwks.json`,
      });
    if (url.pathname === "/.well-known/jwks.json")
      return Response.json({
        keys: [
          {
            ...pair.publicKey.export({ format: "jwk" }),
            alg: "RS256",
            kid: "e12-t10-fixture",
            use: "sig",
          },
        ],
      });
    if (url.pathname === "/authorize" && request.method === "GET") {
      const hidden = [...url.searchParams]
        .map(
          ([name, value]) =>
            `<input type="hidden" name="${name}" value="${value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">`,
        )
        .join("");
      return new Response(
        `<!doctype html><html><head><title>Dedicated issuer fixture</title><meta name="viewport" content="width=device-width"></head><body><h1>Dedicated Auth0-shaped issuer fixture</h1><p>Synthetic identities only. This is not the real Auth0 service.</p><form method="post" action="/authorize">${hidden}<button name="role" value="ada">Continue as Ada fixture</button><button name="role" value="ada-outside">Continue as Ada outside fixture</button><button name="role" value="grace">Continue as Grace fixture</button><button name="role" value="outsider">Continue as Outsider fixture</button></form></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    if (url.pathname === "/authorize" && request.method === "POST") {
      const form = await request.formData();
      const role = form.get("role");
      if (role !== "ada-outside" && !(role in PEOPLE))
        return new Response("unknown fixture", { status: 400 });
      const authorization = new URL(`${issuerOrigin}/authorize`);
      for (const [name, value] of form)
        if (name !== "role") authorization.searchParams.set(name, String(value));
      const callback = new URL(authorization.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", authorization.searchParams.get("state"));
      callback.searchParams.set(
        "code",
        role === "ada-outside"
          ? issue(authorization, "ada", { claims: { email: "outside@example.com" } })
          : issue(authorization, role),
      );
      return new Response(null, { status: 302, headers: { location: callback.href } });
    }
    if (url.pathname === "/oauth/token" && request.method === "POST") {
      const input = new URLSearchParams(await request.text());
      const grant = grants.get(input.get("code"));
      if (!grant || grant.used)
        return Response.json(
          {
            error: "invalid_grant",
            error_description: "Unknown or already used authorization code",
          },
          { status: 400 },
        );
      const validVerifier =
        challenge(input.get("code_verifier") ?? "") ===
        grant.authorization.searchParams.get("code_challenge");
      exchanges.push({
        pkce: "S256",
        challengeMatched: validVerifier && !grant.overrides.badVerifier,
        clientIdMatched: input.get("client_id") === CLIENT_ID,
        callback: input.get("redirect_uri"),
        credentialsRetained: false,
      });
      if (!validVerifier || grant.overrides.badVerifier)
        return Response.json(
          { error: "invalid_grant", error_description: "Invalid code_verifier" },
          { status: 400 },
        );
      if (
        input.get("client_id") !== CLIENT_ID ||
        input.get("redirect_uri") !== grant.authorization.searchParams.get("redirect_uri")
      )
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      grant.used = true;
      return Response.json({
        id_token: token(grant.authorization, grant.role, grant.overrides),
        access_token: "fixture-provider-access-canary-never-retain",
        token_type: "Bearer",
      });
    }
    return new Response("not found", { status: 404 });
  });
  const issuerHttp = await listenPlatformServer(issuerServer);
  const issuerProxy = await proxy(credentials, () => issuerHttp);
  issuerOrigin = issuerProxy.origin;
  let backend;
  const appProxy = await proxy(credentials, () => backend);
  const origin = appProxy.origin;
  const dataDir = resolve(workshop, "private-data");
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const artifactPath = resolve(workshop, "artifact.json");
  const artifact = await hostedArtifact(root, resolve(root, "apps/web/dist"), revision);
  await writeFile(artifactPath, JSON.stringify(artifact));
  const environment = {
    EF_DEPLOYMENT_MODE: "production",
    EF_PUBLIC_ORIGIN: origin,
    EF_OIDC_ISSUER: `${issuerOrigin}/`,
    EF_OIDC_CLIENT_ID: CLIENT_ID,
    EF_DATA_DIR: dataDir,
    EF_WEB_ROOT: resolve(root, "apps/web/dist"),
    EF_BUILD_REVISION: revision,
    EF_AGENT_RESPONDER: options.agentResponder ?? "off",
    ...(options.agentResponder === "restricted-claude"
      ? { CLAUDE_CODE_OAUTH_TOKEN: options.claudeToken ?? `synthetic-${"x".repeat(40)}` }
      : {}),
    PORT: "0",
  };
  const oidcFetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(
      url.origin,
      issuerOrigin,
      "fixture issuer fetch cannot escape its dedicated listener",
    );
    return fetch(`${issuerHttp}${url.pathname}${url.search}`, init);
  };
  let runtime;
  const timings = [];
  async function start(name) {
    const started = performance.now();
    runtime = await createHostedRuntime(environment, {
      artifactPath,
      oidcFetch,
      now,
      ...(options.requestDeadlineMs === undefined
        ? {}
        : { requestDeadlineMs: options.requestDeadlineMs }),
      ...(options.transactionTtlMs === undefined
        ? {}
        : { transactionTtlMs: options.transactionTtlMs }),
      ...(options.claudeCommand === undefined ? {} : { claudeCommand: options.claudeCommand }),
    });
    backend = (await runtime.start()).replace("0.0.0.0", "127.0.0.1");
    const elapsedMs = Math.round(performance.now() - started);
    assert.ok(elapsedMs <= 60000);
    timings.push({ name, elapsedMs });
  }
  async function stop(name = "shutdown") {
    const started = performance.now();
    await runtime.close();
    backend = undefined;
    const elapsedMs = Math.round(performance.now() - started);
    assert.ok(elapsedMs <= 15000);
    timings.push({ name, elapsedMs });
  }
  try {
    await start("startup");
  } catch (error) {
    await closeServer(appProxy.server);
    await closeServer(issuerProxy.server);
    await closeServer(issuerServer);
    throw error;
  }
  async function begin(next = "/", extraHeaders = {}) {
    const response = await fetch(`${backend}/auth/login?next=${encodeURIComponent(next)}`, {
      redirect: "manual",
      headers: extraHeaders,
    });
    assert.equal(response.status, 302, await response.clone().text());
    const authorization = new URL(response.headers.get("location"));
    assert.equal(authorization.searchParams.get("redirect_uri"), `${origin}/auth/callback`);
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    const binding = cookiePair(response, "ef_login");
    assert.ok(binding);
    return { authorization, binding, cookies: response.headers.getSetCookie() };
  }
  async function callback(transaction, role = "ada", overrides = {}, cookie = transaction.binding) {
    const code = issue(transaction.authorization, role, overrides);
    const path = `/auth/callback?state=${transaction.authorization.searchParams.get("state")}&code=${code}`;
    const response = await fetch(`${backend}${path}`, {
      redirect: "manual",
      headers: cookie === undefined ? {} : { cookie },
    });
    return { response, path };
  }
  async function login(role = "ada", next = "/") {
    const transaction = await begin(next);
    const { response } = await callback(transaction, role);
    assert.equal(response.status, 302, await response.clone().text());
    const cookie = cookiePair(response, "ef_session");
    assert.ok(cookie);
    return { cookie, transaction, response };
  }
  const adapter = () => new OfficialStreamAdapter({ baseUrl: runtime.streamUrl });
  async function events(streamId) {
    return (await adapter().exists(streamId)) ? adapter().read(streamId) : [];
  }
  async function heads(streamIds = ["__identity__", "ns:root"]) {
    const result = {};
    for (const streamId of streamIds) {
      const items = await events(streamId);
      const encoded = items.length ? `${items.map(canonicalJson).join("\n")}\n` : "";
      result[streamId] = { count: items.length, sha256: sha(encoded) };
    }
    return result;
  }
  return {
    get runtime() {
      return runtime;
    },
    get baseUrl() {
      return backend;
    },
    origin,
    issuer: `${issuerOrigin}/`,
    environment,
    artifactPath,
    dataDir,
    workshop,
    timings,
    exchanges,
    issue,
    token,
    begin,
    callback,
    login,
    events,
    heads,
    now,
    setNow(value) {
      time = value;
    },
    restart: async () => {
      await stop("shutdown-for-restart");
      await start("restart");
    },
    close: async () => {
      await stop();
      await closeServer(appProxy.server);
      await closeServer(issuerProxy.server);
      await closeServer(issuerServer);
    },
    async dumpIdentity(name) {
      const snapshot = await runtime.identity.snapshot();
      const path = resolve(output, `${name}.jsonl`);
      await writeFile(
        path,
        snapshot.events.length ? `${snapshot.events.map(canonicalJson).join("\n")}\n` : "",
      );
      return {
        path,
        count: snapshot.events.length,
        transportCursor: snapshot.offset,
        lastApplicationOffset: snapshot.events.at(-1)?.offset ?? "-1",
        digest: snapshot.digest,
        sha256: sha(await readFile(path)),
      };
    },
  };
}
