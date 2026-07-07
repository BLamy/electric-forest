# electric-forest Task System

All work on electric-forest is decomposed into task **folders** in this directory,
organized into epic folders (`epic-0-the-seed/` … `epic-7-the-mirror/`) that ladder toward
named, runnable milestones — see `../../ROADMAP.md` for the capability stack, the
targets→epic map, and what each epic gets you. `../loop.md` defines the builder/critic
loop that burns this queue down and the project states (`building` / `complete` /
`paused` / `invalid_loop`).

## A task is a folder

```
.eforest/tasks/epic-1-the-trunk/E1-T03-branch-fork-at-offset/
  readme.md      the task spec + verification log (the only required file)
  work/          the builder's scratch space: throwaway scripts, probes, ad-hoc
                 validation — gitignored; this is the task's /tmp
  evidence/      durable evidence artifacts: event-log dumps, digest files,
                 Playwright traces, promoted fixtures — committed
```

The folder is the task's whole workshop. Everything an agent does while working a task —
every scratch script, every validation run, every adversarial probe — lives in that
task's folder, not in `/tmp`, not in the repo root. When the task is done, `readme.md`
carries the claim and the verdict, `evidence/` carries the proof, and `work/` evaporates.

## The priority queue

`QUEUE.md` is the single ordered list of every task, regenerated from readme frontmatter
by:

```sh
python3 tools/build_queue.py
```

Rules:

- **Priority** is a global integer: `epic × 100 + task number` (`E2-T07` → `207`).
  The queue is sorted ascending. Lower number = sooner. Fractional priorities are allowed
  only for queue-jumping bug/regression tasks, with the reason stated in a frontmatter
  comment.
- Work is done **one task at a time**, taking the highest-priority task whose
  `depends_on` are all `verified`. The queue's "Next up" section computes this for you.
- A dependency may be a task id (`E1-T04`) or a bare epic id (`E1`, meaning "that epic's
  capstone task is verified").

## Task lifecycle

```
pending → in-progress → implemented → verified   (terminal)
              ↑              |
              └── refuted ←──┘   (critic broke it; back to work)
```

`verified` is the only terminal state, and only an adversarial critic can grant it.

## Adversarial verification protocol

Every task readme has an **Adversarial verification** section written *for a hostile
critic* — an agent (or human) whose explicit mission is to **refute** the completion
claim, not to confirm it.

1. The builder finishes the task, sets `status: implemented`, and records *how they claim
   it works* (commands, event-log paths, state digests, Replay recording URLs).
2. A **separate session/agent** — never the builder — takes the task readme and attempts
   to break the claim: run the listed checks, then go beyond them (edge cases, adversarial
   inputs, replay-determinism comparison, two-client convergence diffs, replaying the
   cited event log from a cold clone, fuzzing parsers/offsets/merges, interrogating the
   cited Replay recording through the Replay MCP). The task's verification section lists
   mandatory attack angles; the critic is encouraged to invent more.
3. If **any** refutation succeeds: status → `refuted`, with a written repro appended to
   the readme under `## Verification log`. Back to the builder.
4. If the critic fails to break it: status → `verified`, log entry recording exactly what
   was attempted. Only then does the queue advance.

A capstone task additionally requires its demo to be performed end-to-end from a cold
start (fresh clone / fresh browser profile / fresh stream server data dir) — no state left
over from development.

This repo also ships the protocol as runnable orchestrations: see `.claude/workflows/`
(`implement-task`, `verify-task`, `work-queue`, `plan-epic`, `replay-triage`,
`golden-sweep`, `roadmap-audit`) and `AGENTS.md` for the full doctrine.

## Task readme format

Folder: `E{epic}-T{nn}-{kebab-slug}/` inside the epic folder, containing `readme.md`.
Frontmatter is flat YAML; `depends_on` is an inline list.

```markdown
---
id: E1-T03
epic: 1
title: Branch streams fork from main at an offset with copy-on-write metadata
priority: 103
status: pending
depends_on: [E1-T01]
estimate: M          # S | M | L
capstone: false
---

## Goal
One paragraph: the outcome, not the activity. Present-tense end-state with exact package
names, types, endpoints, and formats inline.

## Context
Why this task exists, what it unblocks, pointers (specs, files, prior art), and any
contract frozen here ("the event envelope is frozen here and versioned; changing it later
invalidates golden logs").

## Deliverables
- Concrete artifacts: packages/files/functions/endpoints/tests/pages.

## Acceptance criteria
- [ ] Objective, binary-checkable statements, each naming its evidence: an exact command
      with an exact expected observable (exit 0, identical digests, a golden event log,
      a Replay recording that shows X). The boxes are never checked off — status flips in
      frontmatter and evidence lives in the Verification log.

## Adversarial verification
Numbered attack angles for the hostile critic: each pairs one concrete manipulation with
one explicit refutation condition ("flip one byte of an event record and the state digest
must go red at that offset; a pipeline that stays green refutes the entire measuring
apparatus").

## Verification log
(appended over time by builders and critics)
```

## Conventions

- Implementation language is **TypeScript** (pnpm workspace); server code runs on Node,
  the web app is React. Behavioral acceptance criteria are digest/exact-equality claims,
  not eyeballs.
- The **only** way to mutate stream-backed state is appending an event through the
  dispatch door, so every feature is born replayable and every session is a trace.
- Tasks should be one focused session of work (estimate S/M/L ≈ hours/half-day/day-plus).
- A task may be declared **optional/stretch** — not required by its epic's capstone gate.
  The exemption must be stated in BOTH the task's own Context and the capstone's body;
  queue audits accept a documented exemption and flag undocumented orphans.
- If a task turns out to be too big, split it into `E{n}-T{nn}a/b` folders rather than
  letting it sprawl — then rerun `build_queue.py`.
