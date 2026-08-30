import { stateDigest, type Event } from "@eforest/protocol";

/**
 * Workspace membership beyond what identity already records. Identity owns the truth of
 * who is a member (`identity.membership.granted`, consulted by authorization); this
 * org-scoped stream (`members:<org>`) owns the *invitations* that lead there: who was
 * invited, by whom, with which role, and whether the invite was accepted. Acceptance is
 * a platform door that verifies the signed-in email against the invite before granting
 * the identity membership and appending the acceptance here.
 */
export const MEMBERS_EVENT_VERSION = 1 as const;
export const MEMBERS_REDUCER = "org-members" as const;

const ORG_PATTERN = "[a-z0-9](?:-?[a-z0-9])*";
const MEMBERS_RE = new RegExp(`^members:(${ORG_PATTERN})$`);
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type MemberRole = "admin" | "member";
export type MembersActionType = "member.invite" | "member.invite.accepted" | "member.invite.revoke";

export function isMembersActionType(type: string): type is MembersActionType {
  return (
    type === "member.invite" || type === "member.invite.accepted" || type === "member.invite.revoke"
  );
}

export function membersStreamId(org: string): string {
  return `members:${org}`;
}

export function isMembersStreamId(streamId: string): boolean {
  return MEMBERS_RE.test(streamId);
}

export function parseMembersStreamId(streamId: string): string | undefined {
  return MEMBERS_RE.exec(streamId)?.[1];
}

export interface MemberInvite {
  readonly token: string;
  readonly email: string;
  readonly role: MemberRole;
  readonly invitedBy: string;
  readonly invitedAt: number;
  readonly status: "pending" | "accepted" | "revoked";
  /** The subject that accepted, once identity granted the membership. */
  readonly sub: string | null;
  readonly resolvedAt: number | null;
}

export interface MembersState {
  readonly invites: Readonly<Record<string, MemberInvite>>;
}

export const membersInitialState: MembersState = Object.freeze({ invites: Object.freeze({}) });

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Client-authored payload shape (before the gateway stamps `actor`). */
export function isMembersDispatchPayload(type: string, payload: unknown): boolean {
  if (type === "member.invite") {
    return (
      exactObject(payload, ["v", "email", "role", "token"]) &&
      payload.v === MEMBERS_EVENT_VERSION &&
      typeof payload.email === "string" &&
      EMAIL_RE.test(payload.email) &&
      payload.email === normalizeEmail(payload.email) &&
      payload.email.length <= 254 &&
      (payload.role === "admin" || payload.role === "member") &&
      typeof payload.token === "string" &&
      TOKEN_RE.test(payload.token)
    );
  }
  if (type === "member.invite.accepted") {
    return (
      exactObject(payload, ["v", "token", "sub"]) &&
      payload.v === MEMBERS_EVENT_VERSION &&
      typeof payload.token === "string" &&
      TOKEN_RE.test(payload.token) &&
      typeof payload.sub === "string" &&
      payload.sub.length > 0
    );
  }
  if (type === "member.invite.revoke") {
    return (
      exactObject(payload, ["v", "token"]) &&
      payload.v === MEMBERS_EVENT_VERSION &&
      typeof payload.token === "string" &&
      TOKEN_RE.test(payload.token)
    );
  }
  return false;
}

export function isMembersEvent(event: Event): boolean {
  if (!isMembersActionType(event.type)) return false;
  if (event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return false;
  }
  const { actor, ...rest } = Object.fromEntries(
    Object.entries(event.payload as Record<string, unknown>).filter(([key]) => key !== "writer"),
  );
  return (
    typeof actor === "string" && actor.length > 0 && isMembersDispatchPayload(event.type, rest)
  );
}

export function membersReducer(state: MembersState, event: Event): MembersState {
  if (!isMembersEvent(event)) return state;
  const payload = event.payload as Record<string, unknown> & { actor: string; token: string };
  const existing = state.invites[payload.token];
  if (event.type === "member.invite") {
    if (existing !== undefined) return state;
    return {
      invites: {
        ...state.invites,
        [payload.token]: {
          token: payload.token,
          email: payload.email as string,
          role: payload.role as MemberRole,
          invitedBy: payload.actor,
          invitedAt: event.ts,
          status: "pending",
          sub: null,
          resolvedAt: null,
        },
      },
    };
  }
  if (existing === undefined || existing.status !== "pending") return state;
  const resolved: MemberInvite =
    event.type === "member.invite.accepted"
      ? { ...existing, status: "accepted", sub: payload.sub as string, resolvedAt: event.ts }
      : { ...existing, status: "revoked", resolvedAt: event.ts };
  return { invites: { ...state.invites, [payload.token]: resolved } };
}

export const membersReducerDefinition = Object.freeze({
  id: MEMBERS_REDUCER,
  version: MEMBERS_EVENT_VERSION,
  initialState: membersInitialState,
  reduce: membersReducer as (state: unknown, event: Event) => unknown,
  digest: stateDigest,
  matchesStream: isMembersStreamId,
});
