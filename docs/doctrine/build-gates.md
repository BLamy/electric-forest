---
title: Build gates
section: Doctrine
order: 2
summary: The four gates, the verify spine, and the cold clone.
---

# Build gates

Every claim passes four gates in ascending cost, and every gate must be green before the
next runs:

```sh
pnpm format:check && pnpm lint   # 1 · shape
pnpm typecheck                   # 2 · types
pnpm test                        # 3 · behavior
pnpm build                       # 4 · the artifact users actually get
```

## The verify spine

`make verify-<task>` targets compose the gates with task-specific adversarial checks in
`tools/verify/`. Examples:

| Target                  | Proves                                                               |
| ----------------------- | -------------------------------------------------------------------- |
| `_v-replay-determinism` | committed golden logs replay to their frozen digests                 |
| `_v-official-streamfs`  | StreamFS behaves against the _published_ Durable Streams server      |
| `_v-e2-t01-identity`    | the identity reducer is pure: no clock, no randomness, no I/O        |
| `verify-E4-clone`       | a cold clone builds and proves itself with nothing from your machine |

{% hint style="info" %}
Verification logs on completed tasks are append-only evidence of what happened at the
time. They are not an API contract — re-earn them with the golden sweep, never edit
them.
{% endhint %}

## Where scratch goes

All task scratch work — throwaway scripts, probes, validation runs — lives in that task's
own `work/` folder (gitignored). Durable evidence goes in its `evidence/` folder
(committed). `/tmp` is for people who don't have a task folder.
