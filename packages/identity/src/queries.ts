import type {
  AuthorizationView,
  IdentityGrantView,
  IdentityUserView,
  MembershipRole,
} from "./view.js";

export interface ActiveGrant extends IdentityGrantView {
  readonly grantId: string;
  readonly status: "active";
}

export function userForSub(view: AuthorizationView, sub: string): IdentityUserView | null {
  return view.users[sub] ?? null;
}

export function roleOf(view: AuthorizationView, orgId: string, sub: string): MembershipRole | null {
  const org = view.orgs[orgId];
  if (org?.ownerSub === sub) return "owner";
  const membership = view.memberships[orgId]?.[sub];
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

export function isSessionActive(view: AuthorizationView, sessionId: string): boolean {
  return view.sessions[sessionId]?.status === "active";
}
