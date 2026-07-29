import type { Event } from "@eforest/protocol";
import { assertIdentityEvent } from "./events.js";
import { ownEntry } from "./records.js";
import { emptyView, type AuthorizationView } from "./view.js";

export class IdentityReducerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "IdentityReducerError";
    this.code = code;
  }
}

function reject(code: string, message: string): never {
  throw new IdentityReducerError(code, message);
}

export const identityInitialState: AuthorizationView = emptyView();

export function identityReducer(state: AuthorizationView, event: Event): AuthorizationView {
  assertIdentityEvent(event);
  switch (event.type) {
    case "identity.user.created": {
      if (ownEntry(state.users, event.payload.sub) !== undefined) {
        reject("identity/duplicate-user", `user ${event.payload.sub} already exists`);
      }
      return {
        ...state,
        users: { ...state.users, [event.payload.sub]: { email: event.payload.email } },
      };
    }
    case "identity.org.created": {
      if (ownEntry(state.orgs, event.payload.orgId) !== undefined) {
        reject("identity/duplicate-org", `org ${event.payload.orgId} already exists`);
      }
      if (ownEntry(state.users, event.payload.ownerSub) === undefined) {
        reject("identity/unknown-owner", `owner ${event.payload.ownerSub} does not exist`);
      }
      return {
        ...state,
        orgs: {
          ...state.orgs,
          [event.payload.orgId]: { name: event.payload.name, ownerSub: event.payload.ownerSub },
        },
        memberships: {
          ...state.memberships,
          [event.payload.orgId]: {
            [event.payload.ownerSub]: { role: "owner", status: "active" },
          },
        },
      };
    }
    case "identity.membership.granted": {
      if (ownEntry(state.orgs, event.payload.orgId) === undefined) {
        reject("identity/unknown-org", `org ${event.payload.orgId} does not exist`);
      }
      if (ownEntry(state.users, event.payload.sub) === undefined) {
        reject("identity/unknown-user", `user ${event.payload.sub} does not exist`);
      }
      const orgMemberships = ownEntry(state.memberships, event.payload.orgId);
      const existing = orgMemberships && ownEntry(orgMemberships, event.payload.sub);
      if (existing?.status === "active") {
        reject(
          "identity/membership-active",
          `membership ${event.payload.orgId}/${event.payload.sub} is already active`,
        );
      }
      return {
        ...state,
        memberships: {
          ...state.memberships,
          [event.payload.orgId]: {
            ...orgMemberships,
            [event.payload.sub]: { role: event.payload.role, status: "active" },
          },
        },
      };
    }
    case "identity.membership.revoked": {
      const org = ownEntry(state.orgs, event.payload.orgId);
      if (org === undefined)
        reject("identity/unknown-org", `org ${event.payload.orgId} does not exist`);
      if (org.ownerSub === event.payload.sub) {
        reject(
          "identity/owner-revoke",
          `owner membership ${event.payload.orgId}/${event.payload.sub} is permanent`,
        );
      }
      const orgMemberships = ownEntry(state.memberships, event.payload.orgId);
      const existing = orgMemberships && ownEntry(orgMemberships, event.payload.sub);
      if (existing?.status !== "active") {
        reject(
          "identity/membership-inactive",
          `membership ${event.payload.orgId}/${event.payload.sub} is not active`,
        );
      }
      return {
        ...state,
        memberships: {
          ...state.memberships,
          [event.payload.orgId]: {
            ...orgMemberships,
            [event.payload.sub]: { ...existing, status: "revoked" },
          },
        },
      };
    }
    case "identity.grant.issued": {
      if (ownEntry(state.users, event.payload.sub) === undefined) {
        reject("identity/unknown-user", `user ${event.payload.sub} does not exist`);
      }
      if (ownEntry(state.grants, event.payload.grantId) !== undefined) {
        reject("identity/duplicate-grant", `grant ${event.payload.grantId} already exists`);
      }
      if (
        Object.values(state.grants).some(
          (grant) => grant.status === "active" && grant.tokenHash === event.payload.tokenHash,
        )
      ) {
        reject("identity/active-token-hash", "tokenHash already belongs to an active grant");
      }
      return {
        ...state,
        grants: {
          ...state.grants,
          [event.payload.grantId]: {
            sub: event.payload.sub,
            kind: event.payload.kind,
            scopes: [...event.payload.scopes],
            tokenHash: event.payload.tokenHash,
            status: "active",
          },
        },
      };
    }
    case "identity.grant.revoked": {
      const existing = ownEntry(state.grants, event.payload.grantId);
      if (existing === undefined) {
        reject("identity/unknown-grant", `grant ${event.payload.grantId} does not exist`);
      }
      if (existing.status !== "active") {
        reject("identity/grant-revoked", `grant ${event.payload.grantId} is already revoked`);
      }
      return {
        ...state,
        grants: {
          ...state.grants,
          [event.payload.grantId]: { ...existing, status: "revoked" },
        },
      };
    }
    case "identity.session.started": {
      if (ownEntry(state.users, event.payload.sub) === undefined) {
        reject("identity/unknown-user", `user ${event.payload.sub} does not exist`);
      }
      if (ownEntry(state.sessions, event.payload.sessionId) !== undefined) {
        reject("identity/duplicate-session", `session ${event.payload.sessionId} already exists`);
      }
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [event.payload.sessionId]: { sub: event.payload.sub, status: "active" },
        },
      };
    }
    case "identity.session.ended": {
      const existing = ownEntry(state.sessions, event.payload.sessionId);
      if (existing === undefined) {
        reject("identity/unknown-session", `session ${event.payload.sessionId} does not exist`);
      }
      if (existing.status !== "active") {
        reject("identity/session-ended", `session ${event.payload.sessionId} is already ended`);
      }
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [event.payload.sessionId]: { ...existing, status: "ended" },
        },
      };
    }
  }
}
