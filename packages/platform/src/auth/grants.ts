import { createHash } from "node:crypto";
import { findGrantByTokenHash } from "@eforest/identity";
import { BearerVerifier, UnauthorizedError, type RequestIdentity } from "../auth.js";
import type { IdentityStore } from "./provision.js";

export interface AuthorizationVerifier {
  verifyAuthorization(header: string | null): Promise<RequestIdentity>;
}

export class TokenRevokedError extends Error {
  constructor() {
    super("token-revoked");
    this.name = "TokenRevokedError";
  }
}

export function bearerToken(header: string | null): string {
  if (header === null || header.trim() === "") throw new UnauthorizedError("missing_bearer_token");
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  if (match === null) throw new UnauthorizedError("malformed_authorization");
  return match[1]!;
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Resolves every CLI bearer through the replayed identity grant view. */
export class GrantAwareVerifier implements AuthorizationVerifier {
  private readonly bearer: BearerVerifier;
  private readonly identity: IdentityStore;

  constructor(options: { readonly bearer: BearerVerifier; readonly identity: IdentityStore }) {
    this.bearer = options.bearer;
    this.identity = options.identity;
  }

  async verifyAuthorization(header: string | null): Promise<RequestIdentity> {
    const token = bearerToken(header);
    const grant = findGrantByTokenHash((await this.identity.snapshot()).view, tokenHash(token));
    if (grant?.status !== "active") throw new TokenRevokedError();

    if (grant.tokenKind === "web-mint" || grant.kind === "web-session-mint") {
      return { sub: grant.sub };
    }

    const verified = await this.bearer.verifyAuthorization(header);
    if (verified.sub !== grant.sub) throw new TokenRevokedError();
    return verified;
  }
}
