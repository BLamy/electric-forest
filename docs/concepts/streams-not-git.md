---
title: Streams, not git
section: Concepts
order: 1
summary: Repositories, branches, and files as append-only streams.
---

# Streams, not git

There is no `.git` directory anywhere in electric-forest. A repository is a set of
**Durable Streams**, and a stream is an append-only log of application events with
canonical offsets.

## The main stream

Each repository has one metadata stream per branch, named like
`fs:maple/reading-room:main:meta`. Every event on it describes a change to the tree:

```json
{ "type": "fs.file.create", "payload": { "v": 2, "path": "README.md", "contentStreamId": "fs:maple/reading-room:main:file:readme" } }
{ "type": "fs.file.write",  "payload": { "v": 2, "path": "README.md", "base": "BASE_NONE", "contentSha256": "…", "size": 142 } }
{ "type": "fs.dir.create",  "payload": { "v": 2, "path": "apps/web" } }
```

File bytes are not on the metadata stream. Each file has its own **content stream**;
the metadata event references it by id and pins the content digest. The tree at any
offset is `replay(events)` up to that offset, and its **tree digest** is a SHA-256 over
the canonically encoded state.

## Branches are forks of the log

A branch is a new stream whose first event says where it came from:

```json
{
  "type": "fs.branch.fork",
  "payload": {
    "v": 1,
    "parentStreamId": "fs:maple/reading-room:main:meta",
    "forkOffset": "000000000000000008"
  }
}
```

Nothing is copied. Replaying the branch means replaying the parent up to `forkOffset`,
then the branch's own events. Consequences:

- **History is O(events)**, not O(files).
- **"Who changed what when"** is a digest bisect (`ef bisect`) between two logs, not
  archaeology.
- **Merging** is log-aware: replay both sides from the fork point, apply a three-way
  merge on the StreamFS state, append the result as events on the target.

{% hint style="info" %}
Electric's native head forks preserve the parent prefix, so application offsets stay
stable across branches. The platform never interprets or forges Electric's own
transport cursor — application offsets are a separate, canonical field on every event.
{% endhint %}

## Live by construction

Because a branch _is_ a stream, "watching a branch" is just tailing it. The web app uses
long-poll and SSE reads with resumable checkpoints; the CLI's `ef init` watcher syncs a
working directory both ways. Two machines on one branch converge through the stream —
there is no push, no pull, and no fetch.

{% expandable title="What about offsets and determinism?" %}
Every JSON stream item carries a canonical application `offset` — a zero-padded,
lexicographically ordered string. Writers allocate the next offset, submit it as
`Stream-Seq`, and retry a rejected race after replaying current state. This is what
makes replay deterministic: the same events in the same offsets always produce the
same digest, on any machine.
{% endexpandable %}
