import {
  ATTACHMENT_EVENT_VERSION,
  evidenceStreamId,
  isPathSafeId,
  isReplayRecordingUrl,
  uploadAttachment,
  type EvidenceLinkedEvent,
  type UploadAttachmentInput,
  type UploadedAttachment,
} from "@eforest/evidence";
import type { Event } from "@eforest/protocol";

export type EvidenceEventDispatch = (event: Event) => Promise<unknown>;
export type EvidenceStreamDispatch = (streamId: string, event: Event) => Promise<unknown>;

export function safeHttpsHref(value: string): string | undefined {
  try {
    return new URL(value).protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function browserSha256(
  bytes: Uint8Array,
  cryptoApi: Pick<Crypto, "subtle"> | undefined = globalThis.crypto,
): Promise<string> {
  if (cryptoApi?.subtle === undefined) throw new Error("Web Crypto is unavailable");
  const copy = Uint8Array.from(bytes);
  const digest = new Uint8Array(await cryptoApi.subtle.digest("SHA-256", copy.buffer));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isTextMediaType(mediaType: string): boolean {
  const normalized = mediaType.split(";", 1)[0]!.trim().toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized === "application/x-ndjson" ||
    normalized === "application/xml" ||
    normalized.endsWith("+json") ||
    normalized.endsWith("+xml")
  );
}

export interface TextPreview {
  readonly text: string;
  readonly truncated: boolean;
}

export function textPreview(bytes: Uint8Array, limit = 64 * 1024): TextPreview {
  const end = Math.min(bytes.byteLength, limit);
  return {
    text: new TextDecoder().decode(bytes.slice(0, end)),
    truncated: end < bytes.byteLength,
  };
}

export function byteExactBlob(bytes: Uint8Array, mediaType: string): Blob {
  return new Blob([Uint8Array.from(bytes)], { type: mediaType });
}

export function formatEvidenceSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function replayLinkEvent(input: {
  readonly attachmentId: string;
  readonly url: string;
  readonly title?: string;
  readonly now?: () => number;
}): EvidenceLinkedEvent {
  if (!isPathSafeId(input.attachmentId)) throw new TypeError("invalid attachment id");
  if (!isReplayRecordingUrl(input.url)) throw new TypeError("invalid Replay recording URL");
  return {
    type: "evidence.linked",
    payload: {
      v: ATTACHMENT_EVENT_VERSION,
      attachmentId: input.attachmentId,
      kind: "replay-recording",
      url: input.url,
      ...(input.title === undefined || input.title === "" ? {} : { title: input.title }),
    },
    ts: (input.now ?? Date.now)(),
  };
}

export async function dispatchEvidenceUpload(input: {
  readonly upload: UploadAttachmentInput;
  readonly parentDispatch: EvidenceEventDispatch;
  readonly contentDispatch: EvidenceStreamDispatch;
}): Promise<UploadedAttachment> {
  const parentStreamId = evidenceStreamId(input.upload.entityRef);
  let attachedEvents = 0;
  const result = await uploadAttachment(
    {
      dispatch: async (streamId, event) => {
        if (streamId !== parentStreamId) return input.contentDispatch(streamId, event);
        if (event.type !== "evidence.attached" || attachedEvents !== 0) {
          throw new Error("upload must append exactly one evidence.attached event");
        }
        attachedEvents += 1;
        return input.parentDispatch(event);
      },
      read: async () => {
        throw new Error("upload does not read evidence streams");
      },
    },
    input.upload,
  );
  if (attachedEvents !== 1) throw new Error("upload omitted evidence.attached");
  return result;
}
