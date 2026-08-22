# Issue event model

Issue streams use `issue:<org>/<repo>/<opaque-issue-id>`. Version 1 has seven
actions: `opened`, `commented`, `labeled`, `unlabeled`, `state-changed`, `closed`,
and `reopened`; every payload contains `v: 1`. At the HTTP boundary this version is
source-sensitive: the payload's JSON number token must be exactly `1`; spellings such
as `1.0` and `1e0` are schema violations even though `JSON.parse` would normalize them
to the same JavaScript number. A structural JSON token/path scanner follows
`event.payload.v` and JSON's last-key-wins behavior rather than matching text, so
whitespace, escaped keys, nested `v` keys, and `"v"` text inside strings are unambiguous.
An issue dispatch request is at most 10,485,760 raw bytes, inclusive.
After authentication, authorization, and known-action classification, these static
source rules are checked before writer-lane idempotency recovery can return an existing
receipt. Full parsed-envelope and workflow validation remains inside the writer lane.

Every issue payload string is at most 1,048,576 UTF-16 code units, a bounded maximum
comfortably below 10 MiB. U+0000 and every UTF-16 surrogate code unit (including valid
pairs representing astral-plane code points) are schema violations. Empty strings and
all other BMP text remain valid. These source, size, and character rules
are part of envelope version 1 and apply to `title`, each `body`, `commentId`, `label`,
`to`, and optional `reason` before workflow validation. The reducer state is the frozen
canonical shape `{v, issueId, title, body, state, labels, comments}`. The
`WORKFLOW_TRANSITIONS` export is the sole transition table and is consumed by
both the reducer-facing validator and callers.

The exhaustive matrix is:

| state       | opened | commented   | labeled     | unlabeled   | state-changed              | closed | reopened |
| ----------- | ------ | ----------- | ----------- | ----------- | -------------------------- | ------ | -------- |
| open        | refuse | open        | open        | open        | any other non-closed state | closed | refuse   |
| in-progress | refuse | in-progress | in-progress | in-progress | any other non-closed state | closed | refuse   |
| done        | refuse | done        | done        | done        | any other non-closed state | refuse | open     |
| closed      | refuse | closed      | closed      | closed      | refuse                     | refuse | open     |
| wont-do     | refuse | wont-do     | wont-do     | wont-do     | any other non-closed state | refuse | open     |

`state-changed` additionally refuses self-transitions and `to: closed`; label,
unlabel, and comment uniqueness are validator checks, not reducer side effects.
When replay is given a malformed or illegal-but-present issue event, the pure reducer
keeps the prior state as a deterministic no-op. It carries a non-serialized opened
marker from the initial state so an empty `issue.opened` payload is still recognized
as opened on the next event; the marker is excluded from the canonical state shape.

`issue-reducer.mjs` is the offline adapter:

```sh
ef replay <dump> --digest --reducer packages/platform/issues-reducer.mjs \
  --stream-id issue:<org>/<repo>/<opaque-issue-id>
```

The explicit stream identity initializes the frozen `issueId` state field in exactly
the same way as application projection bootstrap. It is never inferred from a filename,
cwd, environment variable, or event payload, so online and offline state digests remain
byte-identical without weakening the seven-action envelope.

Epic 6 may add event types only with an envelope version bump and regenerated
goldens. Browser evidence is intentionally not applicable to this server/library
module; the browser write path is E5-T04.
