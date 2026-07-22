import { roleOf, type AuthorizationView } from "@eforest/identity";
import type { RegistryOrgState, RegistryState } from "./reducer.js";

/**
 * E2-T08: the single visibility filter for the project index.
 *
 * All three read doors (`/registry/public`, `/registry/org/:org`,
 * `/registry/me`) and the live-frame gate call exactly this function — no
 * lookalikes. Visibility is decided from the replayed registry state plus the
 * E2-T01 authorization view, never by the client:
 *
 * - a repo entry is visible iff it is `public`, or the subject is the repo's
 *   recorded creator, or the subject is the org's recorded creator, or the
 *   E2-T01 view records the subject as an org member (any role);
 * - an org (and each project) survives filtering iff the subject has that org
 *   relation or it still contains at least one visible repo — so anonymous
 *   and non-member identities can never learn that an empty or all-private
 *   org/project exists through this surface.
 *
 * CLI grant scopes (`repo:read:*` / `repo:write:*`) deliberately confer no
 * LISTING visibility: they authorize stream operations (E2-T07), not index
 * enumeration. Frozen here; extending listing visibility to grants would be a
 * new versioned contract.
 */

export function isRegistryOrgRelation(
  org: RegistryOrgState,
  orgName: string,
  authView: AuthorizationView,
  subject: string | null,
): boolean {
  if (subject === null) return false;
  return org.owner === subject || roleOf(authView, orgName, subject) !== null;
}

function repoVisible(
  org: RegistryOrgState,
  repoOwner: string,
  visibility: "public" | "private",
  orgRelation: boolean,
  subject: string | null,
): boolean {
  if (visibility === "public") return true;
  if (subject === null) return false;
  return repoOwner === subject || orgRelation;
}

export function filterForIdentity(
  state: RegistryState,
  authView: AuthorizationView,
  subject: string | null,
): RegistryState {
  const orgs: Record<string, RegistryOrgState> = {};
  for (const [orgName, org] of Object.entries(state.orgs)) {
    const relation = isRegistryOrgRelation(org, orgName, authView, subject);
    const repos = Object.fromEntries(
      Object.entries(org.repos).filter(([, repo]) =>
        repoVisible(org, repo.owner, repo.visibility, relation, subject),
      ),
    );
    const visibleProjects = new Set(Object.values(repos).map((repo) => repo.project));
    const projects = relation
      ? org.projects
      : Object.fromEntries(
          Object.entries(org.projects).filter(([name]) => visibleProjects.has(name)),
        );
    if (relation || Object.keys(repos).length > 0) {
      orgs[orgName] = { owner: org.owner, projects, repos };
    }
  }
  return { orgs };
}

export interface RegistryEntry {
  readonly org: string;
  readonly project: string;
  readonly repo: string;
  readonly visibility: "public" | "private";
  readonly owner: string;
  readonly repoStreamPrefix: string;
}

/** Flatten a (filtered) registry state to door entries, sorted by (org, repo). */
export function registryEntries(state: RegistryState): readonly RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  for (const orgName of Object.keys(state.orgs).sort()) {
    const org = state.orgs[orgName]!;
    for (const repoName of Object.keys(org.repos).sort()) {
      const repo = org.repos[repoName]!;
      entries.push({
        org: orgName,
        project: repo.project,
        repo: repoName,
        visibility: repo.visibility,
        owner: repo.owner,
        repoStreamPrefix: repo.repoStreamPrefix,
      });
    }
  }
  return entries;
}

/**
 * `/registry/me`'s relation restriction: keep only entries the subject OWNS
 * or that live in an org the subject belongs to. This is a relationship
 * restriction applied AFTER `filterForIdentity` — visibility itself is judged
 * only by the single filter above.
 */
export function restrictToOwnRelations(
  filtered: RegistryState,
  authView: AuthorizationView,
  subject: string,
): RegistryState {
  const orgs: Record<string, RegistryOrgState> = {};
  for (const [orgName, org] of Object.entries(filtered.orgs)) {
    if (isRegistryOrgRelation(org, orgName, authView, subject)) {
      orgs[orgName] = org;
      continue;
    }
    const repos = Object.fromEntries(
      Object.entries(org.repos).filter(([, repo]) => repo.owner === subject),
    );
    if (Object.keys(repos).length === 0) continue;
    const visibleProjects = new Set(Object.values(repos).map((repo) => repo.project));
    const projects = Object.fromEntries(
      Object.entries(org.projects).filter(([name]) => visibleProjects.has(name)),
    );
    orgs[orgName] = { owner: org.owner, projects, repos };
  }
  return { orgs };
}
