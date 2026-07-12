---
id: E0-T13
epic: 0
title: "Capstone: two-terminals-one-log — cold-clone dispatch, live tail, kill/resume, identical digests via make verify-E0-*"
priority: 13
status: implemented
depends_on: [E0-T08, E0-T11, E0-T12]
estimate: M
capstone: true
---

## Goal

ROADMAP's Epic-0 demo — **two-terminals-one-log** — runs mechanically, from a cold
start, under `make verify-E0-T13`. From a pristine clone (`tools/verify/cold_clone.sh`,
scrubbed env per the E0-T02 contract) with a **fresh server data dir** created by the run
itself: process A creates a stream and dispatches a scripted action sequence through the
validated `POST /dispatch` door (E0-T11 — including one deliberately invalid action that
is refused and provably never lands on the log); process B live-tails the same stream via
`packages/client`'s `tail()` in `long-poll` mode and replays the events through the same
reducer; **both processes independently print the same SHA-256 state digest**. Then B is
`SIGKILL`ed mid-stream, restarted from its persisted offset checkpoint file, drains the
remaining suffix — and the digests still match. The whole demo, including the kill/resume
leg, is one deterministic orchestration: `verify-E0-T13` runs it end-to-end, `ef replay
--digest` over A's committed dump independently reproduces the digest, `ef bisect`
(E0-T12) confirms zero divergence between A's dispatched log and B's received
(prefix+suffix) log, and `make verify-all` — the union of every `verify-E0-T{nn}` target
frozen by E0-T02 — is green at the claimed commit. Epic 0 is done when this target
cannot be distinguished from the ROADMAP capstone paragraph by any observable.

## Context

This is the Epic-0 capstone: the gate the whole epic ladders toward (ROADMAP "Epic 0 —
the-seed", capstone paragraph). Per `.eforest/tasks/README.md`, a capstone additionally
requires its demo to run **end-to-end from a cold start** — fresh clone, scrubbed env,
fresh stream-server data dir, no state left over from development. Nothing new is
designed here; this task is pure composition and proof:

- **E0-T08** supplies process B's machinery — `StreamReader.tail()` in long-poll mode,
  the persistable offset checkpoint, resume-from-checkpoint after SIGKILL.
- **E0-T09** (inherited via E0-T11's dependency closure) froze the protocol contract
  both processes speak; the capstone must not bend it (no private dialect between the
  demo scripts and the server).
- **E0-T11** supplies the dispatch door: process A mutates state **only** via
  `POST /dispatch`, and the demo exercises the refusal path so the capstone proves the
  door, not just the pipe.
- **E0-T12** supplies `ef bisect`, the divergence-localization half of the evidence;
  **E0-T04** (`ef replay`, transitively verified) supplies the digest half.
- **E0-T02** froze the `verify-E{n}-T{nn}` target contract this task's orchestrator
  composes into; **E0-T07** (file-backed store) is what makes "fresh server data dir" a
  meaningful phrase.

Anything the demo needs that a dependency failed to deliver is a finding against that
dependency, not a workaround to be quietly absorbed here — a capstone that patches
around its epic refutes the epic. The scripted action sequence is a **committed
fixture** (not generated at run time by the code under test), so the expected digest is
a frozen artifact and any drift is a real regression.

Replay browser layer: **N/A** — no web surface exists until Epic 3, declared here per
AGENTS.md and the E0-T02 convention (`Replay: N/A (no browser surface until Epic 3)`);
mitigation is the stream-layer evidence this task exists to produce: both processes'
committed log dumps, digest transcripts, the independent `ef replay` reproduction, and
the `ef bisect` zero-divergence check.

## Deliverables

- `tools/verify/e0-capstone/` — the demo as code, runnable by anyone:
  - `actions.jsonl` — the committed scripted action sequence A dispatches (including
    exactly one invalid action expected to be refused with the E0-T11 status).
  - `terminal_a.mjs` — spawns/targets the server with a **fresh data dir under the run's
    scratch space**, `PUT`-creates the stream, dispatches `actions.jsonl` through
    `POST /dispatch`, dumps its authoritative event log to a file, prints
    `A digest: <sha256>`.
  - `terminal_b.mjs` — separate OS process: tails via `packages/client` long-poll from
    offset `-1`, persists its offset checkpoint to a file after every yielded batch,
    appends received events to its own log file, replays through the reducer, prints
    `B digest: <sha256>` on completion.
  - `run.sh` — the orchestrator: starts the server (ephemeral port, fresh data dir),
    starts B, runs A, **SIGKILLs B at a mid-stream point**, restarts B from the
    checkpoint file, waits for drain, compares the two printed digests byte-for-byte,
    runs `ef replay --digest` on A's dump and `ef bisect` on A's dump vs B's
    prefix+suffix log, and exits nonzero on any mismatch. Kill point is configurable
    (`EF_CAPSTONE_KILL_AFTER=<n>`) so the critic can pick their own, with pinned edge
    behavior: at `EF_CAPSTONE_KILL_AFTER=0` (B killed before any yielded batch) the
    restarted B finds no checkpoint file and tails from offset `-1`, and the digests
    must still match; a kill point at or past the last event means the kill never
    fires, and `run.sh` must exit nonzero with an explicit "resume leg did not
    execute" error rather than passing. Also provides a
    standalone re-check mode — `run.sh --check <a-dump> <b-log>` — that recomputes both
    digests via `ef replay --digest` and exits nonzero on mismatch, so the digest
    comparison can be exercised against arbitrary (including tampered) log copies
    without a live run.
- `Makefile`: `verify-E0-T13` composed per the E0-T02 contract (standard `_v-*` gates
  plus the `run.sh` orchestration), joined to `verify-all` and visible in
  `make verify-list`; `.PHONY` updated.
- Committed evidence in
  `.eforest/tasks/epic-0-the-seed/E0-T13-two-terminals-one-log/evidence/`:
  - `a-dispatched.jsonl` — process A's authoritative dump.
  - `b-received-prefix.jsonl`, `b-received-suffix.jsonl` — B's log before the kill and
    after the resume, plus `b-checkpoint.txt` (the persisted offset B resumed from).
  - `digests.txt` — both processes' printed digests, the `ef replay` reproduction, and
    the exact commands.
  - `bisect-clean.txt` — `ef bisect` transcript showing zero divergence A vs B.
  - `sensitivity-tamper.txt` — transcript of the tamper drill: one event in a copy of
    B's saved log mutated (one byte), the digest comparison going red, and `ef bisect`
    naming the exact tampered offset. Plant applied to a copy, never committed.
  - `cold-clone-capstone.txt` — `tools/verify/cold_clone.sh verify-E0-T13` transcript,
    plus a `verify-all` transcript at the same SHA.
  - `dispatch-refusal.txt` — the invalid action's request/response and proof (dump
    grep + digest stability) that the log was untouched by it.
- Verification log entry (builder claim): commit hash, every command and exit code,
  digest values, evidence paths, and the `Replay: N/A` declaration with mitigation.

## Acceptance criteria

- [ ] `tools/verify/cold_clone.sh verify-E0-T13` exits 0 from pristine committed HEAD in
      a scratch dir with scrubbed env; the transcript
      (`evidence/cold-clone-capstone.txt`) shows the server data dir was created inside
      the run's scratch space (path printed) — not reused from the working tree, `/tmp`,
      or a dev server.
- [ ] Two-process digest identity: the orchestration transcript contains
      `A digest: <d>` and `B digest: <d>` with byte-identical `<d>`, printed by two
      distinct OS processes (distinct PIDs logged in the transcript), recorded in
      `evidence/digests.txt`.
- [ ] Kill/resume: the transcript shows B receiving a strict prefix, being SIGKILLed
      (signal logged), restarting from `evidence/b-checkpoint.txt`'s offset, and the
      final `B digest` still equals `A digest`; B's concatenated
      prefix+suffix log contains no duplicate at and no gap after the checkpoint offset
      (asserted by the orchestrator, not eyeballed).
- [ ] Independent reproduction: `pnpm ef replay evidence/a-dispatched.jsonl --digest`
      (exact command in `evidence/digests.txt`) prints the same digest `<d>` — a third
      computation of the digest, by a tool neither demo process links against at run
      time.
- [ ] Zero divergence: `ef bisect` over `evidence/a-dispatched.jsonl` and the
      concatenation of `evidence/b-received-prefix.jsonl` +
      `evidence/b-received-suffix.jsonl` reports no divergent offset
      (`evidence/bisect-clean.txt`).
- [ ] Sensitivity (mandatory): with one byte of one event mutated in a **copy** of B's
      saved log, `tools/verify/e0-capstone/run.sh --check evidence/a-dispatched.jsonl
    <mutated-copy>` exits nonzero AND `ef bisect` names exactly the tampered event's
      offset — transcript (exact commands and exit codes) in
      `evidence/sensitivity-tamper.txt`; working tree clean of the plant afterward.
- [ ] Dispatch door proven in the demo: the invalid action in `actions.jsonl` is refused
      with the E0-T11 contract status, `evidence/a-dispatched.jsonl` contains exactly
      the valid actions (count asserted) and zero trace of the invalid one, and the
      digests above were computed over that refusal-containing run
      (`evidence/dispatch-refusal.txt`).
- [ ] `make verify-all` exits 0 at the claimed commit, running the union of every
      `verify-E0-T{nn}` target (transcript shows each target's OK line), and for every
      Epic-0 task with `status: implemented|verified`, `make verify-list` output
      contains a `verify-E0-T{nn}` line matching its id, and each such target appears
      in the `verify-all` transcript with an OK line (count of OK lines == count of
      such tasks).
- [ ] Epic gate: every Epic-0 task E0-T01…E0-T12 is `verified` in frontmatter (or
      carries a documented optional/stretch exemption stated in both its Context and
      this readme — none is currently declared); after running `python3
    tools/build_queue.py`, `git diff --exit-code .eforest/tasks/QUEUE.md` passes
      (the committed queue is the regenerated queue) and `QUEUE.md` lists no Epic-0
      task as pending/in-progress/implemented except E0-T13 itself. Evidence: the
      task frontmatter files at the claimed SHA plus the clean regenerated `QUEUE.md`
      diff, with commands and exit codes recorded in the Verification log entry.
- [ ] All standard gates green at the claimed commit: `pnpm format:check && pnpm lint
    && pnpm typecheck && pnpm test && pnpm build` each exit 0, with each command and
      its exit code recorded in the Verification log entry (stream layer: transcript).
- [ ] Replay (browser layer): N/A — no browser-reaching surface until Epic 3; declared
      in the claim with the stream-layer dumps and digest transcripts named as
      mitigation.

## Adversarial verification

This is a capstone: the claim is "the epic's machine works end-to-end from nothing."
Attack the _from nothing_ and the _end-to-end_ separately, with your own parameters —
never the builder's transcripts, kill points, or tamper offsets. Any single success
refutes. Invent at least one more angle.

1. **Cold-start sabotage.** Run `tools/verify/cold_clone.sh verify-E0-T13` yourself,
   then again with a poisoned caller env (`NODE_OPTIONS`, `NODE_ENV=production`,
   `npm_config_registry` pointing at a dead port) and a warm dev server deliberately
   left running on a likely port. The run must pass regardless of the env (scrub
   contract) and must be provably independent of the warm server: kill your warm server
   mid-capstone-run and the capstone must not care. Then hunt warm state: grep the demo
   scripts for fixed ports, absolute paths, `~/.`-anything, and reads of a data dir
   outside the run's scratch space. Any dependency on pre-existing state refutes the
   cold-start claim.
2. **One-process theater.** The headline claim is _two_ terminals. Verify the digests
   are computed by genuinely separate OS processes: check the logged PIDs differ, strace
   the orchestrator or add your own logging in a scratch worktree, and confirm B's
   digest is computed from **B's received log**, not from A's dump handed over via the
   filesystem. Sabotage check: in a scratch worktree, make B replay `a-dispatched.jsonl`
   instead of its own received events, then expose it through the live path — pick at
   least one of: (a) before starting the run, pre-create `a-dispatched.jsonl`'s path as
   an unreadable directory (`mkdir` + `chmod 000`) — or otherwise make that path
   unreadable/unwritable to B's process — so A's dump can never be read by B; an honest
   B must still print the correct digest from its own received log, while the sabotaged
   B errors or hangs; (b) delay the orchestrator's write of
   `a-dispatched.jsonl` until after `B digest:` has printed — a dump-reading B deadlocks
   or errors where an honest B is unaffected; (c) instrument the run (`lsof`, `dtruss`,
   or equivalent syscall tracing) and assert B's process never opens
   `a-dispatched.jsonl`. If none of these observables distinguishes the sabotaged
   orchestrator from the real one, the demo is theater and the task is refuted.
3. **Kill-point sweep.** Re-run with your own `EF_CAPSTONE_KILL_AFTER` values: 0 (killed
   before receiving anything), 1, the exact last event (nothing left to resume), and a
   value past the end (kill never fires — the orchestrator must still assert the resume
   leg ran or fail loudly, not silently skip it). Also SIGKILL B yourself at a moment
   the orchestrator didn't choose, between a yield and the checkpoint persist if you can
   land it. Refutation: any run where the final digests differ, where B's
   prefix+suffix log has a boundary duplicate or gap (bisect it — the offset is your
   citation), or where the orchestrator reports green without the resume leg executing.
4. **Tamper drill, your offsets.** Repeat the sensitivity proof with your own
   mutations: flip a byte in a different event than the builder chose (first event,
   last event, and one in B's suffix specifically), delete one event, duplicate one
   event, and swap two adjacent events. For each: the digest comparison must go red and
   `ef bisect` must name the exact first-divergent offset. A tamper that stays green
   refutes the entire measuring apparatus and voids every digest claim in this epic's
   evidence.
5. **Dispatch-door bypass.** The demo claims the one-mutation-door bet — scoped to
   what E0-T11 actually froze. Inject your own invalid actions (wrong type, malformed
   payload, oversized, duplicate of a valid one) through `/dispatch`. Per E0-T11's
   frozen contract, refusals must leave the log untouched: re-dump A's stream after
   your attack volley and digest-compare against the pre-attack dump. Refutation is
   (a) any invalid action accepted through `/dispatch`, or (b) any `/dispatch` refusal
   that grows the log, or a demo that only passes because nothing ever tested the door
   mid-run. Also attempt a raw `POST /streams/:id` append — but know the expected
   outcome: per E0-T11 (which keeps the T05/T09 raw handler unchanged), the raw append
   will be **accepted**; that door closes in Epic 2, not here, and its success is not a
   finding against this task. Perform the raw append against a scratch stream (or only
   after the demo's final dump) and exclude it from the pre/post digest comparison so
   it cannot pollute the `/dispatch` evidence.
6. **Scripted-sequence honesty.** The expected digest must be a function of the
   committed `actions.jsonl`, nothing else. Edit one action's payload in a scratch
   worktree: both processes' digests must change (together) and any committed expected
   digest must go red. If the digests don't move, something is hardcoded and the demo is
   self-licking. Then run the full orchestration twice back-to-back from the same clone:
   digests must be identical across runs (determinism), and the second run must not be
   contaminated by the first (fresh data dir per run).
7. **Evidence authenticity.** Re-earn every committed artifact: `ef replay --digest`
   over `evidence/a-dispatched.jsonl` must print the digest in `evidence/digests.txt`;
   `ef bisect` over the committed A/B logs must be clean; the concatenated B log's
   event count must equal A's dump's count; `evidence/b-checkpoint.txt`'s offset must
   actually fall strictly inside the log (a checkpoint at offset `-1` or at the head
   means the kill/resume evidence is decorative). A committed artifact you cannot
   reproduce from the committed code is fabricated evidence and refutes outright.
8. **Epic-gate audit.** A capstone verdict certifies the epic. Cross-check that
   E0-T01…E0-T12 are all `verified` with Verification-log entries to match, that
   `make verify-all` at the claimed SHA really runs all thirteen targets (count the OK
   lines), and that no dependency was quietly patched inside this task's diff — any
   change to `packages/*` or `tools/verify/*.sh` beyond adding the capstone
   orchestration needs a stated reason or it's a finding against the dependency's
   verification.

Refutation currency: an event-log file + the first divergent offset (`ef bisect`
output), a digest pair that should match and doesn't (or should differ and doesn't), a
transcript showing green where the contract demands red, or a planted diff — each cited
by file:line/offset. `Replay: N/A (no browser surface until Epic 3)`; the stream-layer
artifacts above are the whole currency, and their independent reproducibility is the
epic's exit exam.

## Verification log

(appended over time by builders and critics)

### 2026-07-12 — builder — implemented

- Commit: `c0f012e` (`fix: refresh Epic 0 verification coverage`), on
  `codex/e0-t13-two-terminals-one-log`, stacked on verified E0-T12 `514c1b0`.
- Capstone: `tools/verify/e0-capstone/run.sh` starts a fresh reducer-configured file
  server/data directory, terminal A dispatches five valid actions plus one refused
  `capstone/invalid` action, terminal B tails through `@eforest/client` long-poll, is
  SIGKILLed after a strict three-event prefix, then resumes from the persisted offset.
  A and B independently produce digest
  `64b2717b5418603ad46f937ec957121d1f32237a04085fb132db41caf9bb7020`; `ef replay` and
  `ef bisect` independently confirm the concatenated B log is identical to A. The
  committed evidence records distinct PIDs, the killed PID, checkpoint offset
  `0000000000000000_0000000000000002`, refusal status 404, and the tamper drill's
  divergence at index 1.
- Edge attacks: `EF_CAPSTONE_KILL_AFTER=0` passed with no checkpoint before restart;
  `EF_CAPSTONE_KILL_AFTER=5` failed loudly with `resume leg did not execute`.
- Gates: `CI=true make verify-E0-T13` passed with 14 test files/100 tests and the full
  capstone. `make verify-all` passed every target `verify-E0-T01` through
  `verify-E0-T13`; the concise target transcript is committed at
  `evidence/verify-all.txt`. The final cold clone passed at the claimed SHA; transcript
  is `evidence/cold-clone-capstone.txt`.
- Verification-scope repairs required by the union: `no_reimpl_grep.sh` now excludes
  the legitimate file-store frame checksum, and `redux_replay_path_check.sh` scans only
  production server code, not test evidence. No protocol or server implementation was
  changed for these repairs.
- Replay: N/A (CLI/server-only Epic-0 surface; no browser exists until Epic 3) + mitigation:
  committed A/B event logs, digests, checkpoint, bisect transcript, dispatch refusal,
  tamper sensitivity, full gate output, and pristine-clone output.
