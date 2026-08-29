# `ef` CLI credentials

`ef login [--no-browser]` performs RFC 8628 device authorization against
`EF_OIDC_ISSUER` / `EF_OIDC_CLIENT_ID`, registers the redeemed JWT as an event-backed
device grant at `EF_SERVER_URL`, and writes `$EF_HOME/credentials.json` (default
`~/.eforest/credentials.json`) with mode `0600`. Polling honors the issuer interval;
`slow_down` increases it by at least five seconds. `ef logout` deletes the file.

Every authenticated command loads credentials before making a request and injects the
Bearer header. `ef dispatch <stream-id> <event-json>` is the first such command. Missing
credentials are refused locally, including when the platform is unreachable.

`ef init [--org <org>] [--project <name>] [--repo <name>] [--visibility public|private]`
adopts the current directory (or an explicitly supplied directory) through the
authenticated dispatch door. The tree-upload engine is shared with later uplink work;
the `.ef/workspace.json` checkpoint is written only after an independent replay digest
matches the local E4-T01 worktree digest. `EF_STREAM_SERVER_URL` may be supplied when the
platform and official Durable Streams endpoints are separate in a local harness.

## `ef status`

`ef status` discovers the nearest ancestor containing `.ef/workspace.json`, compares the
working tree with that checkpoint's base ledger by SHA-256 content, and performs a
read-only official Durable Streams application-offset read of the branch metadata stream.
The base ledger's `size` and filesystem mtimes never classify a path; a rename is reported
as one deletion and one addition. The root `.ef/` directory is excluded by the shared
E4-T01 walker. `EF_STREAM_SERVER_URL` (then `EF_SERVER_URL`, `EFOREST_SERVER_URL`, or
`EF_SERVER`) selects the official stream endpoint; credentials are optional for public
streams and, when present, are sent as a bearer header.

`ef status --json` writes exactly one canonical JSON line with version `2`:

```json
{
  "baseTreeDigest": "<sha256>",
  "behindBy": 0,
  "branch": "main",
  "checkpointOffset": "<offset>",
  "clean": true,
  "headOffset": "<offset>",
  "paths": { "added": [], "deleted": [], "modified": [], "conflicted": [] },
  "streamId": "<stream-id>",
  "v": 2,
  "workingTreeDigest": "<sha256>"
}
```

`--offline` never probes the server and sets `headOffset` and `behindBy` to `null`.
Missing or malformed workspace state, invalid worktree entries, and an unreachable head
probe return nonzero with an empty stdout; an online head probe is bounded to ten seconds.
The command does not write `.ef/`, the worktree, or the branch stream.

## Uplink sync

`ef watch --up` runs the local-to-branch engine from an adopted workspace. It uses a
real `chokidar` watcher with `atomic: false`, ignores `.ef/**`, and debounces events
before passing them through the pure `coalesce(pendingFsEvents, ledgerView)` planner.
`--debounce <ms>` controls that window; `--quiesce` waits for the window to drain and
returns `0` only when every accepted mutation is journaled and `ef status --json` is
clean. A quiescent run with one or more stale-base refusals returns `3`.

The append-only `.ef/journal.jsonl` has one canonical JSON line per metadata dispatch:

```json
{"action":"fs.file.patch","base":"0000000000000000_0000000000000010","kind":"accepted","offset":"0000000000000000_0000000000000011","path":"src/app.ts","seq":1}
{"action":"fs.file.write","base":"0000000000000000_0000000000000010","conflict":{"actualBase":"0000000000000000_0000000000000012","expectedBase":"0000000000000000_0000000000000011","path":"src/app.ts"},"kind":"refused","path":"src/app.ts","seq":2}
```

Each accepted dispatch receives its authoritative application offset from the
authenticated dispatch door. The engine fsyncs the journal line, emits the same record
to `ef watch` stdout, and only then advances `.ef/workspace.json`; a refusal is fsynced
with the literal `stale-base` conflict and never advances the ledger. A crash between
those two writes therefore leaves provenance that the later offline-recovery task can
reconcile, never a silently advanced base.

Coalescing is pinned as follows: rapid writes to one path become one final patch/write;
create-then-delete with no ledger history produces nothing; write-then-delete of an
existing path produces one delete; and a local rename is deliberately delete plus
create/full-write, never an inferred stream rename. Flushes order directories before
their contents, then deletes, creates, writes, and directory removals using UTF-8 path
order. The ignored editor artifacts are basenames ending in `~`, starting with `.#`,
ending in `.swp` or `.swo`, or ending in `.tmp`; a similarly named real file such as
`notes.tmpx` is not ignored. A dirty tree at startup is classified by E4-T04 and
uploaded as its first flush using the same rules; no head read is used to fabricate a
content base.

The JSON fields are frozen as follows: `branch`, `streamId`, and `checkpointOffset` come
from `.ef/workspace.json`; `headOffset` is the last application event offset observed
from the official read and `behindBy` is the exact number of application events after
the checkpoint (both are `null` offline); `clean` is true exactly when all four path
arrays are empty; `baseTreeDigest` is the E4-T01 digest of the ledger projection and
`workingTreeDigest` is the same digest recipe over the current worktree. Paths are
workspace-root-relative, `/`-separated, sorted by UTF-8 bytes, and classify by content
SHA-256 only: `.ef/` is excluded, an mtime-only change is clean, a rename is one added
plus one deleted path, and size alone never makes a path modified.

The status goldens under `E4-T04-ef-status/evidence/golden-status/` are frozen artifacts.
`normalize.map` may document volatile identifiers only; `behindBy`, `clean`, both
digests, and every path array are compared byte-for-byte. Adding, removing, renaming, or
changing the meaning of any JSON field requires incrementing `STATUS_JSON_VERSION` and
regenerating every committed status golden deliberately in the same change.

For status, exit `0` means a report was produced (including a dirty or offline report),
exit `1` means workspace, worktree, credential, or head-probe refusal with empty stdout,
and exit `2` means invalid `ef status` flags. Machine consumers should use `--json`; the
human output is intentionally not a frozen interface.

## Conflict surfacing

When a stream event and unsynced local bytes address the same path, the stream wins the
working-tree path and the local bytes are preserved as the sibling
`<path>.conflict-<offset>`. The winning offset is opaque: ASCII bytes in
`[A-Za-z0-9._-]` pass through and every other UTF-8 byte is encoded as uppercase `%XX`.
The loser file is written and fsynced through `.ef/tmp/` before the winning path is
overwritten or removed. Repeating the same collision with identical bytes is idempotent;
different bytes at the same name are a hard error.

Content-vs-modify and content-vs-add preserve the local bytes; delete-vs-modify and
delete-vs-add remove the contested path and preserve the bytes. Equal bytes, delete-vs-delete,
content-vs-delete, and the engine's own journal echo produce no conflict file. A file/directory
type collision preserves each displaced local file under its own conflict name. Conflict files
are normal files and sync through the ordinary fenced journal; deleting one accepts the stream,
while copying it back recovers the local version.

After the conflict file is accepted, one tree-neutral `sync/conflict` event is announced with
canonical payload `{path, conflictFile, winningOffset, loserSha256}`. `ef status --json`
reports conflict files in UTF-8 order under `paths.conflicted` as
`{path, conflictFile, offset}` and does not count them as added, modified, or deleted paths.

## Frozen exit codes

## Offline catch-up

`ef watch --catchup-only` performs the stopped-watcher reconcile and exits without
starting a live tail. Reconciliation is ordered as journal repair, bounded downlink,
then ledger-based uplink. Journal repair confirms accepted offsets already assigned by
the branch and never re-dispatches them; an unassigned journal offset fails closed with
exit `4`. A stale-base refusal is recorded and returns exit `3`, while a clean reconcile
returns `0`.

Each decision is one canonical JSON line in `.ef/reconcile.jsonl`, using the frozen
shapes `{phase, action, path?, offset?, base?}`. The summary printed by
`--catchup-only` is one canonical JSON line containing `repaired`, `applied`,
`dispatched`, `refused`, and `checkpoint: {from, to}`. Offline detection compares file
content against the `.ef` ledger; mtimes and directory enumeration order do not affect
the plan.

| exit code | meaning                                                       |
| --------: | ------------------------------------------------------------- |
|       `0` | success                                                       |
|       `1` | status or other command refusal                               |
|       `2` | command usage error                                           |
|      `10` | no credentials; no request made                               |
|      `11` | device flow `expired_token`                                   |
|      `12` | device flow `access_denied`                                   |
|      `13` | server refused the presented credential with a typed 401      |
|      `14` | `init/already-initialized`; `.ef/` already exists             |
|      `15` | `init/digest-mismatch`; replay differs from the worktree      |
|      `16` | `init/workspace-path-conflict`; root `.ef` is not a directory |

## Platform refusal classes

| class                   | status |
| ----------------------- | -----: |
| `token-revoked`         |    401 |
| `web-session-required`  |    401 |
| `grant-already-revoked` |    409 |
| `grant-not-found`       |    404 |
