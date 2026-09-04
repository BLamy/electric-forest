---
title: The ef CLI
section: Guides
order: 2
summary: Replay, bisect, materialize, sync, and dispatch from the terminal.
---

# The `ef` CLI

`ef` is the terminal face of the platform. It operates on **event logs** (`.jsonl`
dumps), **stream URLs**, and **working directories**. Run it with `pnpm ef <command>`
from the repository, or install `@eforest/cli`.

## Identity

```
ef login [--no-browser]       device flow against Auth0; the grant becomes an identity event
ef logout
```

## Working directories

```
ef init [--org <org>] [--project <name>] [--repo <name>] [--visibility public|private] [dir]
ef clone <org>/<repo> [branch] [dir] [--server <url>] [--at <offset>]
ef status [--json] [--offline]
ef branch <name>
ef checkout <branch>
ef workspace check <dir>
ef tree-digest <dir>
```

`ef init` starts a watcher: local edits become StreamFS events on the branch, and remote
events on the branch become local edits. Two working directories on one branch converge
through the stream.

## Replay, digests, and bisect

```
ef replay <dump.jsonl> (--digest|--worktree-digest) [--until <offset>] [--emit-log <path>]
ef replay --session-dump --server <url> --root <stream-id> --out <dir>
ef bisect <log-a.jsonl> <log-b.jsonl> [--stats]
ef materialize <dump.jsonl> --out <dir> [--at <offset>] [--tree-digest|--worktree-digest]
ef snapshot <stream-url>
```

{% hint style="success" %}
`ef replay --digest` is the independent witness used in every browser proof: the digest
it prints must equal the `data-ef-digest` on the DOM node, exactly.
{% endhint %}

## Merging and dispatch

```
ef merge <target-stream-url> <source-stream-url> (--ff-only | --three-way)
ef dispatch <stream-id> <event-json>
ef registry rebuild --data-dir <dir> [--force]
```

`ef dispatch` goes through the same authenticated mutation door as the web app — there is
no side channel. `ef registry rebuild` demonstrates the no-database rule: throw the
registry away and rebuild it from the logs.

{% expandable title="Example: prove two logs are the same state" %}

```sh
ef replay --session-dump --server http://127.0.0.1:4437 --root fs:maple/reading-room:main:meta --out ./a
ef replay --session-dump --server http://127.0.0.1:4437 --root fs:maple/reading-room:feature:meta --out ./b
ef bisect ./a/events.jsonl ./b/events.jsonl --stats
```

If the branches diverged, `bisect` prints the first offset whose reduced state differs.
{% endexpandable %}
