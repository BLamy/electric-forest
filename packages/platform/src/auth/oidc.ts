import { createHash, randomBytes } from "node:crypto";
import { BearerVerifier, UnauthorizedError } from "../auth.js";

export type AuthRefusalReason =
  "bad-state" | "bad-verifier" | "reused-code" | "bad-token" | "expired-token" | "bad-nonce";

export class AuthRefusedError extends Error {
  readonly reason: AuthRefusalReason;

  constructor(reason: AuthRefusalReason) {
    super(reason);
    this.name = "AuthRefusedError";
    this.reason = reason;
  }
}

interface OidcDiscovery {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
}

export interface OidcTransaction {
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
}

type ConsumedTransaction = OidcTransaction & { readonly used: boolean };

export class OidcTransactions {
  private readonly entries = new Map<string, ConsumedTransaction>();
  private readonly random: (size: number) => Uint8Array;

  constructor(random: (size: number) => Uint8Array = (size) => randomBytes(size)) {
    this.random = random;
  }

  create(): OidcTransaction {
    const transaction = {
      state: Buffer.from(this.random(24)).toString("base64url"),
      nonce: Buffer.from(this.random(24)).toString("base64url"),
      verifier: Buffer.from(this.random(48)).toString("base64url"),
    };
    this.entries.set(transaction.state, { ...transaction, used: false });
    if (this.entries.size > 1_024) this.entries.delete(this.entries.keys().next().value as string);
    return transaction;
  }

  consume(state: string): OidcTransaction {
    const transaction = this.entries.get(state);
    if (transaction === undefined) throw new AuthRefusedError("bad-state");
    if (transaction.used) throw new AuthRefusedError("reused-code");
    this.entries.set(state, { ...transaction, used: true });
    return transaction;
  }
}

export interface OidcClientOptions {
  readonly issuer: string;
  readonly clientId: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export interface OidcClaims {
  readonly sub: string;
  readonly email: string;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AuthRefusedError("bad-token");
  }
  return value as Record<string, unknown>;
}

function absoluteHttp(value: unknown): string {
  if (typeof value !== "string") throw new AuthRefusedError("bad-token");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AuthRefusedError("bad-token");
  }
  return url.href;
}

function decodeClaims(token: string): Record<string, unknown> {
  const segments = token.split(".");
  if (segments.length !== 3) throw new AuthRefusedError("bad-token");
  try {
    return object(JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf8")));
  } catch (error) {
    if (error instanceof AuthRefusedError) throw error;
    throw new AuthRefusedError("bad-token");
  }
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export class OidcClient {
  readonly issuer: string;
  readonly clientId: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private discoveryValue: OidcDiscovery | undefined;
  private verifierValue: BearerVerifier | undefined;

  constructor(options: OidcClientOptions) {
    this.issuer = new URL(options.issuer).href;
    this.clientId = options.clientId;
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    if (this.clientId.length === 0) throw new TypeError("clientId must not be empty");
  }

  async authorizationUrl(redirectUri: string, transaction: OidcTransaction): Promise<string> {
    const discovery = await this.discovery();
    const url = new URL(discovery.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      redirect_uri: redirectUri,
      scope: "openid profile email",
      state: transaction.state,
      nonce: transaction.nonce,
      code_challenge: pkceChallenge(transaction.verifier),
      code_challenge_method: "S256",
    }).toString();
    return url.href;
  }

  async exchangeCode(
    code: string,
    redirectUri: string,
    transaction: OidcTransaction,
  ): Promise<OidcClaims> {
    const discovery = await this.discovery();
    let response: Response;
    try {
      response = await this.fetcher(discovery.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: this.clientId,
          redirect_uri: redirectUri,
          code,
          code_verifier: transaction.verifier,
        }),
      });
    } catch {
      throw new AuthRefusedError("bad-token");
    }
    const body = object(await response.json().catch(() => null));
    if (!response.ok) {
      const description = typeof body.error_description === "string" ? body.error_description : "";
      if (/already used|unknown authorization code/i.test(description)) {
        throw new AuthRefusedError("reused-code");
      }
      if (/verifier|does not match/i.test(description)) {
        throw new AuthRefusedError("bad-verifier");
      }
      throw new AuthRefusedError("bad-token");
    }
    if (typeof body.id_token !== "string") throw new AuthRefusedError("bad-token");
    const verifier =
      this.verifierValue ??
      (this.verifierValue = new BearerVerifier({
        issuer: discovery.issuer,
        audience: this.clientId,
        jwksUri: discovery.jwks_uri,
        fetch: this.fetcher,
        now: this.now,
      }));
    let identity;
    try {
      identity = await verifier.verifyAuthorization(`Bearer ${body.id_token}`);
    } catch (error) {
      if (error instanceof UnauthorizedError && error.reason === "expired_token") {
        throw new AuthRefusedError("expired-token");
      }
      throw new AuthRefusedError("bad-token");
    }
    const claims = decodeClaims(body.id_token);
    if (claims.nonce !== transaction.nonce) throw new AuthRefusedError("bad-nonce");
    if (typeof claims.email !== "string" || claims.email.length === 0) {
      throw new AuthRefusedError("bad-token");
    }
    return { sub: identity.sub, email: claims.email };
  }

  private async discovery(): Promise<OidcDiscovery> {
    if (this.discoveryValue !== undefined) return this.discoveryValue;
    try {
      const response = await this.fetcher(
        new URL(
          ".well-known/openid-configuration",
          this.issuer.endsWith("/") ? this.issuer : `${this.issuer}/`,
        ),
        { headers: { accept: "application/json" } },
      );
      if (!response.ok) throw new Error("discovery failed");
      const body = object(await response.json());
      const discovered: OidcDiscovery = {
        issuer: absoluteHttp(body.issuer),
        authorization_endpoint: absoluteHttp(body.authorization_endpoint),
        token_endpoint: absoluteHttp(body.token_endpoint),
        jwks_uri: absoluteHttp(body.jwks_uri),
      };
      if (discovered.issuer !== this.issuer) throw new Error("issuer mismatch");
      this.discoveryValue = discovered;
      return discovered;
    } catch (error) {
      if (error instanceof AuthRefusedError) throw error;
      throw new AuthRefusedError("bad-token");
    }
  }
}
