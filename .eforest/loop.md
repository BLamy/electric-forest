# .eforest/loop.md — the loop that builds this project

`.git` stores the history of file changes. `.eforest` stores the **future of what we are
doing and the history of what we have done**: the task queue is the future, the
verification logs and evidence folders are the past, and this file is the machine that
turns one into the other.

This is both our own build loop AND the reference spec for the loop every project hosted
on electric-forest will run (Epic 6 turns this file's contract into product code — a
task is an issue with evidence, on the same unified stream model as everything else). The
full operational doctrine lives in `AGENTS.md`; this file is the loop's contract.

## The two agents

**1. The builder.** Takes the top eligible task from `tasks/QUEUE.md`, implements it,
verifies its own work through the gates, and produces **evidence**: a deterministic
event-log/digest run (stream layer, always) and a Replay browser recording or rr-style
recording of the final happy run (browser layer, for anything a user can reach). The
builder's whole workshop is the task's own folder — scratch scripts and probes in
`work/` (gitignored), durable artifacts in `evidence/` (committed). The builder ends by
writing a claim: *here is the session where it worked, in full.*

**2. The critic.** Adversarial by nature. Its job is to NOT take the builder at its word:
it tries to falsify the evidence (find one point where the program contradicts the claim)
and to check it for sufficiency (find changed code the evidence never exercised). It runs
the task's own attack angles with its own inputs, invents new ones, fuzzes parsers /
offsets / merge logic / concurrent writers, sabotages the implementation in a scratch
worktree to prove the tests can go red, and interrogates the cited Replay recording
through the Replay MCP. Only the critic can set `verified`.

## The loop

```
           ┌──────────────────────────────────────────────┐
           ▼                                              │
   pick top eligible task ──► builder ──► claim + evidence │
                                              │           │
                                              ▼           │
                                           critic         │
                                         ┌────┴────┐      │
                                    verified     refuted ─┘ (rounds of 3 reworks; a progress
                                         │                   judge rules between rounds;
                                         │                   ≤ 10 total attempts)
                                         │
                                         ▼
                              queue advances (build_queue.py, commit)
```

Runnable as `.claude/workflows/work-queue.js` (which composes `implement-task.js` and
`verify-task.js`).

## Project states

The project's state lives in `.eforest/project.json` (`status` field) and is part of the
loop's contract — the platform (Epic 6) surfaces it live on every project page:

- **`building`** — the queue has eligible work and the loop may run.
- **`complete`** — every task is `verified`, including the final capstone. Terminal until
  new tasks are planned.
- **`paused`** — a human halted the loop. The loop must not self-resume; only a human
  flips it back to `building`.
- **`invalid_loop`** — the loop can no longer make progress honestly. Triggers:
  - a task is refuted past its retry budget: reworks run in rounds of 3, and after each
    round a **progress judge** — a third critic, neither the builder nor the refuting
    critic — reads the successive verdicts and rules whether the reworks are converging.
    Only a "progressing" ruling buys the next round (the check fires after attempts 3, 6,
    and 9), and 10 total attempts is the hard cap;
  - a gate cannot be made green without weakening it (skipping tests, disabling lints,
    `|| true` — the greenwash scanner `tools/verify/self_check.sh` polices this);
  - `roadmap-audit` finds the board lying (statuses without verdict entries, queue drift)
    and the mend requires human judgment;
  - the same task thrashes `implemented → refuted` twice with the same finding.
  `invalid_loop` is a loud stop: record the reason in `statusReason`, commit, and wait for
  a human. Routing around it is itself a refutation of the loop.

Every state change updates `status`, `statusReason`, and `updatedAt` in
`.eforest/project.json` and is committed.

## Streams (once Epic 1+ lands)

A project's main branch is its **main stream**; branches are **branch streams** forked
from it, and every change to a branch syncs live to all users of that branch. `.eforest`
itself rides the stream like any other directory, so watchers see tasks flip states in
realtime — the roadmap, the queue, and the evidence are as live as the code. Until then,
git carries this repo (the mirror flips at Epic 8).
