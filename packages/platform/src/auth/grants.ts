import { createHash, randomUUID } from "node:crypto";
import { findGrantByTokenHash, type AuthorizationView } from "@eforest/identity";
import { BearerVerifier, UnauthorizedError, type RequestIdentity } from "../auth.js";
import type { AuthzPrincipal } from "../authz/decide.js";
import {
  GrantOperationAbortedError,
  IdentityDispatchRefusedError,
  type IdentityStore,
} from "./provision.js";
import { NamespaceRefusalError } from "../ns/dispatch.js";

/**
 * E2-T07: the resolved inputs `decideStreamAuthorization` consumes — the
 * principal the presented credential resolves to, plus the exact replayed
 * identity view (and its offset) the resolution consulted.
 */
export interface AuthorizationContext {
  readonly principal: AuthzPrincipal;
  readonly identity: AuthorizationView;
  readonly identityOffset: string;
}

export interface AuthorizationVerifier {
  verifyAuthorization(header: string | null): Promise<RequestIdentity>;
  /**
   * Resolve the authorization context for a request without deciding it.
   * Unlike verifyAuthorization, a credential that resolves to no usable
   * grant is returned (as a principal that can only be refused), not thrown,
   * so the refusal is decided — and offset-cited — by the pure decision
   * function.
   */
  authorizationContext?(header: string | null): Promise<AuthorizationContext>;
  withAuthorizedMutation?<T>(
    header: string | null,
    plan: (identity: RequestIdentity) => AuthorizedMutationPlan | Promise<AuthorizedMutationPlan>,
    mutation: (
      identity: RequestIdentity,
      operationId: string,
      assertActive: () => Promise<void>,
      decidedAt?: string,
    ) => Promise<T>,
  ): Promise<T>;
}

export interface AuthorizedMutationPlan {
  readonly streamId: string;
  readonly event: import("@eforest/protocol").Event;
}

export class TokenRevokedError extends Error {
  /** The identity-view offset at which the refusing decision was replayed. */
  readonly identityOffset: string | undefined;

  constructor(identityOffset?: string) {
    super("token-revoked");
    this.name = "TokenRevokedError";
    this.identityOffset = identityOffset;
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

  /**
   * Resolve the request's principal against one replayed identity snapshot.
   * Signature/claim validity is still earned the E2-T03 way (invalid JWTs
   * throw UnauthorizedError), but a token that resolves to no active grant
   * becomes a refusable principal — the pure decision function refuses it as
   * `authz/grant-revoked`, citing this snapshot's exact offset.
   */
  async authorizationContext(header: string | null): Promise<AuthorizationContext> {
    if (header === null || header.trim() === "") {
      const snapshot = await this.identity.snapshot();
      return {
        principal: { kind: "anonymous" },
        identity: snapshot.view,
        identityOffset: snapshot.offset,
      };
    }
    const token = bearerToken(header);
    const jwtShaped = token.split(".").length === 3;
    const verified = jwtShaped ? await this.bearer.verifyAuthorization(header) : undefined;
    const snapshot = await this.identity.snapshot();
    const grant = findGrantByTokenHash(snapshot.view, tokenHash(token));
    // The empty grant id can never name a real grant (grant ids are
    // non-empty), so unknown, revoked, and mismatched credentials all
    // resolve to the same refusable principal.
    const revoked: AuthorizationContext = {
      principal: { kind: "identified", sub: verified?.sub ?? "", grantId: "" },
      identity: snapshot.view,
      identityOffset: snapshot.offset,
    };
    if (grant === null || grant.status !== "active") return revoked;
    if (grant.tokenKind === "web-mint" || grant.kind === "web-session-mint") {
      if (jwtShaped) return revoked;
      return {
        principal: { kind: "identified", sub: grant.sub, grantId: grant.grantId },
        identity: snapshot.view,
        identityOffset: snapshot.offset,
      };
    }
    if (verified === undefined || verified.sub !== grant.sub) return revoked;
    return {
      principal: { kind: "identified", sub: verified.sub, grantId: grant.grantId },
      identity: snapshot.view,
      identityOffset: snapshot.offset,
    };
  }

  async withAuthorizedMutation<T>(
    header: string | null,
    plan: (identity: RequestIdentity) => AuthorizedMutationPlan | Promise<AuthorizedMutationPlan>,
    mutation: (
      identity: RequestIdentity,
      operationId: string,
      assertActive: () => Promise<void>,
      decidedAt?: string,
    ) => Promise<T>,
  ): Promise<T> {
    const resolved = await this.resolveGrant(header);
    const operationId = this.operationId();
    let decidedAt: string | undefined;
    try {
      const begun = await this.identity.beginGrantOperation(
        resolved.grantId,
        operationId,
        await plan(resolved.identity),
      );
      decidedAt = begun.decidedAt;
    } catch (error) {
      if (
        error instanceof IdentityDispatchRefusedError &&
        error.code === "identity/grant-revoked"
      ) {
        throw new TokenRevokedError(error.identityOffset);
      }
      throw error;
    }
    try {
      const result = await mutation(
        resolved.identity,
        operationId,
        async () => {
          try {
            await this.identity.assertGrantOperationActive(operationId);
          } catch (error) {
            if (error instanceof GrantOperationAbortedError) {
              throw new TokenRevokedError(error.identityOffset);
            }
            throw error;
          }
        },
        decidedAt,
      );
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
    const snapshot = await this.identity.snapshot();
    const grant = findGrantByTokenHash(snapshot.view, tokenHash(token));
    if (grant?.status !== "active") throw new TokenRevokedError(snapshot.offset);

    if (grant.tokenKind === "web-mint" || grant.kind === "web-session-mint") {
      if (jwtShaped) throw new TokenRevokedError(snapshot.offset);
      return { grantId: grant.grantId, identity: { sub: grant.sub } };
    }

    if (verified === undefined) throw new UnauthorizedError("malformed_token");
    if (verified.sub !== grant.sub) throw new TokenRevokedError(snapshot.offset);
    return { grantId: grant.grantId, identity: verified };
  }
}
