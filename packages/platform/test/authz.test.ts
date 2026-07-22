import { emptyView, identityReducer, type AuthorizationView } from "@eforest/identity";
import type { Event } from "@eforest/protocol";
import { describe, expect, it } from "vitest";
import {
  classifyDispatchTarget,
  composeNamespaceView,
  decideStreamAuthorization,
  repoStreamId,
  repoTargetFromPath,
  type AuthzDecision,
  type AuthzInput,
  type AuthzOperation,
  type AuthzPrincipal,
  type AuthzTarget,
  type NamespaceView,
} from "../src/index.js";

const OWNER = "auth0|owner";
const ADMIN = "auth0|admin";
const MEMBER = "auth0|member";
const OUTSIDER = "auth0|outsider";
const READ_GRANTEE = "auth0|read-grantee";
const WRITE_GRANTEE = "auth0|write-grantee";
const REVOKED_GRANTEE = "auth0|revoked-grantee";

function identityEvents(): Event[] {
  const user = (sub: string): Event => ({
    type: "identity.user.created",
    payload: { v: 1, sub, email: `${sub.replace(/[^a-z0-9]/gi, "-")}@example.test` },
    ts: 1,
  });
  let hashOrdinal = 0;
  const grant = (grantId: string, sub: string, scopes: readonly string[]): Event => {
    hashOrdinal += 1;
    return {
      type: "identity.grant.issued",
      payload: {
        v: 1,
        grantId,
        sub,
        kind: "cli-token",
        scopes: [...scopes].sort(),
        tokenHash: String(hashOrdinal).padStart(64, "0"),
      },
      ts: 1,
    };
  };
  return [
    user(OWNER),
    user(ADMIN),
    user(MEMBER),
    user(OUTSIDER),
    user(READ_GRANTEE),
    user(WRITE_GRANTEE),
    user(REVOKED_GRANTEE),
    {
      type: "identity.org.created",
      payload: { v: 1, orgId: "acme", name: "acme", ownerSub: OWNER },
      ts: 1,
    },
    {
      type: "identity.membership.granted",
      payload: { v: 1, orgId: "acme", sub: ADMIN, role: "admin" },
      ts: 1,
    },
    {
      type: "identity.membership.granted",
      payload: { v: 1, orgId: "acme", sub: MEMBER, role: "member" },
      ts: 1,
    },
    grant("grant-owner-write", OWNER, [
      "repo:write:acme/forest:main",
      "repo:write:acme/secret:main",
    ]),
    grant("grant-read", READ_GRANTEE, ["repo:read:acme/secret"]),
    grant("grant-write", WRITE_GRANTEE, ["repo:write:acme/secret:main"]),
    grant("grant-write-other-branch", WRITE_GRANTEE, ["repo:write:acme/secret:feature"]),
    grant("grant-bare", OUTSIDER, ["repo:write"]),
    grant("grant-revoked", REVOKED_GRANTEE, [
      "repo:read:acme/secret",
      "repo:write:acme/secret:main",
    ]),
    { type: "identity.grant.revoked", payload: { v: 1, grantId: "grant-revoked" }, ts: 2 },
    grant("grant-cross", REVOKED_GRANTEE, []),
  ];
}

function identityView(): AuthorizationView {
  return identityEvents().reduce(identityReducer, emptyView());
}

function namespaceView(): NamespaceView {
  const actor = (sub: string): { readonly sub: string } => ({ sub });
  return composeNamespaceView(
    [{ type: "ns.org.create", payload: { v: 1, name: "acme", actor: actor(OWNER) }, ts: 1 }],
    {
      "ns:org:acme": [
        { type: "ns.project.create", payload: { v: 1, name: "trees", actor: actor(OWNER) }, ts: 1 },
        {
          type: "ns.repo.create",
          payload: {
            v: 1,
            name: "forest",
            project: "trees",
            visibility: "public",
            actor: actor(OWNER),
          },
          ts: 1,
        },
        {
          type: "ns.repo.create",
          payload: {
            v: 1,
            name: "secret",
            project: "trees",
            visibility: "private",
            actor: actor(OWNER),
          },
          ts: 1,
        },
      ],
    },
  );
}

const IDENTITY = identityView();
const NAMESPACE = namespaceView();
const OFFSET = "0000000000000000_0000000000000017";

function decide(
  operation: AuthzOperation,
  target: AuthzTarget,
  principal: AuthzPrincipal,
  overrides: Partial<AuthzInput> = {},
): AuthzDecision {
  return decideStreamAuthorization({
    operation,
    target,
    principal,
    ...(operation === "dispatch" ? { eventKind: "application" as const } : {}),
    identity: IDENTITY,
    identityOffset: OFFSET,
    namespace: NAMESPACE,
    ...overrides,
  });
}

const publicRepo = repoTargetFromPath("acme", "forest", "main");
const privateRepo = repoTargetFromPath("acme", "secret", "main");
const missingRepo = repoTargetFromPath("acme", "ghost", "main");
const missingOrg = repoTargetFromPath("nowhere", "ghost", "main");

const anonymous: AuthzPrincipal = { kind: "anonymous" };
const owner: AuthzPrincipal = { kind: "identified", sub: OWNER, grantId: "grant-owner-write" };
const admin: AuthzPrincipal = { kind: "identified", sub: ADMIN };
const member: AuthzPrincipal = { kind: "identified", sub: MEMBER };
const outsider: AuthzPrincipal = { kind: "identified", sub: OUTSIDER };
const readGrantee: AuthzPrincipal = {
  kind: "identified",
  sub: READ_GRANTEE,
  grantId: "grant-read",
};
const writeGrantee: AuthzPrincipal = {
  kind: "identified",
  sub: WRITE_GRANTEE,
  grantId: "grant-write",
};
const otherBranchGrantee: AuthzPrincipal = {
  kind: "identified",
  sub: WRITE_GRANTEE,
  grantId: "grant-write-other-branch",
};
const bareGrantee: AuthzPrincipal = { kind: "identified", sub: OUTSIDER, grantId: "grant-bare" };
const revokedGrantee: AuthzPrincipal = {
  kind: "identified",
  sub: REVOKED_GRANTEE,
  grantId: "grant-revoked",
};
const crossGrantee: AuthzPrincipal = {
  kind: "identified",
  sub: REVOKED_GRANTEE,
  grantId: "grant-cross",
};

function allowed(decision: AuthzDecision, basis: string, streamId: string): void {
  expect(decision).toEqual({
    allowed: true,
    operation: decision.operation,
    identityOffset: OFFSET,
    basis,
    streamId,
  });
}

function refused(decision: AuthzDecision, refusal: string): void {
  expect(decision).toEqual({
    allowed: false,
    operation: decision.operation,
    identityOffset: OFFSET,
    refusal,
  });
}

describe("decideStreamAuthorization: the pure per-repository matrix", () => {
  const reads: AuthzOperation[] = ["read", "follow"];

  it("permits anonymous reads and follows of public repositories only", () => {
    for (const operation of reads) {
      allowed(
        decide(operation, publicRepo, anonymous),
        "public",
        repoStreamId("acme", "forest", "main"),
      );
      refused(decide(operation, privateRepo, anonymous), "authz/not-found");
      refused(decide(operation, missingRepo, anonymous), "authz/not-found");
      refused(decide(operation, missingOrg, anonymous), "authz/not-found");
    }
  });

  it("grants private reads to owner, admin, member, read-grant, and write-grant", () => {
    for (const operation of reads) {
      allowed(
        decide(operation, privateRepo, owner),
        "repo-owner",
        repoStreamId("acme", "secret", "main"),
      );
      allowed(
        decide(operation, privateRepo, admin),
        "membership:admin",
        repoStreamId("acme", "secret", "main"),
      );
      allowed(
        decide(operation, privateRepo, member),
        "membership:member",
        repoStreamId("acme", "secret", "main"),
      );
      allowed(
        decide(operation, privateRepo, readGrantee),
        "grant:read",
        repoStreamId("acme", "secret", "main"),
      );
      allowed(
        decide(operation, privateRepo, writeGrantee),
        "grant:write",
        repoStreamId("acme", "secret", "main"),
      );
    }
  });

  it("refuses private reads to non-members and bare-scope grants as not-found", () => {
    for (const operation of reads) {
      refused(decide(operation, privateRepo, outsider), "authz/not-found");
      refused(decide(operation, privateRepo, bareGrantee), "authz/not-found");
    }
  });

  it("requires a branch-scoped write grant for every dispatch", () => {
    allowed(
      decide("dispatch", privateRepo, writeGrantee),
      "grant:write",
      repoStreamId("acme", "secret", "main"),
    );
    allowed(
      decide("dispatch", publicRepo, owner),
      "grant:write",
      repoStreamId("acme", "forest", "main"),
    );
    // Roles alone never authorize a write; the caller can see the repo, so
    // the refusal names the missing capability.
    refused(decide("dispatch", privateRepo, admin), "authz/write-grant-required");
    refused(decide("dispatch", privateRepo, member), "authz/write-grant-required");
    refused(decide("dispatch", privateRepo, readGrantee), "authz/write-grant-required");
    refused(decide("dispatch", publicRepo, outsider), "authz/write-grant-required");
    refused(decide("dispatch", publicRepo, bareGrantee), "authz/write-grant-required");
    // A write grant for another branch reads, but does not write this branch.
    refused(decide("dispatch", privateRepo, otherBranchGrantee), "authz/write-grant-required");
    // Invisible target: refusal is exactly the nonexistent decision.
    refused(decide("dispatch", privateRepo, outsider), "authz/not-found");
    refused(decide("dispatch", missingRepo, outsider), "authz/not-found");
    refused(decide("dispatch", missingOrg, writeGrantee), "authz/not-found");
    refused(decide("dispatch", publicRepo, anonymous), "authz/unauthenticated");
    refused(decide("dispatch", privateRepo, anonymous), "authz/unauthenticated");
    refused(decide("dispatch", missingRepo, anonymous), "authz/unauthenticated");
  });

  it("refuses a revoked grant identically for every operation and target", () => {
    const targets = [publicRepo, privateRepo, missingRepo, missingOrg];
    for (const operation of ["read", "follow", "dispatch"] as const) {
      const decisions = targets.map((target) => decide(operation, target, revokedGrantee));
      for (const decision of decisions) {
        refused(decision, "authz/grant-revoked");
        expect(decision).toEqual(decisions[0]);
      }
      // Unknown and subject-mismatched grants are the same refusal.
      refused(
        decide(operation, publicRepo, { kind: "identified", sub: OUTSIDER, grantId: "" }),
        "authz/grant-revoked",
      );
      refused(
        decide(operation, publicRepo, { kind: "identified", sub: OUTSIDER, grantId: "grant-read" }),
        "authz/grant-revoked",
      );
    }
  });

  it("never leaks capabilities across grants of the same subject", () => {
    // REVOKED_GRANTEE owns grant-cross (active, no scopes) while grant-revoked
    // carried read+write scopes: presenting grant-cross confers nothing.
    for (const operation of ["read", "follow", "dispatch"] as const) {
      refused(
        decide(operation, privateRepo, crossGrantee),
        operation === "dispatch" ? "authz/not-found" : "authz/not-found",
      );
    }
  });

  it("decides private-unauthorized and nonexistent identically, byte for byte", () => {
    const principals: readonly AuthzPrincipal[] = [anonymous, outsider, bareGrantee, crossGrantee];
    for (const operation of ["read", "follow", "dispatch"] as const) {
      for (const principal of principals) {
        const privateDecision = decide(operation, privateRepo, principal);
        for (const ghost of [missingRepo, missingOrg]) {
          expect(decide(operation, ghost, principal)).toEqual(privateDecision);
        }
      }
    }
  });

  it("refuses malformed targets from the request text alone", () => {
    const malformed = [
      repoTargetFromPath("acme/evil", "x", "main"),
      repoTargetFromPath("acme", "forest%2Fmain", "main"),
      repoTargetFromPath("ACME", "forest", "main"),
      repoTargetFromPath("", "forest", "main"),
      repoTargetFromPath("acme", "forest", "Main"),
      repoTargetFromPath("acme", "forest", "meta"),
      repoTargetFromPath("acme", "forest", "file"),
      repoTargetFromPath("-acme", "forest", "main"),
      repoTargetFromPath("a".repeat(41), "forest", "main"),
    ];
    for (const target of malformed) {
      expect(target.kind).toBe("malformed");
      for (const operation of ["read", "follow", "dispatch"] as const) {
        refused(decide(operation, target, owner), "authz/malformed-target");
      }
    }
  });

  it("classifies dispatch stream ids into repo, control, internal, and sandbox", () => {
    expect(classifyDispatchTarget("fs:acme/forest:main:meta", "application")).toEqual({
      kind: "repo",
      org: "acme",
      repo: "forest",
      branch: "main",
      streamId: "fs:acme/forest:main:meta",
    });
    expect(
      classifyDispatchTarget("fs:acme/forest:main:file:src/index.ts", "application").kind,
    ).toBe("repo");
    for (const malformed of [
      "fs:acme:main:meta",
      "fs:acme/forest:main",
      "fs:acme/forest:main:journal",
      "fs:acme/forest/extra:main:meta",
      "fs:acme/forest:me ta:meta",
      "fs:acme/forest:meta:meta",
      "fs:ACME/forest:main:meta",
      "fs:",
      "fs::x:meta",
    ]) {
      expect(classifyDispatchTarget(malformed, "application").kind, malformed).toBe("malformed");
    }
    for (const internal of ["ns:root", "ns:org:acme", "ns:anything", "__identity__", "__x__"]) {
      expect(classifyDispatchTarget(internal, "application").kind, internal).toBe("internal");
    }
    for (const sandbox of ["target", "e2-t03-gateway", "cli-target", "ns", "fsx"]) {
      expect(classifyDispatchTarget(sandbox, "application").kind, sandbox).toBe("sandbox");
    }
    // Namespace-admin events always route to the control plane, where the
    // E2-T06 dispatcher enforces the exact stream shape.
    expect(classifyDispatchTarget("ns:root", "namespace")).toEqual({
      kind: "control",
      streamId: "ns:root",
    });
  });

  it("refuses internal streams as nonexistent and gates control/sandbox dispatches", () => {
    const internal = classifyDispatchTarget("__identity__", "application");
    const nsInternal = classifyDispatchTarget("ns:root", "application");
    const control = classifyDispatchTarget("ns:root", "namespace");
    const sandbox = classifyDispatchTarget("e2-t03-gateway", "application");
    for (const operation of ["read", "follow", "dispatch"] as const) {
      refused(decide(operation, internal, owner), "authz/not-found");
      refused(decide(operation, nsInternal, owner), "authz/not-found");
    }
    allowed(
      decideStreamAuthorization({
        operation: "dispatch",
        target: control,
        principal: owner,
        eventKind: "namespace",
        identity: IDENTITY,
        identityOffset: OFFSET,
        namespace: NAMESPACE,
      }),
      "control",
      "ns:root",
    );
    refused(decide("read", control, owner), "authz/not-found");
    allowed(decide("dispatch", sandbox, outsider), "sandbox", "e2-t03-gateway");
    refused(decide("read", sandbox, owner), "authz/not-found");
    refused(
      decideStreamAuthorization({
        operation: "dispatch",
        target: control,
        principal: anonymous,
        eventKind: "namespace",
        identity: IDENTITY,
        identityOffset: OFFSET,
        namespace: NAMESPACE,
      }),
      "authz/unauthenticated",
    );
  });

  it("is total: adversarial inputs decide without throwing", () => {
    const strings = [
      "",
      " ",
      "__proto__",
      "constructor",
      "a".repeat(4096),
      "fs:__proto__/x:main:meta",
      "acme/forest/main",
      "%2F%2F",
      " ",
      "ns:org:__proto__",
    ];
    const principals: AuthzPrincipal[] = [
      anonymous,
      { kind: "identified", sub: "__proto__", grantId: "__proto__" },
      { kind: "identified", sub: "", grantId: "" },
    ];
    for (const value of strings) {
      for (const operation of ["read", "follow", "dispatch"] as const) {
        for (const principal of principals) {
          const targets = [
            classifyDispatchTarget(value, "application"),
            repoTargetFromPath(value, value, value),
          ];
          for (const target of targets) {
            const decision = decide(operation, target, principal);
            expect(typeof decision.allowed).toBe("boolean");
            if (!decision.allowed) {
              expect(decision.refusal.startsWith("authz/")).toBe(true);
            }
          }
        }
      }
    }
  });

  it("keeps every decision inside the provided views (no ambient state)", () => {
    // The same input against an empty identity view flips grant-backed
    // decisions to refusals — the decision reads the replayed views, not
    // any module state.
    refused(
      decide("dispatch", privateRepo, writeGrantee, { identity: emptyView() }),
      "authz/grant-revoked",
    );
    refused(decide("read", privateRepo, member, { identity: emptyView() }), "authz/not-found");
    refused(decide("read", publicRepo, anonymous, { namespace: { orgs: {} } }), "authz/not-found");
  });
});
