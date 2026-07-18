import { randomBytes } from "node:crypto";
import { userForSub } from "@eforest/identity";
import type { PlatformGateway } from "../gateway.js";
import { AuthRefusedError, OidcClient, OidcTransactions, type AuthRefusalReason } from "./oidc.js";
import { IdentityStore } from "./provision.js";
import {
  clearedSessionCookie,
  parseSessionCookie,
  sessionIsValid,
  signedSessionCookie,
} from "./session.js";

export interface PlatformWebAppOptions {
  readonly oidc: OidcClient;
  readonly transactions: OidcTransactions;
  readonly identity: IdentityStore;
  readonly sessionSecret: string;
  readonly sessionTtlMs: number;
  readonly gateway?: PlatformGateway;
  readonly now?: () => number;
  readonly random?: (size: number) => Uint8Array;
}

function json(status: number, body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}

function refusal(reason: AuthRefusalReason): Response {
  const status = reason === "bad-token" || reason === "expired-token" ? 401 : 400;
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

function shell(content: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>electric forest</title><style>body{font-family:ui-monospace,monospace;max-width:48rem;margin:4rem auto;padding:0 1.5rem;background:#08120d;color:#d9ffe8}main{border:1px solid #397a50;padding:2rem;border-radius:12px}a,button{color:#08120d;background:#8dffb0;border:0;border-radius:6px;padding:.65rem 1rem;font:inherit;text-decoration:none}dl{display:grid;grid-template-columns:max-content 1fr;gap:.75rem 1rem}dt{color:#8dffb0}dd{margin:0;overflow-wrap:anywhere}</style></head><body>${content}</body></html>`;
}

function validQueryValue(value: string | null): value is string {
  return (
    value !== null && value.length > 0 && value.length <= 1_024 && /^[A-Za-z0-9_-]+$/.test(value)
  );
}

export class PlatformWebApp {
  private readonly oidc: OidcClient;
  private readonly transactions: OidcTransactions;
  private readonly identity: IdentityStore;
  private readonly sessionSecret: string;
  private readonly sessionTtlMs: number;
  private readonly gateway: PlatformGateway | undefined;
  private readonly now: () => number;
  private readonly random: (size: number) => Uint8Array;

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
    this.now = options.now ?? Date.now;
    this.random = options.random ?? ((size) => randomBytes(size));
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/dispatch" && this.gateway !== undefined) {
        return await this.gateway.handle(request);
      }
      if (url.pathname === "/auth/login") return await this.login(request, url);
      if (url.pathname === "/auth/callback") return await this.callback(request, url);
      if (url.pathname === "/auth/logout") return await this.logout(request);
      if (url.pathname === "/") return await this.home(request);
      return json(404, { error: { class: "auth-refused", reason: "bad-state" } });
    } catch (error) {
      if (error instanceof AuthRefusedError) return refusal(error.reason);
      throw error;
    }
  }

  private async login(request: Request, url: URL): Promise<Response> {
    if (request.method !== "GET") return refusal("bad-state");
    const transaction = this.transactions.create();
    const callback = `${url.origin}/auth/callback`;
    return redirect(await this.oidc.authorizationUrl(callback, transaction));
  }

  private async callback(request: Request, url: URL): Promise<Response> {
    if (request.method !== "GET") return refusal("bad-state");
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (!validQueryValue(state)) throw new AuthRefusedError("bad-state");
    const transaction = this.transactions.consume(state);
    if (!validQueryValue(code)) throw new AuthRefusedError("bad-token");
    const claims = await this.oidc.exchangeCode(code, `${url.origin}/auth/callback`, transaction);
    const sessionId = Buffer.from(this.random(24)).toString("base64url");
    await this.identity.login(claims.sub, claims.email, sessionId);
    return redirect(
      "/",
      signedSessionCookie(this.sessionSecret, sessionId, this.sessionTtlMs / 1_000),
    );
  }

  private async logout(request: Request): Promise<Response> {
    if (request.method !== "POST") return refusal("bad-state");
    const parsed = parseSessionCookie(request.headers.get("cookie"), this.sessionSecret);
    if (parsed.kind === "malformed") return refusal("bad-token");
    if (parsed.kind === "valid") {
      const snapshot = await this.identity.snapshot();
      if (sessionIsValid(snapshot, parsed.sessionId, this.now(), this.sessionTtlMs)) {
        await this.identity.endSession(parsed.sessionId);
      }
    }
    return redirect("/", clearedSessionCookie());
  }

  private async home(request: Request): Promise<Response> {
    if (request.method !== "GET") return refusal("bad-state");
    const parsed = parseSessionCookie(request.headers.get("cookie"), this.sessionSecret);
    if (parsed.kind === "malformed") return refusal("bad-token");
    if (parsed.kind === "valid") {
      const snapshot = await this.identity.snapshot();
      if (sessionIsValid(snapshot, parsed.sessionId, this.now(), this.sessionTtlMs)) {
        const session = snapshot.view.sessions[parsed.sessionId]!;
        const user = userForSub(snapshot.view, session.sub)!;
        return html(
          shell(
            `<main data-auth-state="logged-in" data-identity-offset="${escape(snapshot.offset)}" data-identity-digest="${snapshot.digest}"><h1>Signed in</h1><dl><dt>subject</dt><dd data-testid="identity-sub">${escape(session.sub)}</dd><dt>email</dt><dd data-testid="identity-email">${escape(user.email)}</dd><dt>offset</dt><dd>${escape(snapshot.offset)}</dd><dt>digest</dt><dd>${snapshot.digest}</dd></dl><form method="post" action="/auth/logout"><button type="submit">Log out</button></form></main>`,
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
}

export { refusal as authRefusalResponse };
