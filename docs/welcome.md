---
title: Welcome
section: Start here
order: 1
summary: What electric-forest is, in one page.
---

# Welcome to electric forest

electric-forest is a GitHub clone with the version control ripped out and replaced:
**durable streams instead of git**.

- A project's main branch is an **append-only stream**.
- Branches are **streams forked from it** at an offset — not copies of the tree.
- Files live on **StreamFS**: a metadata stream plus one content stream per file.
- Every change to a branch **syncs live** to every user of that branch. An AI's edits
  appear as they happen, not as a commit afterward.
- Everything GitHub keeps in Postgres — issues, wiki, pull requests, users, orgs —
  lives on the **same streams as the code**, under one unifying model.
- Every project carries a `.eforest/` directory that stores not the history of file
  changes but **the future of what we are building and the proof of what we have built**.

{% hint style="info" %}
The only external service is Auth0, and it only answers "who is this?". There is no
database anywhere in the system. If a feature seems to need one, the feature is
misdesigned.
{% endhint %}

## The four irreversible bets

{% stepper %}
{% step %}
**One mutation door.** The only way to change platform state is dispatching an event
through the authenticated dispatch service. State is `replay(events)` from offset `-1`,
always — so every session is a trace and every bug is a replayable offset.
{% endstep %}
{% step %}
**Branches are forks of the log, not copies of the tree.** A branch stream records
`(parent, forkOffset)` and copy-on-write metadata. Merge is log-aware; history is
O(events).
{% endstep %}
{% step %}
**`.eforest` is data on the same streams as the code.** The task queue, project status,
loop definition, and evidence ride the project's own streams, so the build process is
as observable, forkable, and replayable as the source tree.
{% endstep %}
{% step %}
**No database. The streams are the database.** Anything that looks like a query index
is a derived stream or reducer-materialized view, rebuildable from the logs by replay.
Losing every index loses nothing.
{% endstep %}
{% endstepper %}

## Where to go next

| If you want to…                                  | Read                                               |
| ------------------------------------------------ | -------------------------------------------------- |
| Run it locally and log in                        | [Getting started](/docs/getting-started)           |
| Understand why there is no `.git`                | [Streams, not git](/docs/concepts/streams-not-git) |
| See how issues, PRs and files are the same thing | [One model](/docs/concepts/one-model)              |
| Learn how work gets proven, not just claimed     | [Evidence doctrine](/docs/doctrine/evidence)       |
| See what is built and what is next               | [The roadmap](/roadmap)                            |

{% hint style="success" %}
These docs are Markdown files in the repository's `docs/` folder, rendered by
[Docstream](https://github.com/BLamy/docstream) — the same renderer the product uses for
wiki pages, issues, and pull requests.
{% endhint %}
