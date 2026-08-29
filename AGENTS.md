# AGENTS.md — how agents drive this repo

Operating manual for any agent (or human) working on electric-forest. `ROADMAP.md` says
where we're going. `.eforest/tasks/QUEUE.md` says what's next. `.eforest/loop.md` defines
the loop this file operationalizes. This file says how work gets done — and, more
importantly, how work gets **proven**.

<!-- Recovery-control bridge 2026-07-28: E3-T02 runs 11-13; doctrine unchanged. -->
<!-- Recovery-control bridge 2 2026-07-28: E3-T02 runs 14-16; doctrine unchanged. -->

## The one rule

A builder being satisfied is a **claim**. A deterministic recording of the run that
satisfied them is **evidence**. No task reaches `verified` on claims: a separate,
adversarial critic session must interrogate the evidence, hold it against the diff, and
fail to refute it. Every other rule in this file serves that one.

The pattern is the worker/critic proof loop from Replay-style web verification (via
wasm-vm and the figma-clone, this repo's doctrine donors). Here it comes full circle: the
product we are building — durable streams that store every mutation as an appendable,
replayable event — **is** the core evidence layer. The critic interrogates a **Replay QA
journey run** (and the full exploration that closes an epic) driven against the real app
through its authenticated tunnel and/or the **deterministic event log** a durable stream produces about itself. Same
doctrine either way: _not "trust me, I checked" — here is the session where it worked, in
full; interrogate it._

## Operating hours

Use the repository host's local civil time. A pause to ask for human input is permitted
only from **09:00 through 24:00**. From **00:00 inclusive until 09:00 exclusive**, run the
authorized queue as hard and as far as the proof loop honestly allows: make conservative
in-scope assumptions, exhaust safe diagnostics and alternatives, rework refutations,
launch fresh critics, and advance to the next eligible task without waiting for a human
while useful authorized work remains.

The overnight rule changes scheduling, not authority or evidence. It never permits
weakened gates, fabricated proof, destructive or out-of-scope action, bypassing a
`paused`/`invalid_loop` state, exceeding a committed run ceiling, or routing around a
safety, permission, integrity, or unavailable-capability stop. When one of those hard
stops is reached overnight, durably record the exact blocker and continue any other safe,
independent authorized work; wait for a human only when no such work remains.

## Roles

**Builder** — implements exactly one task from the top of the queue. Self-validates as
much as it likes (ephemeral runs, no limit — all of it inside the task's own `work/`
folder), then submits three things: the diff, a claim, and recorded evidence of the final
happy run.

**Critic** — a **fresh session**, never the one that implemented. It does not fix code and
does not take the builder at its word. It attacks the claim from two directions:

1. **Falsification** — find one point in the evidence where the program contradicts the
   claim or the task's acceptance criteria.
2. **Sufficiency** — find changed code the evidence never exercised. Unexecuted diff is
   either unproven (demand a run that exercises it) or dead (demand deletion).

A builder can therefore fail two ways: the evidence contradicts the claim, or the evidence
doesn't cover the claim.

**Progress critic** — another fresh, read-only session, distinct from every builder and
critic whose reports it reviews. After every third failed verification run for the same
task, it receives the complete reports for the latest three runs and decides whether the
loop is making genuine progress or death-spiraling. Progress requires cited closure or
meaningful narrowing of earlier findings through general invariants, a compounding
permanent suite/evidence corpus, deeper or more compositional new counterexamples, and no
regression or gate weakening. Renamed findings, narrow exceptions, repeated
counterexamples, or loss of previously surviving behavior are a death spiral. Uncertain
means stop. A `progressing` verdict earns only the next window, and no unchanged task
shape may exceed ten verification runs. A failed run 10 triggers one atomic decomposition
probation with a single three-run budget shared across all declared children. A fresh
decomposition critic must prove that finite, dependency-ordered, non-overlapping children
cover every parent criterion and finding; the parent ledger is preserved byte-for-byte
and the exhausted parent is cancelled, never reset. At least one child must be set
`verified` by a fresh critic within those three total runs, or the project enters
`invalid_loop`. A completed
checkpoint is inherited byte-for-byte, including a genuine `progressing` assessment when
the authorized ceiling alone caused the stop. A human may override a recorded failed
checkpoint but never relabel it as progress or erase it.

A bounded recovery ceiling can be lower than the default autonomous ceiling when the
recorded stop occurred at an earlier checkpoint. That lower ceiling is not a shortcut:
it still requires the full commit-attested human-resume lifecycle and grants at most three
additional runs.

Verification-run accounting is durable and task-global. Before any builder call, the
queue workflow requires two fresh readers to return byte-identical output from the
committed deterministic snapshot command. That command reads project state, generated
queue, canonical task path/frontmatter, complete numbered judge history, and progress
checkpoints from `git show HEAD:<path>` and binds them to the full commit OID plus SHA-256
digests. A restart after run 6 must still submit reports 4-6 before run 7; stale resumes
after 3/6/9 fail closed, and no process restart or human resume resets the counter or
ceiling. Project state, history, identity/path, lifecycle, run limits, and structured
progress citations all fail closed. Writer booleans are never persistence evidence: a
fresh reader pair must observe a different promised commit OID and the exact status,
ledger, audit/verdict entry, and queue delta before implementation continues.

When a human-authorized control bridge must recognize historical verdict prose, the
compatibility is valid only when every migrated entry is pinned by its full committed
digest. Broad legacy-heading acceptance or stopped-task rewriting weakens the gate and is
forbidden.

The authorized E2-T06 apparatus recovery is bound to stopped commit
`f1f21df7ad71bb1978ef0dd12081ddc425368e3c`, an empty E2-T06 verdict ledger, and runs
1-3. No other task, stop, or future run-zero transition may inherit that exception.

The authorized E3-T01 specification recovery is separately bound to stopped commit
`cafff29593bdaf12e6eb3851fd2664ac661b661f`, an empty E3-T01 verdict ledger, and runs
1-3. It may reconcile the seed contract with frozen E1/E2 APIs and resume that task only;
it cannot change verified product behavior, erase the blocker report, or authorize any
other pre-run transition.

The human-authorized second E2-T06 apparatus recovery is separately bound to stopped
commit `441e8372e12aad69a68540cfb0e83be3fdfec114`, the same empty verdict ledger, recovery
generation 2, and runs 1-3. It may repair the nested cold-clone queue fixture and resume
that one task only; it is not a reusable run-zero rule and cannot erase the first recovery.

The human-authorized third E2-T06 apparatus recovery is bound to stopped commit
`f1e72dd0f40089fc1a2d62bec715ca6405e36386`, the preserved run-1-through-3 verdict ledger,
recovery generation 3, and runs 4-6. Its lifecycle commit records the missing run-3 stop
assessment; it may use at most three fresh pristine-clone attempts and may not reset or
renumber prior verdicts.

The human-authorized fourth E2-T06 apparatus recovery is bound to stopped commit
`2b2ab56a8f8b7103eb9625d0e2c96967b5215649`, the preserved run-1-through-6 verdict ledger
and audits through run 6, recovery generation 4, and runs 7-10. Its purpose is an
architectural, fail-closed no-side-storage proof boundary; another enumerative syntax
patch is outside the authorization. It may not reset, renumber, or erase prior evidence.

The human-authorized E3-T06 ledger recovery is bound to stopped commit
`c258fb003c1a735117a5fc251b38338d2a0ff8bf`, eight exact-digest verdict entries, two
exact-pinned provisional verifications superseded by later refutations, and run 9 only.
Its lifecycle commit must record both missing checkpoints as `insufficient-evidence`;
neither checkpoint may be relabeled as progress, and no run beyond 9 is authorized.

The human scope decision recorded for E2-T12 on 2026-07-27 makes that capstone
local-only: pinned Auth0 emulation, the published local `DurableStreamTestServer`,
Playwright, Replay, and deterministic stream evidence are the complete proof boundary.
Its live-cloud refutation remains run 1; bounded recovery authorizes only runs 2-4 on
E2-T12 and does not unlock another queue task by itself.

The same agent may play these roles on _different_ tasks — never more than one role on the
same task or progress-audit window. The roles also exist as installable subagents
(`.claude/agents/replay-worker.md`, `.claude/agents/replay-critic.md`, from Replay's
official plugin bundle) and as runnable orchestrations
(`.claude/workflows/implement-task.js`, `verify-task.js` — see Workflows below).

## Task lifecycle

```
pending → in-progress → implemented → verified   (terminal; only the critic sets this)
                              ↘ refuted → in-progress (builder reworks, re-records)
```

Statuses live in each task's `readme.md` frontmatter
(`.eforest/tasks/epic-*/E*-T*/readme.md`). After any status change:
`python3 tools/build_queue.py` regenerates `.eforest/tasks/QUEUE.md`, then commit. One
task in-flight at a time; a task's `depends_on` must all be `verified` before starting it.

The **project** has a state too, in `.eforest/project.json`: `building` while the loop has
eligible work, `complete` when every task including the final capstone is verified,
`paused` when a human halts it, `invalid_loop` when the loop can no longer make progress
honestly (a three-run progress audit finds a death spiral or cannot establish progress,
run 10 and its one global three-run decomposition probation fail to verify any complete
child, the decomposition cannot prove complete non-overlapping coverage, gates cannot be
fixed without being weakened, or a roadmap-audit finding the board lies). Flipping to
`invalid_loop` is a
loud stop for a human — never route around it. `.eforest/loop.md` is the contract.

## Builder protocol

1. **Pick work.** Top entry of "Next up" in `.eforest/tasks/QUEUE.md`. Read the whole task
   readme — the Adversarial verification section tells you how you'll be attacked; build
   for it.
2. **Freeze the finite threat model before code.** A fresh read-only pre-critic converts
   every criterion and task attack into falsifiable predictions, cheap targeted checks,
   and coverage risks. It may clarify the explicit trust boundary; it may not invent an
   unbounded claim such as "secure against everything."
3. Set `status: in-progress`, rebuild queue, commit.
4. **Implement.** Gates in ascending cost, any failure returns to the top:
   `pnpm format:check && pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build`.
   (If the workspace predates a gate — e.g. no package.json yet because THIS task creates
   it — the gate applies from the moment it can.)
   4a. **Browser-impacting work ⇒ prove it in the browser, and show it on the app.** If a
   change touches anything a user can reach through the web app (repo browsing, file
   views, live sync indicators, the task board, auth), you MUST:
   (a) **Update the web app to surface the new capability** so it keeps proving the whole
   machine works — live stream offsets/digests visible in the DOM where applicable,
   the new interaction reachable. The app is the at-a-glance monitor — it must never
   silently fall behind what's landed.
   (b) **Drive it headlessly for deterministic self-validation**: Playwright loads the
   built app, asserts **zero console errors**, asserts DOM-exposed state digests/offsets
   match committed expectations, and exercises the new interaction through real
   pointer/keyboard events.
   (c) **Expose the app through Replay QA's managed tunnel; do not use a local browser
   recording as final evidence.** The repository's durable project binding is
   `.replay/config.json` and its `qa-project-id`. Start the complete app and its normal
   emulators locally, then use the `replay-qa` integration to start `replayqa proxy` for
   the configured project id. It provides the outbound-only, allowlisted tunnel. Keep the
   tunnel alive for the whole run. Never replace this with direct Replay Chromium, a local
   screencast, or a one-off public deployment.
   (d) **Feature journeys now; full exploration at epic close.** For each
   browser-impacting task, create or update named journeys whose instructions contain
   setup, exact actions, expected outcomes, and error/removal paths, then launch those
   journeys inside the configured project. A journey must exercise every changed
   browser-reaching behavior. Do not run an open-ended exploration for an ordinary task.
   After the final remaining task in an epic has passed its focused journeys, run one full
   open-ended exploration of the integrated epic before that epic is considered complete.
   Cite the project id plus journey, test-run, bug, epic-exploration, and attached Replay
   recording ids or URLs that the run produced. The external service receives the
   authenticated test session and visible seeded test data: use dedicated fixtures, least
   privilege, and no production credentials or unrelated workspace data.
   Non-browser work (protocol core, CLI, server internals, tooling, docs) skips this gate
   but still records stream-layer evidence.
5. **Self-validate freely.** Drive the code however you want — ad-hoc runs, scratch
   scripts, throwaway browser sessions. This inner loop is yours; nothing here is
   evidence. All of it lives in the task folder's `work/` (gitignored) — a task folder is
   the task's whole workshop, not just its spec.
6. **Audit the immutable candidate once.** One fresh auditor runs format/lint, typecheck,
   tests, and build sequentially in ascending cost. Do not run four concurrent package
   managers, and do not rerun an unchanged passing root gate during the evidence run.
   Any fix creates a new candidate and restarts the ordered chain.
7. **Run the final Replay QA journeys.** When satisfied, keep the immutable candidate
   running behind the configured tunnel and launch the task's named journeys in the
   configured Replay QA project. Make the run count: every behavior the diff changes must
   execute, because the critic holds the run against the diff. Changed code the journey
   never exercised is either unproven or dead. Durable stream artifacts (event-log dumps,
   digest files, Playwright traces) go in the task folder's `evidence/` (committed).
8. **Write the claim** as a Verification log entry in the task readme: commit hash, exact
   commands run, evidence (event-log paths, state digests, stream offsets, Replay QA
   project/journey/test-run IDs, epic-exploration IDs when applicable, and recording URLs), and one paragraph stating
   what the run demonstrates. **Name
   the evidence layer for every claim; declare absence explicitly** —
   `Replay: N/A (<reason>) + mitigation` — silence is forbidden.
9. Set `status: implemented`, rebuild queue, commit.

Know that the critic inspects the Replay QA run, its event timeline, bugs, console/network
evidence, and attached Replay recording where available — not just what your test printed.
It is looking for any point where behavior contradicts the task, and for any changed
browser behavior the journey never exercised.

## Pull requests carry evidence

**Publication routing is fixed:** never use the GitHub CLI (`gh`) in this repository.
Use local `git` for commits and `git push`; use the connected GitHub app to create pull
requests and read or update PR metadata.

Every PR opened on this repo states its browser-layer evidence in the PR body, one of
exactly two ways (`.github/pull_request_template.md` enforces the section):

1. **Replay QA evidence link(s)** — the configured project plus journey/test-run
   identifiers or URLs, the epic-closing exploration when applicable, and any
   `https://app.replay.io/recording/<id>` URL the
   run produced. These prove Replay QA reached the candidate through the tunnel and ran
   the declared scenario; a reviewer opens the run and interrogates its evidence.
2. **A justification** — the literal form `Replay: N/A (<reason>) + mitigation`, where
   the reason explains why no browser session can validate this PR (pure protocol/CLI/
   server change, docs, planning) and the mitigation names the stream-layer evidence
   that stands in (event-log dump, digest comparison, conformance run, test output).

The **Replay QA run is the browser validation proof**. A PR with neither a Replay QA run
nor a justification is
not reviewable — silence about evidence is the one thing the doctrine forbids
everywhere. Reviewers refuse it the way the dispatch door refuses a malformed event.
The platform itself mirrors this rule once Epic 5 lands: merging a hosted PR requires
an evidence attachment or an explicit waiver event (E5-T06 gate + E5-T10
attachment/reference model — Replay links are `evidence.linked` reference events).

## Evidence: two layers of time travel

| Layer                              | Records                                                                                                                                                                                                                                                                                           | Tooling                                                                                                                                                            | Runs where                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| **Stream** (the event machine)     | every dispatched action (append-only, offset-addressed, canonical JSON events), state digests (SHA-256 over canonically-encoded reduced state), replay determinism (same log replayed twice → identical digest), branch-divergence bisect (first offset where two streams' state digests diverge) | the durable-stream server + `ef replay <dump> --digest` + `ef bisect` (land in Epic 0; until then, deterministic test output captured to `evidence/`)              | everywhere — node, CI, this Mac                                       |
| **Browser** (the app in the world) | Replay QA journey actions, epic-closing exploration, rrweb timeline, console/network findings, bugs, and attached Replay recordings                                                                                                                                                               | `.replay/config.json` + Replay QA managed reverse-proxy tunnel + `start_local_journey`; `start_local_exploration` only at epic close (`replayqa proxy` underneath) | the configured Replay QA project against the locally running full app |

- The stream layer answers _"did the event machine do the right thing?"_ Every mutation
  flows through the dispatch door onto a durable stream, so every session is a replayable
  trace, `replay(log)` from offset `-1` is ground truth, and equality claims are digest
  comparisons (exact, not eyeballs). The product being its own Replay browser is the
  founding bet of this repo, and stream-layer evidence is mandatory for every task once
  the trace infra lands (Epic 0 onward).
- The browser layer answers _"what did an external user journey actually encounter?"_ —
  the critic reads the journey steps, rrweb timeline, console/network findings, bugs, and
  any attached Replay point links. It is mandatory for every browser-impacting task.
- The citation currency: Replay QA project + journey/test-run id, epic-closing exploration id when applicable, and, when
  available, a Replay **point link** (`https://app.replay.io/recording/<id>?point=<p>&time=<ms>`). For stream-layer findings:
  event-log file + offset + digest. A finding without a citation anyone can jump to is not
  a finding.
- The stream-layer `whowrote`: **digest bisect** — replay the event log, compare state
  digests against a known-good reference, and binary-search the first divergence. "Which
  event corrupted the state" gets an exact offset, the way `reverse-continue` gets an
  exact line.
- **Project binding is committed, runs are remote evidence.** `.replay/config.json`
  contains the project id and is committed; tunnel credentials and run data are not.
  Use reusable named journeys for task acceptance. Do not create a fresh project per task
  and do not run an open-ended exploration per task. Run one full exploration only after
  the final task in each epic passes its focused journeys.
- **Validation leans on Replay QA.** Direct local Playwright inspection is deterministic
  self-validation, not final browser evidence. The critic opens the cited Replay QA
  journey/test run (or epic-closing exploration), reviews its rrweb timeline, task outcome, bugs, console/network
  findings, and any attached Replay recording against the diff. A claim no one has held
  against the Replay QA run is unvalidated.
- If the tunnel or Replay QA is unavailable, browser evidence falls back **loudly** to
  Playwright plus console/network interrogation, and every claim uses the literal
  `Replay: N/A` form with a reason and mitigation. Never silently substitute a local
  recording.

## Critic charter

You receive: the task readme (claims, acceptance criteria, attack list), the diff
(`git diff` scoped to the task's commits), and the evidence from the Verification log.
Your goal is to refute. You do not edit implementation code; your writes are limited to
the Verification log, promoted tests, and the status field.

**Your primary instrument for browser claims is the cited Replay QA journey/test run or
epic-closing exploration.** Use the `replay-qa` integration to open the run and project issues; when the run
attaches an app.replay.io recording, use the Replay MCP for point-level interrogation.
Do not re-drive the app to check a browser claim — interrogate the builder's run so the
verdict rests on what actually happened, not on a different rerun.

**ORIENT.** Read the task readme and the diff before touching evidence. For Replay QA
runs: open the cited journey/test run or epic-closing exploration, get the shape of its timeline and interactions,
and inspect its outcome, bugs, network, and console evidence. For event logs: replay the cited dump and check the digest matches the
claimed one — a builder citing a stale log fails immediately. Cheap sweeps first: uncaught
exceptions anywhere in the recording, any test `.skip`ped or `.todo`d in the diff, any
lint rule disabled inline, any golden "blessed" without a stated reason?

**PREDICT, THEN VERIFY.** For each acceptance criterion, write a falsifiable prediction
about concrete program state at a specific point **before** inspecting that state. A
prediction made after looking is a caption, not a check. Then verify with the narrowest
tool that can falsify it, routing by layer:

- Claim about stream/state behavior → replay the cited event log yourself, compare state
  digests, digest-bisect any divergence to the exact offset.
- Claim about sync convergence → drive two independent clients yourself, diff their
  reduced state canonically (exact), never eyeball two UIs.
- Claim about browser behavior → the Replay QA run: inspect the journey steps, rrweb
  timeline, console/network findings, and attached Replay point links; confirm the claimed
  offsets/digests appear in the run and match the independently replayed stream dump.
- Claim about performance → the benchmark harness's numbers against the task's stated
  budget and the committed baseline. Never eyeballs.

**Every finding cites a point.** Replay point link, event-log offset + digest, golden
path, or diff hunk. "The sync is flaky" is an opinion; "client B's state digest diverges
at offset 0000000000000000_0000000000004821, bisect log attached, point link into the
session" is evidence anyone can jump to.

**COVERAGE.** Hold the Replay QA journey against the diff. For each changed hunk: did the
journey exercise its behavior, and does attached source-execution evidence cover it where
available? Classify every uncovered hunk: **needs-evidence** (behavior the task mentions —
name the exact journey the builder must run), **dead** (demand deletion),
or **waived** (types, config, logging — one line of reasoning each). The diff isn't proven
until every changed line is executed, waived, or gone.

**MOCK & ENV HUNT.** Find every fixture the recorded run depended on: golden values
computed by the code under test at test time (self-licking test — goldens must be frozen
committed artifacts), magic constants, seeded RNG defaults, `NODE_ENV`-conditional
behavior leaking semantics, environment the run inherited, a stream server left warm from
development. Cold-clone rule: acceptance commands must pass from a pristine clone in a
scratch dir with scrubbed env (`NODE_OPTIONS`, `NODE_ENV`, `npm_config_*` unset) —
`tools/verify/cold_clone.sh` does this. "Works on the builder's machine" is a refutation,
not an excuse.

**RUN THE TASK'S OWN ATTACKS.** Execute every angle in the task's Adversarial verification
section — with your own seeds and inputs, never the builder's — and invent at least one
attack the section doesn't list. Fuzz where the task touches parsing, offsets, or merge
logic: malformed events, out-of-order appends, concurrent writers, truncated streams.
Sabotage-check the tests once per task: break the implementation in a scratch worktree and
confirm the builder's tests actually go red. A sensitivity proof is non-negotiable
wherever a measuring apparatus is claimed: mutate one byte of the input and the apparatus
must go red, or the apparatus itself is refuted.

**SUITE (only if correctness + coverage hold).** Judge what survives as a permanent
artifact — this is the duty that compounds:

- **Deterministic test** — exact assertions on stable behavior → committed unit/
  integration test asserting what _you_ verified, not what the builder printed.
- **Golden artifact** — the verified event log, state digest, or fixture checked in as a
  regression fixture (in the task's `evidence/` or the shared corpus).
- **Fuzz corpus entry** — inputs that reached interesting states → committed seeds.
- **Verify target** — recurring acceptance commands → a `make verify-*` recipe.
- Or **discard**, with one line of why.

**NO-FIRE LIST.** Do not raise: style nits, performance without a stated budget,
pre-existing warnings, requirements the task doesn't state, or anything you can't anchor
to a point link, a digest, a log offset, or a diff line. Re-check every finding once
before raising it.

**VERDICT.** First line: `VERDICT: verified | refuted | needs-evidence`. Then one bullet
per finding: prediction, observed value, citation, one-sentence demand. Append the entry
to the task's Verification log, flip `status` (`verified`, or back to `in-progress` with
the report as the builder's new context), rebuild the queue, commit.

Example log entry:

```
### 2026-07-10 — critic — VERDICT: refuted
- P2 branch-fork state parity — FAILED. Predicted fork digest 4f21… equal to main
  digest at fork offset; observed a01c… — digest bisect pins divergence at offset
  …0000512 (fork copies metadata but drops the pending patch event). Event log
  evidence/e1-t04-final.jsonl:512; recording
  https://app.replay.io/recording/9f2e…?point=8241…&time=41250. Fix, re-record.
- COVERAGE conflict-path — INSUFFICIENT. packages/streamfs/src/merge.ts:88-104
  (this diff) never executed in the recorded run. Record a run merging a branch with
  a conflicting write, or delete.
- SUITE: n/a until refutations clear.
Commands: ef replay evidence/e1-t04-final.jsonl --digest; pnpm test --filter streamfs merge
```

## Workflows

The doctrine above is runnable. `.claude/workflows/` ships:

- **implement-task** — the builder protocol end-to-end: pick from the queue, freeze a
  pre-critic threat model, implement through cheap targeted checks, run one sequential
  fresh-session gate audit for the immutable candidate, record evidence, write the
  claim. `args {task: "E0-T03"}` targets a specific task; `{rework: true}` after a
  refutation.
- **verify-task** — the critic charter with one consolidated lead critic: focused
  falsification, coverage, mock/env hunt, sabotage, and task attacks share one disposable
  worktree and one context. The lead runs exactly one cold clone, and only after cheaper
  semantic attacks survive. One Replay QA evidence reader is added only when the claim
  cites a journey run or epic-closing exploration. A single fresh skeptic/judge batch-cross-examines
  every finding, keeps false builder claims and failed measuring-apparatus sensitivity
  blocking, treats only non-claim apparatus polish and out-of-scope hardening as
  non-refuting follow-up, issues the verdict, and promotes suite artifacts.
- **work-queue** — the full gauntlet looped: implement → verify → rework until verified,
  advancing the queue. Before spending run 3, a fresh two-run progress preview attempts
  to cite convergence and name the next focus; it is advisory, cannot stop or grant runs,
  and cannot rewrite history. After failed runs 3, 6, and 9 it gives the complete latest
  three-run window to a fresh progress critic; only a cited `progressing` assessment
  earns another window. A failed run 10 exhausts that task shape and invokes one
  commit-attested decomposition. Its finite children share exactly three probationary
  verification runs; a fresh critic must verify at least one child before the shared
  budget is exhausted, with every parent criterion and finding still assigned. Failure
  or uncertainty records `invalid_loop`; success returns remaining children to ordinary
  policy. After the
  committed `invalid_loop` stop, only an explicit human approval may durably raise a
  task's `verification_run_ceiling` to at most three runs beyond the recorded stop without
  resetting history. A completed checkpoint is preserved exactly; a ceiling-exhaustion
  stop does not fabricate a second or contradictory audit for the same three-run window.
  If the measuring apparatus itself prevents that lifecycle write, an
  explicitly authorized control-only bridge may change only the frozen recovery-control
  path set while project/task/ledger state remains stopped; the following lifecycle commit
  must be its direct child. The next divisible-by-three checkpoint still requires a fresh
  progress critic, and exhausting that ceiling stops again before another builder call.
  The two ledger readers run
  the attester and parser from the trusted pre-write commit, not the warm worktree or the
  commit under inspection; every writer transition must preserve the complete prior
  verdict/audit digest chain and control-source digest, satisfy its exact role-specific
  changed-path policy, and use the same visible Markdown token stream for headings,
  verdict evidence, all audit fields, catalog extraction, and readback. The control root
  includes both charters, child workflows, queue builder, attester/parser, and permanent
  sensor. Progress evidence must be selected from the attested commit's catalog with a
  concrete verifier and committed target; command text and free-floating digest syntax
  are not resolved evidence. This IS `.eforest/loop.md` running; it must honor the project
  states (halt and independently attest `invalid_loop` rather than push a task through
  dishonestly).
- **plan-epic** — decompose a roadmap epic into task folders (proposals → judge → authors
  → hostile spec review). `args {epic: 3}`.
- **replay-triage** — production feedback: interrogate production/dogfood Replay
  recordings, cluster defects, file evidence-backed bug tasks into the queue.
- **golden-sweep** — re-earn every standing verification (goldens, replay determinism,
  convergence fixtures, promoted tests, fuzz smoke, cold-clone) with independent
  reproduction of any failure.
- **roadmap-audit** — catch the board lying: queue vs task readmes, statuses vs
  Verification logs, the app vs verified reality, doctrine references vs the actual tree.

## The gauntlet

```
builder edits code
      │
      ▼
format + lint                seconds  · deterministic
      │
      ▼
typecheck                    seconds  · deterministic
      │
      ▼
tests                        minutes  · deterministic
      │
      ▼
build                        minutes  · deterministic
      │
      ▼
self-validation              minutes  · builder drives its own runs until satisfied
      │                                 (all of it inside the task folder's work/)
      ▼
Replay QA journey run        minutes  · event log + state digests (always)
      │                                 + journey evidence; full exploration at epic close
      ▼
adversarial verification     minutes  · fresh session falsifies the evidence run,
      │                                 audits the diff, promotes tests
      ▼
verified → build_queue.py → commit → next task
```

A failure at ANY stage returns the builder to the top, with the failure report as new
context. Failure means starting over, not patching in place — a fix applied mid-pipeline
never re-earned the earlier gates. And every verified task deposits promoted tests, golden
artifacts, and fuzz seeds into the cheap gates at the front, so the pipeline gets stricter
every time it runs. That's the compounding the whole system is built for.

## Production is the same loop

Production sessions are recorded with the same Replay tooling, so a production bug arrives
as — or is reproduced into — a recording whose ID enters the same citation pipeline.
`replay-triage` turns recordings into bug tasks whose repro is the extracted event log
replayed to a digest; the fix is done only when a hostile fresh session fails to refute
the claim against a **new** recording of the same steps, and the replayed log joins the
regression corpus. And once Epic 6 lands, this whole loop is a **product feature**: any
project hosted on electric-forest runs the same builder/critic gauntlet out of its own
`.eforest/` directory, statuses streaming live to everyone watching the branch.

## Platform quick-reference

- **Replay QA reaches the local app through its managed tunnel.** Keep the real full stack
  running, bind this checkout through `.replay/config.json`, start the outbound proxy, and
  run focused journeys in that project, plus one full exploration at each epic close. The browser runs in Replay QA, not in a local
  recording harness.
- Stream-layer evidence (event logs, digests, convergence fixtures) runs everywhere,
  including CI, and is the fallback currency wherever Replay tooling is absent — declared
  loudly: `SKIPPED: <reason>` and a nonzero exit unless `VERIFY_ALLOW_SKIP=1`.
- Runtime boundary: ElectricSQL's published `@durable-streams/client` and
  `@durable-streams/server` packages define transport behavior locally; Electric Cloud
  defines it in deployment. `@eforest/streamfs`, reducers, validation, digests, and
  merge semantics are application layers above that boundary. This repository never
  implements another Durable Streams transport. The explicitly authorized E4-T03
  provider-retention patch is a task-scoped exception: it stays pinned to the published
  server and adds no second transport. If `blamy/emulate` adds Durable Streams support,
  it wraps the published reference server without a fork. Full rationale and current
  limits are in `ARCHITECTURE.md`.
