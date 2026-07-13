# `@eforest/streamfs`

`@eforest/streamfs` is the Epic-1 filesystem entity built on the E0 durable-stream
engine. A repository named `alpha` has one metadata stream,
`fs:alpha:main:meta`, with stream type `fs-meta`, and one content stream per live
file. Metadata mutations go through `POST /streams/<meta-id>/dispatch`; content bytes
are events on the per-file content stream.

## Frozen v2 contract

`FS_EVENT_VERSION` is `2`. Every metadata payload has exactly the shape below:

```text
fs.dir.create  { v: 2, path }
fs.dir.remove  { v: 2, path }
fs.rename      { v: 2, from, to }
fs.file.create { v: 2, path, contentStreamId }
fs.file.write  { v: 2, path, contentSha256, size }
fs.file.delete { v: 2, path }
```

Payloads reject extra fields, missing fields, wrong types, unknown versions, and
unknown `fs.*` event types. Paths are slash-separated Unicode scalar strings already
in NFC form. They have no leading or trailing slash, no empty, `.` or `..` segment,
and no NUL. Dispatch never normalizes a path.

Parents are strict: every non-top-level file or directory create requires its parent
to be an explicit live directory. The root is implicit. `fs.dir.remove` is empty-only;
tombstones do not count as entries. `fs.rename` moves either a file or a directory in
one event, refuses missing sources, occupied destinations, missing target parents, and
directory self-descendants, and keeps every moved file's content-stream identity and
recorded metadata byte-for-byte. Tombstones are historical records and remain at their
original keys during a directory move; a tombstone at the exact rename destination is
cleared.

Deleting a file removes its live file entry and records
`tombstones[path] = { contentStreamId }`. Recreating that path clears the tombstone and
uses the event's fresh content-stream identity. Creating a directory at a tombstoned
path also clears the tombstone. A tombstone never appears in `listTree()`.

The reduced tree is exactly:

```json
{
  "files": { "path": { "contentStreamId": "...", "contentSha256": "...", "size": 0 } },
  "dirs": { "path": {} },
  "tombstones": { "path": { "contentStreamId": "..." } }
}
```

All three maps are always present and key-sorted. A path is in at most one live map or
tombstone map. `treeDigest(state) === stateDigest(state)` from `@eforest/protocol`:
the lowercase SHA-256 of canonical JSON. It hashes reduced metadata, including the
recorded content hash and size; `readFile()` separately verifies live content bytes.

`listTree(state)` returns one row per live directory or file. Rows sort by full-path
segments, comparing each segment as raw UTF-16 code units and placing an ancestor
before descendants:

```text
D a
D a/b
F a/b/file.txt <sha256> <size>
F a! <sha256> <size>
```

This listing order is intentionally independent from canonical-JSON key sorting for
the digest. The function consumes only reduced state: no log, I/O, locale, clock, RNG,
or environment.

Changing an existing event schema, reducer semantic, or tree-state/digest recipe
requires a deliberate version bump and regeneration of every committed fs golden. The
v1 goldens were regenerated to v2 in E1-T02 because directory entities and tombstones
changed the state shape and file-delete semantics. Adding a new `fs.*` event type under
the current version is additive and does not invalidate old logs.

## Server registration and replay

Use `createStreamFsServerOptions()` (or the individual registration helpers) when
constructing `createHttpServer`:

```ts
const server = createHttpServer(store, createStreamFsServerOptions());
```

The helper binds `fsReducer` to `fs-meta` with explicit version `fs-v2` and registers
dispatch validators for all six actions and their schema, parent, collision, emptiness,
and rename preconditions. Every precondition is also enforced by the pure reducer, so
a raw stream append that bypasses `/dispatch` makes `GET /state` and `ef replay` fail at
the offending event rather than silently folding invalid history.

The standalone reducer entry point is `packages/streamfs/reducer.mjs` after the
workspace build. It is the module used by the evidence command:

```text
ef replay evidence/golden-dirs.jsonl --digest --reducer packages/streamfs/reducer.mjs
```

The module exports `reducer` and `initialState` for `ef replay --reducer`.
