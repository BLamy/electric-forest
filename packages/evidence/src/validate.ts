import type { Event, Offset } from "@eforest/protocol";
import {
  ALL_EVIDENCE_ACTION_TYPES,
  ATTACHMENT_EVENT_VERSION,
  MAX_ATTACHMENT_BYTES,
  MAX_CHUNK_BYTES,
  decodeCanonicalBase64,
  entityStreamId,
  isContentChunkEvent,
  isContentEvidenceKind,
  isContentSealedEvent,
  isEvidenceActionType,
  isEvidenceAttachedEvent,
  isEvidenceContentActionType,
  isEvidenceDetachedEvent,
  isEvidenceLinkedEvent,
  isEvidenceWaivedEvent,
  isPathSafeId,
  isReferenceEvidenceKind,
  isReplayRecordingUrl,
  isSha256,
  parseEvidenceContentStreamId,
  parseEvidenceStreamIdentity,
  parseEvidenceStreamId,
  type AnyEvidenceActionType,
  type EvidenceStreamIdentity,
} from "./events.js";
import {
  contentBytes,
  reduceContentEvents,
  type AttachmentListState,
  type ContentState,
} from "./reducer.js";

export const EVIDENCE_REFUSAL_REASONS = [
  "evidence/unknown-entity",
  "evidence/duplicate-attachment-id",
  "evidence/unknown-attachment",
  "evidence/already-detached",
  "evidence/unsealed-content",
  "evidence/content-not-found",
  "evidence/digest-mismatch",
  "evidence/size-mismatch",
  "evidence/oversized",
  "evidence/chunk-out-of-order",
  "evidence/sealed-terminal",
  "evidence/invalid-url",
  "evidence/unknown-kind",
  "evidence/unknown-entity-type",
] as const;

export type EvidenceRefusalReason = (typeof EVIDENCE_REFUSAL_REASONS)[number];

export class EvidenceSchemaError extends Error {
  constructor() {
    super("schema-violation");
    this.name = "EvidenceSchemaError";
  }
}

export class EvidenceUnknownActionError extends Error {
  constructor() {
    super("unknown-action-type");
    this.name = "EvidenceUnknownActionError";
  }
}

export class EvidenceRefusalError extends Error {
  constructor(readonly reason: EvidenceRefusalReason) {
    super(reason);
    this.name = "EvidenceRefusalError";
  }
}

export interface EvidenceResolvedStream {
  readonly records: readonly Event[];
  /** Optional platform projection; records remain the portable fallback. */
  readonly state?: unknown;
}

export interface EvidenceActionValidationContext {
  readonly streamId: string;
  readonly state: AttachmentListState | ContentState;
  readonly headOffset: Offset;
  readonly nextOffset: Offset;
  readonly records: readonly Event[];
  /** One platform-owned lookup mouth for entities and content streams alike. */
  readonly resolveStream: (streamId: string) => Promise<EvidenceResolvedStream | undefined>;
}

export interface EvidenceActionValidator {
  readonly actionType: AnyEvidenceActionType;
  readonly validate: (
    action: Event,
    context: EvidenceActionValidationContext,
  ) => void | Promise<void>;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(value);
  if (own.some((key) => typeof key === "symbol")) return false;
  const actual = (own as string[]).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasEnvelope(action: Event): boolean {
  return (
    typeof action.type === "string" && typeof action.ts === "number" && Number.isFinite(action.ts)
  );
}

function looseAttachedSchema(action: Event): Record<string, unknown> | undefined {
  const payload = object(action.payload);
  if (
    action.type !== "evidence.attached" ||
    payload === undefined ||
    !hasExactKeys(payload, [
      "v",
      "attachmentId",
      "kind",
      "name",
      "mediaType",
      "size",
      "sha256",
      "contentStream",
    ]) ||
    payload.v !== ATTACHMENT_EVENT_VERSION ||
    !isPathSafeId(payload.attachmentId) ||
    typeof payload.kind !== "string" ||
    typeof payload.name !== "string" ||
    payload.name.length === 0 ||
    typeof payload.mediaType !== "string" ||
    payload.mediaType.length === 0 ||
    !Number.isSafeInteger(payload.size) ||
    (payload.size as number) < 0 ||
    !isSha256(payload.sha256) ||
    typeof payload.contentStream !== "string"
  ) {
    return undefined;
  }
  return payload;
}

function looseLinkedSchema(action: Event): Record<string, unknown> | undefined {
  const payload = object(action.payload);
  if (action.type !== "evidence.linked" || payload === undefined) return undefined;
  const keys = Object.hasOwn(payload, "title")
    ? ["v", "attachmentId", "kind", "url", "title"]
    : ["v", "attachmentId", "kind", "url"];
  if (
    !hasExactKeys(payload, keys) ||
    payload.v !== ATTACHMENT_EVENT_VERSION ||
    !isPathSafeId(payload.attachmentId) ||
    typeof payload.kind !== "string" ||
    typeof payload.url !== "string" ||
    (payload.title !== undefined &&
      (typeof payload.title !== "string" || payload.title.length === 0))
  ) {
    return undefined;
  }
  return payload;
}

function contentState(context: EvidenceActionValidationContext): ContentState {
  try {
    contentBytes(context.state as ContentState);
    return context.state as ContentState;
  } catch {
    return reduceContentEvents(context.records);
  }
}

async function assertEntity(
  context: EvidenceActionValidationContext,
): Promise<EvidenceStreamIdentity> {
  const loose = parseEvidenceStreamIdentity(context.streamId);
  if (loose === undefined) throw new EvidenceSchemaError();
  if (loose.entityType !== "issue" && loose.entityType !== "pr") {
    throw new EvidenceRefusalError("evidence/unknown-entity-type");
  }
  const identity = parseEvidenceStreamId(context.streamId);
  if (identity === undefined) throw new EvidenceSchemaError();
  const entity = await context.resolveStream(entityStreamId(identity));
  if (entity === undefined || entity.records.length === 0) {
    throw new EvidenceRefusalError("evidence/unknown-entity");
  }
  return identity;
}

export async function validateEvidenceContentAction(
  action: Event,
  context: EvidenceActionValidationContext,
): Promise<void> {
  if (parseEvidenceContentStreamId(context.streamId) === undefined) throw new EvidenceSchemaError();
  const state = contentState(context);
  if (state.sealed || state.sealError !== undefined) {
    throw new EvidenceRefusalError("evidence/sealed-terminal");
  }

  if (action.type === "content.chunk") {
    if (!isContentChunkEvent(action)) throw new EvidenceSchemaError();
    const bytes = decodeCanonicalBase64(action.payload.bytes)!;
    if (
      bytes.byteLength > MAX_CHUNK_BYTES ||
      state.size + bytes.byteLength > MAX_ATTACHMENT_BYTES
    ) {
      throw new EvidenceRefusalError("evidence/oversized");
    }
    if (action.payload.seq !== state.chunks) {
      throw new EvidenceRefusalError("evidence/chunk-out-of-order");
    }
    return;
  }

  if (!isContentSealedEvent(action)) throw new EvidenceSchemaError();
  if (action.payload.chunks !== state.chunks) {
    throw new EvidenceRefusalError("evidence/chunk-out-of-order");
  }
  if (action.payload.size !== state.size) {
    throw new EvidenceRefusalError("evidence/size-mismatch");
  }
  if (action.payload.sha256 !== state.sha256) {
    throw new EvidenceRefusalError("evidence/digest-mismatch");
  }
}

export async function validateEvidenceAttachmentAction(
  action: Event,
  context: EvidenceActionValidationContext,
): Promise<void> {
  const identity = await assertEntity(context);
  const state = context.state as AttachmentListState;

  if (action.type === "evidence.attached") {
    const payload = looseAttachedSchema(action);
    if (payload === undefined) throw new EvidenceSchemaError();
    if (!isContentEvidenceKind(payload.kind)) {
      throw new EvidenceRefusalError("evidence/unknown-kind");
    }
    if ((payload.size as number) > MAX_ATTACHMENT_BYTES) {
      throw new EvidenceRefusalError("evidence/oversized");
    }
    if (state.attachments.some(({ attachmentId }) => attachmentId === payload.attachmentId)) {
      throw new EvidenceRefusalError("evidence/duplicate-attachment-id");
    }
    const contentIdentity = parseEvidenceContentStreamId(payload.contentStream as string);
    if (
      contentIdentity === undefined ||
      contentIdentity.org !== identity.org ||
      contentIdentity.repo !== identity.repo ||
      contentIdentity.attachmentId !== payload.attachmentId
    ) {
      throw new EvidenceRefusalError("evidence/content-not-found");
    }
    const resolved = await context.resolveStream(payload.contentStream as string);
    if (resolved === undefined) throw new EvidenceRefusalError("evidence/content-not-found");
    const content = resolvedContentState(resolved);
    if (!content.sealed) throw new EvidenceRefusalError("evidence/unsealed-content");
    if (content.sha256 !== payload.sha256) {
      throw new EvidenceRefusalError("evidence/digest-mismatch");
    }
    if (content.size !== payload.size) {
      throw new EvidenceRefusalError("evidence/size-mismatch");
    }
    if (!isEvidenceAttachedEvent(action)) throw new EvidenceSchemaError();
    return;
  }

  if (action.type === "evidence.linked") {
    const payload = looseLinkedSchema(action);
    if (payload === undefined) throw new EvidenceSchemaError();
    if (!isReferenceEvidenceKind(payload.kind)) {
      throw new EvidenceRefusalError("evidence/unknown-kind");
    }
    if (!isReplayRecordingUrl(payload.url)) {
      throw new EvidenceRefusalError("evidence/invalid-url");
    }
    if (state.attachments.some(({ attachmentId }) => attachmentId === payload.attachmentId)) {
      throw new EvidenceRefusalError("evidence/duplicate-attachment-id");
    }
    if (!isEvidenceLinkedEvent(action)) throw new EvidenceSchemaError();
    return;
  }

  if (action.type === "evidence.waived") {
    if (!isEvidenceWaivedEvent(action)) throw new EvidenceSchemaError();
    return;
  }

  if (!isEvidenceDetachedEvent(action)) throw new EvidenceSchemaError();
  const attachment = state.attachments.find(
    ({ attachmentId }) => attachmentId === action.payload.attachmentId,
  );
  if (attachment === undefined) throw new EvidenceRefusalError("evidence/unknown-attachment");
  if (attachment.detachedAtOffset !== undefined) {
    throw new EvidenceRefusalError("evidence/already-detached");
  }
}

function isResolvedContentState(value: unknown): value is ContentState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ContentState>;
  return (
    candidate.v === ATTACHMENT_EVENT_VERSION &&
    Number.isSafeInteger(candidate.size) &&
    (candidate.size ?? -1) >= 0 &&
    Number.isSafeInteger(candidate.chunks) &&
    (candidate.chunks ?? -1) >= 0 &&
    isSha256(candidate.sha256) &&
    typeof candidate.sealed === "boolean"
  );
}

function resolvedContentState(resolved: EvidenceResolvedStream): ContentState {
  return isResolvedContentState(resolved.state)
    ? resolved.state
    : reduceContentEvents(resolved.records);
}

export async function validateEvidenceAction(
  action: Event,
  context: EvidenceActionValidationContext,
): Promise<void> {
  if (!hasEnvelope(action)) throw new EvidenceSchemaError();
  if (!isEvidenceActionType(action.type) && !isEvidenceContentActionType(action.type)) {
    throw new EvidenceUnknownActionError();
  }
  if (isEvidenceContentActionType(action.type)) {
    await validateEvidenceContentAction(action, context);
    return;
  }
  await validateEvidenceAttachmentAction(action, context);
}

export const evidenceActionValidators: readonly EvidenceActionValidator[] =
  ALL_EVIDENCE_ACTION_TYPES.map((actionType) =>
    Object.freeze({
      actionType,
      validate: async (action: Event, context: EvidenceActionValidationContext) => {
        if (action.type !== actionType) throw new EvidenceUnknownActionError();
        await validateEvidenceAction(action, context);
      },
    }),
  );
