import {
  OFFSET_BEFORE_FIRST,
  compareOffsets,
  sha256Hex,
  stateDigest,
  type Event,
  type Offset,
} from "@eforest/protocol";
import { isWellFormedOffset } from "@eforest/protocol/offset-allocation";
import {
  ATTACHMENT_EVENT_VERSION,
  EVIDENCE_CONTENT_STREAM_TYPE,
  EVIDENCE_STREAM_TYPE,
  MAX_ATTACHMENT_BYTES,
  MAX_CHUNK_BYTES,
  decodeCanonicalBase64,
  isContentChunkEvent,
  isContentSealedEvent,
  isEvidenceAttachedEvent,
  isEvidenceDetachedEvent,
  isEvidenceLinkedEvent,
  isEvidenceContentStreamId,
  isEvidenceStreamId,
  parseEvidenceStreamId,
  entityStreamId,
  type ContentEvidenceKind,
  type ReferenceEvidenceKind,
} from "./events.js";

export type ContentSealError = "chunk-out-of-order" | "size-mismatch" | "digest-mismatch";

export interface ContentState {
  readonly v: typeof ATTACHMENT_EVENT_VERSION;
  readonly size: number;
  readonly chunks: number;
  /** Always reducer-computed from decoded chunks; never copied from a seal. */
  readonly sha256: string;
  readonly sealed: boolean;
  readonly sealError?: ContentSealError;
}

export interface ContentAttachment {
  readonly attachmentId: string;
  readonly type: "content";
  readonly kind: ContentEvidenceKind;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentStream: string;
  readonly attachedAtOffset: Offset;
  readonly detachedAtOffset?: Offset;
}

export interface ReferenceAttachment {
  readonly attachmentId: string;
  readonly type: "reference";
  readonly kind: ReferenceEvidenceKind;
  readonly url: string;
  readonly title?: string;
  readonly attachedAtOffset: Offset;
  readonly detachedAtOffset?: Offset;
}

export type Attachment = ContentAttachment | ReferenceAttachment;

export interface AttachmentListState {
  readonly v: typeof ATTACHMENT_EVENT_VERSION;
  /** The owning issue or PR stream id. */
  readonly entityRef: string;
  /** Append/offset order, including detached tombstones. */
  readonly attachments: readonly Attachment[];
}

const CONTENT_BYTES = "__eforestEvidenceContentBytes" as const;
type ContentStateWithBytes = ContentState & { readonly [CONTENT_BYTES]: Uint8Array };

function withContentBytes(state: ContentState, bytes: Uint8Array): ContentState {
  const result = { ...state } as ContentStateWithBytes;
  Object.defineProperty(result, CONTENT_BYTES, {
    configurable: false,
    enumerable: false,
    value: bytes.slice(),
    writable: false,
  });
  return Object.freeze(result);
}

export function contentInitialStateValue(): ContentState {
  const bytes = new Uint8Array();
  return withContentBytes(
    {
      v: ATTACHMENT_EVENT_VERSION,
      size: 0,
      chunks: 0,
      sha256: sha256Hex(bytes),
      sealed: false,
    },
    bytes,
  );
}

export const contentInitialState: ContentState = contentInitialStateValue();

export function contentInitialStateForStream(streamId: string): ContentState {
  if (!isEvidenceContentStreamId(streamId)) {
    throw new TypeError(`invalid evidence content stream id: ${streamId}`);
  }
  return contentInitialStateValue();
}

export const attachmentInitialState: AttachmentListState = Object.freeze({
  v: ATTACHMENT_EVENT_VERSION,
  entityRef: "",
  attachments: Object.freeze([]),
});

export function attachmentInitialStateForStream(streamId: string): AttachmentListState {
  const identity = parseEvidenceStreamId(streamId);
  if (identity === undefined) throw new TypeError(`invalid evidence stream id: ${streamId}`);
  return Object.freeze({
    v: ATTACHMENT_EVENT_VERSION,
    entityRef: entityStreamId(identity),
    attachments: Object.freeze([]),
  });
}

function bytesOf(state: ContentState): Uint8Array | undefined {
  const bytes = (state as Partial<ContentStateWithBytes>)[CONTENT_BYTES];
  return bytes instanceof Uint8Array ? bytes : undefined;
}

export function contentBytes(state: ContentState): Uint8Array {
  const bytes = bytesOf(state);
  if (bytes === undefined) throw new TypeError("content state has no replay-derived bytes");
  return bytes.slice();
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left, 0);
  joined.set(right, left.byteLength);
  return joined;
}

export function contentReducer(state: ContentState, rawEvent: Event): ContentState {
  const existing = bytesOf(state);
  if (existing === undefined) return state;
  const event = cleanEvent(rawEvent);

  if (event.type === "content.chunk") {
    if (state.sealed || !isContentChunkEvent(event)) return state;
    const chunk = decodeCanonicalBase64(event.payload.bytes);
    if (
      chunk === undefined ||
      chunk.byteLength === 0 ||
      chunk.byteLength > MAX_CHUNK_BYTES ||
      state.size + chunk.byteLength > MAX_ATTACHMENT_BYTES ||
      event.payload.seq !== state.chunks
    ) {
      return state;
    }
    const bytes = appendBytes(existing, chunk);
    return withContentBytes(
      {
        v: ATTACHMENT_EVENT_VERSION,
        size: bytes.byteLength,
        chunks: state.chunks + 1,
        sha256: sha256Hex(bytes),
        sealed: false,
      },
      bytes,
    );
  }

  if (event.type !== "content.sealed" || state.sealed || !isContentSealedEvent(event)) {
    return state;
  }

  const sealError: ContentSealError | undefined =
    event.payload.chunks !== state.chunks
      ? "chunk-out-of-order"
      : event.payload.size !== state.size
        ? "size-mismatch"
        : event.payload.sha256 !== state.sha256
          ? "digest-mismatch"
          : undefined;
  if (sealError !== undefined) {
    return withContentBytes({ ...state, sealed: false, sealError }, existing);
  }
  return withContentBytes(
    {
      v: ATTACHMENT_EVENT_VERSION,
      size: state.size,
      chunks: state.chunks,
      sha256: state.sha256,
      sealed: true,
    },
    existing,
  );
}

export function reduceContentEvents(events: readonly Event[]): ContentState {
  return events.reduce(contentReducer, contentInitialStateValue());
}

function eventOffset(event: Event): Offset | undefined {
  const offset = (event as Event & { readonly offset?: unknown }).offset;
  return typeof offset === "string" && offset !== OFFSET_BEFORE_FIRST && isWellFormedOffset(offset)
    ? (offset as Offset)
    : undefined;
}

function cleanEvent(rawEvent: Event): Event {
  if (
    rawEvent.payload === null ||
    typeof rawEvent.payload !== "object" ||
    Array.isArray(rawEvent.payload)
  ) {
    return rawEvent;
  }
  const payload = Object.fromEntries(
    Object.entries(rawEvent.payload).filter(([key]) => key !== "actor" && key !== "writer"),
  );
  return { ...rawEvent, payload };
}

export function attachmentReducer(
  state: AttachmentListState,
  rawEvent: Event,
): AttachmentListState {
  const offset = eventOffset(rawEvent);
  if (offset === undefined) return state;
  const event = cleanEvent(rawEvent);

  if (isEvidenceAttachedEvent(event)) {
    if (state.attachments.some(({ attachmentId }) => attachmentId === event.payload.attachmentId)) {
      return state;
    }
    const attachment: ContentAttachment = {
      attachmentId: event.payload.attachmentId,
      type: "content",
      kind: event.payload.kind,
      name: event.payload.name,
      mediaType: event.payload.mediaType,
      size: event.payload.size,
      sha256: event.payload.sha256,
      contentStream: event.payload.contentStream,
      attachedAtOffset: offset,
    };
    return {
      ...state,
      attachments: [...state.attachments, attachment].sort((left, right) =>
        compareOffsets(left.attachedAtOffset, right.attachedAtOffset),
      ),
    };
  }

  if (isEvidenceLinkedEvent(event)) {
    if (state.attachments.some(({ attachmentId }) => attachmentId === event.payload.attachmentId)) {
      return state;
    }
    const attachment: ReferenceAttachment = {
      attachmentId: event.payload.attachmentId,
      type: "reference",
      kind: event.payload.kind,
      url: event.payload.url,
      ...(event.payload.title === undefined ? {} : { title: event.payload.title }),
      attachedAtOffset: offset,
    };
    return {
      ...state,
      attachments: [...state.attachments, attachment].sort((left, right) =>
        compareOffsets(left.attachedAtOffset, right.attachedAtOffset),
      ),
    };
  }

  if (!isEvidenceDetachedEvent(event)) return state;
  const index = state.attachments.findIndex(
    ({ attachmentId }) => attachmentId === event.payload.attachmentId,
  );
  if (
    index < 0 ||
    state.attachments[index]!.detachedAtOffset !== undefined ||
    compareOffsets(offset, state.attachments[index]!.attachedAtOffset) <= 0
  ) {
    return state;
  }
  return {
    ...state,
    attachments: state.attachments.map((attachment, attachmentIndex) =>
      attachmentIndex === index ? { ...attachment, detachedAtOffset: offset } : attachment,
    ),
  };
}

export const attachmentReducerVersion = ATTACHMENT_EVENT_VERSION;
export const contentReducerVersion = ATTACHMENT_EVENT_VERSION;

export const attachmentReducerDefinition = Object.freeze({
  id: EVIDENCE_STREAM_TYPE,
  version: ATTACHMENT_EVENT_VERSION,
  initialState: attachmentInitialState,
  initialStateForStream: attachmentInitialStateForStream,
  reduce: attachmentReducer as (state: unknown, event: Event) => unknown,
  digest: stateDigest,
  matchesStream: isEvidenceStreamId,
});

export const contentReducerDefinition = Object.freeze({
  id: EVIDENCE_CONTENT_STREAM_TYPE,
  version: ATTACHMENT_EVENT_VERSION,
  initialState: contentInitialState,
  initialStateForStream: contentInitialStateForStream,
  reduce: contentReducer as (state: unknown, event: Event) => unknown,
  digest: stateDigest,
  matchesStream: isEvidenceContentStreamId,
});
