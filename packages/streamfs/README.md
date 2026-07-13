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
fs.file.write  { v: 2, path, base, contentSha256, size }
fs.file.delete { v: 2, path }
fs.file.patch  { v: 2, path, base, baseDigest, ops, resultDigest }
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
  "files": {
    "path": {
      "contentStreamId": "...",
      "contentSha256": "...",
      "size": 0,
      "lastContentOffset": "BASE_NONE"
    }
  },
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
changed the state shape and file-delete semantics. Adding `fs.file.patch` under the
current v2 envelope is additive and does not invalidate old logs. Any later change to
the patch payload, op grammar, refusal taxonomy, or fallback rule is a contract change:
bump `FS_EVENT_VERSION` and regenerate every fs golden, including the patch fixtures.

## Text patches (E1-T03)

`fs.file.patch` is a byte-level edit over the current content. `ops` is a canonical JSON
array of `=[positive safe integer]`, `+[non-empty Unicode scalar string]`, and
`-[positive safe integer]` tuples. Adjacent tuples of the same kind are rejected, and
the `=` plus `-` lengths must exhaust the base byte length exactly. Inserts are encoded
as UTF-8 and may not contain unpaired surrogates; the patched result must be valid UTF-8
and contain no NUL byte. `baseDigest` and `resultDigest` are lowercase SHA-256 digests
of the exact base and result bytes.

The writer emits a patch only when both versions are text and
`patchWireBytes < fullWireBytes`, using these exact costs:

```text
fullWireBytes = byteLength(canonicalJson(fullWritePayload)) + targetBytes.byteLength
patchWireBytes = byteLength(canonicalJson(patchPayload))
```

The full-write side includes the content-stream append; a binary target, invalid UTF-8,
NUL-containing text, malformed patch, or non-winning size comparison falls back to
`fs.file.write`. Dispatch and replay refuse, with log-neutral behavior at the dispatch
door, at least `patch/malformed-ops`, `patch/base-mismatch`,
`patch/result-mismatch`, and `patch/target-not-a-text-file`.

`fs.file.content` events live on per-file content streams and include their
`contentStreamId`. Combined replay fixtures use that identity to pair content bytes
with metadata events; the reducer applies patch ops to the tracked bytes instead of
trusting `resultDigest`. The deterministic diff and apply implementation is exported
from the package for fixture and parity harnesses.

## Server registration and replay

Use `createStreamFsServerOptions()` (or the individual registration helpers) when
constructing `createHttpServer`:

```ts
const server = createHttpServer(store, createStreamFsServerOptions());
```

The helper binds `fsReducer` to `fs-meta` with explicit version `fs-v2` and registers
dispatch validators for all seven metadata actions and their schema, parent, collision,
emptiness, rename, and patch preconditions. Every precondition is also enforced by the pure reducer, so
a raw stream append that bypasses `/dispatch` makes `GET /state` and `ef replay` fail at
the offending event rather than silently folding invalid history.

The standalone reducer entry point is `packages/streamfs/reducer.mjs` after the
workspace build. It is the module used by the evidence command:

```text
ef replay evidence/golden-dirs.jsonl --digest --reducer packages/streamfs/reducer.mjs
```

The module exports `reducer` and `initialState` for `ef replay --reducer`.

## Stale-write fencing (E1-T04)

Every `fs.file.write` and `fs.file.patch` action carries a mandatory string `base`.
It is the metadata-stream offset of the last accepted content-affecting event for
that path, recorded in the reduced file state as `lastContentOffset`. A path with no
content history uses the exported `BASE_NONE` sentinel. The revision is an offset,
not a content digest, so an ABA sequence (X, Y, X) still has three distinct
revisions.

The dispatch validator requires an exact match. A mismatch is HTTP 409 with
`error.class = "validator-rejected"`, `error.reason = "stale-base"`, and
`error.conflict = { path, expectedBase, actualBase }`; the metadata stream is not
appended. Missing or non-string `base` is a schema violation (HTTP 422), before the
stale validator runs. The raw `Stream-Seq` fence remains underneath this per-path
content fence.

The edge rules are frozen as follows:

- `BASE_NONE` is accepted only by the first full write after create or recreate.
- A patch may never declare `BASE_NONE`, because a diff against no content is not a
  valid patch base.
- Deleting a file and recreating the same path creates a fresh content identity and
  resets its revision to `BASE_NONE`.
- Renaming a live file is not content-affecting: its `lastContentOffset` moves with
  the file identity, and the next write at the new path declares that same offset.
