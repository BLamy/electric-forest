# `@eforest/streamfs`

`@eforest/streamfs` is the Epic-1 filesystem entity built on the E0 durable-stream
engine. A repository named `alpha` has one metadata stream,
`fs:alpha:main:meta`, with stream type `fs-meta`, and one content stream per file:
`fs:alpha:main:file:<fileId>`. Metadata mutations go through
`POST /streams/<meta-id>/dispatch`; content bytes are stored as events on the
per-file content stream.

## Frozen contract

`FS_EVENT_VERSION` is `1`. Metadata events are protocol `Event` envelopes with exactly
these payloads:

```text
fs.file.create  { v: 1, path, contentStreamId }
fs.file.write   { v: 1, path, contentSha256, size }
fs.file.delete  { v: 1, path }
```

Payloads reject extra fields, missing fields, wrong types, unknown versions, and
unknown `fs.*` event types. Paths are slash-separated Unicode scalar strings already
in NFC form. They have no leading or trailing slash, no empty, `.` or `..` segment,
and no NUL. Dispatch never normalizes a path.

The reduced tree is exactly:

```json
{ "files": { "path": { "contentStreamId": "...", "contentSha256": "...", "size": 0 } } }
```

Keys in `files` are maintained lexicographically. Deletes remove the key. The tree
digest is `treeDigest(state) === stateDigest(state)` from `@eforest/protocol`: the
lowercase SHA-256 of canonical JSON. It hashes the reduced metadata, including the
recorded content hash and size; it does not independently hash live content bytes.
`readFile()` performs that separate byte-integrity check and raises
`ContentIntegrityError` on mismatch.

Changing either the event envelope or tree-state recipe requires bumping
`FS_EVENT_VERSION` and regenerating every committed fs golden deliberately. The
state-preserving sensitivity carve-outs are explicit: payload bytes of a shadowed
write, swaps of adjacent commuting events (for example writes to different existing
paths), duplicate idempotent writes, and envelope `ts` changes. A mutated log must
still be independently folded before a carve-out is accepted.

## Server registration and replay

Use `createStreamFsServerOptions()` (or the individual registration helpers) when
constructing `createHttpServer`:

```ts
const server = createHttpServer(store, createStreamFsServerOptions());
```

The helper binds `fsReducer` to `fs-meta` with explicit version `fs-v1` and registers
dispatch validators for the three actions and their existence preconditions. The
standalone reducer entry point is `packages/streamfs/reducer.mjs` after the workspace
build. It is the module used by the evidence command:

```text
ef replay evidence/golden-fs.jsonl --digest --reducer packages/streamfs/reducer.mjs
```

The module exports `reducer` and `initialState` for `ef replay --reducer`.
