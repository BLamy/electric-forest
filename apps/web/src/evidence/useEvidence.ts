import {
  evidenceContentStreamId,
  evidenceStreamId,
  type AttachmentListState,
  type ContentEvidenceKind,
  type ContentState,
  type EvidenceEntityRef,
  type EvidenceEntityType,
  type UploadedAttachment,
} from "@eforest/evidence";
import {
  postDispatch,
  useDispatch,
  useStreamReducer,
  type DispatchFunction,
  type StreamReducerResult,
} from "@eforest/web-hooks";
import { dispatchEvidenceUpload } from "./model.js";

const EVIDENCE_REDUCER = "evidence" as const;
const EVIDENCE_CONTENT_REDUCER = "evidence-content" as const;

function encoded(value: string): string {
  return encodeURIComponent(value);
}

export interface EvidenceBinding {
  readonly entityRef: EvidenceEntityRef;
  readonly streamId: string;
  readonly reducerId: typeof EVIDENCE_REDUCER;
  readonly projection: StreamReducerResult<AttachmentListState>;
  readonly dispatch: DispatchFunction;
}

export interface EvidenceContentBinding {
  readonly streamId: string;
  readonly reducerId: typeof EVIDENCE_CONTENT_REDUCER;
  readonly projection: StreamReducerResult<ContentState>;
}

export function useEvidence(
  org: string,
  repo: string,
  entityType: EvidenceEntityType,
  entityId: string,
): EvidenceBinding {
  const entityRef: EvidenceEntityRef = { org, repo, entityType, entityId };
  const streamId = evidenceStreamId(entityRef);
  const projection = useStreamReducer<AttachmentListState>({
    apiPath: `/api/repos/${encoded(org)}/${encoded(repo)}/main/events?stream=evidence&entityType=${encoded(entityType)}&entityId=${encoded(entityId)}`,
    streamId,
    reducerId: EVIDENCE_REDUCER,
    followWaitMs: 500,
    reconnectDelayMs: 100,
  });
  const dispatch = useDispatch(streamId, { replayedOffset: projection.checkpoint });
  return { entityRef, streamId, reducerId: EVIDENCE_REDUCER, projection, dispatch };
}

export function useEvidenceContent(
  org: string,
  repo: string,
  attachmentId: string,
): EvidenceContentBinding {
  const streamId = evidenceContentStreamId(org, repo, attachmentId);
  const projection = useStreamReducer<ContentState>({
    apiPath: `/api/repos/${encoded(org)}/${encoded(repo)}/main/events?stream=evidence-content&attachmentId=${encoded(attachmentId)}`,
    streamId,
    reducerId: EVIDENCE_CONTENT_REDUCER,
    followWaitMs: 500,
    reconnectDelayMs: 100,
  });
  return { streamId, reducerId: EVIDENCE_CONTENT_REDUCER, projection };
}

export async function uploadEvidence(
  binding: EvidenceBinding,
  input: {
    readonly attachmentId?: string;
    readonly kind: ContentEvidenceKind;
    readonly name: string;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
  },
): Promise<UploadedAttachment> {
  return dispatchEvidenceUpload({
    upload: {
      entityRef: binding.entityRef,
      ...(input.attachmentId === undefined ? {} : { attachmentId: input.attachmentId }),
      kind: input.kind,
      name: input.name,
      mediaType: input.mediaType,
      bytes: input.bytes,
    },
    parentDispatch: binding.dispatch,
    contentDispatch: (streamId, event) => postDispatch(streamId, event),
  });
}
