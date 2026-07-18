import type {
  AuthorizationView,
  IdentityGrantView,
  IdentityUserView,
  MembershipRole,
} from "./view.js";
import { ownEntry } from "./records.js";

export interface ActiveGrant extends IdentityGrantView {
  readonly grantId: string;
  readonly status: "active";
}

export function userForSub(view: AuthorizationView, sub: string): IdentityUserView | null {
  return ownEntry(view.users, sub) ?? null;
}

export function roleOf(view: AuthorizationView, orgId: string, sub: string): MembershipRole | null {
  const org = ownEntry(view.orgs, orgId);
  if (org?.ownerSub === sub) return "owner";
  const orgMemberships = ownEntry(view.memberships, orgId);
  const membership = orgMemberships && ownEntry(orgMemberships, sub);
  return membership?.status === "active" ? membership.role : null;
}

export function findActiveGrantByTokenHash(
  view: AuthorizationView,
  tokenHash: string,
): ActiveGrant | null {
  for (const [grantId, grant] of Object.entries(view.grants)) {
    if (grant.status === "active" && grant.tokenHash === tokenHash) {
      return { grantId, ...grant, status: "active" };
    }
  }
  return null;
}

export function findGrantByTokenHash(
  view: AuthorizationView,
  tokenHash: string,
): (IdentityGrantView & { readonly grantId: string }) | null {
  for (const [grantId, grant] of Object.entries(view.grants)) {
    if (grant.tokenHash === tokenHash) return { grantId, ...grant };
  }
  return null;
}

export function grantsForSub(
  view: AuthorizationView,
  sub: string,
): readonly (IdentityGrantView & { readonly grantId: string })[] {
  return Object.entries(view.grants)
    .filter(([, grant]) => grant.sub === sub)
    .map(([grantId, grant]) => ({ grantId, ...grant }))
    .sort((left, right) => left.grantId.localeCompare(right.grantId));
}

export function isSessionActive(view: AuthorizationView, sessionId: string): boolean {
  return ownEntry(view.sessions, sessionId)?.status === "active";
}
