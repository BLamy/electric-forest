import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Server } from "node:http";
import { createDurableStreamTestServer } from "@eforest/server";
import { StreamFsRepo } from "@eforest/streamfs";
import { OfficialStreamAdapter } from "./official.js";
import { createPlatformProductionRuntime } from "./production.js";
import { createPlatformServer, listenPlatformServer } from "./server.js";
import { signedSessionCookie } from "./auth/session.js";
import { previewArtifact } from "./preview-artifact.js";

/** Deliberately public shared identities. These are never an OIDC provider or a real login. */
export const PREVIEW_SUBJECTS = {
  ada: { sub: "preview|ada", email: "ada@preview.invalid" },
  grace: { sub: "preview|grace", email: "grace@preview.invalid" },
} as const;
export const PREVIEW_README =
  "# Electric Forest preview\n\nThis is a public, disposable fixture repository.\n\nTry the #welcome channel in two browsers. Agent execution and external integrations are disabled.\n";

export interface PreviewConfig {
  readonly origin: string;
  readonly port: number;
  readonly dataDir: string;
  readonly webRoot: string;
  readonly revision: string;
}

/** Refuse inputs before opening a store or socket; do not print their values. */
export function readPreviewEnvironment(environment: NodeJS.ProcessEnv): PreviewConfig {
  if (environment.EF_DEPLOYMENT_MODE !== "preview" || environment.EF_PREVIEW_AUTH !== "fixture") {
    throw new Error("preview requires EF_DEPLOYMENT_MODE=preview and EF_PREVIEW_AUTH=fixture");
  }
  const allowed = new Set([
    "EF_DEPLOYMENT_MODE",
    "EF_PREVIEW_AUTH",
    "EF_PREVIEW_DATA_DIR",
    "EF_PUBLIC_ORIGIN",
    "EF_WEB_ROOT",
    "EF_BUILD_REVISION",
    "EF_AGENT_RESPONDER",
  ]);
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || value === "") continue;
    if ((name.startsWith("EF_") && !allowed.has(name)) || name.startsWith("EFOREST_")) {
      throw new Error(`preview forbids integration configuration: ${name}`);
    }
    if (
      /^(?:AUTH0_|OIDC_|RESEND_|OPENAI_|ANTHROPIC_|CLAUDE_|CODEX_|AWS_|GITHUB_TOKEN$|GH_TOKEN$|GOOGLE_APPLICATION_CREDENTIALS$|DURABLE_STREAM|ELECTRIC_|NODE_OPTIONS$|NODE_PATH$|SSH_AUTH_SOCK$|GIT_ASKPASS$)/.test(
        name,
      )
    ) {
      throw new Error(`preview forbids inherited credentials or integrations: ${name}`);
    }
  }
  if (environment.EF_AGENT_RESPONDER !== undefined && environment.EF_AGENT_RESPONDER !== "off") {
    throw new Error("preview requires agent execution off");
  }
  const origin = new URL(
    environment.EF_PUBLIC_ORIGIN ?? `https://${environment.RAILWAY_PUBLIC_DOMAIN ?? ""}`,
  );
  const loopback =
    origin.protocol === "http:" &&
    (origin.hostname === "127.0.0.1" || origin.hostname === "localhost");
  if (
    (!loopback && origin.protocol !== "https:") ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("EF_PUBLIC_ORIGIN must be an HTTPS origin (HTTP loopback is allowed locally)");
  }
  const revision = environment.EF_BUILD_REVISION;
  if (revision === undefined || !/^[0-9a-f]{40}$/.test(revision))
    throw new Error("EF_BUILD_REVISION must identify the full source commit");
  const rawPort = environment.PORT ?? "4322";
  if (!/^\d+$/.test(rawPort) || Number(rawPort) > 65535) throw new Error("PORT is invalid");
  const dataDir = environment.EF_PREVIEW_DATA_DIR ?? "/data/forest-preview";
  const webRoot =
    environment.EF_WEB_ROOT ?? resolve(import.meta.dirname, "../../../../apps/web/dist");
  if (!isAbsolute(dataDir) || !isAbsolute(webRoot))
    throw new Error("preview paths must be absolute");
  return { origin: origin.origin, port: Number(rawPort), dataDir, webRoot, revision };
}

interface PreviewState {
  readonly version: 1;
  readonly fixture: "railway-first-light-v1";
  readonly bootstrap: "initializing" | "ready";
  readonly sessionSecret: string;
}

async function saveState(path: string, state: PreviewState): Promise<void> {
  await writeFile(`${path}.tmp`, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

async function prepareState(dataDir: string): Promise<PreviewState> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = resolve(dataDir, "preview-state.json");
  const entries = await readdir(dataDir);
  if (entries.length === 0) {
    const state: PreviewState = {
      version: 1,
      fixture: "railway-first-light-v1",
      bootstrap: "initializing",
      sessionSecret: randomBytes(48).toString("base64url"),
    };
    await saveState(path, state);
    return state;
  }
  let state: PreviewState;
  try {
    state = JSON.parse(await readFile(path, "utf8")) as PreviewState;
  } catch {
    throw new Error(
      "preview volume has no valid bootstrap marker; stop and explicitly reset its disposable directory",
    );
  }
  if (
    state.version !== 1 ||
    state.fixture !== "railway-first-light-v1" ||
    state.bootstrap !== "ready" ||
    !/^[A-Za-z0-9_-]{64}$/.test(state.sessionSecret)
  ) {
    throw new Error(
      "preview bootstrap is incomplete or incompatible; stop and explicitly reset its disposable directory",
    );
  }
  return state;
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function safeNext(value: string | null): string {
  return value !== null && /^\/(?!\/)[A-Za-z0-9/_\-.~%]*$/.test(value) ? value : "/preview/forest";
}

function fixtureLogin(next: string, revision: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Electric Forest preview</title><style>body{font:17px system-ui;background:#101713;color:#e4f3e8;max-width:42rem;margin:8vh auto;padding:2rem}button{font:inherit;margin:1rem 1rem 0 0;padding:.8rem;border-radius:.5rem;background:#a8e8b5;border:0}code{overflow-wrap:anywhere}</style></head><body><main><p data-testid="preview-notice">PUBLIC PREVIEW · DISPOSABLE DATA · SHARED FIXTURE ACCOUNTS</p><h1>Explore Electric Forest</h1><p>Anyone can sign in as either fixture account and read or change the shared data. Do not enter private information. This deployment is a preview; production authentication is not configured.</p><p>Agent execution, email delivery and external integrations are off.</p><p>Build <code data-testid="preview-revision">${escape(revision)}</code></p><form method="post" action="/auth/preview"><input type="hidden" name="next" value="${escape(next)}"><button name="subject" value="ada" data-testid="preview-login-ada">Enter as Ada (fixture)</button><button name="subject" value="grace" data-testid="preview-login-grace">Enter as Grace (fixture)</button></form></main></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

async function checkAssets(webRoot: string): Promise<void> {
  const html = await readFile(resolve(webRoot, "index.html"), "utf8");
  const paths = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map((match) => match[1]!);
  if (!paths.some((path) => path.endsWith(".js")))
    throw new Error("preview requires built web assets");
  for (const path of paths) await readFile(resolve(webRoot, `.${path}`));
}

export interface PreviewRuntime {
  readonly config: PreviewConfig;
  readonly server: Server;
  /** Loopback only; deliberately absent from every public response. */
  readonly streamUrl: string;
  readonly identity: Awaited<ReturnType<typeof createPlatformProductionRuntime>>["identity"];
  start(): Promise<string>;
  close(): Promise<void>;
}

export async function createPreviewRuntime(
  environment: NodeJS.ProcessEnv,
): Promise<PreviewRuntime> {
  let bakedRevision: string | undefined;
  try {
    bakedRevision = (
      await readFile(resolve(import.meta.dirname, "../../../../build-revision"), "utf8")
    ).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (
    bakedRevision !== undefined &&
    environment.EF_BUILD_REVISION !== undefined &&
    environment.EF_BUILD_REVISION !== bakedRevision
  )
    throw new Error("configured revision does not match the built artifact");
  const config = readPreviewEnvironment({
    ...environment,
    ...(bakedRevision === undefined ? {} : { EF_BUILD_REVISION: bakedRevision }),
  });
  await checkAssets(config.webRoot);
  const artifact = await previewArtifact(
    resolve(import.meta.dirname, "../../../.."),
    config.webRoot,
  );
  const state = await prepareState(config.dataDir);
  const streams = createDurableStreamTestServer({
    host: "127.0.0.1",
    port: 0,
    longPollTimeout: 250,
    dataDir: resolve(config.dataDir, "streams"),
  });
  const streamUrl = await streams.start();
  const adapter = new OfficialStreamAdapter({ baseUrl: streamUrl });
  let platform: Awaited<ReturnType<typeof createPlatformProductionRuntime>> | undefined;
  try {
    if (state.bootstrap === "ready") {
      for (const stream of [
        "__identity__",
        "ns:root",
        "ns:org:preview",
        "fs:preview/forest:main:meta",
        "chat:preview/welcome",
      ]) {
        if (!(await adapter.exists(stream)))
          throw new Error("preview volume is incomplete; refusing to reseed accepted data");
      }
    }
    // This composition uses the normal stores, dispatch gateway and reducers. There is
    // no OIDC listener: the wrapper alone starts explicit fixture-backed web sessions.
    platform = await createPlatformProductionRuntime({
      EF_OIDC_ISSUER: `${streamUrl}/__fixture_identity_disabled`,
      EF_OIDC_CLIENT_ID: "preview-fixture-no-oidc",
      EF_SESSION_SECRET: state.sessionSecret,
      EF_SESSION_TTL: "86400",
      EFOREST_SERVER_URL: streamUrl,
      EF_WEB_ROOT: config.webRoot,
      EF_AGENT_RESPONDER: "off",
    });
    if (state.bootstrap === "initializing") {
      for (const subject of Object.values(PREVIEW_SUBJECTS))
        await platform.identity.ensureUser(subject.sub, subject.email);
      await platform.identity.createOrg(
        "preview",
        "Public disposable preview",
        PREVIEW_SUBJECTS.ada.sub,
      );
      await platform.identity.grantMembership("preview", PREVIEW_SUBJECTS.grace.sub, "member");
      await platform.namespaces.dispatch(
        "ns:root",
        { type: "ns.org.create", payload: { v: 1, name: "preview" }, ts: 1 },
        PREVIEW_SUBJECTS.ada.sub,
      );
      await platform.namespaces.dispatch(
        "ns:org:preview",
        { type: "ns.project.create", payload: { v: 1, name: "first-light" }, ts: 2 },
        PREVIEW_SUBJECTS.ada.sub,
      );
      await platform.namespaces.dispatch(
        "ns:org:preview",
        {
          type: "ns.repo.create",
          payload: { v: 1, name: "forest", project: "first-light", visibility: "public" },
          ts: 3,
        },
        PREVIEW_SUBJECTS.ada.sub,
      );
      await adapter.create("fs:preview/forest:main:meta");
      const repo = new StreamFsRepo(streamUrl, fetch, "preview/forest", "main", () => 3);
      await repo.createFile("README.md", new TextEncoder().encode(PREVIEW_README));
      const dispatch = async (streamId: string, type: string, payload: unknown): Promise<void> => {
        const view = await platform!.identity.snapshot();
        const response = await platform!.gateway.handleSessionDispatch(
          new Request(`${config.origin}/api/dispatch`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ streamId, event: { type, payload, ts: 4 } }),
          }),
          PREVIEW_SUBJECTS.ada.sub,
          view.view,
          view.offset,
        );
        if (!response.ok)
          throw new Error(
            `preview fixture dispatch refused (${String(response.status)}): ${await response.text()}`,
          );
      };
      await dispatch("chat:preview", "chat.channel.create", {
        v: 1,
        name: "welcome",
        topic: "Public disposable preview. Agent execution and integrations are off.",
      });
      await dispatch("chat:preview/welcome", "chat.message.post", {
        v: 1,
        id: "preview-welcome",
        body: "Welcome! Try posting here from two browsers. Everything in this fixture is public and disposable.",
      });
      await saveState(resolve(config.dataDir, "preview-state.json"), {
        ...state,
        bootstrap: "ready",
      });
    }
    await platform.registry.syncOnce();
  } catch (error) {
    if (platform !== undefined) {
      await platform.registry.stop();
      platform.gateway.terminate();
      platform.namespaces.terminate();
    }
    await streams.stop();
    throw error;
  }
  const app = platform;
  let closing = false;
  let active = 0;
  const build = {
    mode: "preview",
    auth: "fixture",
    revision: config.revision,
    agents: "off",
    integrations: "off",
    data: "public-disposable",
    artifactDigest: artifact.digest,
  };
  const handle = async (incoming: Request): Promise<Response> => {
    const incomingUrl = new URL(incoming.url);
    const url = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, config.origin);
    const request = new Request(url, incoming);
    if (url.pathname === "/healthz" || url.pathname === "/readyz")
      return json(closing ? 503 : 200, { ...build, ready: !closing });
    if (url.pathname === "/api/build") return json(200, build);
    if (url.pathname === "/api/deployment") return json(200, { ...build, artifact });
    if (/^\/(?:streams|admin|__admin|\.env|\.git)(?:\/|$)/.test(url.pathname))
      return json(404, { error: "not-found" });
    if (url.pathname === "/auth/login")
      return request.method === "GET"
        ? fixtureLogin(safeNext(url.searchParams.get("next")), config.revision)
        : json(405, { error: "method-not-allowed" });
    if (
      !["GET", "HEAD"].includes(request.method) &&
      request.headers.get("origin") !== config.origin
    )
      return json(403, { error: "preview-origin-refused" });
    if (url.pathname === "/auth/preview" && request.method === "POST") {
      const form = await request.formData();
      const selected = form.get("subject");
      if (selected !== "ada" && selected !== "grace")
        return json(400, { error: "fixture-subject-refused" });
      const sessionId = randomUUID().replaceAll("-", "");
      const subject = PREVIEW_SUBJECTS[selected];
      await app.identity.login(subject.sub, subject.email, sessionId);
      return new Response(null, {
        status: 303,
        headers: {
          location: safeNext(String(form.get("next"))),
          "set-cookie": `${signedSessionCookie(state.sessionSecret, sessionId, 86400)}${config.origin.startsWith("https:") ? "; Secure" : ""}`,
        },
      });
    }
    if (url.pathname.startsWith("/auth/") && url.pathname !== "/auth/logout")
      return json(404, { error: "preview-oidc-disabled" });
    if (
      url.pathname.startsWith("/api/cli-tokens") ||
      url.pathname === "/api/device-grants" ||
      url.pathname === "/settings/cli-tokens"
    )
      return json(403, { error: "preview-external-integrations-disabled" });
    if (url.pathname === "/api/dispatch") {
      const value: unknown = await request
        .clone()
        .json()
        .catch(() => undefined);
      const type = (value as { event?: { type?: unknown } } | undefined)?.event?.type;
      if (typeof type === "string" && type.startsWith("agent."))
        return json(403, { error: "preview-agent-execution-disabled" });
    }
    const response = await app.app.handle(request);
    if (response.status === 302 && response.headers.get("location") === "/auth/login")
      response.headers.set("location", `/auth/login?next=${encodeURIComponent(url.pathname)}`);
    if (config.origin.startsWith("https:") && response.headers.has("set-cookie"))
      response.headers.set("set-cookie", `${response.headers.get("set-cookie")!}; Secure`);
    if (response.headers.get("content-type")?.startsWith("text/html") === true) {
      const html = await response.text();
      return new Response(
        html.replace(
          /<head>/i,
          `<head><meta name="ef-mode" content="preview"><meta name="ef-build" content="${config.revision}">`,
        ),
        { status: response.status, headers: response.headers },
      );
    }
    return response;
  };
  const server = createPlatformServer(async (request) => {
    active += 1;
    try {
      return await handle(request);
    } finally {
      active -= 1;
    }
  });
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
        if (server.listening)
          await new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          });
        const deadline = Date.now() + 15_000;
        while (active > 0 && Date.now() < deadline)
          await new Promise((done) => setTimeout(done, 25));
        if (active !== 0) throw new Error("preview handlers did not drain before shutdown");
        await app.registry.stop();
        app.gateway.terminate();
        app.namespaces.terminate();
        // Aborted clients can leave reference-server reads waiting after their HTTP
        // socket closes. Its bounded 250 ms transport waits must expire while LMDB
        // is still open; no platform/projector work can start another read now.
        await new Promise<void>((done) => setTimeout(done, 500));
        await streams.stop();
      })()),
  };
}
