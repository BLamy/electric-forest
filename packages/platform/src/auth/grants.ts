import { createHash, randomUUID } from "node:crypto";
import { findGrantByTokenHash } from "@eforest/identity";
import { BearerVerifier, UnauthorizedError, type RequestIdentity } from "../auth.js";
import {
  GrantOperationAbortedError,
  IdentityDispatchRefusedError,
  type IdentityStore,
} from "./provision.js";
import { NamespaceRefusalError } from "../ns/dispatch.js";

export interface AuthorizationVerifier {
  verifyAuthorization(header: string | null): Promise<RequestIdentity>;
  withAuthorizedMutation?<T>(
    header: string | null,
    plan: (identity: RequestIdentity) => AuthorizedMutationPlan | Promise<AuthorizedMutationPlan>,
    mutation: (
      identity: RequestIdentity,
      operationId: string,
      assertActive: () => Promise<void>,
    ) => Promise<T>,
  ): Promise<T>;
}

export interface AuthorizedMutationPlan {
  readonly streamId: string;
  readonly event: import("@eforest/protocol").Event;
}

export class TokenRevokedError extends Error {
  constructor() {
    super("token-revoked");
    this.name = "TokenRevokedError";
  }
}

export class GrantTargetUnavailableError extends Error {
  constructor() {
    super("grant-target-unavailable");
    this.name = "GrantTargetUnavailableError";
  }
}

export class GrantTargetCommitError extends Error {
  constructor(cause: unknown) {
    super("grant-target-commit-failed", { cause });
    this.name = "GrantTargetCommitError";
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
  private readonly operationId: () => string;

  constructor(options: {
    readonly bearer: BearerVerifier;
    readonly identity: IdentityStore;
    readonly operationId?: () => string;
  }) {
    this.bearer = options.bearer;
    this.identity = options.identity;
    this.operationId = options.operationId ?? randomUUID;
  }

  async verifyAuthorization(header: string | null): Promise<RequestIdentity> {
    return this.verifyGrant(header);
  }

  async withAuthorizedMutation<T>(
    header: string | null,
    plan: (identity: RequestIdentity) => AuthorizedMutationPlan | Promise<AuthorizedMutationPlan>,
    mutation: (
      identity: RequestIdentity,
      operationId: string,
      assertActive: () => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    const resolved = await this.resolveGrant(header);
    const operationId = this.operationId();
    try {
      await this.identity.beginGrantOperation(
        resolved.grantId,
        operationId,
        await plan(resolved.identity),
      );
    } catch (error) {
      if (
        error instanceof IdentityDispatchRefusedError &&
        error.code === "identity/grant-revoked"
      ) {
        throw new TokenRevokedError();
      }
      throw error;
    }
    try {
      const result = await mutation(resolved.identity, operationId, async () => {
        try {
          await this.identity.assertGrantOperationActive(operationId);
        } catch (error) {
          if (error instanceof GrantOperationAbortedError) throw new TokenRevokedError();
          throw error;
        }
      });
      await this.identity.completeGrantOperation(operationId);
      return result;
    } catch (error) {
      if (error instanceof GrantTargetUnavailableError) {
        await this.identity.settleUnavailableGrantOperation(operationId);
      } else if (error instanceof NamespaceRefusalError) {
        await this.identity.abortGrantOperation(operationId, "target-refused");
      }
      throw error;
    }
  }

  private async verifyGrant(header: string | null): Promise<RequestIdentity> {
    return (await this.resolveGrant(header)).identity;
  }

  private async resolveGrant(
    header: string | null,
  ): Promise<{ readonly grantId: string; readonly identity: RequestIdentity }> {
    const token = bearerToken(header);
    // Device credentials are JWTs and must earn E2-T03 signature/claim validity
    // before the identity stream is consulted. Web-mint credentials are opaque.
    const jwtShaped = token.split(".").length === 3;
    const verified = jwtShaped ? await this.bearer.verifyAuthorization(header) : undefined;
    const grant = findGrantByTokenHash((await this.identity.snapshot()).view, tokenHash(token));
    if (grant?.status !== "active") throw new TokenRevokedError();

    if (grant.tokenKind === "web-mint" || grant.kind === "web-session-mint") {
      if (jwtShaped) throw new TokenRevokedError();
      return { grantId: grant.grantId, identity: { sub: grant.sub } };
    }

    if (verified === undefined) throw new UnauthorizedError("malformed_token");
    if (verified.sub !== grant.sub) throw new TokenRevokedError();
    return { grantId: grant.grantId, identity: verified };
  }
}
