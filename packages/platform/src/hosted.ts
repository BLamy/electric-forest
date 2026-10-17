import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Server } from "node:http";
import { createDurableStreamTestServer } from "@eforest/server";
import { createPlatformProductionRuntime } from "./production.js";
import { OfficialStreamAdapter } from "./official.js";
import { createPlatformServer, listenPlatformServer, platformTimeouts } from "./server.js";
import { prepareHostedStorage } from "./hosted-storage.js";
import { verifyHostedArtifact } from "./hosted-artifact.js";

export const HOSTED_LIMITS = Object.freeze({
  maxBodyBytes: 8_388_608,
  requestDeadlineMs: 30_000,
  readinessMs: 60_000,
  drainMs: 15_000,
  transactionTtlMs: 600_000,
  sessionTtlSeconds: 86_400,
  maxLongPollMs: 10_000,
});

export interface HostedConfig {
  readonly origin: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly port: number;
  readonly dataDir: string;
  readonly webRoot: string;
  readonly revision: string;
  readonly sessionTtlSeconds: number;
}

/** This entrypoint has no provider/model/harness/email credentials or fixture mode. */
export function readHostedEnvironment(environment: NodeJS.ProcessEnv): HostedConfig {
  if (environment.EF_DEPLOYMENT_MODE !== "production")
    throw new Error("hosted runtime requires production mode");
  const allowed = new Set([
    "EF_DEPLOYMENT_MODE",
    "EF_PUBLIC_ORIGIN",
    "EF_OIDC_ISSUER",
    "EF_OIDC_CLIENT_ID",
    "EF_DATA_DIR",
    "EF_WEB_ROOT",
    "EF_BUILD_REVISION",
    "EF_SESSION_TTL",
    "EF_AGENT_RESPONDER",
  ]);
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (
      (name.startsWith("EF_") && !allowed.has(name)) ||
      name.startsWith("EFOREST_") ||
      /^(?:AUTH0_|OIDC_|RESEND_|OPENAI_|ANTHROPIC_|CLAUDE_|CODEX_|AWS_|GITHUB_TOKEN$|GH_TOKEN$|GOOGLE_APPLICATION_CREDENTIALS$|DURABLE_STREAM|ELECTRIC_|NODE_OPTIONS$|NODE_PATH$|SSH_AUTH_SOCK$|GIT_ASKPASS$)/.test(
        name,
      )
    ) {
      throw new Error(`hosted runtime forbids inherited credentials or integrations: ${name}`);
    }
  }
  if (environment.EF_AGENT_RESPONDER !== undefined && environment.EF_AGENT_RESPONDER !== "off")
    throw new Error("hosted agent execution must be off");
  const publicUrl = new URL(environment.EF_PUBLIC_ORIGIN ?? "");
  if (
    publicUrl.protocol !== "https:" ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.pathname !== "/" ||
    publicUrl.search ||
    publicUrl.hash
  )
    throw new Error("EF_PUBLIC_ORIGIN must be a canonical HTTPS origin");
  const issuer = new URL(environment.EF_OIDC_ISSUER ?? "");
  if (
    issuer.protocol !== "https:" ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    !issuer.pathname.endsWith("/")
  )
    throw new Error("EF_OIDC_ISSUER must be a canonical HTTPS issuer ending in slash");
  const clientId = environment.EF_OIDC_CLIENT_ID;
  if (clientId === undefined || !/^[A-Za-z0-9_-]{1,256}$/.test(clientId))
    throw new Error("EF_OIDC_CLIENT_ID is required");
  const revision = environment.EF_BUILD_REVISION;
  if (revision === undefined || !/^[a-f0-9]{40}$/.test(revision))
    throw new Error("EF_BUILD_REVISION must identify the full source commit");
  const port = environment.PORT ?? "8080";
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) throw new Error("PORT is invalid");
  const dataDir = environment.EF_DATA_DIR ?? "/data/forest-private";
  const webRoot =
    environment.EF_WEB_ROOT ?? resolve(import.meta.dirname, "../../../../apps/web/dist");
  if (!isAbsolute(dataDir) || !isAbsolute(webRoot))
    throw new Error("hosted paths must be absolute");
  const sessionTtl = environment.EF_SESSION_TTL ?? String(HOSTED_LIMITS.sessionTtlSeconds);
  if (
    !/^[1-9][0-9]*$/.test(sessionTtl) ||
    !Number.isSafeInteger(Number(sessionTtl) * 1_000) ||
    Number(sessionTtl) > HOSTED_LIMITS.sessionTtlSeconds
  )
    throw new Error("EF_SESSION_TTL must be positive seconds at most 86400");
  return {
    origin: publicUrl.origin,
    issuer: issuer.href,
    clientId,
    revision,
    port: Number(port),
    dataDir,
    webRoot,
    sessionTtlSeconds: Number(sessionTtl),
  };
}

export interface HostedRuntimeOptions {
  /** Isolated fixture seams are constructor-only; there is no public fixture endpoint or env switch. */
  readonly artifactPath?: string;
  readonly oidcFetch?: typeof fetch;
  readonly now?: () => number;
  readonly requestDeadlineMs?: number;
  readonly transactionTtlMs?: number;
}
export interface HostedRuntime {
  readonly config: HostedConfig;
  readonly server: Server;
  /** Private loopback is available only to the in-process fixture proof owner. */
  readonly streamUrl: string;
  readonly identity: Awaited<ReturnType<typeof createPlatformProductionRuntime>>["identity"];
  start(): Promise<string>;
  close(): Promise<void>;
}

function json(status: number, value: unknown): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function privateRoute(pathname: string): boolean {
  let decoded = pathname;
  for (let count = 0; count < 4; count += 1) {
    if (
      /^\/(?:streams|admin|__admin|__proof|\.env|\.git)(?:\/|$)/.test(decoded) ||
      decoded === "/auth/preview"
    )
      return true;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return true;
    }
  }
  return false;
}

export async function createHostedRuntime(
  environment: NodeJS.ProcessEnv,
  options: HostedRuntimeOptions = {},
): Promise<HostedRuntime> {
  for (const [value, maximum] of [
    [options.requestDeadlineMs, HOSTED_LIMITS.requestDeadlineMs],
    [options.transactionTtlMs, HOSTED_LIMITS.transactionTtlMs],
  ]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > maximum!))
      throw new TypeError(
        "hosted fixture bounds must be positive and no looser than the production profile",
      );
  }
  const root = resolve(import.meta.dirname, "../../../..");
  const artifactPath = options.artifactPath ?? resolve(root, "production-artifact.json");
  const baked = JSON.parse(await readFile(artifactPath, "utf8")) as { revision?: string };
  if (
    environment.EF_BUILD_REVISION !== undefined &&
    baked.revision !== environment.EF_BUILD_REVISION
  )
    throw new Error("configured revision does not match the built artifact");
  const config = readHostedEnvironment({
    ...environment,
    ...(baked.revision === undefined ? {} : { EF_BUILD_REVISION: baked.revision }),
  });
  const artifact = await verifyHostedArtifact(root, config.webRoot, config.revision, artifactPath);
  const state = await prepareHostedStorage(config.dataDir, config.issuer, config.clientId);
  const provider = createDurableStreamTestServer({
    host: "127.0.0.1",
    port: 0,
    longPollTimeout: 250,
    dataDir: resolve(config.dataDir, "streams"),
  });
  const streamUrl = await provider.start();
  const streams = new OfficialStreamAdapter({ baseUrl: streamUrl });
  let platform: Awaited<ReturnType<typeof createPlatformProductionRuntime>> | undefined;
  try {
    if (!state.initializing) {
      for (const stream of ["__identity__", "ns:root", "__registry__"]) {
        if (!(await streams.exists(stream)))
          throw new Error("hosted ready volume is incomplete; refusing to recreate authority");
      }
    }
    platform = await createPlatformProductionRuntime(
      {
        EF_OIDC_ISSUER: config.issuer,
        EF_OIDC_CLIENT_ID: config.clientId,
        EF_SESSION_SECRET: state.secret,
        EF_SESSION_TTL: String(config.sessionTtlSeconds),
        EFOREST_SERVER_URL: streamUrl,
        EF_WEB_ROOT: config.webRoot,
        EF_AGENT_RESPONDER: "off",
      },
      {
        hosted: {
          origin: config.origin,
          transactionTtlMs: options.transactionTtlMs ?? HOSTED_LIMITS.transactionTtlMs,
        },
        ...(options.oidcFetch === undefined ? {} : { oidcFetch: options.oidcFetch }),
        ...(options.now === undefined ? {} : { now: options.now }),
      },
    );
    if (state.initializing) {
      const identity = await platform.identity.snapshot();
      if (identity.events.length !== 0 || (await streams.read("ns:root")).length !== 0)
        throw new Error("hosted initialization cannot adopt pre-existing users or projects");
    }
    await platform.registry.syncOnce();
    await state.ready();
  } catch (error) {
    if (platform !== undefined) {
      await platform.registry.stop();
      platform.gateway.terminate();
      platform.namespaces.terminate();
      await new Promise((done) => setTimeout(done, 500));
    }
    await provider.stop();
    throw error;
  }
  const app = platform;
  let closing = false;
  let active = 0;
  const limits = {
    ...HOSTED_LIMITS,
    requestDeadlineMs: options.requestDeadlineMs ?? HOSTED_LIMITS.requestDeadlineMs,
    transactionTtlMs: options.transactionTtlMs ?? HOSTED_LIMITS.transactionTtlMs,
    sessionTtlSeconds: config.sessionTtlSeconds,
    http: platformTimeouts(options.requestDeadlineMs ?? HOSTED_LIMITS.requestDeadlineMs),
  };
  const build = {
    mode: "production",
    auth: "auth0",
    revision: config.revision,
    agents: "off",
    integrations: "off",
    data: "private",
    artifactDigest: artifact.digest,
    limits,
  };
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    let response: Response;
    if (closing) return json(503, { error: "draining" });
    if (
      url.searchParams.has("waitMs") &&
      Number(url.searchParams.get("waitMs")) > HOSTED_LIMITS.maxLongPollMs
    ) {
      return json(400, { error: "hosted-follow-hold-exceeds-profile" });
    }
    if (url.pathname === "/healthz" || url.pathname === "/readyz")
      response = json(200, { ...build, ready: true });
    else if (url.pathname === "/api/build") response = json(200, build);
    else if (url.pathname === "/api/deployment") response = json(200, { ...build, artifact });
    else if (privateRoute(url.pathname)) response = json(404, { error: "not-found" });
    else if (url.pathname === "/api/device-grants")
      response = json(403, { error: "hosted-device-flow-disabled" });
    else {
      if (url.pathname === "/api/dispatch") {
        const value: unknown = await request
          .clone()
          .json()
          .catch(() => undefined);
        const type = (value as { event?: { type?: unknown } } | undefined)?.event?.type;
        if (
          typeof type === "string" &&
          /^(?:agent\.|integration\.|webhook\.|email\.|harness\.|mcp\.)/.test(type)
        )
          return json(403, { error: "hosted-integrations-disabled" });
      }
      if (
        !["GET", "HEAD"].includes(request.method) &&
        /^\/api\/(?:agents|agent-runs|integrations|webhooks)(?:\/|$)/.test(url.pathname)
      )
        return json(403, { error: "hosted-integrations-disabled" });
      response = await app.app.handle(request);
    }
    // Suppress callback credentials across the redirect. Ordinary documents retain
    // same-origin referrers so browser form POSTs send the required Origin (a
    // no-referrer document causes navigation POSTs to serialize Origin as null).
    response.headers.set(
      "referrer-policy",
      url.pathname.startsWith("/auth/") ? "no-referrer" : "same-origin",
    );
    response.headers.set("x-content-type-options", "nosniff");
    if (response.headers.get("content-type")?.startsWith("text/html") === true) {
      const html = await response.text();
      return new Response(
        html.replace(
          /<head>/i,
          `<head><meta name="ef-mode" content="production"><meta name="ef-auth" content="auth0"><meta name="ef-agents" content="off"><meta name="ef-integrations" content="off"><meta name="ef-build" content="${config.revision}">`,
        ),
        { status: response.status, headers: response.headers },
      );
    }
    return response;
  };
  const server = createPlatformServer(
    async (request) => {
      active += 1;
      try {
        return await handle(request);
      } finally {
        active -= 1;
      }
    },
    {
      origin: config.origin,
      maxBodyBytes: HOSTED_LIMITS.maxBodyBytes,
      requestDeadlineMs: limits.requestDeadlineMs,
      redactErrors: true,
    },
  );
  let closePromise: Promise<void> | undefined;
  return {
    config,
    server,
    streamUrl,
    identity: app.identity,
    start: () => listenPlatformServer(server, config.port, "0.0.0.0"),
    close: () =>
      (closePromise ??= (async () => {
        closing = true;
        const deadline = Date.now() + HOSTED_LIMITS.drainMs;
        if (server.listening)
          await new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          });
        while (active > 0 && Date.now() < deadline)
          await new Promise((done) => setTimeout(done, 10));
        if (active !== 0) throw new Error("hosted handlers exceeded the drain deadline");
        await app.registry.stop();
        app.gateway.terminate();
        app.namespaces.terminate();
        // The pinned provider's bounded in-flight reads settle before LMDB closes.
        await new Promise((done) => setTimeout(done, 500));
        await provider.stop();
      })()),
  };
}
