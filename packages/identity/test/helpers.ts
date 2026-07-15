import type { Event } from "@eforest/protocol";
import type { AuthorizationView, GrantKind, MembershipRole } from "../src/index.js";

export function identityEvent(type: string, payload: unknown, ts = 0): Event {
  return { type, payload, ts };
}

export function user(sub: string, email = `${sub.replaceAll("|", "-")}@example.com`): Event {
  return identityEvent("identity.user.created", { email, sub, v: 1 });
}

export function org(orgId: string, ownerSub: string, name = orgId): Event {
  return identityEvent("identity.org.created", { name, orgId, ownerSub, v: 1 });
}

export function membership(orgId: string, sub: string, role: "admin" | "member" = "member"): Event {
  return identityEvent("identity.membership.granted", { orgId, role, sub, v: 1 });
}

export function membershipRevoke(orgId: string, sub: string): Event {
  return identityEvent("identity.membership.revoked", { orgId, sub, v: 1 });
}

export function grant(
  grantId: string,
  sub: string,
  tokenHash: string,
  kind: GrantKind = "cli-token",
  scopes: readonly string[] = ["repo:read"],
): Event {
  return identityEvent("identity.grant.issued", {
    grantId,
    kind,
    scopes,
    sub,
    tokenHash,
    v: 1,
  });
}

export function grantRevoke(grantId: string): Event {
  return identityEvent("identity.grant.revoked", { grantId, v: 1 });
}

export function session(sessionId: string, sub: string): Event {
  return identityEvent("identity.session.started", { sessionId, sub, v: 1 });
}

export function sessionEnd(sessionId: string): Event {
  return identityEvent("identity.session.ended", { sessionId, v: 1 });
}

interface MutableView {
  users: Record<string, { email: string }>;
  orgs: Record<string, { name: string; ownerSub: string }>;
  memberships: Record<
    string,
    Record<string, { role: MembershipRole; status: "active" | "revoked" }>
  >;
  grants: Record<
    string,
    {
      sub: string;
      kind: GrantKind;
      scopes: string[];
      tokenHash: string;
      status: "active" | "revoked";
    }
  >;
  sessions: Record<string, { sub: string; status: "active" | "ended" }>;
}

/** Independent documented-semantics fold used only by tests, never by production. */
export function oracleFold(events: readonly Event[]): AuthorizationView {
  const view: MutableView = { users: {}, orgs: {}, memberships: {}, grants: {}, sessions: {} };
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    switch (event.type) {
      case "identity.user.created":
        view.users[payload.sub as string] = { email: payload.email as string };
        break;
      case "identity.org.created": {
        const orgId = payload.orgId as string;
        const ownerSub = payload.ownerSub as string;
        view.orgs[orgId] = { name: payload.name as string, ownerSub };
        view.memberships[orgId] = { [ownerSub]: { role: "owner", status: "active" } };
        break;
      }
      case "identity.membership.granted": {
        const orgId = payload.orgId as string;
        view.memberships[orgId] ??= {};
        view.memberships[orgId]![payload.sub as string] = {
          role: payload.role as MembershipRole,
          status: "active",
        };
        break;
      }
      case "identity.membership.revoked": {
        const current = view.memberships[payload.orgId as string]![payload.sub as string]!;
        current.status = "revoked";
        break;
      }
      case "identity.grant.issued":
        view.grants[payload.grantId as string] = {
          sub: payload.sub as string,
          kind: payload.kind as GrantKind,
          scopes: [...(payload.scopes as string[])],
          tokenHash: payload.tokenHash as string,
          status: "active",
        };
        break;
      case "identity.grant.revoked":
        view.grants[payload.grantId as string]!.status = "revoked";
        break;
      case "identity.session.started":
        view.sessions[payload.sessionId as string] = {
          sub: payload.sub as string,
          status: "active",
        };
        break;
      case "identity.session.ended":
        view.sessions[payload.sessionId as string]!.status = "ended";
        break;
    }
  }
  return view;
}

export function xorshift(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}
