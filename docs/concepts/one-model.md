---
title: One model to hold them all
section: Concepts
order: 2
summary: Every noun on the platform is (stream, reducer).
---

# One model to hold them all

Every noun on the platform — file, directory, branch, repo, issue, wiki page, pull
request, task, comment, project status, evidence — is the **same thing**: an entity
defined by `(stream, reducer)`, whose state is `replay(events)` and whose history and
future are both just offsets.

| Entity            | Stream                          | Reduced state                                                   |
| ----------------- | ------------------------------- | --------------------------------------------------------------- |
| Files / dirs      | `fs:<org>/<repo>:<branch>:meta` | the tree; per-file content streams hold bytes                   |
| Issue             | `issue:<org>/<repo>/<id>`       | `open` / `in-progress` / `done` / `closed` / `wont-do` + thread |
| Issue board       | `repo-issues:<org>/<repo>`      | a derived stream over the repo's issues                         |
| Wiki              | `fs:<org>/<repo>:wiki:meta`     | StreamFS pages on a dedicated branch                            |
| Pull request      | `pr:<org>/<repo>/<id>`          | `(sourceBranch, targetBranch, forkOffset)` + reviews + merge    |
| Identity          | `__identity__`                  | users, sessions, CLI grants — the view the servers enforce      |
| Org / namespace   | `ns:org:<org>`                  | repositories, visibility, membership                            |
| Task (`.eforest`) | an issue with evidence          | plus `claimed` / `refuted` / `verified` builder-critic events   |

## One door, one replay path

```
   dispatch(event) ──► validate against reduced state ──► append to stream
                                                            │
        UI / CLI ◄── reducer(state, event) ◄── tail ◄───────┘
```

The dispatch service is the **only** writer of platform state. It replays the target
stream, validates the event against the reduced state (does this branch exist? may this
user write here? is the base digest current?), and appends. Readers — the web app, the
CLI, a critic — tail the same stream and run the same reducer.

{% hint style="success" %}
A merged pull request is not a row. It is a replayable negotiation ending in a merge
event on the target stream. You can scrub it.
{% endhint %}

## Derived views are disposable

Anything that looks like an index — the repository registry, an issue board, a PR
catalog — is a **derived stream** or a reducer-materialized view. It can always be
rebuilt from the logs:

```sh
pnpm ef registry rebuild --data-dir ./data --force
```

Losing every index loses nothing.

## Time travel is a product feature

Because state is a pure function of the log, any UI can be pointed at any offset:

- `ef materialize dump.jsonl --out ./tree --at 000000000000000042`
- `ef replay dump.jsonl --digest --until 000000000000000042`
- the Stream Inspector at `/inspect/<org>/<repo>/<branch>` in the web app

The same mechanism powers evidence: a critic does not ask "did it work?" — it asks
"show me the offset where it did".
