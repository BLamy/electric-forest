import { sha256Hex, type Event } from "@eforest/protocol";
import {
  ATTACHMENT_EVENT_VERSION,
  MAX_ATTACHMENT_BYTES,
  MAX_CHUNK_BYTES,
  evidenceContentStreamId,
  evidenceStreamId,
  encodeCanonicalBase64,
  isContentEvidenceKind,
  isPathSafeId,
  type ContentEvidenceKind,
  type EvidenceEntityRef,
} from "./events.js";
import { contentBytes, reduceContentEvents } from "./reducer.js";

export interface EvidenceClient {
  readonly dispatch: (streamId: string, event: Event) => Promise<unknown>;
  readonly read: (streamId: string) => Promise<readonly Event[]>;
  readonly now?: () => number;
  readonly createAttachmentId?: () => string;
}

export interface UploadAttachmentInput {
  readonly entityRef: EvidenceEntityRef;
  readonly attachmentId?: string;
  readonly kind: ContentEvidenceKind;
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface UploadedAttachment {
  readonly attachmentId: string;
  readonly attachmentStreamId: string;
  readonly contentStreamId: string;
  readonly sha256: string;
  readonly size: number;
  readonly chunks: number;
}

function defaultAttachmentId(): string {
  if (globalThis.crypto?.randomUUID === undefined) {
    throw new Error("attachmentId or client.createAttachmentId is required");
  }
  return globalThis.crypto.randomUUID();
}

export async function uploadAttachment(
  client: EvidenceClient,
  input: UploadAttachmentInput,
): Promise<UploadedAttachment> {
  if (!isContentEvidenceKind(input.kind)) throw new TypeError("unknown content evidence kind");
  if (input.name.length === 0 || input.mediaType.length === 0) {
    throw new TypeError("name and mediaType must not be empty");
  }
  if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new RangeError(`attachment exceeds ${MAX_ATTACHMENT_BYTES} decoded bytes`);
  }
  const sourceBytes = input.bytes.slice();
  const attachmentId = input.attachmentId ?? client.createAttachmentId?.() ?? defaultAttachmentId();
  if (!isPathSafeId(attachmentId)) throw new TypeError("invalid attachment id");
  const now = client.now ?? Date.now;
  const contentStreamId = evidenceContentStreamId(
    input.entityRef.org,
    input.entityRef.repo,
    attachmentId,
  );
  const attachmentStreamId = evidenceStreamId(input.entityRef);
  const sha256 = sha256Hex(sourceBytes);
  let chunks = 0;
  for (let start = 0; start < sourceBytes.byteLength; start += MAX_CHUNK_BYTES) {
    const bytes = sourceBytes.slice(
      start,
      Math.min(start + MAX_CHUNK_BYTES, sourceBytes.byteLength),
    );
    await client.dispatch(contentStreamId, {
      type: "content.chunk",
      payload: {
        v: ATTACHMENT_EVENT_VERSION,
        seq: chunks,
        bytes: encodeCanonicalBase64(bytes),
      },
      ts: now(),
    });
    chunks += 1;
  }
  await client.dispatch(contentStreamId, {
    type: "content.sealed",
    payload: {
      v: ATTACHMENT_EVENT_VERSION,
      sha256,
      size: sourceBytes.byteLength,
      chunks,
    },
    ts: now(),
  });
  await client.dispatch(attachmentStreamId, {
    type: "evidence.attached",
    payload: {
      v: ATTACHMENT_EVENT_VERSION,
      attachmentId,
      kind: input.kind,
      name: input.name,
      mediaType: input.mediaType,
      size: sourceBytes.byteLength,
      sha256,
      contentStream: contentStreamId,
    },
    ts: now(),
  });
  return {
    attachmentId,
    attachmentStreamId,
    contentStreamId,
    sha256,
    size: sourceBytes.byteLength,
    chunks,
  };
}

export async function downloadAttachment(
  client: Pick<EvidenceClient, "read">,
  contentStreamId: string,
): Promise<Uint8Array> {
  if (evidenceContentStreamIdFromValue(contentStreamId) === undefined) {
    throw new TypeError("invalid evidence content stream id");
  }
  const state = reduceContentEvents(await client.read(contentStreamId));
  if (!state.sealed) throw new Error("evidence content stream is not validly sealed");
  return contentBytes(state);
}

function evidenceContentStreamIdFromValue(value: string): string | undefined {
  try {
    const match = /^evidence-content:([^/]+)\/([^/]+)\/([^/]+)$/.exec(value);
    if (match === null) return undefined;
    const expected = evidenceContentStreamId(match[1]!, match[2]!, match[3]!);
    return expected === value ? value : undefined;
  } catch {
    return undefined;
  }
}
