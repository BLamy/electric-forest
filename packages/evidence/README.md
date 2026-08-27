# `@eforest/evidence`

Frozen v1 evidence contracts and transport-independent helpers for Electric Forest.
The package owns event shapes, pure reducers, validators, and upload/download
orchestration. It does not own HTTP routes, authorization, persistence, or registry
wiring.

## Frozen stream ids

| Stream           | Pattern                                         | Purpose                                   |
| ---------------- | ----------------------------------------------- | ----------------------------------------- |
| Attachment list  | `evidence:<org>/<repo>/<entityType>/<entityId>` | Evidence belonging to one `issue` or `pr` |
| Artifact content | `evidence-content:<org>/<repo>/<attachmentId>`  | Immutable chunked bytes for one upload    |

`org` and `repo` use the repository name grammar. `entityId` and `attachmentId`
are non-empty path-safe identifiers containing only `A-Z a-z 0-9 . _ ~ -`.
New entity types are additive only under a contract version bump.

`parseEvidenceStreamIdentity` intentionally accepts a path-safe, unsupported
`entityType`. Authorization uses this loose parser to classify the target as repo-scoped,
then semantic validation returns `evidence/unknown-entity-type`. The strict
`parseEvidenceStreamId` and `isEvidenceStreamId` accept only `issue | pr`.

## Frozen v1 events

All payloads contain exactly the listed fields. Unknown fields are schema violations.

| Type                | Payload fields                                                                         |
| ------------------- | -------------------------------------------------------------------------------------- |
| `content.chunk`     | `v: 1`, `seq`, `bytes` (canonical standard base64)                                     |
| `content.sealed`    | `v: 1`, `sha256`, `size`, `chunks`                                                     |
| `evidence.attached` | `v: 1`, `attachmentId`, `kind`, `name`, `mediaType`, `size`, `sha256`, `contentStream` |
| `evidence.linked`   | `v: 1`, `attachmentId`, `kind: "replay-recording"`, `url`, optional `title`            |
| `evidence.waived`   | `v: 1`, non-blank `justification`                                                      |
| `evidence.detached` | `v: 1`, `attachmentId`                                                                 |

Content kinds are `event-log`, `digest`, and `rr-trace`. Reference kind is
`replay-recording`. Reference URLs are at most 2048 characters and must be
`https://app.replay.io/recording/<id>` URLs; point/time query parameters are allowed.

## Content lifecycle and limits

Chunks are consecutive from `seq: 0`. Each decoded chunk is at most 512 KiB and the
decoded stream total is at most 16 MiB. Empty artifacts are legal: they have zero
chunks and seal with the SHA-256 of empty bytes. Exactly one valid seal terminates the
stream. The validator recomputes size and SHA-256 from decoded chunks before accepting
the seal. The reducer always derives `sha256` from decoded bytes through
`@eforest/protocol`'s sanctioned `sha256Hex`; it never copies the seal claim.

The reduced content shape is:

```ts
interface ContentState {
  v: 1;
  size: number;
  chunks: number;
  sha256: string;
  sealed: boolean;
  sealError?: "chunk-out-of-order" | "size-mismatch" | "digest-mismatch";
}
```

Door-illegal chunks and post-seal events are deterministic no-ops. A hand-built dump
with a lying seal remains unsealed and records the deterministic `sealError`; reduction
never throws. Replay-derived bytes are held as non-enumerable reducer state so the
public/canonical state shape remains frozen.

## Attachment list

The reduced attachment state is:

```ts
interface AttachmentListState {
  v: 1;
  entityRef: string;
  attachments: readonly Array<{
    attachmentId: string;
    type: "content" | "reference";
    kind: "event-log" | "digest" | "rr-trace" | "replay-recording";
    attachedAtOffset: Offset;
    detachedAtOffset?: Offset;
    // content or reference metadata, according to type
  }>;
}
```

Entries remain in event-offset order. Detach sets an offset tombstone; it never removes
history. `evidence.waived` remains an event-level declaration consumed by merge policy
and does not synthesize an attachment.

## Frozen validator refusals

All semantic refusals are `EvidenceRefusalError` with exactly one reason:

- `evidence/unknown-entity`
- `evidence/duplicate-attachment-id`
- `evidence/unknown-attachment`
- `evidence/already-detached`
- `evidence/unsealed-content`
- `evidence/content-not-found`
- `evidence/digest-mismatch`
- `evidence/size-mismatch`
- `evidence/oversized`
- `evidence/chunk-out-of-order`
- `evidence/sealed-terminal`
- `evidence/invalid-url`
- `evidence/unknown-kind`
- `evidence/unknown-entity-type`

Malformed known actions throw `EvidenceSchemaError`; unknown actions throw
`EvidenceUnknownActionError`. Platform code maps these package errors to the frozen
E0-T11 response classes/statuses.

## Gateway composition

Register `attachmentReducerDefinition` for `evidence` and
`contentReducerDefinition` for `evidence-content`. Register every member of
`evidenceActionValidators` at the dispatch door. The validation context provides one
async `resolveStream(streamId)` function returning records and, optionally, a projected
state. The package uses it for both owner existence and sealed-content checks and falls
back to replaying records itself.

Gateways may call `validateEvidenceAction` for the shared door, or the narrower
`validateEvidenceAttachmentAction` / `validateEvidenceContentAction` entry points after
they have routed by strict stream type. All three use the same context and typed errors.

`uploadAttachment` and `downloadAttachment` depend only on injected `dispatch` and
`read` functions. Upload dispatches chunks, a seal, then the attachment event. It does
not roll back already accepted chunks after an external transport failure; callers may
retry only according to the platform's operation-id/sequence semantics.

Kinds and entity types are frozen. Adding either requires a version bump and
regeneration of every evidence golden; silently widening the arrays is not compatible.
