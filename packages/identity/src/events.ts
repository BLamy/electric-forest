import { isEvent, type Event } from "@eforest/protocol";
import { ownEntry } from "./records.js";
import { CLI_GRANT_EVENT_VERSION, IDENTITY_EVENT_VERSION } from "./version.js";

export type MembershipGrantRole = "admin" | "member";
export type GrantKind = "cli-token" | "web-session-mint";
export type CliTokenKind = "device" | "web-mint";

export interface IdentityUserCreatedPayload {
  readonly v: typeof IDENTITY_EVENT_VERSION;
  readonly sub: string;
  readonly email: string;
}

export interface IdentityOrgCreatedPayload {
  readonly v: typeof IDENTITY_EVENT_VERSION;
  readonly orgId: string;
  readonly name: string;
  readonly ownerSub: string;
}

export interface IdentityMembershipGrantedPayload {
  readonly v: typeof IDENTITY_EVENT_VERSION;
  readonly orgId: string;
  readonly sub: string;
  readonly role: MembershipGrantRole;
}

export interface IdentityMembershipRevokedPayload {
  readonly v: typeof IDENTITY_EVENT_VERSION;
  readonly orgId: string;
  readonly sub: string;
}

export interface IdentityGrantIssuedPayload {
  readonly v: typeof IDENTITY_EVENT_VERSION | typeof CLI_GRANT_EVENT_VERSION;
  readonly grantId: string;
  readonly sub: string;
  readonly kind: GrantKind;
  readonly scopes: readonly string[];
  readonly tokenHash: string;
  /** E2-T05 metadata. Absent only on legacy E2-T01 grant fixtures. */
  readonly tokenKind?: CliTokenKind;
  readonly name?: string;
  readonly issuedAt?: number;
}

export interface IdentityGrantRevokedPayload {
  readonly v: typeof IDENTITY_EVENT_VERSION | typeof CLI_GRANT_EVENT_VERSION;
  readonly grantId: string;
  /** E2-T05 metadata. Absent only on legacy E2-T01 grant fixtures. */
  readonly revokedAt?: number;
}

export interface IdentityGrantOperationStartedPayload {
  readonly v: typeof CLI_GRANT_EVENT_VERSION;
  readonly operationId: string;
  readonly grantId: string;
  readonly startedAt: number;
}

export interface IdentityGrantOperationCompletedPayload {
  readonly v: typeof CLI_GRANT_EVENT_VERSION;
  readonly operationId: string;
  readonly completedAt: number;
}

export interface IdentitySessionStartedPayload {
  readonly v: typeof IDENTITY_EVENT_VERSION;
  readonly sessionId: string;
  readonly sub: string;
}

export interface IdentitySessionEndedPayload {
  readonly v: typeof IDENTITY_EVENT_VERSION;
  readonly sessionId: string;
}

export interface IdentityUserCreatedEvent extends Event {
  readonly type: "identity.user.created";
  readonly payload: IdentityUserCreatedPayload;
}

export interface IdentityOrgCreatedEvent extends Event {
  readonly type: "identity.org.created";
  readonly payload: IdentityOrgCreatedPayload;
}

export interface IdentityMembershipGrantedEvent extends Event {
  readonly type: "identity.membership.granted";
  readonly payload: IdentityMembershipGrantedPayload;
}

export interface IdentityMembershipRevokedEvent extends Event {
  readonly type: "identity.membership.revoked";
  readonly payload: IdentityMembershipRevokedPayload;
}

export interface IdentityGrantIssuedEvent extends Event {
  readonly type: "identity.grant.issued";
  readonly payload: IdentityGrantIssuedPayload;
}

export interface IdentityGrantRevokedEvent extends Event {
  readonly type: "identity.grant.revoked";
  readonly payload: IdentityGrantRevokedPayload;
}

export interface IdentityGrantOperationStartedEvent extends Event {
  readonly type: "identity.grant.operation.started";
  readonly payload: IdentityGrantOperationStartedPayload;
}

export interface IdentityGrantOperationCompletedEvent extends Event {
  readonly type: "identity.grant.operation.completed";
  readonly payload: IdentityGrantOperationCompletedPayload;
}

export interface IdentitySessionStartedEvent extends Event {
  readonly type: "identity.session.started";
  readonly payload: IdentitySessionStartedPayload;
}

export interface IdentitySessionEndedEvent extends Event {
  readonly type: "identity.session.ended";
  readonly payload: IdentitySessionEndedPayload;
}

export type IdentityEvent =
  | IdentityUserCreatedEvent
  | IdentityOrgCreatedEvent
  | IdentityMembershipGrantedEvent
  | IdentityMembershipRevokedEvent
  | IdentityGrantIssuedEvent
  | IdentityGrantRevokedEvent
  | IdentityGrantOperationStartedEvent
  | IdentityGrantOperationCompletedEvent
  | IdentitySessionStartedEvent
  | IdentitySessionEndedEvent;

export type IdentityEventType = IdentityEvent["type"];

export class IdentityEventValidationError extends Error {
  readonly code: "identity/invalid-envelope" | "identity/invalid-payload" | "identity/unknown-type";

  constructor(code: IdentityEventValidationError["code"], message: string) {
    super(`${code}: ${message}`);
    this.name = "IdentityEventValidationError";
    this.code = code;
  }
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol")) return false;
  const actual = (ownKeys as string[]).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.normalize("NFC") === value &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f);
    })
  );
}

function opaqueId(value: unknown): value is string {
  return canonicalText(value, 256);
}

function validSub(value: unknown): value is string {
  return canonicalText(value, 256);
}

function validOrgId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

function validScopes(value: unknown): value is readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (scope) =>
        canonicalText(scope, 256) &&
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(scope),
    )
  ) {
    return false;
  }
  return value.every((scope, index) => index === 0 || value[index - 1]! < scope);
}

function eventWithPayload(value: unknown, type: string): value is Event {
  return isEvent(value) && value.type === type;
}

export function isIdentityUserCreatedEvent(value: unknown): value is IdentityUserCreatedEvent {
  if (!eventWithPayload(value, "identity.user.created")) return false;
  const payload = value.payload;
  return (
    exactObject(payload, ["v", "sub", "email"]) &&
    payload.v === IDENTITY_EVENT_VERSION &&
    validSub(payload.sub) &&
    canonicalText(payload.email, 320)
  );
}

export function isIdentityOrgCreatedEvent(value: unknown): value is IdentityOrgCreatedEvent {
  if (!eventWithPayload(value, "identity.org.created")) return false;
  const payload = value.payload;
  return (
    exactObject(payload, ["v", "orgId", "name", "ownerSub"]) &&
    payload.v === IDENTITY_EVENT_VERSION &&
    validOrgId(payload.orgId) &&
    canonicalText(payload.name, 256) &&
    validSub(payload.ownerSub)
  );
}

export function isIdentityMembershipGrantedEvent(
  value: unknown,
): value is IdentityMembershipGrantedEvent {
  if (!eventWithPayload(value, "identity.membership.granted")) return false;
  const payload = value.payload;
  return (
    exactObject(payload, ["v", "orgId", "sub", "role"]) &&
    payload.v === IDENTITY_EVENT_VERSION &&
    validOrgId(payload.orgId) &&
    validSub(payload.sub) &&
    (payload.role === "admin" || payload.role === "member")
  );
}

export function isIdentityMembershipRevokedEvent(
  value: unknown,
): value is IdentityMembershipRevokedEvent {
  if (!eventWithPayload(value, "identity.membership.revoked")) return false;
  const payload = value.payload;
  return (
    exactObject(payload, ["v", "orgId", "sub"]) &&
    payload.v === IDENTITY_EVENT_VERSION &&
    validOrgId(payload.orgId) &&
    validSub(payload.sub)
  );
}

export function isIdentityGrantIssuedEvent(value: unknown): value is IdentityGrantIssuedEvent {
  if (!eventWithPayload(value, "identity.grant.issued")) return false;
  const payload = value.payload;
  const record = payload as Record<string, unknown>;
  const legacy = exactObject(payload, ["v", "grantId", "sub", "kind", "scopes", "tokenHash"]);
  const extended =
    exactObject(payload, [
      "v",
      "grantId",
      "sub",
      "kind",
      "scopes",
      "tokenHash",
      "tokenKind",
      "issuedAt",
    ]) ||
    exactObject(payload, [
      "v",
      "grantId",
      "sub",
      "kind",
      "scopes",
      "tokenHash",
      "tokenKind",
      "name",
      "issuedAt",
    ]);
  return (
    (legacy || extended) &&
    ((legacy && record.v === IDENTITY_EVENT_VERSION) ||
      (extended && record.v === CLI_GRANT_EVENT_VERSION)) &&
    opaqueId(record.grantId) &&
    validSub(record.sub) &&
    (record.kind === "cli-token" || record.kind === "web-session-mint") &&
    validScopes(record.scopes) &&
    typeof record.tokenHash === "string" &&
    /^[0-9a-f]{64}$/.test(record.tokenHash) &&
    (legacy ||
      (((record.tokenKind === "device" && record.kind === "cli-token") ||
        (record.tokenKind === "web-mint" && record.kind === "web-session-mint")) &&
        typeof record.issuedAt === "number" &&
        Number.isSafeInteger(record.issuedAt) &&
        record.issuedAt >= 0 &&
        (record.name === undefined || canonicalText(record.name, 128))))
  );
}

export function isIdentityGrantRevokedEvent(value: unknown): value is IdentityGrantRevokedEvent {
  if (!eventWithPayload(value, "identity.grant.revoked")) return false;
  const payload = value.payload;
  const record = payload as Record<string, unknown>;
  const legacy = exactObject(payload, ["v", "grantId"]);
  const extended = exactObject(payload, ["v", "grantId", "revokedAt"]);
  return (
    (legacy || extended) &&
    ((legacy && record.v === IDENTITY_EVENT_VERSION) ||
      (extended && record.v === CLI_GRANT_EVENT_VERSION)) &&
    opaqueId(record.grantId) &&
    (legacy ||
      (typeof record.revokedAt === "number" &&
        Number.isSafeInteger(record.revokedAt) &&
        record.revokedAt >= 0))
  );
}

export function isIdentityGrantOperationStartedEvent(
  value: unknown,
): value is IdentityGrantOperationStartedEvent {
  if (!eventWithPayload(value, "identity.grant.operation.started")) return false;
  const payload = value.payload;
  return (
    exactObject(payload, ["v", "operationId", "grantId", "startedAt"]) &&
    payload.v === CLI_GRANT_EVENT_VERSION &&
    opaqueId(payload.operationId) &&
    opaqueId(payload.grantId) &&
    typeof payload.startedAt === "number" &&
    Number.isSafeInteger(payload.startedAt) &&
    payload.startedAt >= 0
  );
}

export function isIdentityGrantOperationCompletedEvent(
  value: unknown,
): value is IdentityGrantOperationCompletedEvent {
  if (!eventWithPayload(value, "identity.grant.operation.completed")) return false;
  const payload = value.payload;
  return (
    exactObject(payload, ["v", "operationId", "completedAt"]) &&
    payload.v === CLI_GRANT_EVENT_VERSION &&
    opaqueId(payload.operationId) &&
    typeof payload.completedAt === "number" &&
    Number.isSafeInteger(payload.completedAt) &&
    payload.completedAt >= 0
  );
}

export function isIdentitySessionStartedEvent(
  value: unknown,
): value is IdentitySessionStartedEvent {
  if (!eventWithPayload(value, "identity.session.started")) return false;
  const payload = value.payload;
  return (
    exactObject(payload, ["v", "sessionId", "sub"]) &&
    payload.v === IDENTITY_EVENT_VERSION &&
    opaqueId(payload.sessionId) &&
    validSub(payload.sub)
  );
}

export function isIdentitySessionEndedEvent(value: unknown): value is IdentitySessionEndedEvent {
  if (!eventWithPayload(value, "identity.session.ended")) return false;
  const payload = value.payload;
  return (
    exactObject(payload, ["v", "sessionId"]) &&
    payload.v === IDENTITY_EVENT_VERSION &&
    opaqueId(payload.sessionId)
  );
}

const validators: Readonly<Record<IdentityEventType, (value: unknown) => boolean>> = {
  "identity.user.created": isIdentityUserCreatedEvent,
  "identity.org.created": isIdentityOrgCreatedEvent,
  "identity.membership.granted": isIdentityMembershipGrantedEvent,
  "identity.membership.revoked": isIdentityMembershipRevokedEvent,
  "identity.grant.issued": isIdentityGrantIssuedEvent,
  "identity.grant.revoked": isIdentityGrantRevokedEvent,
  "identity.grant.operation.started": isIdentityGrantOperationStartedEvent,
  "identity.grant.operation.completed": isIdentityGrantOperationCompletedEvent,
  "identity.session.started": isIdentitySessionStartedEvent,
  "identity.session.ended": isIdentitySessionEndedEvent,
};

export function isIdentityEvent(value: unknown): value is IdentityEvent {
  if (!isEvent(value)) return false;
  const validator = ownEntry(validators, value.type);
  return validator !== undefined && validator(value);
}

export function assertIdentityEvent(value: unknown): asserts value is IdentityEvent {
  if (!isEvent(value)) {
    throw new IdentityEventValidationError(
      "identity/invalid-envelope",
      "event must contain exactly type, payload, and finite ts",
    );
  }
  const validator = ownEntry(validators, value.type);
  if (validator === undefined) {
    throw new IdentityEventValidationError(
      "identity/unknown-type",
      `unsupported event type ${JSON.stringify(value.type)}`,
    );
  }
  if (!validator(value)) {
    throw new IdentityEventValidationError(
      "identity/invalid-payload",
      `payload for ${value.type} violates the frozen v${IDENTITY_EVENT_VERSION} schema`,
    );
  }
}
