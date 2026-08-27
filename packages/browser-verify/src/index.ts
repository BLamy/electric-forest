import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { createServer as createHttpServer, type IncomingHttpHeaders } from "node:http";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { headDurableJsonStream, readDurableJson, type StreamRecord } from "@eforest/client";
import type { AuthorizationView } from "@eforest/identity";
import {
  IdentityStore,
  OfficialStreamAdapter,
  WriterLaneDispatcher,
  createPlatformProductionRuntime,
  listenPlatformServer,
  type AuthorizationVerifier,
  type IdentitySnapshot,
  type PlatformGatewayOptions,
} from "@eforest/platform";
import type { Event, Offset } from "@eforest/protocol";
import type { Browser, BrowserContext, Page } from "playwright-core";

export interface BrowserSubject {
  readonly id: string;
  readonly email: string;
  readonly password: string;
  readonly name?: string;
}

export interface EfRegion {
  readonly stream: string;
  readonly offset: string;
  readonly digest: string;
}

export interface GuardedPage {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly network: readonly WireObservation[];
  settleNetwork(): Promise<void>;
  assertClean(): void;
  close(): Promise<void>;
}

export interface WireObservation {
  readonly layer: "browser" | "platform-wire" | "server-oidc";
  readonly direction: "request" | "response";
  readonly url: string;
  readonly method?: string;
  readonly status?: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly bodyBase64: string | null;
  readonly bodyError?: string;
}

function rawHeaderEntries(rawHeaders: readonly string[]): readonly (readonly [string, string])[] {
  const entries: (readonly [string, string])[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    entries.push([rawHeaders[index] ?? "", rawHeaders[index + 1] ?? ""]);
  }
  return entries;
}

function responseHeaderEntries(
  headers: import("node:http").OutgoingHttpHeaders,
): readonly (readonly [string, string])[] {
  const entries: (readonly [string, string])[] = [];
  for (const [name, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) entries.push([name, String(item)]);
    }
  }
  return entries;
}

function capturePlatformWire(
  server: import("node:http").Server,
  observations: WireObservation[],
): void {
  server.prependListener("request", (request, response) => {
    const requestChunks: Buffer[] = [];
    const responseChunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) =>
      requestChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    );
    request.on("end", () => {
      observations.push({
        layer: "platform-wire",
        direction: "request",
        url: request.url ?? "",
        ...(request.method === undefined ? {} : { method: request.method }),
        headers: rawHeaderEntries(request.rawHeaders),
        bodyBase64: bodyBase64(Buffer.concat(requestChunks)),
      });
    });
    const write = response.write.bind(response);
    const end = response.end.bind(response);
    response.write = ((chunk: unknown, ...args: unknown[]) => {
      if (chunk !== undefined && chunk !== null) {
        responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      return write(chunk as never, ...(args as never[]));
    }) as typeof response.write;
    response.end = ((chunk?: unknown, ...args: unknown[]) => {
      if (chunk !== undefined && chunk !== null) {
        responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      return end(chunk as never, ...(args as never[]));
    }) as typeof response.end;
    response.on("finish", () => {
      observations.push({
        layer: "platform-wire",
        direction: "response",
        url: request.url ?? "",
        status: response.statusCode,
        headers: responseHeaderEntries(response.getHeaders()),
        bodyBase64: bodyBase64(Buffer.concat(responseChunks)),
      });
    });
  });
}

export interface BrowserWorld {
  readonly platformUrl: string;
  readonly streamUrl: string;
  readonly emulatorUrl: string;
  readonly identityStreamUrl: string;
  readonly dataDir: string;
  readonly subject: BrowserSubject;
  readonly identity: IdentityStore;
  readonly serverNetwork: readonly WireObservation[];
  snapshotIdentity(): Promise<IdentitySnapshot>;
  dumpIdentity(): Promise<readonly StreamRecord[]>;
  headIdentity(): Promise<string>;
  seedPublicRepo(options: {
    readonly org: string;
    readonly project: string;
    readonly repo: string;
    readonly branch: string;
    readonly events?: readonly Event[];
  }): Promise<string>;
  dispatchNamespace(streamId: string, event: Event, actor?: string): Promise<void>;
  appendApplication(streamId: string, event: Event): Promise<Offset>;
  appendApplicationAs(streamId: string, event: Event, actor: string): Promise<Offset>;
  appendApplicationAt(streamId: string, event: Event, offset: Offset): Promise<void>;
  openPage(browser: Browser): Promise<GuardedPage>;
  close(): Promise<void>;
}

interface Emulator {
  readonly url: string;
  close(): Promise<void>;
}

interface FixtureLoginProxy {
  readonly url: string;
  close(): Promise<void>;
}

interface Auth0EmulatorStartup {
  readonly emulator: Emulator;
  readonly fixtureProxy?: FixtureLoginProxy;
}

interface Auth0EmulatorStartupOptions {
  readonly root: string;
  readonly fixtureLogin: boolean;
  readonly platformUrl: string;
  readonly subject: BrowserSubject;
  readonly clientId: string;
  readonly nowSeconds: number;
  /** @internal Overrides only the child module loaded by startup-race tests. */
  readonly emulatorModuleUrl?: string;
  readonly allocatePort?: () => Promise<number>;
  readonly onAttempt?: (attempt: {
    readonly number: number;
    readonly pid: number;
    readonly port: number;
  }) => void;
}

function isLoopback(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("ephemeral port unavailable");
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error === undefined ? resolveClose() : reject(error))),
  );
  return address.port;
}

async function waitForListening(child: ChildProcess): Promise<string> {
  let stdout = "";
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  return await new Promise<string>((resolveListening, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`stream server did not listen: ${stderr}`)),
      15_000,
    );
    const finish = (operation: () => void): void => {
      clearTimeout(timeout);
      operation();
    };
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      const match = /(?:^|\n)LISTENING (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
      if (match?.[1] !== undefined) finish(() => resolveListening(match[1]!));
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) =>
      finish(() =>
        reject(
          new Error(
            `stream server exited before listening: code=${String(code)} signal=${String(signal)} ${stderr}`,
          ),
        ),
      ),
    );
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolveExit) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolveExit();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}

async function closeServer(server: import("node:http").Server): Promise<void> {
  server.closeIdleConnections();
  server.closeAllConnections();
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error === undefined ? resolveClose() : reject(error))),
  );
}

function forwardedHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      name === "host" ||
      name === "content-length" ||
      name === "connection" ||
      name === "keep-alive"
    )
      continue;
    for (const item of Array.isArray(value) ? value : [value]) result.append(name, item);
  }
  result.set("connection", "close");
  return result;
}

function fixtureLoginHtml(html: string): string {
  const fieldsStart = html.indexOf('<label for="auth0-email">');
  const submitStart = html.indexOf('<button class="checkout-pay-btn"', fieldsStart);
  assert.ok(fieldsStart >= 0 && submitStart > fieldsStart, "emulator login form shape changed");
  const withoutCredentials =
    html.slice(0, fieldsStart) +
    '<p data-testid="auth0-fixture-notice">Test fixture identity — no password is sent by this browser.</p>\n' +
    html.slice(submitStart);
  return withoutCredentials
    .replace(
      '<form method="post" action="/authorize" data-testid="auth0-login-form">',
      '<form method="post" action="/__fixture/authorize" data-testid="auth0-fixture-login-form">',
    )
    .replace('data-testid="auth0-login-submit"', 'data-testid="auth0-fixture-login-submit"')
    .replace(">Continue</button>", ">Continue with test identity</button>");
}

async function startFixtureLoginProxy(
  port: number,
  upstreamUrl: string,
  subject: BrowserSubject,
): Promise<FixtureLoginProxy> {
  const url = `http://127.0.0.1:${String(port)}`;
  const server = createHttpServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", url);
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      let body = Buffer.concat(chunks);
      let targetPath = `${requestUrl.pathname}${requestUrl.search}`;
      const headers = forwardedHeaders(request.headers);
      if (request.method === "POST" && requestUrl.pathname === "/__fixture/authorize") {
        const form = new globalThis.URLSearchParams(body.toString("utf8"));
        assert.equal(form.has("email"), false);
        assert.equal(form.has("password"), false);
        form.set("email", subject.email);
        form.set("password", subject.password);
        body = Buffer.from(form.toString());
        targetPath = "/authorize";
        headers.set("content-type", "application/x-www-form-urlencoded");
      }
      const upstream = await fetch(new URL(targetPath, upstreamUrl), {
        ...(request.method === undefined ? {} : { method: request.method }),
        headers,
        ...(request.method === "GET" || request.method === "HEAD" ? {} : { body }),
        redirect: "manual",
      });
      let output = Buffer.from(await upstream.arrayBuffer());
      if (
        request.method === "GET" &&
        requestUrl.pathname === "/authorize" &&
        upstream.status === 200
      ) {
        output = Buffer.from(fixtureLoginHtml(output.toString("utf8")));
      }
      response.statusCode = upstream.status;
      for (const [name, value] of upstream.headers) {
        if (
          name === "content-length" ||
          name === "content-encoding" ||
          name === "transfer-encoding" ||
          name === "connection" ||
          name === "keep-alive"
        )
          continue;
        response.setHeader(name, value);
      }
      response.setHeader("content-length", String(output.length));
      response.end(output);
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          error: {
            class: "fixture-login-proxy",
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  return { url, close: () => closeServer(server) };
}

function deterministicRandom(seed: number): (size: number) => Uint8Array {
  let counter = seed;
  return (size) => {
    counter += 1;
    return Uint8Array.from({ length: size }, (_, index) => (counter * 31 + index * 17) & 0xff);
  };
}

function headerEntries(headers: Headers): readonly (readonly [string, string])[] {
  return [...headers.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function bodyBase64(bytes: ArrayBuffer | Uint8Array | null): string | null {
  if (bytes === null) return null;
  return Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).toString(
    "base64",
  );
}

async function captureServerFetch(
  observations: WireObservation[],
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const requestClone = request.clone();
  const requestBytes =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : await requestClone.arrayBuffer().catch(() => null);
  observations.push({
    layer: "server-oidc",
    direction: "request",
    url: request.url,
    method: request.method,
    headers: headerEntries(request.headers),
    bodyBase64: bodyBase64(requestBytes),
  });
  const response = await fetch(request);
  const responseClone = response.clone();
  try {
    observations.push({
      layer: "server-oidc",
      direction: "response",
      url: response.url || request.url,
      status: response.status,
      headers: headerEntries(response.headers),
      bodyBase64: bodyBase64(await responseClone.arrayBuffer()),
    });
  } catch (error) {
    observations.push({
      layer: "server-oidc",
      direction: "response",
      url: response.url || request.url,
      status: response.status,
      headers: headerEntries(response.headers),
      bodyBase64: null,
      bodyError: error instanceof Error ? error.message : String(error),
    });
  }
  return response;
}

const emulatorChildSource = String.raw`
import process from "node:process";

const moduleUrl = process.argv[1];
let serialized = "";
for await (const chunk of process.stdin) serialized += chunk.toString();
const options = JSON.parse(serialized);
let emulator;
let stopping = false;
let ready = false;

function errorText(error) {
  if (!(error instanceof Error)) return String(error);
  const code = "code" in error ? String(error.code) : "unknown";
  return error.name + ": " + error.message + " code=" + code;
}

async function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  if (ready) {
    try {
      await Promise.race([
        emulator.close(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("emulator close timed out")), 1000),
        ),
      ]);
    } catch (error) {
      process.stderr.write("emulator close failed: " + errorText(error) + "\n");
      exitCode = 1;
    }
  }
  process.exit(exitCode);
}

function fail(prefix, error) {
  process.stderr.write(prefix + errorText(error) + "\n");
  process.exit(1);
}

process.once("SIGINT", () => void stop(0));
process.once("SIGTERM", () => void stop(0));
process.once("uncaughtException", (error) => fail("emulator startup failed: ", error));
process.once("unhandledRejection", (error) => fail("emulator startup rejected: ", error));

try {
  const { createEmulator } = await import(moduleUrl);
  emulator = await createEmulator(options);
  await new Promise((resolve) => setImmediate(resolve));
  const deadline = Date.now() + 5000;
  let readinessError;
  while (Date.now() < deadline) {
    try {
      const discovery = await fetch(
        new URL("/.well-known/openid-configuration", options.internalUrl),
      );
      const document = await discovery.json();
      if (discovery.ok && document.issuer === options.baseUrl + "/") {
        ready = true;
        process.stdout.write("READY\n");
        break;
      }
      readinessError = new Error("Auth0 readiness response did not advertise the configured issuer");
    } catch (error) {
      readinessError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!ready) throw readinessError ?? new Error("Auth0 readiness timed out");
} catch (error) {
  fail("emulator startup rejected: ", error);
}
`;

function isRetryableEmulatorStartup(error: unknown): boolean {
  return (
    (error instanceof Error && "code" in error && error.code === "EADDRINUSE") ||
    (error instanceof Error &&
      (error.message.includes("EADDRINUSE") ||
        error.message.includes("exited before readiness") ||
        error.message.includes("did not become ready")))
  );
}

async function startEmulatorProcess(
  root: string,
  options: Record<string, unknown>,
  attempt: number,
  onAttempt?: Auth0EmulatorStartupOptions["onAttempt"],
  emulatorModuleUrl?: string,
): Promise<Emulator> {
  const modulePath = resolve(root, ["vendor", "emulate"].join("/"), "packages/emulate/dist/api.js");
  const moduleUrl = emulatorModuleUrl ?? pathToFileURL(modulePath).href;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", emulatorChildSource, moduleUrl],
    { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
  );
  const port = options.port;
  if (typeof port !== "number") throw new Error("emulator port unavailable");
  assert.ok(child.pid !== undefined, "emulator child PID unavailable");
  onAttempt?.({ number: attempt, pid: child.pid, port });
  child.stdin?.end(JSON.stringify(options));

  let stdout = "";
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      const timeout = setTimeout(
        () => rejectReady(new Error(`emulator did not become ready: ${stderr}`)),
        15_000,
      );
      const finish = (operation: () => void): void => {
        clearTimeout(timeout);
        child.removeListener("error", onError);
        child.removeListener("exit", onExit);
        operation();
      };
      const onError = (error: Error): void => finish(() => rejectReady(error));
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
        finish(() =>
          rejectReady(
            new Error(
              `emulator exited before readiness: code=${String(code)} signal=${String(signal)} ${stderr}`,
            ),
          ),
        );
      child.once("error", onError);
      child.once("exit", onExit);
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
        if (/(?:^|\n)READY\n/.test(stdout)) finish(resolveReady);
      });
    });
  } catch (error) {
    await stopChild(child);
    throw error;
  }

  return {
    url: String(options.baseUrl),
    close: () => stopChild(child),
  };
}

async function auth0Seed(
  root: string,
  options: {
    readonly port: number;
    readonly platformUrl: string;
    readonly subject: BrowserSubject;
    readonly clientId: string;
    readonly nowSeconds: number;
    readonly baseUrl?: string;
  },
): Promise<Record<string, unknown>> {
  const fixtureRoot = resolve(
    root,
    ["vendor", "emulate"].join("/"),
    "packages/@emulators/auth0/fixtures",
  );
  const privateJwk = JSON.parse(
    await readFile(resolve(fixtureRoot, "test-keypair.private.jwk.json"), "utf8"),
  ) as JsonWebKey;
  const publicJwk = JSON.parse(
    await readFile(resolve(fixtureRoot, "test-keypair.public.jwk.json"), "utf8"),
  ) as JsonWebKey;
  const privatePem = createPrivateKey({ key: privateJwk, format: "jwk" })
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  const publicPem = createPublicKey({ key: publicJwk, format: "jwk" })
    .export({ format: "pem", type: "spki" })
    .toString();
  const baseUrl = options.baseUrl ?? `http://127.0.0.1:${String(options.port)}`;
  return {
    service: "auth0",
    port: options.port,
    baseUrl,
    now: options.nowSeconds,
    seedMaterial: "e3-t02-browser-world",
    seed: {
      auth0: {
        now: options.nowSeconds,
        seed: "e3-t02-browser-world",
        connections: [{ name: "Username-Password-Authentication" }],
        users: [
          {
            email: options.subject.email,
            password: options.subject.password,
            user_id: options.subject.id,
            email_verified: true,
            name: options.subject.name ?? options.subject.id,
          },
        ],
        oauth_clients: [
          {
            client_id: options.clientId,
            client_secret: "",
            redirect_uris: [`${options.platformUrl}/auth/callback`],
            grant_types: ["authorization_code"],
            audience: options.clientId,
          },
        ],
        signing_key: {
          private_key_pem: privatePem,
          public_key_pem: publicPem,
          kid: "e3-t02-browser-key",
        },
      },
    },
  };
}

async function startAuth0Emulator(
  options: Auth0EmulatorStartupOptions,
): Promise<Auth0EmulatorStartup> {
  const allocatePort = options.allocatePort ?? freePort;
  const maximumAttempts = 5;
  let lastCollision: unknown;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const advertisedPort = await allocatePort();
    let internalPort = advertisedPort;
    if (options.fixtureLogin) {
      do {
        internalPort = await allocatePort();
      } while (internalPort === advertisedPort);
    }
    const advertisedUrl = `http://127.0.0.1:${String(advertisedPort)}`;
    let emulator: Emulator | undefined;
    try {
      emulator = await startEmulatorProcess(
        options.root,
        {
          ...(await auth0Seed(options.root, {
            port: internalPort,
            platformUrl: options.platformUrl,
            subject: options.subject,
            clientId: options.clientId,
            nowSeconds: options.nowSeconds,
            baseUrl: advertisedUrl,
          })),
          internalUrl: `http://127.0.0.1:${String(internalPort)}`,
        },
        attempt,
        options.onAttempt,
        options.emulatorModuleUrl,
      );
      const fixtureProxy = options.fixtureLogin
        ? await startFixtureLoginProxy(
            advertisedPort,
            `http://127.0.0.1:${String(internalPort)}`,
            options.subject,
          )
        : undefined;
      return { emulator, ...(fixtureProxy === undefined ? {} : { fixtureProxy }) };
    } catch (error) {
      await emulator?.close();
      if (!isRetryableEmulatorStartup(error)) throw error;
      lastCollision = error;
    }
  }
  throw new Error(`emulator ports remained occupied after ${String(maximumAttempts)} attempts`, {
    cause: lastCollision,
  });
}

/** @internal Deterministic startup-race coverage without widening bootWorld's public options. */
export const browserVerifyStartupTestHooks = { startAuth0Emulator };

function sessionSecret(): string {
  return "e3-t02-browser-session-secret-is-at-least-32-bytes";
}

export async function bootWorld(
  options: {
    readonly subject?: BrowserSubject;
    readonly root?: string;
    readonly fixtureLogin?: boolean;
    readonly proofReceiptPath?: string;
    readonly platformPort?: number;
    /** @internal Test-only emulator module override for focused browser oracles. */
    readonly auth0EmulatorModuleUrl?: string;
    readonly gatewayVerifier?: AuthorizationVerifier;
    readonly gatewayDecideAuthorization?: PlatformGatewayOptions["decideAuthorization"];
  } = {},
): Promise<BrowserWorld> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("browser-verify emulator fixtures are forbidden in production");
  }
  if (options.proofReceiptPath !== undefined && options.fixtureLogin !== true) {
    throw new Error("proof receipt requires the explicit test fixture login");
  }
  const root = options.root ?? process.cwd();
  const subject = options.subject ?? {
    id: "ada",
    email: "ada@canopy.test",
    password: "AdaCanopy1234!",
    name: "Ada Canopy",
  };
  const dataDir = await mkdtemp(resolve(tmpdir(), "eforest-e3-t02-"));
  const serverBin = resolve(root, "packages/server/dist/src/bin.js");
  const streamChild = spawn(
    process.execPath,
    [serverBin, "--port=0", "--store", "file", "--data-dir", dataDir],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  const streamUrl = await waitForListening(streamChild);
  const platformPort = options.platformPort ?? (await freePort());
  const platformUrl = `http://127.0.0.1:${String(platformPort)}`;
  const clientId = "eforest-e3-t02-browser";
  const nowSeconds = 1_700_000_000;
  let auth0: Auth0EmulatorStartup;
  try {
    auth0 = await startAuth0Emulator({
      root,
      fixtureLogin: options.fixtureLogin === true,
      platformUrl,
      subject,
      clientId,
      nowSeconds,
      ...(options.auth0EmulatorModuleUrl === undefined
        ? {}
        : { emulatorModuleUrl: options.auth0EmulatorModuleUrl }),
    });
  } catch (error) {
    await stopChild(streamChild);
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
  const { emulator, fixtureProxy } = auth0;
  // Ports prove isolation, but must not leak nondeterminism into the durable identity log.
  const random = deterministicRandom(3_002);
  const serverNetwork: WireObservation[] = [];
  let operation = 0;
  const runtime = await createPlatformProductionRuntime(
    {
      EF_OIDC_ISSUER: fixtureProxy?.url ?? emulator.url,
      EF_OIDC_CLIENT_ID: clientId,
      EF_SESSION_SECRET: sessionSecret(),
      EF_SESSION_TTL: "60",
      EFOREST_SERVER_URL: streamUrl,
      EF_WEB_ROOT: resolve(root, "apps/web/dist"),
    },
    {
      now: () => nowSeconds * 1_000,
      random,
      operationId: () => `e3-t02-browser-operation-${String(++operation).padStart(4, "0")}`,
      rateLimit: { max: 1_000, windowMs: 60_000 },
      oidcFetch: (input, init) => captureServerFetch(serverNetwork, input, init),
      ...(options.gatewayVerifier === undefined
        ? {}
        : { gatewayVerifier: options.gatewayVerifier }),
      ...(options.gatewayDecideAuthorization === undefined
        ? {}
        : { gatewayDecideAuthorization: options.gatewayDecideAuthorization }),
    },
  );
  const applicationStreams = new OfficialStreamAdapter({ baseUrl: streamUrl });
  const applicationWriters = new WriterLaneDispatcher(applicationStreams);
  const browserSubject = subject.id.startsWith("auth0|") ? subject.id : `auth0|${subject.id}`;
  const settleRegistry = async (): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await runtime.registry.syncOnce();
      const rootRecords = await applicationStreams.read("ns:root");
      const orgs = rootRecords
        .filter(
          (
            record,
          ): record is { readonly type: "ns.org.create"; readonly payload: { name: string } } =>
            typeof record === "object" &&
            record !== null &&
            (record as { readonly type?: unknown }).type === "ns.org.create" &&
            typeof (record as { readonly payload?: { readonly name?: unknown } }).payload?.name ===
              "string",
        )
        .map((record) => record.payload.name);
      const expected =
        rootRecords.length +
        (await Promise.all(orgs.map((org) => applicationStreams.read(`ns:org:${org}`)))).reduce(
          (sum, records) => sum + records.length,
          0,
        );
      const projected = await applicationStreams.read("__registry__");
      if (projected.length === expected) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error("registry projector did not reach the namespace-stream fixpoint");
  };
  if (options.proofReceiptPath !== undefined) {
    runtime.app.installTestProofReceiptForHarness(async () => {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        let serialized: string;
        try {
          serialized = await readFile(options.proofReceiptPath!, "utf8");
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            (error as NodeJS.ErrnoException).code === "ENOENT"
          ) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 250));
            continue;
          }
          throw error;
        }
        assert.equal(/password|code_verifier/i.test(serialized), false);
        return JSON.parse(serialized) as unknown;
      }
      return undefined;
    });
  }
  const identity = runtime.identity;
  const platformServer = runtime.server;
  capturePlatformWire(platformServer, serverNetwork);
  await listenPlatformServer(platformServer, platformPort);
  let closed = false;

  return {
    platformUrl,
    streamUrl,
    emulatorUrl: fixtureProxy?.url ?? emulator.url,
    identityStreamUrl: `${streamUrl}/streams/${encodeURIComponent(identity.streamId)}`,
    dataDir,
    subject,
    identity,
    serverNetwork,
    snapshotIdentity: () => identity.snapshot(),
    dumpIdentity: () => readDurableJson<StreamRecord>({ url: `${streamUrl}/streams/__identity__` }),
    headIdentity: async () =>
      (await headDurableJsonStream({ url: `${streamUrl}/streams/__identity__` })).offset ?? "-1",
    seedPublicRepo: async ({ org, project, repo, branch, events = [] }) => {
      await runtime.namespaces.dispatch(
        "ns:root",
        { type: "ns.org.create", payload: { v: 1, name: org }, ts: 1 },
        browserSubject,
      );
      await runtime.namespaces.dispatch(
        `ns:org:${org}`,
        { type: "ns.project.create", payload: { v: 1, name: project }, ts: 2 },
        browserSubject,
      );
      await runtime.namespaces.dispatch(
        `ns:org:${org}`,
        {
          type: "ns.repo.create",
          payload: { v: 1, name: repo, project, visibility: "public" },
          ts: 3,
        },
        browserSubject,
      );
      const streamId = `fs:${org}/${repo}:${branch}:meta`;
      await applicationStreams.create(streamId);
      for (const event of events) {
        await applicationWriters.dispatch(streamId, event, browserSubject);
      }
      await settleRegistry();
      return streamId;
    },
    dispatchNamespace: async (streamId, event, actor = browserSubject) => {
      await runtime.namespaces.dispatch(streamId, event, actor);
      await settleRegistry();
    },
    appendApplication: async (streamId, event) =>
      (await applicationWriters.dispatch(streamId, event, browserSubject)).globalSequence,
    appendApplicationAs: async (streamId, event, actor) =>
      (await applicationWriters.dispatch(streamId, event, actor)).globalSequence,
    appendApplicationAt: async (streamId, event, offset) => {
      await applicationStreams.append(streamId, event, { applicationOffset: offset });
    },
    openPage: async (browser) => openGuardedPage(browser, platformUrl),
    close: async () => {
      if (closed) return;
      closed = true;
      await closeServer(platformServer);
      await runtime.registry.stop();
      runtime.gateway.terminate();
      runtime.namespaces.terminate();
      await fixtureProxy?.close();
      await emulator.close();
      await stopChild(streamChild);
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function openGuardedPage(browser: Browser, platformUrl: string): Promise<GuardedPage> {
  const failures: string[] = [];
  const network: WireObservation[] = [];
  const pending = new Set<Promise<void>>();
  const context = await browser.newContext();
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!isLoopback(url)) {
      failures.push(`non-loopback request: ${url.href}`);
      await route.abort("blockedbyclient");
      return;
    }
    network.push({
      layer: "browser",
      direction: "request",
      url: url.href,
      method: request.method(),
      headers: (await request.headersArray())
        .map(({ name, value }) => [name, value] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
      bodyBase64: bodyBase64(request.postDataBuffer()),
    });
    await route.fallback();
  });
  const guarded = new WeakSet<Page>();
  const guardPage = (page: Page): void => {
    if (guarded.has(page)) return;
    guarded.add(page);
    page.on("console", (message) => {
      if (message.type() === "error") failures.push(`console.error: ${message.text()}`);
    });
    page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
    page.on("requestfailed", (request) => {
      const url = new URL(request.url());
      if (url.origin === platformUrl || isLoopback(url)) {
        failures.push(
          `requestfailed: ${request.method()} ${url.href} ${request.failure()?.errorText ?? "unknown"}`,
        );
      }
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      const capture = (async (): Promise<void> => {
        let headers: Array<readonly [string, string]> = [];
        try {
          headers = (await response.headersArray())
            .map(({ name, value }) => [name, value] as const)
            .sort(([left], [right]) => left.localeCompare(right));
          network.push({
            layer: "browser",
            direction: "response",
            url: url.href,
            status: response.status(),
            headers,
            bodyBase64: bodyBase64(await response.body()),
          });
        } catch (error) {
          network.push({
            layer: "browser",
            direction: "response",
            url: url.href,
            status: response.status(),
            headers,
            bodyBase64: null,
            bodyError: error instanceof Error ? error.message : String(error),
          });
        }
      })();
      pending.add(capture);
      void capture.finally(() => pending.delete(capture));
    });
  };
  context.on("page", guardPage);
  const page = await context.newPage();
  guardPage(page);
  return {
    context,
    page,
    network,
    settleNetwork: async () => {
      await Promise.all([...pending]);
    },
    assertClean: () => assert.deepEqual(failures, [], failures.join("\n")),
    close: () => context.close(),
  };
}

export async function loginAs(page: Page, subject: BrowserSubject): Promise<void> {
  await page.getByTestId("auth0-login-form").waitFor();
  await page.getByTestId("auth0-login-email").click();
  await page.getByTestId("auth0-login-email").fill(subject.email);
  await page.getByTestId("auth0-login-password").click();
  await page.getByTestId("auth0-login-password").fill(subject.password);
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/"),
    page.getByTestId("auth0-login-submit").click(),
  ]);
  await page.getByTestId("identity-region").waitFor();
}

export async function loginWithFixture(page: Page): Promise<void> {
  await page.getByTestId("auth0-fixture-login-form").waitFor();
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  assert.equal(await page.locator('input[name="email"], input[name="password"]').count(), 0);
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/"),
    page.getByTestId("auth0-fixture-login-submit").click(),
  ]);
  await page.getByTestId("identity-region").waitFor();
}

export async function collectEfRegions(page: Page): Promise<readonly EfRegion[]> {
  const observations = await page
    .locator("[data-ef-stream], [data-ef-offset], [data-ef-digest]")
    .evaluateAll((elements) =>
      elements.map((element) => ({
        stream: element.getAttribute("data-ef-stream"),
        offset: element.getAttribute("data-ef-offset"),
        digest: element.getAttribute("data-ef-digest"),
      })),
    );
  for (const [index, observation] of observations.entries()) {
    const values = [observation.stream, observation.offset, observation.digest];
    assert.equal(
      values.filter((value) => value !== null).length,
      3,
      `partial EF region at index ${String(index)}`,
    );
  }
  return observations.map((observation) => ({
    stream: observation.stream!,
    offset: observation.offset!,
    digest: observation.digest!,
  }));
}

export interface CredentialScanOptions {
  readonly secretLiterals: readonly string[];
}

export interface CredentialScanReceipt {
  readonly observations: number;
  readonly fields: number;
}

function decodedBody(observation: WireObservation): string {
  return observation.bodyBase64 === null
    ? ""
    : Buffer.from(observation.bodyBase64, "base64").toString("utf8");
}

interface CookieComponent {
  readonly name: string;
  readonly value: string;
}

interface SetCookieRecord {
  readonly cookie: CookieComponent;
  readonly attributes: readonly {
    readonly name: string;
    readonly value?: string;
  }[];
}

const cookieToken = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const sessionCookieValue = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const maximumEncodedComponentBytes = 8 * 1024;
const maximumPercentDecodePasses = 2;

interface CanonicalPercentDecode {
  readonly representations: readonly string[];
  readonly error?: "control" | "malformed" | "overlong" | "recursive";
}

interface PercentUnit {
  readonly character: string;
  /**
   * Zero is raw input. Every successful decode increments the depth of every
   * character it emits, preserving same-pass provenance across whole octet runs.
   */
  readonly decodeDepth: number;
}

interface PercentGrammar {
  readonly encodedOctets: number;
  readonly malformed: boolean;
}

/**
 * Percent grammar is parsed left-to-right per occurrence, not inferred from
 * suffix shapes and not summarized by the first percent encountered.
 *
 * A raw percent must begin a complete `%HH` octet. An incomplete percent emitted
 * by the first decode is direct literal `%25` data and is retained while scanning
 * later occurrences. An incomplete percent emitted by a later decode crossed a
 * recursive boundary and is malformed. A depth-one percent followed by hex
 * characters emitted in the same pass is literal data, not a deeper escape;
 * genuine deeper escapes have two hex characters from a shallower depth.
 * Complete occurrences decode in adjacent same-depth byte runs, and safe literals
 * never short-circuit later encoded input.
 */
function isEncodedPercentAt(units: readonly PercentUnit[], index: number): boolean {
  const percent = units[index];
  const high = units[index + 1];
  const low = units[index + 2];
  if (
    percent?.character !== "%" ||
    high === undefined ||
    low === undefined ||
    !/[0-9A-Fa-f]/.test(high.character) ||
    !/[0-9A-Fa-f]/.test(low.character)
  ) {
    return false;
  }
  return (
    percent.decodeDepth === 0 ||
    (high.decodeDepth < percent.decodeDepth && low.decodeDepth < percent.decodeDepth)
  );
}

function classifyPercentGrammar(units: readonly PercentUnit[]): PercentGrammar {
  let encodedOctets = 0;
  let malformed = false;
  for (let index = 0; index < units.length; index += 1) {
    if (units[index]!.character !== "%") continue;
    const high = units[index + 1]?.character;
    const low = units[index + 2]?.character;
    if (
      high === undefined ||
      low === undefined ||
      !/[0-9A-Fa-f]/.test(high) ||
      !/[0-9A-Fa-f]/.test(low)
    ) {
      if (units[index]!.decodeDepth !== 1) malformed = true;
      continue;
    }
    if (isEncodedPercentAt(units, index)) {
      encodedOctets += 1;
    } else if (units[index]!.decodeDepth !== 1) {
      malformed = true;
    }
    index += 2;
  }
  return { encodedOctets, malformed };
}

function decodePercentOctets(units: readonly PercentUnit[]): readonly PercentUnit[] | undefined {
  const decoded: PercentUnit[] = [];
  for (let index = 0; index < units.length;) {
    const unit = units[index]!;
    if (!isEncodedPercentAt(units, index)) {
      decoded.push(unit);
      index += 1;
      continue;
    }

    let encodedRun = "";
    const sourceDepth = unit.decodeDepth;
    while (
      index + 2 < units.length &&
      units[index]!.decodeDepth === sourceDepth &&
      isEncodedPercentAt(units, index)
    ) {
      const runHigh = units[index + 1]!.character;
      const runLow = units[index + 2]!.character;
      encodedRun += `%${runHigh}${runLow}`;
      index += 3;
    }
    try {
      for (const character of decodeURIComponent(encodedRun)) {
        decoded.push({ character, decodeDepth: sourceDepth + 1 });
      }
    } catch {
      return undefined;
    }
  }
  return decoded;
}

function canonicalPercentDecode(value: string, plusAsSpace: boolean): CanonicalPercentDecode {
  if (Buffer.byteLength(value, "utf8") > maximumEncodedComponentBytes) {
    return { representations: [], error: "overlong" };
  }
  let current = plusAsSpace ? value.replaceAll("+", " ") : value;
  const representations: string[] = current === value ? [] : [current];
  let units: readonly PercentUnit[] = [...current].map((character) => ({
    character,
    decodeDepth: 0,
  }));
  if (hasControlCharacter(current)) {
    return { representations, error: "control" };
  }
  let grammar = classifyPercentGrammar(units);
  if (grammar.malformed) {
    return { representations, error: "malformed" };
  }
  for (let pass = 0; pass < maximumPercentDecodePasses; pass += 1) {
    if (grammar.encodedOctets === 0) break;
    const decodedUnits = decodePercentOctets(units);
    if (decodedUnits === undefined) {
      return { representations, error: "malformed" };
    }
    const decoded = decodedUnits.map((unit) => unit.character).join("");
    if (Buffer.byteLength(decoded, "utf8") > maximumEncodedComponentBytes) {
      return { representations, error: "overlong" };
    }
    if (decoded !== value && !representations.includes(decoded)) representations.push(decoded);
    current = decoded;
    units = decodedUnits;
    if (hasControlCharacter(current)) {
      return { representations, error: "control" };
    }
    grammar = classifyPercentGrammar(units);
    if (grammar.malformed) {
      return { representations, error: "malformed" };
    }
  }
  if (grammar.encodedOctets > 0) {
    return { representations, error: "recursive" };
  }
  return { representations };
}

/**
 * Collects ordinary successful decodeURIComponent representations only for
 * protected-literal matching. This search cannot produce a validity finding:
 * malformed, recursive, overlong, and control decisions remain exclusively in
 * canonicalPercentDecode's provenance grammar.
 */
function alternatePercentRepresentations(value: string, plusAsSpace: boolean): readonly string[] {
  if (Buffer.byteLength(value, "utf8") > maximumEncodedComponentBytes) return [];
  let current = plusAsSpace ? value.replaceAll("+", " ") : value;
  const representations: string[] = [];
  for (let pass = 0; pass < maximumPercentDecodePasses; pass += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      break;
    }
    if (decoded === current || Buffer.byteLength(decoded, "utf8") > maximumEncodedComponentBytes) {
      break;
    }
    representations.push(decoded);
    current = decoded;
  }
  return representations;
}

interface RawAuthority {
  readonly userinfo?: string;
  readonly host: string;
  readonly port?: string;
  /**
   * Serialized authority bytes that follow a bracketed host but do not form a
   * `:port`. A malformed or ambiguous authority keeps these bytes here instead
   * of discarding them, so decomposition is lossless and every serialized byte
   * still reaches bounded canonical inspection.
   */
  readonly suffix?: string;
}

interface RawRequestTarget {
  readonly authority?: RawAuthority;
  readonly pathname: string;
  readonly query?: string;
  /**
   * HTTP request targets do not carry fragments. This is populated only when
   * the captured browser observation itself serialized a literal `#` suffix.
   */
  readonly observedFragment?: string;
}

function decomposeRawAuthority(serialized: string): RawAuthority {
  const userinfoEnd = serialized.lastIndexOf("@");
  const userinfo = userinfoEnd < 0 ? undefined : serialized.slice(0, userinfoEnd);
  const hostAndPort = serialized.slice(userinfoEnd + 1);
  if (hostAndPort.startsWith("[")) {
    const bracketEnd = hostAndPort.indexOf("]");
    if (bracketEnd >= 0) {
      const remainder = hostAndPort.slice(bracketEnd + 1);
      const isPort = remainder.startsWith(":");
      return {
        ...(userinfo === undefined ? {} : { userinfo }),
        host: hostAndPort.slice(1, bracketEnd),
        ...(isPort ? { port: remainder.slice(1) } : {}),
        ...(isPort || remainder.length === 0 ? {} : { suffix: remainder }),
      };
    }
  }
  const firstColon = hostAndPort.indexOf(":");
  const lastColon = hostAndPort.lastIndexOf(":");
  const hasUnambiguousPort = firstColon >= 0 && firstColon === lastColon;
  return {
    ...(userinfo === undefined ? {} : { userinfo }),
    host: hasUnambiguousPort ? hostAndPort.slice(0, firstColon) : hostAndPort,
    ...(hasUnambiguousPort ? { port: hostAndPort.slice(firstColon + 1) } : {}),
  };
}

/**
 * Decomposes the captured request target before WHATWG parsing can normalize
 * dot segments, decode hostnames, or discard authority/userinfo. Each returned
 * component is independently bounded by canonicalPercentDecode when inspected.
 */
function decomposeRawRequestTarget(value: string, authorityForm: boolean): RawRequestTarget {
  const fragmentStart = value.indexOf("#");
  const beforeFragment = fragmentStart < 0 ? value : value.slice(0, fragmentStart);
  const observedFragment = fragmentStart < 0 ? undefined : value.slice(fragmentStart + 1);
  const queryStart = beforeFragment.indexOf("?");
  const beforeQuery = queryStart < 0 ? beforeFragment : beforeFragment.slice(0, queryStart);
  const query = queryStart < 0 ? undefined : beforeFragment.slice(queryStart + 1);

  if (authorityForm) {
    return {
      authority: decomposeRawAuthority(beforeQuery),
      pathname: "",
      ...(query === undefined ? {} : { query }),
      ...(observedFragment === undefined ? {} : { observedFragment }),
    };
  }

  const absolutePrefix = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(beforeQuery);
  const authorityStart =
    absolutePrefix !== null ? absolutePrefix[0].length : beforeQuery.startsWith("//") ? 2 : -1;
  if (authorityStart >= 0) {
    const slash = beforeQuery.indexOf("/", authorityStart);
    const authorityEnd = slash < 0 ? beforeQuery.length : slash;
    return {
      authority: decomposeRawAuthority(beforeQuery.slice(authorityStart, authorityEnd)),
      pathname: slash < 0 ? "" : beforeQuery.slice(slash),
      ...(query === undefined ? {} : { query }),
      ...(observedFragment === undefined ? {} : { observedFragment }),
    };
  }

  return {
    pathname: beforeQuery,
    ...(query === undefined ? {} : { query }),
    ...(observedFragment === undefined ? {} : { observedFragment }),
  };
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function parseCookieComponent(serialized: string): CookieComponent | undefined {
  const separator = serialized.indexOf("=");
  if (separator <= 0) return undefined;
  const name = serialized.slice(0, separator).trim();
  const value = serialized.slice(separator + 1).trim();
  if (
    !cookieToken.test(name) ||
    hasControlCharacter(value) ||
    value.includes(";") ||
    value.includes(",")
  ) {
    return undefined;
  }
  return { name, value };
}

function parseCookieHeader(value: string): readonly CookieComponent[] | undefined {
  const serialized = value.split(";");
  if (serialized.length === 0 || serialized.some((component) => component.trim() === "")) {
    return undefined;
  }
  const components = serialized.map((component) => parseCookieComponent(component.trim()));
  return components.every((component) => component !== undefined)
    ? (components as readonly CookieComponent[])
    : undefined;
}

function splitSetCookieRecords(value: string): readonly string[] | undefined {
  const records = value.split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/);
  if (records.length === 0 || records.some((record) => record.trim() === "")) return undefined;
  return records.map((record) => record.trim());
}

function parseSetCookieHeader(value: string): readonly SetCookieRecord[] | undefined {
  const serializedRecords = splitSetCookieRecords(value);
  if (serializedRecords === undefined) return undefined;
  const records: SetCookieRecord[] = [];
  for (const serialized of serializedRecords) {
    const components = serialized.split(";");
    if (components.length === 0 || components.some((component) => component.trim() === "")) {
      return undefined;
    }
    const cookie = parseCookieComponent(components[0]!.trim());
    if (cookie === undefined) return undefined;
    const attributes: { name: string; value?: string }[] = [];
    for (const component of components.slice(1)) {
      const trimmed = component.trim();
      const separator = trimmed.indexOf("=");
      const name = (separator < 0 ? trimmed : trimmed.slice(0, separator)).trim();
      const attributeValue = separator < 0 ? undefined : trimmed.slice(separator + 1).trim();
      if (
        !cookieToken.test(name) ||
        (attributeValue !== undefined &&
          (hasControlCharacter(attributeValue) || attributeValue.includes(";")))
      ) {
        return undefined;
      }
      attributes.push(attributeValue === undefined ? { name } : { name, value: attributeValue });
    }
    records.push({ cookie, attributes });
  }
  return records;
}

export function scanCredentialLeaks(
  observations: readonly WireObservation[],
  options: CredentialScanOptions,
): CredentialScanReceipt {
  const findings: string[] = [];
  let fields = 0;
  const inspectProtectedSecrets = (
    field: string,
    value: string,
    sessionException: boolean,
  ): void => {
    for (const secret of options.secretLiterals) {
      if (secret.length > 0 && value.includes(secret) && !sessionException) {
        findings.push(
          `${field}: secret literal sha256=${createHash("sha256").update(secret).digest("hex")}`,
        );
      }
    }
  };
  const inspect = (
    observation: WireObservation,
    field: string,
    value: string,
    sessionException = false,
  ): void => {
    fields += 1;
    if (/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(value)) {
      findings.push(`${field}: JWT`);
    }
    if (/code_verifier/i.test(value)) findings.push(`${field}: code_verifier`);
    if (/ef_session/i.test(value) && !sessionException) findings.push(`${field}: ef_session`);
    inspectProtectedSecrets(field, value, sessionException);
  };
  const inspectCanonical = (
    observation: WireObservation,
    field: string,
    value: string,
    plusAsSpace: boolean,
    sessionException = false,
  ): void => {
    const decoded = canonicalPercentDecode(value, plusAsSpace);
    if (decoded.error !== undefined) {
      findings.push(`${field}: ${decoded.error} percent encoding`);
    }
    for (const [decodeIndex, representation] of decoded.representations.entries()) {
      inspect(
        observation,
        `${field}.percent-decoded[${String(decodeIndex)}]`,
        representation,
        sessionException,
      );
    }
    for (const [decodeIndex, representation] of alternatePercentRepresentations(
      value,
      plusAsSpace,
    ).entries()) {
      fields += 1;
      inspectProtectedSecrets(
        `${field}.alternate-percent-decoded[${String(decodeIndex)}]`,
        representation,
        sessionException,
      );
    }
  };
  const inspectCookieHeader = (
    observation: WireObservation,
    field: string,
    headerName: string,
    value: string,
    aggregateSessionCount: number,
    aggregateIsComplete: boolean,
  ): boolean => {
    const lowerName = headerName.toLowerCase();
    if (observation.direction === "request" && lowerName === "cookie") {
      const cookies = parseCookieHeader(value);
      if (cookies === undefined) {
        findings.push(`${field}: malformed Cookie header`);
        inspect(observation, field, value);
        inspectCanonical(observation, field, value, false);
        return true;
      }
      const sessionCookies = cookies.filter((cookie) => cookie.name.toLowerCase() === "ef_session");
      for (const [cookieIndex, cookie] of cookies.entries()) {
        const allowedSession =
          cookie.name.toLowerCase() === "ef_session" &&
          sessionCookies.length === 1 &&
          aggregateSessionCount === 1 &&
          aggregateIsComplete &&
          sessionCookieValue.test(cookie.value);
        if (cookie.name.toLowerCase() === "ef_session" && !allowedSession) {
          findings.push(`${field}: ef_session cookie is not narrowly formed`);
        }
        inspect(
          observation,
          `${field}.cookie[${String(cookieIndex)}].name`,
          cookie.name,
          allowedSession,
        );
        inspectCanonical(
          observation,
          `${field}.cookie[${String(cookieIndex)}].name`,
          cookie.name,
          false,
          allowedSession,
        );
        inspect(
          observation,
          `${field}.cookie[${String(cookieIndex)}].value`,
          cookie.value,
          allowedSession,
        );
        inspectCanonical(
          observation,
          `${field}.cookie[${String(cookieIndex)}].value`,
          cookie.value,
          false,
          allowedSession,
        );
      }
      return true;
    }
    if (observation.direction === "response" && lowerName === "set-cookie") {
      const records = parseSetCookieHeader(value);
      if (records === undefined) {
        findings.push(`${field}: malformed Set-Cookie header`);
        inspect(observation, field, value);
        inspectCanonical(observation, field, value, false);
        return true;
      }
      const sessionRecords = records.filter(
        (record) => record.cookie.name.toLowerCase() === "ef_session",
      );
      for (const [recordIndex, record] of records.entries()) {
        const httpOnlyAttributes = record.attributes.filter(
          (attribute) => attribute.name.toLowerCase() === "httponly",
        );
        const allowedSession =
          record.cookie.name.toLowerCase() === "ef_session" &&
          sessionRecords.length === 1 &&
          aggregateSessionCount === 1 &&
          aggregateIsComplete &&
          sessionCookieValue.test(record.cookie.value) &&
          httpOnlyAttributes.length === 1 &&
          httpOnlyAttributes[0]!.value === undefined;
        if (record.cookie.name.toLowerCase() === "ef_session" && !allowedSession) {
          findings.push(`${field}: ef_session cookie is not narrowly HttpOnly`);
        }
        inspect(
          observation,
          `${field}.set-cookie[${String(recordIndex)}].name`,
          record.cookie.name,
          allowedSession,
        );
        inspectCanonical(
          observation,
          `${field}.set-cookie[${String(recordIndex)}].name`,
          record.cookie.name,
          false,
          allowedSession,
        );
        inspect(
          observation,
          `${field}.set-cookie[${String(recordIndex)}].value`,
          record.cookie.value,
          allowedSession,
        );
        inspectCanonical(
          observation,
          `${field}.set-cookie[${String(recordIndex)}].value`,
          record.cookie.value,
          false,
          allowedSession,
        );
        for (const [attributeIndex, attribute] of record.attributes.entries()) {
          const attributeField =
            `${field}.set-cookie[${String(recordIndex)}]` + `.attribute[${String(attributeIndex)}]`;
          inspect(observation, `${attributeField}.name`, attribute.name);
          inspectCanonical(observation, `${attributeField}.name`, attribute.name, false);
          if (attribute.value !== undefined) {
            inspect(observation, `${attributeField}.value`, attribute.value);
            inspectCanonical(observation, `${attributeField}.value`, attribute.value, false);
          }
        }
      }
      return true;
    }
    return false;
  };
  for (const [index, observation] of observations.entries()) {
    const prefix = `${observation.layer}.${observation.direction}[${String(index)}]`;
    const responseHasNoInspectableBody =
      observation.direction === "response" &&
      observation.status !== undefined &&
      ((observation.status >= 300 && observation.status < 400) ||
        observation.status === 204 ||
        observation.status === 205);
    if (observation.bodyError !== undefined && !responseHasNoInspectableBody) {
      findings.push(`${prefix}.body: missing or unreadable body provenance`);
    }
    let aggregateSessionCount = 0;
    let aggregateIsComplete = true;
    for (const [name, value] of observation.headers) {
      if (observation.direction === "request" && name.toLowerCase() === "cookie") {
        const cookies = parseCookieHeader(value);
        if (cookies === undefined) {
          aggregateIsComplete = false;
        } else {
          aggregateSessionCount += cookies.filter(
            (cookie) => cookie.name.toLowerCase() === "ef_session",
          ).length;
        }
      }
      if (observation.direction === "response" && name.toLowerCase() === "set-cookie") {
        const records = parseSetCookieHeader(value);
        if (records === undefined) {
          aggregateIsComplete = false;
        } else {
          aggregateSessionCount += records.filter(
            (record) => record.cookie.name.toLowerCase() === "ef_session",
          ).length;
        }
      }
    }
    inspect(observation, `${prefix}.url`, observation.url);
    const inspectPath = (field: string, pathname: string): void => {
      for (const [segmentIndex, segment] of pathname.split("/").entries()) {
        if (segment.length === 0) continue;
        inspectCanonical(
          observation,
          `${prefix}.url.${field}[${String(segmentIndex)}]`,
          segment,
          false,
        );
      }
    };
    const rawTarget = decomposeRawRequestTarget(
      observation.url,
      observation.direction === "request" && observation.method === "CONNECT",
    );
    if (rawTarget.authority !== undefined) {
      if (rawTarget.authority.userinfo !== undefined) {
        inspectCanonical(
          observation,
          `${prefix}.url.raw-authority.userinfo`,
          rawTarget.authority.userinfo,
          false,
        );
      }
      inspectCanonical(
        observation,
        `${prefix}.url.raw-authority.host`,
        rawTarget.authority.host,
        false,
      );
      if (rawTarget.authority.port !== undefined) {
        inspectCanonical(
          observation,
          `${prefix}.url.raw-authority.port`,
          rawTarget.authority.port,
          false,
        );
      }
      if (rawTarget.authority.suffix !== undefined) {
        inspectCanonical(
          observation,
          `${prefix}.url.raw-authority.suffix`,
          rawTarget.authority.suffix,
          false,
        );
      }
    }
    inspectPath("raw-path", rawTarget.pathname);
    try {
      const normalizedPathname = new URL(observation.url, "http://localhost").pathname;
      if (normalizedPathname !== rawTarget.pathname) {
        inspectPath("normalized-path", normalizedPathname);
      }
    } catch {
      // The raw request target was already inspected above. URL parser failure
      // is not a credential-encoding validity decision.
    }
    if (rawTarget.query !== undefined) {
      for (const [componentIndex, component] of rawTarget.query.split("&").entries()) {
        const separator = component.indexOf("=");
        const name = separator < 0 ? component : component.slice(0, separator);
        const value = separator < 0 ? "" : component.slice(separator + 1);
        const componentField = `${prefix}.url.query[${String(componentIndex)}]`;
        inspectCanonical(observation, `${componentField}.name`, name, true);
        inspectCanonical(observation, `${componentField}.value`, value, true);
      }
    }
    if (rawTarget.observedFragment !== undefined) {
      inspectCanonical(
        observation,
        `${prefix}.url.observed-fragment`,
        rawTarget.observedFragment,
        false,
      );
    }
    for (const [name, value] of observation.headers) {
      if (
        !inspectCookieHeader(
          observation,
          `${prefix}.headers.${name}`,
          name,
          value,
          aggregateSessionCount,
          aggregateIsComplete,
        )
      ) {
        inspect(observation, `${prefix}.headers.${name}.name`, name);
        inspectCanonical(observation, `${prefix}.headers.${name}.name`, name, false);
        inspect(observation, `${prefix}.headers.${name}`, value);
        inspectCanonical(observation, `${prefix}.headers.${name}`, value, false);
      }
    }
    const body = decodedBody(observation);
    inspect(observation, `${prefix}.body`, body);
    const isForm = observation.headers.some(
      ([name, value]) =>
        name.toLowerCase() === "content-type" &&
        value.split(";", 1)[0]!.trim().toLowerCase() === "application/x-www-form-urlencoded",
    );
    if (isForm) {
      for (const [componentIndex, component] of body.split("&").entries()) {
        const separator = component.indexOf("=");
        const name = separator < 0 ? component : component.slice(0, separator);
        const value = separator < 0 ? "" : component.slice(separator + 1);
        const componentField = `${prefix}.body.form[${String(componentIndex)}]`;
        inspectCanonical(observation, `${componentField}.name`, name, true);
        inspectCanonical(observation, `${componentField}.value`, value, true);
      }
    }
  }
  assert.deepEqual(findings, [], findings.join("\n"));
  return { observations: observations.length, fields };
}

export function identityViewAt(snapshot: IdentitySnapshot): AuthorizationView {
  return snapshot.view;
}

export function replayChromiumPath(): string {
  return (
    process.env.AGENT_BROWSER_EXECUTABLE_PATH ??
    resolve(homedir(), ".replay/runtimes/Replay-Chromium.app/Contents/MacOS/Chromium")
  );
}

export function browserSessionSecretForAttacks(): string {
  return sessionSecret();
}
