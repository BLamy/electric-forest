# Issues and derived views

Issue event envelope v1 remains the E5-T01 contract. In particular,
`issue.labeled` and `issue.unlabeled` carry the field `label`; E5-T03 defines
that frozen field's value as a `labelId`. It is not renamed to `labelId`.

Each repo has a `repo-labels:<org>/<repo>` stream reduced by `repo-labels`
version 1. Its events are `label.created {v,labelId,name,color}`,
`label.renamed {v,labelId,name}`, and
`label.recolored {v,labelId,color}`. IDs are path-safe opaque strings.
Names use exact byte equality: no case folding or Unicode normalization.
Labels cannot be deleted or archived in v1. The standalone reducer is built at
`packages/issues/label-reducer.mjs` and can be used with:

```sh
ef replay <label-dump> --digest --reducer packages/issues/label-reducer.mjs
```

The server records validated first-open discovery in the explicit authoritative
`repo-issues:<org>/<repo>` stream. Each `repo.issue-observed` event binds an
issue stream ID to the exact source offset intended for its first
`issue.opened`. This stream exists because the provider API has no stream
enumeration operation. It is not a hidden file or database: it is an
append-only, replayed stream, and it is included in endpoint provenance. A
catalog is gateway-internal: public dispatch classifies every `repo-issues:`
target as internal and refuses before writer-lane append; only the materializer
writes it through the provider adapter while validating an accepted issue open.
A catalog entry whose target append never completes contributes no issue because
an unopened stream is excluded by `deriveBoard`.
Catalog replay requires every declared issue stream to belong to the catalog's
exact org/repo and requires the declared `sourceOffset` to equal the first
accepted `issue.opened` record's offset. Empty write-ahead entries are pending
and ignored, including when the provider append fails or an authorization
liveness fence cancels the opening after validation. The pending declaration is
a durable intent, not a claim that the issue opened: a later authorized retry
fills the same declaration without appending another catalog event. A nonempty
target that does not open at the declared offset is corruption.

There is deliberately no pretend migration based on identity journals or
provider listing: issue streams opened before E5-T03 cannot be discovered
retroactively because the provider exposes no enumeration API. They require an
explicit, source-attested migration that writes the correct catalog declaration.
Until then, subsequent dispatch to such a stream fails closed with
`repo-issues/migration-required`.

## List-view registry

| View            | Version | Inputs                                                              |
| --------------- | ------: | ------------------------------------------------------------------- |
| `issue-board@1` |       1 | repo issue catalog, repo label stream, discovered per-issue streams |

`BOARD_VIEW_VERSION = 1` freezes five always-present columns (`open`,
`in-progress`, `done`, `closed`, `wont-do`), each shaped
`{count,issues}`; the full label catalog shaped
`{labelId:{name,color,issues}}`; and the top-level
`{v,reducer,columns,labels}`. Every issues array is sorted by raw UTF-8 bytes,
every count equals its array length, and every opened issue appears in exactly
one workflow column. `filterBoard(board, labelId)` accepts IDs only, refuses
unknown IDs, and intersects every column and label-membership array with the
selected label's members.

The board digest is SHA-256 over `@eforest/protocol` canonical JSON. Endpoint
provenance lists every consumed stream and exact offset, including empty input
heads as `-1`. The server always maintains a deletable in-memory materialized
copy. When `boardCacheDir` (production `EF_BOARD_CACHE_DIR`) is configured,
it also writes the optional snapshot
`<boardCacheDir>/<percent-encoded-org>%2F<percent-encoded-repo>.json`. Both are
disposable and neither supplies source discovery or served truth. Every read
checks the private reduced state against its board, digest, and provenance and
checks those private heads against the authoritative streams. A valid warm copy
is served without reducing the logs again. The first accepted dispatch after
startup bootstraps by cold replay; later accepted label and issue dispatches
apply exactly their one gateway-validated event to private reducer state and
advance the exact source heads (including the issue catalog head for a new
issue). An absent, stale, or internally inconsistent copy triggers cold replay,
which also overwrites an absent/corrupt/poisoned snapshot. The endpoint returns
exactly `{board,digest,provenance}` in canonical JSON. Snapshot I/O failure is
recorded by the materializer but cannot turn an already-committed dispatch into
a false refusal.

Any field addition, removal, rename, ordering change, or semantic change bumps
`BOARD_VIEW_VERSION`, names a new reducer, and regenerates every dependent
golden. Human-friendly sequential issue numbering is intentionally not part of
v1; any future numbering surface is a separately registered derived view.
