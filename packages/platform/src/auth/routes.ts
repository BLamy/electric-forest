import { randomBytes } from "node:crypto";
import { grantsForSub, userForSub } from "@eforest/identity";
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

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function shell(content: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>electric forest</title><style>body{font-family:ui-monospace,monospace;max-width:58rem;margin:4rem auto;padding:0 1.5rem;background:#08120d;color:#d9ffe8}main{border:1px solid #397a50;padding:2rem;border-radius:12px}a,button{color:#08120d;background:#8dffb0;border:0;border-radius:6px;padding:.65rem 1rem;font:inherit;text-decoration:none}input{font:inherit;padding:.6rem;margin:.25rem}dl{display:grid;grid-template-columns:max-content 1fr;gap:.75rem 1rem}dt{color:#8dffb0}dd{margin:0;overflow-wrap:anywhere}li{margin:1rem 0}.secret{padding:1rem;border:1px solid #8dffb0;overflow-wrap:anywhere}</style></head><body>${content}</body></html>`;
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
  private readonly deviceVerifier: BearerVerifier | undefined;
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
    this.deviceVerifier = options.deviceVerifier;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? ((size) => randomBytes(size));
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/dispatch" && this.gateway !== undefined) {
        return await this.gateway.handle(request);
      }
      if (
        (url.pathname === "/api/repos" || url.pathname.startsWith("/api/repos/")) &&
        this.gateway !== undefined
      ) {
        return await this.gateway.handle(request);
      }
      if (url.pathname === "/api/device-grants") return await this.registerDeviceGrant(request);
      if (url.pathname === "/api/cli-tokens") return await this.cliTokens(request);
      if (url.pathname.startsWith("/api/cli-tokens/")) {
        return await this.revokeCliToken(request, decodeURIComponent(url.pathname.slice(16)));
      }
      if (url.pathname === "/auth/login") return await this.login(request, url);
      if (url.pathname === "/auth/callback") return await this.callback(request, url);
      if (url.pathname === "/auth/logout") return await this.logout(request);
      if (url.pathname === "/") return await this.home(request);
      if (url.pathname === "/settings/cli-tokens") return await this.cliTokensPage(request);
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
    if (parsed.kind !== "valid") return refusal("bad-token");
    const snapshot = await this.identity.snapshot();
    if (!sessionIsValid(snapshot, parsed.sessionId, this.now(), this.sessionTtlMs)) {
      return refusal("bad-token");
    }
    return { snapshot, sub: snapshot.view.sessions[parsed.sessionId]!.sub };
  }

  private async cliTokens(request: Request): Promise<Response> {
    const session = await this.webSession(request);
    if (session instanceof Response) return session;
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
    if (request.method !== "GET") return refusal("bad-state");
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
