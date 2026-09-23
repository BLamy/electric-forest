import { randomBytes } from "node:crypto";
import { grantsForSub, roleOf, userForSub } from "@eforest/identity";
import { membersStreamId, normalizeEmail, type MemberRole } from "@eforest/reducers";
import { inviteEmail, ResendMailer, type ResendConfig } from "../email/resend.js";
import { reduceMembers } from "../org/validators.js";
import { UnauthorizedError, type BearerVerifier } from "../auth.js";
import { bearerToken, tokenHash } from "./grants.js";
import type { PlatformGateway } from "../gateway.js";
import { AuthRefusedError, OidcClient, OidcTransactions, type AuthRefusalReason } from "./oidc.js";
import { IdentityDispatchRefusedError, IdentityStore, type IdentitySnapshot } from "./provision.js";
import {
  clearedSessionCookie,
  parseSessionCookie,
  sessionIsValid,
  signedSessionCookie,
} from "./session.js";
import { classifyPlatformRoute } from "../route-topology.js";
import {
  DEFAULT_PLATFORM_RATE_LIMIT,
  FixedWindowRateLimiter,
  RateLimitExceededError,
  rateLimitResponse,
} from "../rate-limit.js";
import { resolveSessionBackedIdentity, whoamiResponse } from "../api/whoami.js";
import { spaResponse } from "../web/spa.js";

export interface PlatformWebAppOptions {
  readonly oidc: OidcClient;
  readonly transactions: OidcTransactions;
  readonly identity: IdentityStore;
  readonly sessionSecret: string;
  readonly sessionTtlMs: number;
  readonly gateway?: PlatformGateway;
  readonly deviceVerifier?: BearerVerifier;
  readonly now?: () => number;
  readonly random?: (size: number) => Uint8Array;
  /** Shared with PlatformGateway so one platform process owns one counter ledger. */
  readonly rateLimiter?: FixedWindowRateLimiter;
  /** Enables the authenticated E3 SPA while omitted callers retain E2's legacy home page. */
  readonly webRoot?: string;
  /** Test-only, authenticated proof receipt. Production composition never supplies this. */
  readonly testProofReceipt?: () => Promise<unknown | undefined>;
  /** Outbound email (invites). Omitted → invites are recorded but never emailed. */
  readonly resend?: ResendConfig;
  /** Optional same-origin bridge for a local OIDC emulator behind a managed tunnel. */
  readonly oidcProxyTarget?: string;
  /** Public origin to use when an upstream wrapper terminates or rewrites Host. */
  readonly publicOrigin?: string;
}

function json(status: number, body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}

const AUTH_REFUSAL_COPY: Readonly<
  Record<AuthRefusalReason, { readonly title: string; readonly message: string }>
> = {
  "bad-state": {
    title: "That sign-in session is no longer available",
    message: "Start a new sign-in to continue to Electric Forest.",
  },
  "bad-verifier": {
    title: "We could not verify that sign-in",
    message: "The sign-in link did not match this browser. Start again to continue.",
  },
  "reused-code": {
    title: "That sign-in link was already used",
    message: "Start a new sign-in to continue to Electric Forest.",
  },
  "bad-token": {
    title: "We could not complete sign-in",
    message: "The sign-in link is invalid or expired. Start a new sign-in to continue.",
  },
  "expired-token": {
    title: "Your sign-in expired",
    message: "Please sign in again to continue to Electric Forest.",
  },
  "bad-nonce": {
    title: "We could not verify that sign-in",
    message: "The sign-in response was not valid for this browser. Start again to continue.",
  },
};

function refusal(reason: AuthRefusalReason, request?: Request): Response {
  const status = reason === "bad-token" || reason === "expired-token" ? 401 : 400;
  if (request?.headers.get("accept")?.toLowerCase().includes("text/html") === true) {
    const copy = AUTH_REFUSAL_COPY[reason];
    const next = nextPathFromCookie(request.headers.get("cookie"));
    const loginHref =
      next === undefined ? "/auth/login" : `/auth/login?next=${encodeURIComponent(next)}`;
    return html(
      shell(
        `<main data-testid="auth-error"><h1>${copy.title}</h1><p>${copy.message}</p><p><a data-testid="auth-retry" href="${escape(loginHref)}">Try signing in again</a></p><p><a href="/">Return home</a></p></main>`,
      ),
      status,
    );
  }
  return json(status, { error: { class: "auth-refused", reason } });
}

function redirect(location: string, cookie?: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      ...(cookie === undefined ? {} : { "set-cookie": cookie }),
    },
  });
}

function html(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function shell(content: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>electric forest</title><style>body{font-family:ui-monospace,monospace;max-width:58rem;margin:4rem auto;padding:0 1.5rem;background:#08120d;color:#d9ffe8}main{border:1px solid #397a50;padding:2rem;border-radius:12px}a,button{color:#08120d;background:#8dffb0;border:0;border-radius:6px;padding:.65rem 1rem;font:inherit;text-decoration:none}input{font:inherit;padding:.6rem;margin:.25rem}dl{display:grid;grid-template-columns:max-content 1fr;gap:.75rem 1rem}dt{color:#8dffb0}dd{margin:0;overflow-wrap:anywhere}li{margin:1rem 0}.secret{padding:1rem;border:1px solid #8dffb0;overflow-wrap:anywhere}</style></head><body>${content}</body></html>`;
}

const SAFE_NEXT_PATH = /^\/(?!\/)[A-Za-z0-9/_\-.~%]*$/;
const OIDC_PROXY_PREFIX = "/__auth0";
const OIDC_PROXY_ROOT_PATHS = [
  "/authorize",
  "/activate",
  "/userinfo",
  "/oauth/",
  "/.well-known/",
  "/_emulate/",
  "/api/v2/",
] as const;
const HOP_BY_HOP_HEADERS = ["connection", "content-length", "host", "transfer-encoding"] as const;

function nextPathFromCookie(cookie: string | null): string | undefined {
  if (cookie === null) return undefined;
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== "ef_next") continue;
    try {
      const value = decodeURIComponent(rest.join("="));
      return SAFE_NEXT_PATH.test(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** A dispatch-door request built by a platform door on the session's behalf. */
function dispatchRequest(origin: string, streamId: string, event: unknown): Request {
  return new Request(`${origin}/api/dispatch`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-eforest-dispatch-receipt": "offset" },
    body: JSON.stringify({ streamId, event }),
  });
}

function validQueryValue(value: string | null): value is string {
  return (
    value !== null && value.length > 0 && value.length <= 1_024 && /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function oidcProxySuffix(pathname: string): string | undefined {
  if (pathname === OIDC_PROXY_PREFIX || pathname.startsWith(`${OIDC_PROXY_PREFIX}/`)) {
    return pathname.slice(OIDC_PROXY_PREFIX.length) || "/";
  }
  return OIDC_PROXY_ROOT_PATHS.some((prefix) =>
    prefix.endsWith("/") ? pathname.startsWith(prefix) : pathname === prefix,
  )
    ? pathname
    : undefined;
}

export class PlatformWebApp {
  private readonly oidc: OidcClient;
  private readonly transactions: OidcTransactions;
  private readonly identity: IdentityStore;
  private readonly sessionSecret: string;
  private readonly sessionTtlMs: number;
  private readonly gateway: PlatformGateway | undefined;
  private readonly deviceVerifier: BearerVerifier | undefined;
  private readonly now: () => number;
  private readonly random: (size: number) => Uint8Array;
  private readonly rateLimiter: FixedWindowRateLimiter;
  private readonly webRoot: string | undefined;
  private readonly mailer: ResendMailer | undefined;
  private readonly oidcProxyTarget: URL | undefined;
  private readonly publicOrigin: string | undefined;
  private testProofReceipt: (() => Promise<unknown | undefined>) | undefined;

  constructor(options: PlatformWebAppOptions) {
    if (options.sessionSecret.length < 32)
      throw new TypeError("sessionSecret must be at least 32 bytes");
    if (!Number.isFinite(options.sessionTtlMs) || options.sessionTtlMs <= 0) {
      throw new TypeError("sessionTtlMs must be positive and finite");
    }
    this.oidc = options.oidc;
    this.transactions = options.transactions;
    this.identity = options.identity;
    this.sessionSecret = options.sessionSecret;
    this.sessionTtlMs = options.sessionTtlMs;
    this.gateway = options.gateway;
    this.deviceVerifier = options.deviceVerifier;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? ((size) => randomBytes(size));
    this.rateLimiter =
      options.rateLimiter ?? new FixedWindowRateLimiter(DEFAULT_PLATFORM_RATE_LIMIT);
    this.webRoot = options.webRoot;
    this.mailer = options.resend === undefined ? undefined : new ResendMailer(options.resend);
    if (options.oidcProxyTarget !== undefined) {
      const target = new URL(options.oidcProxyTarget);
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        throw new TypeError("oidcProxyTarget must use http or https");
      }
      if (
        target.username !== "" ||
        target.password !== "" ||
        target.search !== "" ||
        target.hash !== ""
      ) {
        throw new TypeError("oidcProxyTarget must not contain credentials, a query, or a fragment");
      }
      this.oidcProxyTarget = target;
    }
    if (options.publicOrigin !== undefined) {
      const origin = new URL(options.publicOrigin);
      if (origin.protocol !== "http:" && origin.protocol !== "https:") {
        throw new TypeError("publicOrigin must use http or https");
      }
      if (
        origin.username !== "" ||
        origin.password !== "" ||
        origin.pathname !== "/" ||
        origin.search !== "" ||
        origin.hash !== ""
      ) {
        throw new TypeError("publicOrigin must be an origin without credentials or a path");
      }
      this.publicOrigin = origin.origin;
    }
    this.testProofReceipt = options.testProofReceipt;
  }

  installTestProofReceiptForHarness(receipt: () => Promise<unknown | undefined>): void {
    if (this.testProofReceipt !== undefined) {
      throw new Error("test proof receipt is already installed");
    }
    this.testProofReceipt = receipt;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      const proxySuffix = oidcProxySuffix(url.pathname);
      if (this.oidcProxyTarget !== undefined && proxySuffix !== undefined) {
        return await this.oidcProxy(request, url, proxySuffix);
      }
      if (url.pathname === "/__proof/e3-t02") {
        return await this.proofReceipt(request);
      }
      switch (classifyPlatformRoute(url.pathname)) {
        case "dispatch":
        case "namespaces":
        case "repos":
        case "chat":
        case "members":
        case "agents":
        case "registry": {
          if (
            this.gateway !== undefined &&
            (url.pathname === "/api/dispatch" ||
              url.pathname === "/registry/me" ||
              url.pathname.startsWith("/api/repos/") ||
              url.pathname.startsWith("/api/chat/") ||
              url.pathname.startsWith("/api/members/") ||
              url.pathname.startsWith("/api/agents/")) &&
            !request.headers.has("authorization")
          ) {
            const identity = await resolveSessionBackedIdentity(request, {
              identity: this.identity,
              sessionSecret: this.sessionSecret,
              sessionTtlMs: this.sessionTtlMs,
              now: this.now,
            });
            if (identity !== null) {
              if (url.pathname === "/api/dispatch") {
                return this.gateway.handleSessionDispatch(
                  request,
                  identity.sub,
                  identity.snapshot.view,
                  identity.snapshot.offset,
                );
              }
              if (url.pathname === "/registry/me") {
                return this.gateway.handleSessionRegistry(
                  request,
                  identity.sub,
                  identity.snapshot.view,
                );
              }
              if (
                url.pathname.startsWith("/api/chat/") ||
                url.pathname.startsWith("/api/members/") ||
                url.pathname.startsWith("/api/agents/")
              ) {
                return this.gateway.handleSessionChat(
                  request,
                  identity.sub,
                  identity.snapshot.view,
                  identity.snapshot.offset,
                );
              }
              return this.gateway.handleSessionRepository(
                request,
                identity.sub,
                identity.snapshot.view,
                identity.snapshot.offset,
              );
            }
          }
          return this.gateway === undefined
            ? json(404, { error: { class: "auth-refused", reason: "bad-state" } })
            : await this.gateway.handle(request);
        }
        case "device-grants":
          return await this.registerDeviceGrant(request);
        case "cli-tokens":
          return await this.cliTokens(request);
        case "cli-token-item":
          return await this.revokeCliToken(request, decodeURIComponent(url.pathname.slice(16)));
        case "auth-login":
          return await this.login(request, url);
        case "auth-callback":
          return await this.callback(request, url);
        case "auth-logout":
          return await this.logout(request);
        case "whoami":
          return await whoamiResponse(request, {
            identity: this.identity,
            sessionSecret: this.sessionSecret,
            sessionTtlMs: this.sessionTtlMs,
            now: this.now,
          });
        case "home":
          return this.webRoot === undefined
            ? await this.home(request)
            : await this.spa(request, this.webRoot);
        case "cli-tokens-page":
          return await this.cliTokensPage(request);
        case "org-api":
          return await this.orgApi(request, url);
        default:
          if (
            this.webRoot !== undefined &&
            !url.pathname.startsWith("/api/") &&
            !url.pathname.startsWith("/auth/")
          ) {
            return await this.spa(request, this.webRoot);
          }
          return json(404, { error: { class: "auth-refused", reason: "bad-state" } });
      }
    } catch (error) {
      if (error instanceof AuthRefusedError) return refusal(error.reason, request);
      throw error;
    }
  }

  /**
   * Keep local OIDC emulators reachable to a remote Replay QA browser without
   * exposing a second public listener. The configured target is explicit and
   * the route is only mounted under the fixed internal prefix.
   */
  private async oidcProxy(request: Request, url: URL, suffix: string): Promise<Response> {
    const target = new URL(this.oidcProxyTarget!);
    target.pathname = `${target.pathname.replace(/\/$/, "")}${suffix}`;
    target.search = url.search;
    const headers = new Headers(request.headers);
    for (const header of HOP_BY_HOP_HEADERS) headers.delete(header);
    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: "manual",
      ...(request.method === "GET" || request.method === "HEAD"
        ? {}
        : { body: new Uint8Array(await request.arrayBuffer()) }),
    };
    let upstream: Response;
    try {
      upstream = await fetch(target, init);
    } catch {
      return json(502, { error: { class: "oidc-proxy", reason: "upstream-unavailable" } });
    }
    const responseHeaders = new Headers(upstream.headers);
    for (const header of HOP_BY_HOP_HEADERS) responseHeaders.delete(header);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }

  private async proofReceipt(request: Request): Promise<Response> {
    if (this.testProofReceipt === undefined) {
      return json(404, { error: { class: "auth-refused", reason: "bad-state" } });
    }
    if (request.method !== "GET") return refusal("bad-state", request);
    const session = await this.webSession(request);
    if (session instanceof Response) return session;
    const receipt = await this.testProofReceipt();
    if (receipt === undefined) {
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    return json(200, receipt, { "cache-control": "no-store" });
  }

  private spa(request: Request, webRoot: string): Promise<Response> {
    return spaResponse(request, {
      webRoot,
      proofReceiptAvailable: this.testProofReceipt !== undefined,
      identity: this.identity,
      sessionSecret: this.sessionSecret,
      sessionTtlMs: this.sessionTtlMs,
      now: this.now,
    });
  }

  private async login(request: Request, url: URL): Promise<Response> {
    if (request.method !== "GET") return refusal("bad-state", request);
    const transaction = this.transactions.create();
    const callback = `${this.publicOrigin ?? url.origin}/auth/callback`;
    const next = url.searchParams.get("next");
    const location = await this.oidc.authorizationUrl(callback, transaction);
    // A local return path (an invite landing, a deep link) rides a short-lived cookie
    // through the OIDC round-trip; anything that is not a same-origin path is dropped.
    if (next !== null && SAFE_NEXT_PATH.test(next)) {
      return redirect(
        location,
        `ef_next=${encodeURIComponent(next)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
      );
    }
    if (nextPathFromCookie(request.headers.get("cookie")) !== undefined) {
      return redirect(location, "ef_next=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    }
    return redirect(location);
  }

  private async callback(request: Request, url: URL): Promise<Response> {
    if (request.method !== "GET") return refusal("bad-state", request);
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (!validQueryValue(state)) throw new AuthRefusedError("bad-state");
    const transaction = this.transactions.consume(state);
    if (!validQueryValue(code)) throw new AuthRefusedError("bad-token");
    const claims = await this.oidc.exchangeCode(
      code,
      `${this.publicOrigin ?? url.origin}/auth/callback`,
      transaction,
    );
    const sessionId = Buffer.from(this.random(24)).toString("base64url");
    await this.identity.login(claims.sub, claims.email, sessionId);
    // One Set-Cookie per response: the session cookie must never share a header with
    // another cookie (the HTTP layer joins them). `ef_next` is consumed here and
    // cleared by the next plain /auth/login; it expires on its own within ten minutes.
    const next = nextPathFromCookie(request.headers.get("cookie"));
    return redirect(
      next ?? "/",
      signedSessionCookie(this.sessionSecret, sessionId, this.sessionTtlMs / 1_000),
    );
  }

  /**
   * Workspace roster doors. Humans are identity memberships (the truth authorization
   * consults); invitations live on the org's `members:` stream and are accepted here,
   * where the signed-in email is checked against the invite before identity grants the
   * membership. Every mutation still goes through the dispatch door.
   */
  private async orgApi(request: Request, url: URL): Promise<Response> {
    const session = await this.webSession(request);
    if (session instanceof Response) return session;
    if (this.gateway === undefined) return json(503, { error: { class: "gateway-unavailable" } });
    const segments = url.pathname.split("/").filter(Boolean).slice(2);
    let org: string;
    try {
      org = decodeURIComponent(segments[0] ?? "");
    } catch {
      return json(400, { error: { class: "invalid-path" } });
    }
    if (!/^(?=[a-z0-9-]{1,40}$)[a-z0-9](?:-?[a-z0-9])*$/.test(org)) {
      return json(404, { error: { class: "not-found" } });
    }
    const owner = await this.gateway.orgOwner(org);
    if (owner === undefined) return json(404, { error: { class: "not-found" } });
    const view = session.snapshot.view;
    const me = session.sub;
    const myRole = owner === me ? "owner" : roleOf(view, org, me);
    const tail = segments.slice(1);

    if (request.method === "GET" && tail.length === 1 && tail[0] === "members") {
      if (myRole === null) return json(404, { error: { class: "not-found" } });
      const memberships = view.memberships[org] ?? {};
      const humans = [
        {
          sub: owner,
          email: userForSub(view, owner)?.email ?? null,
          role: "owner",
          status: "active",
        },
        ...Object.entries(memberships)
          .filter(([sub]) => sub !== owner)
          .map(([sub, membership]) => ({
            sub,
            email: userForSub(view, sub)?.email ?? null,
            role: membership.role,
            status: membership.status,
          })),
      ];
      const members = reduceMembers(await this.gateway.readOrgStream(membersStreamId(org)));
      return json(200, {
        org,
        owner,
        me: { sub: me, role: myRole },
        humans,
        invites: Object.values(members.invites).sort((a, b) => a.invitedAt - b.invitedAt),
        identityOffset: session.snapshot.offset,
        emailDelivery: this.mailer === undefined ? "unconfigured" : "resend",
      });
    }

    if (request.method === "POST" && tail.length === 1 && tail[0] === "invites") {
      if (myRole !== "owner" && myRole !== "admin") {
        return json(403, { error: { class: "authz-refused", reason: "invite-requires-admin" } });
      }
      const body = (await request.json().catch(() => null)) as {
        email?: unknown;
        role?: unknown;
      } | null;
      const email = typeof body?.email === "string" ? normalizeEmail(body.email) : "";
      const role: MemberRole = body?.role === "admin" ? "admin" : "member";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json(422, { error: { class: "schema-violation", reason: "invalid-email" } });
      }
      const token = Buffer.from(this.random(24)).toString("base64url");
      const dispatched = await this.gateway.handleSessionDispatch(
        dispatchRequest(url.origin, membersStreamId(org), {
          type: "member.invite",
          payload: { v: 1, email, role, token },
          ts: this.now(),
        }),
        me,
        view,
        session.snapshot.offset,
      );
      if (!dispatched.ok) return dispatched;
      const link = `${this.publicOrigin ?? url.origin}/auth/login?next=${encodeURIComponent(`/invite/${org}/${token}`)}`;
      let emailed: { readonly id: string } | null = null;
      if (this.mailer !== undefined) {
        const inviter = userForSub(view, me)?.email ?? me;
        emailed = await this.mailer.send({ to: email, ...inviteEmail({ org, inviter, link }) });
      }
      return json(201, { token, email, role, link, emailed });
    }

    if (
      request.method === "POST" &&
      tail.length === 3 &&
      tail[0] === "invites" &&
      tail[2] === "accept"
    ) {
      const token = tail[1]!;
      const members = reduceMembers(await this.gateway.readOrgStream(membersStreamId(org)));
      const invite = members.invites[token];
      if (invite === undefined || invite.status !== "pending") {
        return json(404, { error: { class: "not-found", reason: "invite-unavailable" } });
      }
      const myEmail = userForSub(view, me)?.email;
      if (myEmail === undefined || normalizeEmail(myEmail) !== invite.email) {
        return json(403, { error: { class: "authz-refused", reason: "invite-email-mismatch" } });
      }
      // Namespace orgs are created on `ns:root`; identity learns about an org the first
      // time a membership is granted in it, mirrored with the namespace owner.
      if (view.orgs[org] === undefined) await this.identity.createOrg(org, org, owner);
      const granted =
        myRole === "owner"
          ? session.snapshot
          : await this.identity.grantMembership(org, me, invite.role);
      const accepted = await this.gateway.handleSessionDispatch(
        dispatchRequest(url.origin, membersStreamId(org), {
          type: "member.invite.accepted",
          payload: { v: 1, token, sub: me },
          ts: this.now(),
        }),
        me,
        granted.view,
        granted.offset,
      );
      if (!accepted.ok) return accepted;
      return json(200, {
        org,
        role: myRole === "owner" ? "owner" : invite.role,
        identityOffset: granted.offset,
      });
    }
    return json(404, { error: { class: "not-found" } });
  }

  private async logout(request: Request): Promise<Response> {
    if (request.method !== "POST") return refusal("bad-state", request);
    const parsed = parseSessionCookie(request.headers.get("cookie"), this.sessionSecret);
    if (parsed.kind === "malformed") return refusal("bad-token", request);
    if (parsed.kind === "valid") {
      const snapshot = await this.identity.snapshot();
      if (sessionIsValid(snapshot, parsed.sessionId, this.now(), this.sessionTtlMs)) {
        await this.identity.endSession(parsed.sessionId);
      }
    }
    return redirect("/", clearedSessionCookie());
  }

  private async home(request: Request): Promise<Response> {
    if (request.method !== "GET") return refusal("bad-state", request);
    const parsed = parseSessionCookie(request.headers.get("cookie"), this.sessionSecret);
    if (parsed.kind === "malformed") return refusal("bad-token", request);
    if (parsed.kind === "valid") {
      const snapshot = await this.identity.snapshot();
      if (sessionIsValid(snapshot, parsed.sessionId, this.now(), this.sessionTtlMs)) {
        const session = snapshot.view.sessions[parsed.sessionId]!;
        const user = userForSub(snapshot.view, session.sub)!;
        return html(
          shell(
            `<main data-auth-state="logged-in" data-identity-offset="${escape(snapshot.offset)}" data-identity-digest="${snapshot.digest}"><h1>Signed in</h1><dl><dt>subject</dt><dd data-testid="identity-sub">${escape(session.sub)}</dd><dt>email</dt><dd data-testid="identity-email">${escape(user.email)}</dd><dt>offset</dt><dd>${escape(snapshot.offset)}</dd><dt>digest</dt><dd>${snapshot.digest}</dd></dl><p><a data-testid="cli-tokens-link" href="/settings/cli-tokens">CLI tokens</a></p><form method="post" action="/auth/logout"><button type="submit">Log out</button></form></main>`,
          ),
        );
      }
    }
    return html(
      shell(
        '<main data-auth-state="logged-out"><h1>electric forest</h1><p>Identity is replayed from the stream.</p><a data-testid="login" href="/auth/login">Log in</a></main>',
      ),
    );
  }

  private async webSession(
    request: Request,
  ): Promise<{ readonly snapshot: IdentitySnapshot; readonly sub: string } | Response> {
    if (request.headers.has("authorization")) {
      return json(401, { error: { class: "web-session-required" } });
    }
    const parsed = parseSessionCookie(request.headers.get("cookie"), this.sessionSecret);
    if (parsed.kind !== "valid") return refusal("bad-token", request);
    const snapshot = await this.identity.snapshot();
    if (!sessionIsValid(snapshot, parsed.sessionId, this.now(), this.sessionTtlMs)) {
      return refusal("bad-token", request);
    }
    return { snapshot, sub: snapshot.view.sessions[parsed.sessionId]!.sub };
  }

  private async cliTokens(request: Request): Promise<Response> {
    const session = await this.webSession(request);
    if (session instanceof Response) return session;
    const rateRefusal = this.admitTokenRate(session.sub);
    if (rateRefusal !== undefined) return rateRefusal;
    if (request.method === "GET") {
      return json(200, this.cliTokenList(session.snapshot, session.sub));
    }
    if (request.method !== "POST") return json(405, { error: { class: "method-not-allowed" } });
    const input = await this.cliTokenInput(request);
    if (input instanceof Response) return input;
    const secret = `ef_cli_${Buffer.from(this.random(32)).toString("base64url")}`;
    const grantId = `grant_${Buffer.from(this.random(18)).toString("base64url")}`;
    const snapshot = await this.identity.issueCliGrant({
      grantId,
      sub: session.sub,
      tokenKind: "web-mint",
      tokenHash: tokenHash(secret),
      scopes: input.scopes,
      ...(input.name === undefined ? {} : { name: input.name }),
    });
    const grant = snapshot.view.grants[grantId]!;
    return json(201, {
      grantId,
      token: secret,
      name: grant.name ?? null,
      tokenKind: "web-mint",
      scopes: grant.scopes,
      issuedAt: grant.issuedAt,
      offset: snapshot.offset,
      digest: snapshot.digest,
    });
  }

  private async registerDeviceGrant(request: Request): Promise<Response> {
    if (request.method !== "POST") return json(405, { error: { class: "method-not-allowed" } });
    if (this.deviceVerifier === undefined) {
      return json(503, { error: { class: "device-flow-unavailable" } });
    }
    let accessToken: string;
    let accessIdentity;
    try {
      accessToken = bearerToken(request.headers.get("authorization"));
      accessIdentity = await this.deviceVerifier.verifyAuthorization(
        request.headers.get("authorization"),
      );
    } catch (error) {
      const reason = error instanceof UnauthorizedError ? error.reason : "malformed_token";
      return json(401, { error: { class: "unauthorized", reason } });
    }
    const input = await this.cliTokenInput(request, true);
    if (input instanceof Response) return input;
    let idIdentity;
    try {
      idIdentity = await this.deviceVerifier.verifyAuthorization(`Bearer ${input.idToken}`);
    } catch (error) {
      const reason = error instanceof UnauthorizedError ? error.reason : "malformed_token";
      return json(401, { error: { class: "unauthorized", reason } });
    }
    if (idIdentity.sub !== accessIdentity.sub || idIdentity.email === undefined) {
      return json(401, { error: { class: "unauthorized", reason: "subject_mismatch" } });
    }
    const rateRefusal = this.admitTokenRate(accessIdentity.sub);
    if (rateRefusal !== undefined) return rateRefusal;
    await this.identity.ensureUser(accessIdentity.sub, idIdentity.email);
    const grantId = `grant_${Buffer.from(this.random(18)).toString("base64url")}`;
    try {
      const snapshot = await this.identity.issueCliGrant({
        grantId,
        sub: accessIdentity.sub,
        tokenKind: "device",
        tokenHash: tokenHash(accessToken),
        scopes: input.scopes,
        ...(input.name === undefined ? {} : { name: input.name }),
      });
      return json(201, { grantId, offset: snapshot.offset, digest: snapshot.digest });
    } catch (error) {
      if (
        error instanceof IdentityDispatchRefusedError &&
        error.code === "identity/active-token-hash"
      ) {
        return json(409, { error: { class: "grant-already-issued" } });
      }
      throw error;
    }
  }

  private async revokeCliToken(request: Request, grantId: string): Promise<Response> {
    const session = await this.webSession(request);
    if (session instanceof Response) return session;
    const rateRefusal = this.admitTokenRate(session.sub);
    if (rateRefusal !== undefined) return rateRefusal;
    if (request.method !== "DELETE") return json(405, { error: { class: "method-not-allowed" } });
    const grant = session.snapshot.view.grants[grantId];
    if (grant === undefined || grant.sub !== session.sub) {
      return json(404, { error: { class: "grant-not-found" } });
    }
    if (grant.status !== "active") {
      return json(409, { error: { class: "grant-already-revoked" } });
    }
    try {
      const snapshot = await this.identity.revokeCliGrant(grantId);
      return json(200, { ok: true, offset: snapshot.offset, digest: snapshot.digest });
    } catch (error) {
      if (
        error instanceof IdentityDispatchRefusedError &&
        error.code === "identity/grant-revoked"
      ) {
        return json(409, { error: { class: "grant-already-revoked" } });
      }
      throw error;
    }
  }

  private cliTokenList(snapshot: IdentitySnapshot, sub: string): unknown {
    return {
      tokens: grantsForSub(snapshot.view, sub)
        .filter((grant) => grant.status === "active")
        .map((grant) => ({
          grantId: grant.grantId,
          name: grant.name ?? null,
          tokenKind: grant.tokenKind ?? (grant.kind === "cli-token" ? "device" : "web-mint"),
          scopes: grant.scopes,
          issuedAt: grant.issuedAt ?? null,
        })),
      offset: snapshot.offset,
      digest: snapshot.digest,
    };
  }

  private admitTokenRate(subject: string): Response | undefined {
    const decision = this.rateLimiter.consume({
      tenant: `subject:${subject}`,
      subject,
      operation: "cli-token.issue",
    });
    if (decision.allowed) return undefined;
    return rateLimitResponse(new RateLimitExceededError(decision).decision);
  }

  private async cliTokenInput(
    request: Request,
    device = false,
  ): Promise<
    | { readonly name?: string; readonly scopes: readonly string[]; readonly idToken: string }
    | Response
  > {
    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return json(400, { error: { class: "invalid-request" } });
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return json(400, { error: { class: "invalid-request" } });
    }
    const record = value as Record<string, unknown>;
    const scopes = record.scopes;
    const name = record.name;
    const idToken = record.idToken;
    if (
      !Array.isArray(scopes) ||
      scopes.length === 0 ||
      !scopes.every(
        (scope) => typeof scope === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(scope),
      ) ||
      !scopes.every((scope, index) => index === 0 || scopes[index - 1]! < scope) ||
      (name !== undefined &&
        (typeof name !== "string" || name.length === 0 || name.length > 128)) ||
      (device && (typeof idToken !== "string" || idToken.length === 0))
    ) {
      return json(400, { error: { class: "invalid-request" } });
    }
    return {
      scopes: scopes as string[],
      ...(name === undefined ? {} : { name: name as string }),
      idToken: device ? (idToken as string) : "",
    };
  }

  private async cliTokensPage(request: Request): Promise<Response> {
    if (request.method !== "GET") return refusal("bad-state", request);
    const session = await this.webSession(request);
    if (session instanceof Response) return session;
    const initial = this.cliTokenList(session.snapshot, session.sub);
    return html(
      shell(`<main data-auth-state="logged-in" data-identity-offset="${escape(session.snapshot.offset)}" data-identity-digest="${session.snapshot.digest}">
<h1>CLI tokens</h1><p><a href="/">Back</a></p>
<form data-testid="cli-token-mint"><label>Name <input name="name" required></label><label>Scopes <input name="scopes" value="repo:write" required></label><button type="submit">Mint token</button></form>
<p class="secret" data-testid="cli-token-secret" hidden></p><ul data-testid="cli-token-list"></ul>
<script type="application/json" id="cli-token-initial">${scriptJson(initial)}</script>
<script>(function(){const main=document.querySelector('main');const list=document.querySelector('[data-testid="cli-token-list"]');const secret=document.querySelector('[data-testid="cli-token-secret"]');function render(data){main.dataset.identityOffset=data.offset;main.dataset.identityDigest=data.digest;list.replaceChildren(...data.tokens.map(function(token){const li=document.createElement('li');li.dataset.grantId=token.grantId;li.append(document.createTextNode((token.name||'unnamed')+' · '+token.tokenKind+' · '+token.scopes.join(', ')));const button=document.createElement('button');button.type='button';button.textContent='Revoke';button.addEventListener('click',async function(){const response=await fetch('/api/cli-tokens/'+encodeURIComponent(token.grantId),{method:'DELETE'});if(!response.ok)throw new Error('revoke failed');await refresh();});li.append(' ',button);return li;}));}async function refresh(){const response=await fetch('/api/cli-tokens');if(!response.ok)throw new Error('list failed');render(await response.json());}render(JSON.parse(document.getElementById('cli-token-initial').textContent));document.querySelector('[data-testid="cli-token-mint"]').addEventListener('submit',async function(event){event.preventDefault();const form=new FormData(event.currentTarget);const scopes=String(form.get('scopes')).split(',').map(function(value){return value.trim();}).filter(Boolean).sort();const response=await fetch('/api/cli-tokens',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:String(form.get('name')),scopes:scopes})});if(!response.ok)throw new Error('mint failed');const result=await response.json();secret.textContent=result.token;secret.hidden=false;await refresh();});})();</script>
</main>`),
    );
  }
}

export { refusal as authRefusalResponse };
