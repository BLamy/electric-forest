import { roleOf, type AuthorizationView, type IdentityGrantView } from "@eforest/identity";
import { isRepoIssuesStreamId } from "@eforest/issues";
import { parsePrStreamId } from "@eforest/pr";
import type { NamespaceView } from "../ns/reducer.js";

/**
 * E2-T07: one total, pure authorization decision for every platform operation
 * that can resolve a stream.
 *
 * The decision joins the E2-T01 identity view (users, orgs, memberships,
 * grants — replayed from `__identity__`) with the E2-T06 namespace view
 * (orgs, projects, repos — replayed from `ns:root` and `ns:org:<name>`), and
 * decides `read`, `follow`, or `dispatch` for a target stream. Electric owns
 * stream transport; this function owns who may ask the platform to use it.
 *
 * Totality: `decide` never throws and consults nothing outside its inputs —
 * no clock, no randomness, no I/O. Every possible input produces either one
 * allowance with a named basis or one typed refusal.
 *
 * Existence neutrality: a refusal carries no target-derived information
 * beyond the refusal code itself, and a private repository the principal
 * cannot read refuses with exactly the decision an entirely nonexistent
 * repository produces (`authz/not-found`, byte-identical decision object).
 */

export type AuthzOperation = "read" | "follow" | "dispatch";

/** What kind of event a dispatch carries; reads and follows have none. */
export type AuthzEventKind = "namespace" | "application";

export type AuthzPrincipal =
  | { readonly kind: "anonymous" }
  | {
      readonly kind: "identified";
      readonly sub: string;
      /**
       * The grant the presented credential resolved to, when the credential
       * is a grant-backed token. Capabilities (scoped read/write) flow ONLY
       * from this presented grant — never from other grants the same subject
       * happens to own. An empty string means "credential resolved to no
       * usable grant" and always refuses as `authz/grant-revoked` (no real
       * grant id is empty, so unknown and revoked credentials are
       * indistinguishable by construction).
       */
      readonly grantId?: string;
    };

export type AuthzTarget =
  | { readonly kind: "malformed"; readonly input: string }
  | { readonly kind: "internal"; readonly streamId: string }
  | { readonly kind: "control"; readonly streamId: string }
  | { readonly kind: "sandbox"; readonly streamId: string }
  | {
      readonly kind: "repo";
      readonly org: string;
      readonly repo: string;
      readonly branch: string;
      /** The physical Durable Streams id this logical target resolves to. */
      readonly streamId: string;
    };

export type AuthzRefusalReason =
  | "authz/malformed-target"
  | "authz/grant-revoked"
  | "authz/unauthenticated"
  | "authz/not-found"
  | "authz/write-grant-required";

export type AuthzBasis =
  | "public"
  | "repo-owner"
  | "org-owner"
  | "membership:admin"
  | "membership:member"
  | "grant:read"
  | "grant:write"
  | "control"
  | "sandbox";

export interface AuthzInput {
  readonly operation: AuthzOperation;
  readonly target: AuthzTarget;
  readonly principal: AuthzPrincipal;
  /** Dispatch only: whether the event is a namespace-admin event. */
  readonly eventKind?: AuthzEventKind;
  /** The replayed E2-T01 identity view the decision consults. */
  readonly identity: AuthorizationView;
  /** The exact identity-view offset the decision is made at ("-1" = empty). */
  readonly identityOffset: string;
  /** The replayed E2-T06 namespace view (may be scoped to the target org). */
  readonly namespace: NamespaceView;
}

export interface AuthzAllowed {
  readonly allowed: true;
  readonly operation: AuthzOperation;
  readonly identityOffset: string;
  readonly basis: AuthzBasis;
  readonly streamId: string;
}

export interface AuthzRefused {
  readonly allowed: false;
  readonly operation: AuthzOperation;
  readonly identityOffset: string;
  readonly refusal: AuthzRefusalReason;
}

export type AuthzDecision = AuthzAllowed | AuthzRefused;

/** Mirrors packages/platform/src/ns/events.ts isNamespaceName (frozen E2-T06 grammar). */
const NAME_PATTERN = /^(?=[a-z0-9-]{1,40}$)[a-z0-9](?:-?[a-z0-9])*$/;
/** Mirrors packages/streamfs/src/branch.ts BRANCH_NAME_PATTERN; "meta"/"file" reserved. */
const BRANCH_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const INTERNAL_PATTERN = /^__[\s\S]*__$/;
const FS_STREAM_PATTERN = /^fs:([^:]*):([^:]*):([\s\S]+)$/;

function ownEntry<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function isAuthzName(value: string): boolean {
  return NAME_PATTERN.test(value);
}

export function isAuthzBranch(value: string): boolean {
  return BRANCH_PATTERN.test(value) && value !== "meta" && value !== "file";
}

export function repoStreamId(org: string, repo: string, branch: string): string {
  return `fs:${org}/${repo}:${branch}:meta`;
}

/**
 * Classify a logical `org/repo/branch` path (already URL-decoded segments)
 * into a repo target. Any grammar violation is `malformed` — decided from the
 * request text alone, before any view is consulted, so the refusal can never
 * leak existence.
 */
export function repoTargetFromPath(
  org: string,
  repo: string,
  branch: string,
): Extract<AuthzTarget, { kind: "repo" | "malformed" }> {
  if (!isAuthzName(org) || !isAuthzName(repo) || !isAuthzBranch(branch)) {
    return { kind: "malformed", input: `${org}/${repo}/${branch}` };
  }
  return { kind: "repo", org, repo, branch, streamId: repoStreamId(org, repo, branch) };
}

/**
 * Classify a dispatch stream id. Namespace-admin events always target the
 * namespace control plane (the E2-T06 dispatcher enforces the exact stream
 * shape and refuses with its frozen taxonomy). Application events resolve:
 * `fs:<org>/<repo>:<branch>:<meta|file:…>` is a repo/branch stream, dunder
 * ids (`__identity__`, …), the gateway-maintained `repo-issues:` catalogs,
 * and every other `ns:`-prefixed id are internal and never exist for
 * applications; anything else is a legacy sandbox stream (the frozen E2-T03
 * dispatch surface).
 */
export function classifyDispatchTarget(streamId: string, eventKind: AuthzEventKind): AuthzTarget {
  if (eventKind === "namespace") return { kind: "control", streamId };
  if (isRepoIssuesStreamId(streamId) || streamId.startsWith("repo-issues:"))
    return { kind: "internal", streamId };
  if (streamId.startsWith("fs:")) {
    const match = FS_STREAM_PATTERN.exec(streamId);
    if (match === null) return { kind: "malformed", input: streamId };
    const [, path, branch, rest] = match as unknown as [string, string, string, string];
    const separator = path.indexOf("/");
    if (separator === -1) return { kind: "malformed", input: streamId };
    const org = path.slice(0, separator);
    const repo = path.slice(separator + 1);
    if (
      !isAuthzName(org) ||
      !isAuthzName(repo) ||
      !isAuthzBranch(branch) ||
      (rest !== "meta" && !rest.startsWith("file:"))
    ) {
      return { kind: "malformed", input: streamId };
    }
    return { kind: "repo", org, repo, branch, streamId };
  }
  if (streamId.startsWith("issue:")) {
    const match = /^issue:([^/]+)\/([^/]+)\/([^/]+)$/.exec(streamId);
    if (match === null) return { kind: "malformed", input: streamId };
    const [, org, repo, issueId] = match as unknown as [string, string, string, string];
    if (!isAuthzName(org) || !isAuthzName(repo) || !/^[A-Za-z0-9._~-]+$/.test(issueId)) {
      return { kind: "malformed", input: streamId };
    }
    return { kind: "repo", org, repo, branch: "main", streamId };
  }
  if (streamId.startsWith("repo-labels:")) {
    const match = /^repo-labels:([^/]+)\/([^/]+)$/.exec(streamId);
    if (match === null) return { kind: "malformed", input: streamId };
    const [, org, repo] = match as unknown as [string, string, string];
    if (!isAuthzName(org) || !isAuthzName(repo)) return { kind: "malformed", input: streamId };
    return { kind: "repo", org, repo, branch: "main", streamId };
  }
  if (streamId.startsWith("pr:")) {
    const identity = parsePrStreamId(streamId);
    if (identity === undefined) return { kind: "malformed", input: streamId };
    return {
      kind: "repo",
      org: identity.org,
      repo: identity.repo,
      branch: "main",
      streamId,
    };
  }
  if (streamId.startsWith("ns:") || INTERNAL_PATTERN.test(streamId)) {
    return { kind: "internal", streamId };
  }
  return { kind: "sandbox", streamId };
}

/** Parse `repo:read:<org>/<repo>` — anything else confers nothing. */
function readScopeMatches(scope: string, org: string, repo: string): boolean {
  return scope === `repo:read:${org}/${repo}`;
}

/** Parse `repo:write:<org>/<repo>:<branch>` — anything else confers nothing. */
function writeScopeMatches(scope: string, org: string, repo: string, branch?: string): boolean {
  const prefix = `repo:write:${org}/${repo}:`;
  if (!scope.startsWith(prefix)) return false;
  const scopeBranch = scope.slice(prefix.length);
  if (!isAuthzBranch(scopeBranch)) return false;
  return branch === undefined || scopeBranch === branch;
}

export function decideStreamAuthorization(input: AuthzInput): AuthzDecision {
  const { operation, target, principal, identity, identityOffset, namespace } = input;
  const refuse = (refusal: AuthzRefusalReason): AuthzRefused => ({
    allowed: false,
    operation,
    identityOffset,
    refusal,
  });
  const allow = (basis: AuthzBasis, streamId: string): AuthzAllowed => ({
    allowed: true,
    operation,
    identityOffset,
    basis,
    streamId,
  });

  // 1. Target grammar — request text alone; leaks nothing about state.
  if (target.kind === "malformed") return refuse("authz/malformed-target");

  // 2. Credential status — presented-grant lookup in the replayed identity
  //    view; uniform across every target, so it can never act as an
  //    existence oracle. An unknown, revoked, or subject-mismatched grant is
  //    one indistinguishable refusal.
  let grant: (IdentityGrantView & { readonly grantId: string }) | undefined;
  if (principal.kind === "identified" && principal.grantId !== undefined) {
    const found = ownEntry(identity.grants, principal.grantId);
    if (found === undefined || found.status !== "active" || found.sub !== principal.sub) {
      return refuse("authz/grant-revoked");
    }
    grant = { grantId: principal.grantId, ...found };
  }

  // 3. Writes require an identity — uniform across every target.
  if (operation === "dispatch" && principal.kind === "anonymous") {
    return refuse("authz/unauthenticated");
  }

  // 4. Non-repo targets.
  if (target.kind === "internal") return refuse("authz/not-found");
  if (target.kind === "control") {
    if (operation === "dispatch" && input.eventKind === "namespace") {
      return allow("control", target.streamId);
    }
    return refuse("authz/not-found");
  }
  if (target.kind === "sandbox") {
    if (operation === "dispatch" && input.eventKind !== "namespace") {
      return allow("sandbox", target.streamId);
    }
    return refuse("authz/not-found");
  }

  // 5. Repo resolution against the replayed namespace view.
  const org = ownEntry(namespace.orgs, target.org);
  const repo = org === undefined ? undefined : ownEntry(org.repos, target.repo);
  if (org === undefined || repo === undefined) return refuse("authz/not-found");

  const sub = principal.kind === "identified" ? principal.sub : undefined;
  const role = sub === undefined ? null : roleOf(identity, target.org, sub);
  const readBasis: AuthzBasis | undefined =
    repo.visibility === "public"
      ? "public"
      : sub === undefined
        ? undefined
        : repo.owner === sub
          ? "repo-owner"
          : org.owner === sub || role === "owner"
            ? "org-owner"
            : role === "admin"
              ? "membership:admin"
              : role === "member"
                ? "membership:member"
                : grant !== undefined &&
                    grant.scopes.some((scope) => readScopeMatches(scope, target.org, target.repo))
                  ? "grant:read"
                  : grant !== undefined &&
                      grant.scopes.some((scope) =>
                        writeScopeMatches(scope, target.org, target.repo),
                      )
                    ? "grant:write"
                    : undefined;

  if (operation !== "dispatch") {
    if (readBasis !== undefined) return allow(readBasis, target.streamId);
    return refuse("authz/not-found");
  }

  // 6. Every write requires a branch-scoped write grant on the PRESENTED
  //    credential — membership and ownership alone never authorize a write.
  if (
    grant !== undefined &&
    grant.scopes.some((scope) => writeScopeMatches(scope, target.org, target.repo, target.branch))
  ) {
    return allow("grant:write", target.streamId);
  }
  if (readBasis !== undefined) return refuse("authz/write-grant-required");
  return refuse("authz/not-found");
}
