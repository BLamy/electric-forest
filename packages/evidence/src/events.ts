import type { Event } from "@eforest/protocol";

export const ATTACHMENT_EVENT_VERSION = 1 as const;
export const EVIDENCE_STREAM_TYPE = "evidence" as const;
export const EVIDENCE_CONTENT_STREAM_TYPE = "evidence-content" as const;
export const MAX_CHUNK_BYTES = 512 * 1024;
export const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;
export const MAX_REFERENCE_URL_LENGTH = 2048;

export const CONTENT_EVIDENCE_KINDS = ["event-log", "digest", "rr-trace"] as const;
export const REFERENCE_EVIDENCE_KINDS = ["replay-recording"] as const;
export const EVIDENCE_ENTITY_TYPES = ["issue", "pr"] as const;

export type ContentEvidenceKind = (typeof CONTENT_EVIDENCE_KINDS)[number];
export type ReferenceEvidenceKind = (typeof REFERENCE_EVIDENCE_KINDS)[number];
export type EvidenceEntityType = (typeof EVIDENCE_ENTITY_TYPES)[number];

export const EVIDENCE_ACTION_TYPES = [
  "evidence.attached",
  "evidence.linked",
  "evidence.waived",
  "evidence.detached",
] as const;
export const EVIDENCE_CONTENT_ACTION_TYPES = ["content.chunk", "content.sealed"] as const;
export const ALL_EVIDENCE_ACTION_TYPES = [
  ...EVIDENCE_ACTION_TYPES,
  ...EVIDENCE_CONTENT_ACTION_TYPES,
] as const;

export type EvidenceActionType = (typeof EVIDENCE_ACTION_TYPES)[number];
export type EvidenceContentActionType = (typeof EVIDENCE_CONTENT_ACTION_TYPES)[number];
export type AnyEvidenceActionType = (typeof ALL_EVIDENCE_ACTION_TYPES)[number];

export interface ContentChunkEvent extends Event {
  readonly type: "content.chunk";
  readonly payload: {
    readonly v: typeof ATTACHMENT_EVENT_VERSION;
    readonly seq: number;
    readonly bytes: string;
  };
}

export interface ContentSealedEvent extends Event {
  readonly type: "content.sealed";
  readonly payload: {
    readonly v: typeof ATTACHMENT_EVENT_VERSION;
    readonly sha256: string;
    readonly size: number;
    readonly chunks: number;
  };
}

export interface EvidenceAttachedEvent extends Event {
  readonly type: "evidence.attached";
  readonly payload: {
    readonly v: typeof ATTACHMENT_EVENT_VERSION;
    readonly attachmentId: string;
    readonly kind: ContentEvidenceKind;
    readonly name: string;
    readonly mediaType: string;
    readonly size: number;
    readonly sha256: string;
    readonly contentStream: string;
  };
}

export interface EvidenceLinkedEvent extends Event {
  readonly type: "evidence.linked";
  readonly payload: {
    readonly v: typeof ATTACHMENT_EVENT_VERSION;
    readonly attachmentId: string;
    readonly kind: ReferenceEvidenceKind;
    readonly url: string;
    readonly title?: string;
  };
}

export interface EvidenceWaivedEvent extends Event {
  readonly type: "evidence.waived";
  readonly payload: {
    readonly v: typeof ATTACHMENT_EVENT_VERSION;
    readonly justification: string;
  };
}

export interface EvidenceDetachedEvent extends Event {
  readonly type: "evidence.detached";
  readonly payload: {
    readonly v: typeof ATTACHMENT_EVENT_VERSION;
    readonly attachmentId: string;
  };
}

export type EvidenceEvent =
  EvidenceAttachedEvent | EvidenceLinkedEvent | EvidenceWaivedEvent | EvidenceDetachedEvent;
export type EvidenceContentEvent = ContentChunkEvent | ContentSealedEvent;
export type AnyEvidenceEvent = EvidenceEvent | EvidenceContentEvent;

export interface EvidenceEntityRef {
  readonly org: string;
  readonly repo: string;
  readonly entityType: EvidenceEntityType;
  readonly entityId: string;
}

export interface EvidenceStreamIdentity extends EvidenceEntityRef {}

/** Repo-scoped syntax used before semantic entity-type validation. */
export interface LooseEvidenceStreamIdentity {
  readonly org: string;
  readonly repo: string;
  readonly entityType: string;
  readonly entityId: string;
}

export interface EvidenceContentStreamIdentity {
  readonly org: string;
  readonly repo: string;
  readonly attachmentId: string;
}

const NAME_PATTERN = /^(?=[a-z0-9-]{1,40}$)[a-z0-9](?:-?[a-z0-9])*$/;
const PATH_ID_PATTERN = /^[A-Za-z0-9._~-]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function exactObject(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) return false;
  const actual = (keys as string[]).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function eventEnvelope(value: unknown): value is Event {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).type === "string" &&
    typeof (value as Record<string, unknown>).ts === "number" &&
    Number.isFinite((value as Record<string, unknown>).ts)
  );
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isPathSafeId(value: unknown): value is string {
  return typeof value === "string" && PATH_ID_PATTERN.test(value);
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

export function decodeCanonicalBase64(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string" || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    return undefined;
  }
  try {
    const decoded = atob(value);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }
    return encodeCanonicalBase64(bytes) === value ? bytes : undefined;
  } catch {
    return undefined;
  }
}

export function encodeCanonicalBase64(bytes: Uint8Array): string {
  const stride = 32 * 1024;
  let binary = "";
  for (let start = 0; start < bytes.byteLength; start += stride) {
    const end = Math.min(start + stride, bytes.byteLength);
    for (let index = start; index < end; index += 1) {
      binary += String.fromCharCode(bytes[index]!);
    }
  }
  return btoa(binary);
}

export function isContentEvidenceKind(value: unknown): value is ContentEvidenceKind {
  return (CONTENT_EVIDENCE_KINDS as readonly unknown[]).includes(value);
}

export function isReferenceEvidenceKind(value: unknown): value is ReferenceEvidenceKind {
  return (REFERENCE_EVIDENCE_KINDS as readonly unknown[]).includes(value);
}

export function isEvidenceEntityType(value: unknown): value is EvidenceEntityType {
  return (EVIDENCE_ENTITY_TYPES as readonly unknown[]).includes(value);
}

export function isEvidenceActionType(value: string): value is EvidenceActionType {
  return (EVIDENCE_ACTION_TYPES as readonly string[]).includes(value);
}

export function isEvidenceContentActionType(value: string): value is EvidenceContentActionType {
  return (EVIDENCE_CONTENT_ACTION_TYPES as readonly string[]).includes(value);
}

export function isAnyEvidenceActionType(value: string): value is AnyEvidenceActionType {
  return (ALL_EVIDENCE_ACTION_TYPES as readonly string[]).includes(value);
}

export function isContentChunkEvent(value: unknown): value is ContentChunkEvent {
  if (!eventEnvelope(value) || value.type !== "content.chunk") return false;
  const payload = value.payload;
  const bytes =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? decodeCanonicalBase64((payload as Record<string, unknown>).bytes)
      : undefined;
  return (
    exactObject(payload, ["v", "seq", "bytes"]) &&
    payload.v === ATTACHMENT_EVENT_VERSION &&
    nonNegativeInteger(payload.seq) &&
    bytes !== undefined &&
    bytes.byteLength > 0
  );
}

export function isContentSealedEvent(value: unknown): value is ContentSealedEvent {
  if (!eventEnvelope(value) || value.type !== "content.sealed") return false;
  const payload = value.payload;
  return (
    exactObject(payload, ["v", "sha256", "size", "chunks"]) &&
    payload.v === ATTACHMENT_EVENT_VERSION &&
    isSha256(payload.sha256) &&
    nonNegativeInteger(payload.size) &&
    nonNegativeInteger(payload.chunks)
  );
}

export function isEvidenceAttachedEvent(value: unknown): value is EvidenceAttachedEvent {
  if (!eventEnvelope(value) || value.type !== "evidence.attached") return false;
  const payload = value.payload;
  return (
    exactObject(payload, [
      "v",
      "attachmentId",
      "kind",
      "name",
      "mediaType",
      "size",
      "sha256",
      "contentStream",
    ]) &&
    payload.v === ATTACHMENT_EVENT_VERSION &&
    isPathSafeId(payload.attachmentId) &&
    isContentEvidenceKind(payload.kind) &&
    nonEmptyText(payload.name) &&
    nonEmptyText(payload.mediaType) &&
    nonNegativeInteger(payload.size) &&
    isSha256(payload.sha256) &&
    typeof payload.contentStream === "string"
  );
}

export function isEvidenceLinkedEvent(value: unknown): value is EvidenceLinkedEvent {
  if (!eventEnvelope(value) || value.type !== "evidence.linked") return false;
  const payload = value.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const candidate = payload as Record<string, unknown>;
  const keys = Object.hasOwn(candidate, "title")
    ? ["v", "attachmentId", "kind", "url", "title"]
    : ["v", "attachmentId", "kind", "url"];
  return (
    exactObject(candidate, keys) &&
    candidate.v === ATTACHMENT_EVENT_VERSION &&
    isPathSafeId(candidate.attachmentId) &&
    isReferenceEvidenceKind(candidate.kind) &&
    typeof candidate.url === "string" &&
    (candidate.title === undefined || nonEmptyText(candidate.title))
  );
}

export function isEvidenceWaivedEvent(value: unknown): value is EvidenceWaivedEvent {
  if (!eventEnvelope(value) || value.type !== "evidence.waived") return false;
  const payload = value.payload;
  return (
    exactObject(payload, ["v", "justification"]) &&
    payload.v === ATTACHMENT_EVENT_VERSION &&
    nonEmptyText(payload.justification) &&
    payload.justification.trim().length > 0
  );
}

export function isEvidenceDetachedEvent(value: unknown): value is EvidenceDetachedEvent {
  if (!eventEnvelope(value) || value.type !== "evidence.detached") return false;
  const payload = value.payload;
  return (
    exactObject(payload, ["v", "attachmentId"]) &&
    payload.v === ATTACHMENT_EVENT_VERSION &&
    isPathSafeId(payload.attachmentId)
  );
}

export function isEvidenceEvent(value: unknown): value is EvidenceEvent {
  return (
    isEvidenceAttachedEvent(value) ||
    isEvidenceLinkedEvent(value) ||
    isEvidenceWaivedEvent(value) ||
    isEvidenceDetachedEvent(value)
  );
}

export function isEvidenceContentEvent(value: unknown): value is EvidenceContentEvent {
  return isContentChunkEvent(value) || isContentSealedEvent(value);
}

export function entityStreamId(ref: EvidenceEntityRef): string {
  if (
    !NAME_PATTERN.test(ref.org) ||
    !NAME_PATTERN.test(ref.repo) ||
    !isEvidenceEntityType(ref.entityType) ||
    !isPathSafeId(ref.entityId)
  ) {
    throw new TypeError("invalid evidence entity reference");
  }
  return `${ref.entityType}:${ref.org}/${ref.repo}/${ref.entityId}`;
}

export function evidenceStreamId(ref: EvidenceEntityRef): string {
  entityStreamId(ref);
  return `${EVIDENCE_STREAM_TYPE}:${ref.org}/${ref.repo}/${ref.entityType}/${ref.entityId}`;
}

export function evidenceContentStreamId(org: string, repo: string, attachmentId: string): string {
  if (!NAME_PATTERN.test(org) || !NAME_PATTERN.test(repo) || !isPathSafeId(attachmentId)) {
    throw new TypeError("invalid evidence content stream identity");
  }
  return `${EVIDENCE_CONTENT_STREAM_TYPE}:${org}/${repo}/${attachmentId}`;
}

export function parseEvidenceStreamIdentity(
  streamId: string,
): LooseEvidenceStreamIdentity | undefined {
  const match = /^evidence:([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(streamId);
  if (match === null) return undefined;
  const [, org, repo, entityType, entityId] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  return NAME_PATTERN.test(org) &&
    NAME_PATTERN.test(repo) &&
    isPathSafeId(entityType) &&
    isPathSafeId(entityId)
    ? { org, repo, entityType, entityId }
    : undefined;
}

export function parseEvidenceStreamId(streamId: string): EvidenceStreamIdentity | undefined {
  const identity = parseEvidenceStreamIdentity(streamId);
  return identity !== undefined && isEvidenceEntityType(identity.entityType)
    ? { ...identity, entityType: identity.entityType }
    : undefined;
}

export function parseEvidenceContentStreamId(
  streamId: string,
): EvidenceContentStreamIdentity | undefined {
  const match = /^evidence-content:([^/]+)\/([^/]+)\/([^/]+)$/.exec(streamId);
  if (match === null) return undefined;
  const [, org, repo, attachmentId] = match as unknown as [string, string, string, string];
  return NAME_PATTERN.test(org) && NAME_PATTERN.test(repo) && isPathSafeId(attachmentId)
    ? { org, repo, attachmentId }
    : undefined;
}

export function isEvidenceStreamId(streamId: string): boolean {
  return parseEvidenceStreamId(streamId) !== undefined;
}

export function isEvidenceContentStreamId(streamId: string): boolean {
  return parseEvidenceContentStreamId(streamId) !== undefined;
}

export function isReplayRecordingUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_REFERENCE_URL_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return false;
  }
  try {
    const parsed = new URL(value);
    const path = /^\/recording\/([A-Za-z0-9._~-]+)$/.exec(parsed.pathname);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "app.replay.io" &&
      parsed.port === "" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hash === "" &&
      path !== null
    );
  } catch {
    return false;
  }
}
