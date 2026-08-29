# `@eforest/workspace`

`@eforest/workspace` freezes the version-1 state kept in a worktree's root
`.ef/workspace.json`. It is deliberately a small, local format: it has no network,
authentication, watcher, or StreamFS dispatch behavior. `save(dir, state)` writes the
canonical bytes atomically and `load(dir)` either returns a fully validated state or a
typed `WorkspaceFormatError`; it never supplies defaults for missing or corrupt data.

## Version 1 layout

The file is canonical JSON followed by exactly one LF:

```json
{
  "files": {
    "src/app.ts": {
      "base": "BASE_NONE",
      "contentSha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "size": 0
    }
  },
  "headOffset": "-1",
  "identity": {
    "branch": "main",
    "metadataStreamId": "metadata-main",
    "project": "demo",
    "repo": "repo",
    "server": "https://example.test"
  },
  "v": 1
}
```

The root `v` is `EF_WORKSPACE_VERSION` (`1`). `identity` records the server URL,
project, repository, branch, and metadata stream id. `headOffset` is the last stream
offset fully materialized into the directory (`-1` means before the first event).
`files` is the per-path base ledger. Each `base` is either `BASE_NONE` for a file with
no prior content revision or a well-formed E1-T04 stream offset from which the local
copy was materialized; arbitrary revision strings are refused. `contentSha256` and
`size` describe the bytes currently on disk. Paths use the same NFC, slash-separated
StreamFS path rules.

Only the root `.ef/` directory is reserved; `ef tree-digest` excludes it from the
worktree projection, while a nested `sub/.ef/` is ordinary content. Empty directories
are not represented in the content projection, so creating or removing an otherwise
empty directory does not change the digest. A case-insensitive filesystem that cannot
construct two distinct case-only names simply has one on-disk entry; if both names are
present on a case-sensitive filesystem they are distinct canonical paths and both enter
the projection.

The projection excludes only the session-scoped StreamFS `contentStreamId` bookkeeping
field and filesystem metadata (mtime, mode, owner, inode, traversal order). Any change
to bytes, path, or file set changes the digest. Changing this format or projection
requires bumping its version and regenerating every Epic-4 golden; consumers must refuse
unknown versions rather than silently interpreting them.

`save` writes a uniquely named temporary file in `.ef/`, flushes and fsyncs it, renames
it over `workspace.json`, and fsyncs the directory. An injected
`EFOREST_WORKSPACE_FAILPOINT=after-fsync` throws before rename for crash-atomicity tests;
the existing state remains intact.
