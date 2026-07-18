import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";

export interface RequestIdentity {
  readonly sub: string;
  readonly email?: string;
}

export type UnauthorizedReason =
  | "missing_bearer_token"
  | "malformed_authorization"
  | "malformed_token"
  | "unsupported_algorithm"
  | "unknown_kid"
  | "invalid_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "expired_token"
  | "token_not_active"
  | "missing_subject"
  | "jwks_unavailable";

export class UnauthorizedError extends Error {
  readonly reason: UnauthorizedReason;

  constructor(reason: UnauthorizedReason) {
    super(reason);
    this.name = "UnauthorizedError";
    this.reason = reason;
  }
}

export interface BearerVerifierOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUri?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
}

interface ParsedJwt {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
  readonly signingInput: string;
  readonly signature: Uint8Array;
}

interface CachedJwks {
  readonly expiresAt: number;
  readonly keys: ReadonlyMap<string, KeyObject>;
}

function absoluteIssuer(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("issuer must use http or https");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new TypeError("issuer must not contain a query or fragment");
  }
  return parsed.href;
}

function jsonSegment(segment: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new UnauthorizedError("malformed_token");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new UnauthorizedError("malformed_token");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new UnauthorizedError("malformed_token");
  }
  return value as Record<string, unknown>;
}

function parseJwt(token: string): ParsedJwt {
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    throw new UnauthorizedError("malformed_token");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];
  if (!/^[A-Za-z0-9_-]+$/.test(encodedSignature)) {
    throw new UnauthorizedError("malformed_token");
  }
  const signature = Buffer.from(encodedSignature, "base64url");
  if (signature.length === 0) throw new UnauthorizedError("malformed_token");
  return {
    header: jsonSegment(encodedHeader),
    payload: jsonSegment(encodedPayload),
    signingInput: `${encodedHeader}.${encodedPayload}`,
    signature,
  };
}

function audienceMatches(value: unknown, audience: string): boolean {
  return value === audience || (Array.isArray(value) && value.some((item) => item === audience));
}

function authorizationToken(header: string | null): string {
  if (header === null || header.trim() === "") throw new UnauthorizedError("missing_bearer_token");
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  if (match === null) throw new UnauthorizedError("malformed_authorization");
  return match[1]!;
}

export class BearerVerifier {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUri: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private cache: CachedJwks | undefined;
  private refreshPromise: Promise<CachedJwks> | undefined;

  constructor(options: BearerVerifierOptions) {
    this.issuer = absoluteIssuer(options.issuer);
    if (options.audience.length === 0) throw new TypeError("audience must not be empty");
    this.audience = options.audience;
    this.jwksUri =
      options.jwksUri ??
      new URL(".well-known/jwks.json", this.issuer.endsWith("/") ? this.issuer : `${this.issuer}/`)
        .href;
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = options.cacheTtlMs ?? 300_000;
    if (!Number.isFinite(this.cacheTtlMs) || this.cacheTtlMs < 0) {
      throw new TypeError("cacheTtlMs must be a non-negative finite number");
    }
  }

  async verifyAuthorization(header: string | null): Promise<RequestIdentity> {
    const token = authorizationToken(header);
    const parsed = parseJwt(token);
    if (parsed.header.alg !== "RS256") throw new UnauthorizedError("unsupported_algorithm");
    const kid = parsed.header.kid;
    if (typeof kid !== "string" || kid.length === 0) {
      throw new UnauthorizedError("unknown_kid");
    }

    let keys = await this.keys(false);
    let key = keys.get(kid);
    if (key === undefined) {
      keys = await this.keys(true);
      key = keys.get(kid);
      if (key === undefined) throw new UnauthorizedError("unknown_kid");
    }

    let signatureValid = verifySignature(
      "RSA-SHA256",
      Buffer.from(parsed.signingInput),
      key,
      parsed.signature,
    );
    if (!signatureValid) {
      keys = await this.keys(true);
      key = keys.get(kid);
      signatureValid =
        key !== undefined &&
        verifySignature("RSA-SHA256", Buffer.from(parsed.signingInput), key, parsed.signature);
    }
    if (!signatureValid) throw new UnauthorizedError("invalid_signature");

    const nowSeconds = Math.floor(this.now() / 1000);
    if (parsed.payload.iss !== this.issuer) throw new UnauthorizedError("wrong_issuer");
    if (!audienceMatches(parsed.payload.aud, this.audience)) {
      throw new UnauthorizedError("wrong_audience");
    }
    if (
      typeof parsed.payload.exp !== "number" ||
      !Number.isFinite(parsed.payload.exp) ||
      parsed.payload.exp <= nowSeconds
    ) {
      throw new UnauthorizedError("expired_token");
    }
    if (
      parsed.payload.nbf !== undefined &&
      (typeof parsed.payload.nbf !== "number" ||
        !Number.isFinite(parsed.payload.nbf) ||
        parsed.payload.nbf > nowSeconds)
    ) {
      throw new UnauthorizedError("token_not_active");
    }
    if (typeof parsed.payload.sub !== "string" || parsed.payload.sub.length === 0) {
      throw new UnauthorizedError("missing_subject");
    }
    return {
      sub: parsed.payload.sub,
      ...(typeof parsed.payload.email === "string" ? { email: parsed.payload.email } : {}),
    };
  }

  private async keys(force: boolean): Promise<ReadonlyMap<string, KeyObject>> {
    if (!force && this.cache !== undefined && this.cache.expiresAt > this.now()) {
      return this.cache.keys;
    }
    if (this.refreshPromise !== undefined) return (await this.refreshPromise).keys;
    this.refreshPromise = this.fetchJwks();
    try {
      this.cache = await this.refreshPromise;
      return this.cache.keys;
    } finally {
      this.refreshPromise = undefined;
    }
  }

  private async fetchJwks(): Promise<CachedJwks> {
    try {
      const response = await this.fetcher(this.jwksUri, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`JWKS returned ${response.status}`);
      const body: unknown = await response.json();
      if (
        body === null ||
        typeof body !== "object" ||
        !Array.isArray((body as { keys?: unknown }).keys)
      ) {
        throw new Error("JWKS body has no keys array");
      }
      const keys = new Map<string, KeyObject>();
      for (const value of (body as { keys: unknown[] }).keys) {
        if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
        const jwk = value as Record<string, unknown>;
        if (
          typeof jwk.kid !== "string" ||
          jwk.kty !== "RSA" ||
          (jwk.use !== undefined && jwk.use !== "sig") ||
          (jwk.alg !== undefined && jwk.alg !== "RS256")
        ) {
          continue;
        }
        try {
          keys.set(jwk.kid, createPublicKey({ key: jwk as JsonWebKey, format: "jwk" }));
        } catch {
          // Ignore malformed individual keys. An empty usable set is still a valid cache.
        }
      }
      return { expiresAt: this.now() + this.cacheTtlMs, keys };
    } catch (error) {
      if (error instanceof UnauthorizedError) throw error;
      throw new UnauthorizedError("jwks_unavailable");
    }
  }
}
