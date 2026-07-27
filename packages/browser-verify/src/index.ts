import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { headDurableJsonStream, readDurableJson, type StreamRecord } from "@eforest/client";
import type { AuthorizationView } from "@eforest/identity";
import {
  IdentityStore,
  createPlatformProductionRuntime,
  listenPlatformServer,
  type IdentitySnapshot,
} from "@eforest/platform";
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
  readonly layer: "browser" | "server-oidc";
  readonly direction: "request" | "response";
  readonly url: string;
  readonly method?: string;
  readonly status?: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly bodyBase64: string | null;
  readonly bodyError?: string;
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
  openPage(browser: Browser): Promise<GuardedPage>;
  close(): Promise<void>;
}

interface Emulator {
  readonly url: string;
  close(): Promise<void>;
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

async function emulatorFactory(
  root: string,
): Promise<(options: Record<string, unknown>) => Promise<Emulator>> {
  const modulePath = resolve(root, ["vendor", "emulate"].join("/"), "packages/emulate/dist/api.js");
  const module = (await import(pathToFileURL(modulePath).href)) as {
    createEmulator(options: Record<string, unknown>): Promise<Emulator>;
  };
  return module.createEmulator;
}

async function auth0Seed(
  root: string,
  options: {
    readonly port: number;
    readonly platformUrl: string;
    readonly subject: BrowserSubject;
    readonly clientId: string;
    readonly nowSeconds: number;
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
  const baseUrl = `http://127.0.0.1:${String(options.port)}`;
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

function sessionSecret(): string {
  return "e3-t02-browser-session-secret-is-at-least-32-bytes";
}

export async function bootWorld(
  options: { readonly subject?: BrowserSubject; readonly root?: string } = {},
): Promise<BrowserWorld> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("browser-verify emulator fixtures are forbidden in production");
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
  const platformPort = await freePort();
  const emulatorPort = await freePort();
  const platformUrl = `http://127.0.0.1:${String(platformPort)}`;
  const clientId = "eforest-e3-t02-browser";
  const nowSeconds = 1_700_000_000;
  const createEmulator = await emulatorFactory(root);
  const emulator = await createEmulator(
    await auth0Seed(root, {
      port: emulatorPort,
      platformUrl,
      subject,
      clientId,
      nowSeconds,
    }),
  );
  // Ports prove isolation, but must not leak nondeterminism into the durable identity log.
  const random = deterministicRandom(3_002);
  const serverNetwork: WireObservation[] = [];
  let operation = 0;
  const runtime = await createPlatformProductionRuntime(
    {
      EF_OIDC_ISSUER: emulator.url,
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
    },
  );
  const identity = runtime.identity;
  const platformServer = runtime.server;
  await listenPlatformServer(platformServer, platformPort);
  let closed = false;

  return {
    platformUrl,
    streamUrl,
    emulatorUrl: emulator.url,
    identityStreamUrl: `${streamUrl}/streams/${encodeURIComponent(identity.streamId)}`,
    dataDir,
    subject,
    identity,
    serverNetwork,
    snapshotIdentity: () => identity.snapshot(),
    dumpIdentity: () => readDurableJson<StreamRecord>({ url: `${streamUrl}/streams/__identity__` }),
    headIdentity: async () =>
      (await headDurableJsonStream({ url: `${streamUrl}/streams/__identity__` })).offset ?? "-1",
    openPage: async (browser) => openGuardedPage(browser, platformUrl),
    close: async () => {
      if (closed) return;
      closed = true;
      await closeServer(platformServer);
      await runtime.registry.stop();
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
      headers: Object.entries(await request.allHeaders()).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
      bodyBase64: bodyBase64(request.postDataBuffer()),
    });
    await route.continue();
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
        failures.push(`requestfailed: ${request.method()} ${url.href}`);
      }
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      const capture = (async (): Promise<void> => {
        const headers = Object.entries(await response.allHeaders()).sort(([left], [right]) =>
          left.localeCompare(right),
        );
        try {
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

function isSessionCookieException(
  observation: WireObservation,
  headerName: string,
  value: string,
): boolean {
  const name = headerName.toLowerCase();
  if (observation.direction === "request" && name === "cookie") {
    return /(?:^|;\s*)ef_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:;|$)/.test(value);
  }
  if (observation.direction === "response" && name === "set-cookie") {
    return (
      /^ef_session=(?:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)?;/i.test(value) &&
      /(?:^|;)\s*httponly(?:;|$)/i.test(value)
    );
  }
  return false;
}

export function scanCredentialLeaks(
  observations: readonly WireObservation[],
  options: CredentialScanOptions,
): CredentialScanReceipt {
  const findings: string[] = [];
  let fields = 0;
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
    for (const secret of options.secretLiterals) {
      if (secret.length > 0 && value.includes(secret) && !sessionException) {
        findings.push(
          `${field}: secret literal sha256=${createHash("sha256").update(secret).digest("hex")}`,
        );
      }
    }
  };
  for (const [index, observation] of observations.entries()) {
    const prefix = `${observation.layer}.${observation.direction}[${String(index)}]`;
    inspect(observation, `${prefix}.url`, observation.url);
    for (const [name, value] of observation.headers) {
      const exception = isSessionCookieException(observation, name, value);
      if (
        observation.direction === "response" &&
        name.toLowerCase() === "set-cookie" &&
        /(?:^|,\s*)ef_session=/i.test(value) &&
        !exception
      ) {
        findings.push(`${prefix}.headers.${name}: ef_session cookie is not narrowly HttpOnly`);
      }
      inspect(observation, `${prefix}.headers.${name}`, value, exception);
      if (exception) {
        const withoutAllowedSession =
          observation.direction === "request"
            ? value
                .replace(/(?:^|;\s*)ef_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?=;|$)/, "")
                .replace(/^;\s*|;\s*$/g, "")
            : value.replace(/^ef_session=(?:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)?;[^,]*/i, "");
        inspect(
          observation,
          `${prefix}.headers.${name}.outside-http-only-session`,
          withoutAllowedSession,
        );
      }
    }
    inspect(observation, `${prefix}.body`, decodedBody(observation));
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
