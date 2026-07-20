# .eforest/loop.md — the loop that builds this project

`.git` stores the history of file changes. `.eforest` stores the **future of what we are
doing and the history of what we have done**: the task queue is the future, the
verification logs and evidence folders are the past, and this file is the machine that
turns one into the other.

This is both our own build loop AND the reference spec for the loop every project hosted
on electric-forest will run (Epic 6 turns this file's contract into product code — a
task is an issue with evidence, on the same unified stream model as everything else). The
full operational doctrine lives in `AGENTS.md`; this file is the loop's contract.

## Operating-hours contract

All times use the repository host's local civil time. Human-input pauses may occur only
from **09:00 through 24:00**. During the overnight acceleration window—**00:00 inclusive
to 09:00 exclusive**—the loop must continue autonomously through every safe, in-scope,
already-authorized action while useful work remains. It should make conservative
assumptions, exhaust diagnostics and alternatives, rework refutations, run fresh proof
sessions, and pull the next eligible queue item without waiting for human input.

This is a scheduling rule, not an authority expansion. Proof gates, role separation,
committed run ceilings, project states, safety and permission boundaries, and fail-closed
integrity checks remain absolute. If a hard stop prevents one path overnight, the loop
records it and pursues other independent authorized work; it waits only after no such work
remains. It never self-resumes `paused` or `invalid_loop` and never weakens evidence to
manufacture progress.

## The three roles

**1. The builder.** Takes the top eligible task from `tasks/QUEUE.md`, implements it,
verifies its own work through the gates, and produces **evidence**: a deterministic
event-log/digest run (stream layer, always) and a Replay browser recording or rr-style
recording of the final happy run (browser layer, for anything a user can reach). The
builder's whole workshop is the task's own folder — scratch scripts and probes in
`work/` (gitignored), durable artifacts in `evidence/` (committed). The builder ends by
writing a claim: _here is the session where it worked, in full._

**2. The critic.** Adversarial by nature. Its job is to NOT take the builder at its word:
it tries to falsify the evidence (find one point where the program contradicts the claim)
and to check it for sufficiency (find changed code the evidence never exercised). It runs
the task's own attack angles with its own inputs, invents new ones, fuzzes parsers /
offsets / merge logic / concurrent writers, sabotages the implementation in a scratch
worktree to prove the tests can go red, and interrogates the cited Replay recording
through the Replay MCP. Only the critic can set `verified`.

**3. The progress critic.** A separate fresh session that never implemented or judged
any run in the window it audits. After every third non-verified run of one task, it
receives the complete reports from those three runs and decides whether the
loop is genuinely converging or death-spiraling. Genuine progress means old findings are
closed or narrowed by a general invariant, permanent tests/evidence compound, newly found
failures move to deeper or more compositional cases, and no previously surviving behavior
regresses. Reworded findings, one-off exceptions, weakened gates, a surviving identical
counterexample, or regressions are not progress. An uncertain audit stops the loop; it
never grants itself the benefit of the doubt.

## The loop

```
           ┌──────────────────────────────────────────────┐
           ▼                                              │
   pick top eligible task ──► builder ──► claim + evidence │
                                              │           │
                                              ▼           │
                                           critic         │
                                         ┌────┴────┐      │
                                    verified     refuted ─┘
                                         │          │
                                         │          └─ runs 3/6/9 ─► progress critic
                                         │                              │
                                         │                  progressing ┘ (continue)
                                         │                  death spiral ─► invalid_loop
                                         │
                                         ▼
                              queue advances (build_queue.py, commit)
```

Runnable as `.claude/workflows/work-queue.js` (which composes `implement-task.js` and
`verify-task.js`).

A **verification run** is one builder claim followed by its fresh critic verdict. A
refutation may start another run only while the most recent three-run progress audit says
`progressing`. Audits are mandatory after failed runs 3, 6, and 9. Passing run 10 still
verifies the task; any non-verified verdict at run 10 is an unconditional autonomous
stop. Ten is the absolute ceiling of the initially authorized loop, not a default
allocation: the loop earns each three-run extension by showing progress.

After any stop has been durably recorded as `invalid_loop`, only a new explicit human
authorization may open a bounded recovery window ending at most three runs after the
recorded stop. The approval must be committed before work resumes as a task
`verification_run_ceiling` plus `verification_recovery_base_run`, a project
`statusReason`, and a visible structured human-resume Verification-log entry. A completed
checkpoint is inherited byte-for-byte: an exhausted ceiling does not turn a genuine
`progressing` audit into a failed one. If a required checkpoint was missing or failed, the
recovery must retain or record its `death-spiral` / `insufficient-evidence` assessment;
human authorization may override the stop but never relabel its audit. Recovery never
deletes, renumbers, or resets earlier history. If the stopped attester cannot express the
new window, the same human approval may authorize one control-only bridge: it must leave
project/task/ledger state stopped, change exactly the frozen recovery-control path set,
and be followed directly by the lifecycle commit. The next checkpoint divisible by three
still requires a fresh progress critic over that complete three-run window; exhausting
the authorized ceiling without verification returns to `invalid_loop` before any further
builder call.

The explicit recovery ceiling may be below the default autonomous ceiling when the stop
occurred at an earlier failed checkpoint; nondefault ceilings are valid only with the
same commit-attested recovery authorization and never grant more than three runs.

A bridge that recognizes pre-ledger verdict prose must pin every migrated entry by its
complete committed digest and reject byte drift. It cannot broadly accept ambiguous
headings, rewrite the stopped task, or synthesize history from mutable text.

The human-authorized bridge at stopped commit
`f1f21df7ad71bb1978ef0dd12081ddc425368e3c` may reopen only E2-T06 runs 1-3 from an
empty verdict ledger. This exact-tip exception repairs the inherited E2-T05 ledger pin;
it is not a reusable run-zero recovery rule.

The second human-authorized E2-T06 bridge at stopped commit
`441e8372e12aad69a68540cfb0e83be3fdfec114` may renew only that same empty-ledger runs
1-3 window as recovery generation 2. The prior authorization remains visible and bound;
the bridge may repair the nested cold-clone queue fixture but cannot reset or synthesize
verdict history, apply to another stop, or authorize a third run-zero recovery.

Run numbers, authorized ceilings, and audit checkpoints are **task-global durable
state**, never counters local to one workflow process. Before any builder call, two fresh
readers must independently run the snapshot CLI piped from the trusted commit and return
byte-identical output. The CLI loads its parser from that same commit, then reads the exact
project, generated queue,
and canonical task record from the source commit under inspection. Every snapshot binds
the full OIDs, attester/control-source digests, transition path set, complete verdict and
audit entry-digest arrays, and one chained ledger digest. Post-write reads execute the
**pre-write** attester, so a writer cannot change the measuring apparatus and then attest
itself. The only exception is the explicit stopped-state control bridge above; it cannot
reopen work and its direct-child lifecycle write is measured by the bridge. A restart at
run 6 must therefore audit the complete committed reports 4-6 before
run 7; a stale checkpoint at runs 4/5, 7/8, or 10 fails closed, and restarting can never
reset the windows or silently enlarge the committed ceiling.

Every control gate fails closed: project state must be observed as exactly `building`;
the requested `maxRuns` must be a positive integer no greater than the task's committed
ceiling; and `progressing` requires a non-empty rationale,
at least one report/diff/commit/test/fixture/digest citation selected byte-for-byte from
the snapshot's commit-resolved evidence catalog, and at least one actionable next focus.
The catalog admits only evidence with a concrete verifier and committed target; command
text and free-floating digest syntax are not evidence. One visible Markdown token stream
drives headings, verdict bullets, the exact Rationale/Evidence/Next focus/Assessment audit
fields, catalog extraction, and writer readback, so fenced or commented text cannot
authorize a transition. The control root includes this charter, `AGENTS.md`, both child
workflows, the queue builder, the attester/parser, and its permanent sensor. E2-T01's
historical checkpoint start is pinned to 6 and every ordinary task is pinned to 3. The
accepted audit is appended and committed before rework starts. A writer must return its
base and new full commit OIDs, then a new reader pair must observe that exact commit,
role-specific changed-path set, and expected ledger/status/queue delta. Missing,
malformed, uncited, self-attested, uncommitted, or path-expansive results never earn
another run; even an `invalid_loop` write must be independently attested.

## Project states

The project's state lives in `.eforest/project.json` (`status` field) and is part of the
loop's contract — the platform (Epic 6) surfaces it live on every project page:

- **`building`** — the queue has eligible work and the loop may run.
- **`complete`** — every task is `verified`, including the final capstone. Terminal until
  new tasks are planned.
- **`paused`** — a human halted the loop. The loop must not self-resume; only a human
  flips it back to `building`.
- **`invalid_loop`** — the loop can no longer make progress honestly. Triggers:
  - a three-run progress critic reports `death-spiral` or cannot establish progress from
    cited changes in findings, retained suite artifacts, and surviving behavior;
  - a task remains non-verified after its tenth verification run;
  - a gate cannot be made green without weakening it (skipping tests, disabling lints,
    `|| true` — the greenwash scanner `tools/verify/self_check.sh` polices this);
  - `roadmap-audit` finds the board lying (statuses without verdict entries, queue drift)
    and the mend requires human judgment.
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
