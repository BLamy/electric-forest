import type { AuthorizationView } from "@eforest/identity";

export interface TenantDecision {
  readonly allowed: boolean;
  readonly subjectTenants: readonly string[];
}

/** Active organizations are derived only from the replayed identity view. */
export function activeTenants(view: AuthorizationView, subject: string): readonly string[] {
  const tenants: string[] = [];
  for (const [org, memberships] of Object.entries(view.memberships)) {
    if (Object.hasOwn(memberships, subject) && memberships[subject]?.status === "active") {
      tenants.push(org);
    }
  }
  return tenants.sort();
}

/**
 * A tenant-bound identity may not probe a different tenant. Subjects with no
 * organization binding retain E2-T07's public-read behavior, as do anonymous
 * requests; private/nonexistent equality remains the downstream authz rule.
 */
export function decideTenantAccess(
  view: AuthorizationView,
  subject: string | null,
  targetTenant: string,
): TenantDecision {
  if (subject === null) return { allowed: true, subjectTenants: [] };
  const subjectTenants = activeTenants(view, subject);
  return {
    allowed: subjectTenants.length === 0 || subjectTenants.includes(targetTenant),
    subjectTenants,
  };
}
