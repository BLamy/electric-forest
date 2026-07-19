import { stateDigest, type Event } from "@eforest/protocol";
import type { CliTokenKind, GrantKind, MembershipGrantRole } from "./events.js";

export type MembershipRole = "owner" | MembershipGrantRole;
export type RevocationStatus = "active" | "revoked";
export type SessionStatus = "active" | "ended";

export interface IdentityUserView {
  readonly email: string;
}

export interface IdentityOrgView {
  readonly name: string;
  readonly ownerSub: string;
}

export interface IdentityMembershipView {
  readonly role: MembershipRole;
  readonly status: RevocationStatus;
}

export interface IdentityGrantView {
  readonly sub: string;
  readonly kind: GrantKind;
  readonly scopes: readonly string[];
  readonly tokenHash: string;
  readonly status: RevocationStatus;
  readonly tokenKind?: CliTokenKind;
  readonly name?: string;
  readonly issuedAt?: number;
  readonly revokedAt?: number;
}

export interface IdentityGrantOperationView {
  readonly grantId: string;
  readonly status: "active" | "completed";
  readonly startedAt: number;
  readonly streamId: string;
  readonly event: Event;
  readonly completedAt?: number;
}

export interface IdentitySessionView {
  readonly sub: string;
  readonly status: SessionStatus;
}

export interface AuthorizationView {
  readonly users: Readonly<Record<string, IdentityUserView>>;
  readonly orgs: Readonly<Record<string, IdentityOrgView>>;
  readonly memberships: Readonly<Record<string, Readonly<Record<string, IdentityMembershipView>>>>;
  readonly grants: Readonly<Record<string, IdentityGrantView>>;
  /** Added lazily by E2-T05 so legacy identity digests retain byte parity. */
  readonly grantOperations?: Readonly<Record<string, IdentityGrantOperationView>>;
  readonly sessions: Readonly<Record<string, IdentitySessionView>>;
}

export function emptyView(): AuthorizationView {
  return { users: {}, orgs: {}, memberships: {}, grants: {}, sessions: {} };
}

export function viewDigest(view: AuthorizationView): string {
  return stateDigest(view);
}
