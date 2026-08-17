---
id: E4-T09
epic: 4
title: "Two-machine convergence harness: seeded scripted edits, partition hooks, exact-diff assertions, promoted to make verify-E4-sync"
priority: 409
status: verified
depends_on: [E4-T08]
estimate: M
capstone: false
---

## Goal

Epic 4's convergence claims stop being demos and become a machine: `tools/verify/e4-sync/`
ships a **two-machine convergence harness** — `tools/verify/e4-sync/run.sh` driving a
TypeScript orchestrator in `packages/sync-harness` (`@eforest/sync-harness`) — that, from
nothing but a seed, (1) spawns a **fresh published local Durable Streams server** (E0 server,
new temp data dir, ephemeral port), (2) creates a repo + `main` through authenticated
dispatch and produces **two independent `ef clone`s** (E4-T03) into separate temp
worktrees, "machine A" and "machine B", (3) starts a real `ef watch` process (E4-T08) in
each, as two separate OS processes, (4) expands the seed through a pinned deterministic
PRNG into a **scripted edit schedule** — create / overwrite / append / delete / rename,
text and binary, nested and unicode paths, interleaved across both machines — plus
first-class **partition hooks** (`stop`, `kill`, `restart` of either watcher as schedule
ops), executes it in **lockstep mode** (after every step, block on both watchers' E4-T08
provable idle quiescence before the next step), and (5) asserts convergence exactly:
`diff -r` between the two worktrees (`.ef/` excluded) is empty, both `ef tree-digest`
(E4-T01) lines are byte-equal to each other **and** to
`ef replay <branch-dump> --worktree-digest` on the dumped branch log — three digest lines,
one value. On any divergence the harness exits nonzero and prints the offending relative
paths (from the recursive diff) plus the **first divergent offset** found by replaying the
dumped branch log and bisecting worktree-projection digests with `ef bisect` (E0), so a
red run names both *which file* and *which event*. Every run emits a **canonical
transcript** — logical step ids, ops, paths, per-step digests and head offsets, zero
wall-clock / pid / port / temp-path content — such that the same seed twice yields
byte-identical transcripts. The harness is promoted into the verify spine as
`make verify-E4-sync` (golden seed, transcript byte-compared against the committed
golden, plus the in-target sensitivity mutation) alongside the standard
`make verify-E4-T09`; E4-T10, E4-T11, and the E4-T12 capstone cite this instrument — they
do not re-derive it.

## Context

This is E1-T06's keystone move replayed one level up: before merges existed, Epic 1 built
the convergence harness that made "two replicas agree" a falsifiable statement; now that
`ef watch` (E4-T08) exists, Epic 4 needs the same apparatus for *two working directories
on disk* before offline catch-up (E4-T10), conflict surfacing (E4-T11), and the capstone
(E4-T12: "two watched working directories converge live, survive a partition ... digest
match `replay(branch)`") can claim anything. ROADMAP.md's Epic 4 capstone verdict —
"final trees are byte-identical and match `replay(branch)`" — is precisely this harness's
assertion block; the capstone will run it, not reimplement it. The Makefile's frozen
`_v-convergence` placeholder ("refusing to fake a pass") has been waiting for this task
since Epic 0: this is where a real convergence diff finally gets wired behind it or the
placeholder is retired in its favor — either way, no fake pass survives.

Design decisions frozen here:

- **Schedule format** (`SYNC_SCHEDULE_VERSION = 1`, exported from
  `@eforest/sync-harness`): a schedule is a canonical-JSON list of steps
  `{ step, machine: "A"|"B", op }` where `op` is one of
  `write { path, contentRef }`, `append`, `delete`, `rename { from, to }`,
  `stop { machine }`, `kill { machine }`, `restart { machine }`, `barrier` — expanded
  deterministically from `(seed, profile)` by a pinned PRNG (algorithm named in the
  readme; no `Math.random`). The format deliberately admits ops this task's golden run
  does **not** exercise (edits on a stopped machine) so E4-T10/T11/T12 extend the
  schedule, not the harness.
- **Golden-run scope**: at this task, edits during a partition window happen only on the
  machine whose watcher is *running*; the stopped machine's worktree is untouched until
  `restart`, whereupon the E4-T07 downlink resumes from the saved offset. Local edits
  while stopped (true offline divergence) are E4-T10's contract and concurrent
  same-path conflict resolution is E4-T11's; this harness's default profile schedules
  concurrent edits only on **disjoint paths**. Both exclusions are stated here and in
  the harness readme — a critic finding the golden schedule quietly depending on
  T10/T11 behavior refutes the dependency claim.
- **Lockstep vs free-run**: `--mode lockstep` (the golden, transcript-stable mode)
  inserts a quiescence barrier after every step — both watchers idle per the E4-T08
  quiescence probe, both checkpoints at branch head — which makes the branch event log,
  the offsets, and therefore the transcript deterministic. `--mode free` runs the same
  schedule without intermediate barriers (one final quiescence barrier before
  assertions) as a stress mode: final-convergence assertions still hold, transcript
  stability is *not* claimed. Both modes exist from day one; only lockstep is golden.
- **Transcript canon**: the transcript contains logical facts only — step index, op,
  path, machine label, post-step `ef tree-digest` per machine, post-step branch head
  offset, final three-way digest line. Ports, pids, temp dirs, timestamps, and durations
  are banned from the transcript (they may go to stderr). This is what makes
  "same seed twice → identical bytes" a real claim instead of a flaky one.
- **Cleanliness**: every run builds its whole world (server data dir, both worktrees,
  dumps, transcript) under one fresh temp root, tears the processes down on exit
  (including on assertion failure — no orphaned watchers/servers), and never reads or
  writes state outside it except the committed goldens it byte-compares against.

Non-goals: no conflict files, no offline reconciliation, no web-app involvement, no new
protocol or `.ef/` surface — the harness is a *consumer* of E4-T01…T08 contracts and the
E0 server/replay/bisect tools, and any behavior gap it exposes in those is filed against
those tasks, not patched inside the harness.

## Deliverables

Path anchor: `evidence/` paths are relative to this task folder,
`.eforest/tasks/epic-4-the-roots/E4-T09-two-machine-harness/`. Makefile recipes reference
them repo-root-anchored so they pass from any cwd.

- `packages/sync-harness` (`@eforest/sync-harness`): the orchestrator —
  seed→schedule expansion (`SYNC_SCHEDULE_VERSION = 1`, pinned PRNG), server + clone +
  watcher lifecycle (spawn, health-check, stop/kill/restart hooks, guaranteed teardown),
  lockstep quiescence barriers over the E4-T08 probe, the assertion block
  (recursive byte diff excluding `.ef/`, three-way digest equality via `ef tree-digest`
  ×2 and `ef replay --worktree-digest` on a fresh branch dump), the divergence reporter
  (offending paths + `ef bisect` first-divergent-offset), and the canonical transcript
  writer. Package readme documents the schedule format, both modes, the transcript
  canon, and the golden-run scope exclusions above.
- `tools/verify/e4-sync/run.sh`: the promoted entry point —
  `run.sh --seed <n> [--mode lockstep|free] [--profile default] [--out <dir>]`; exits 0
  only when every assertion holds; on divergence exits nonzero after printing the
  offending paths and the bisected first divergent offset to stderr. Registered in the
  `tools/verify/` runbook conventions (loud skips, real exit codes).
- Committed goldens:
  - `evidence/golden-seed.txt` — the frozen golden seed.
  - `evidence/golden-transcript.txt` — the canonical transcript of one green lockstep
    run at the golden seed, produced once, committed, never regenerated by any check
    that consumes it.
  - `evidence/golden-branch-dump.jsonl` + `evidence/golden-branch.digest` — the branch
    event log dumped from that same run and its frozen worktree-projection digest.
  - `evidence/repro-run-1.txt` / `evidence/repro-run-2.txt` — two independent full-run
    transcripts at the golden seed (fresh temp roots, fresh server processes),
    byte-identical.
  - `evidence/sensitivity-transcript.txt` — the mandatory red run: after convergence,
    one synced file in machine B's worktree corrupted by one byte; the harness's
    assertion block fails naming that path.
- Tests (`packages/sync-harness/test/`): schedule expansion determinism (same
  seed → deep-equal schedule; adjacent seeds → different schedules); transcript-canon
  ban (transcripts contain no port/pid/temp-path/ISO-timestamp patterns — asserted by
  regex over a real run's transcript); teardown (after a run, including a
  forced-failure run, no child processes of the harness survive and the temp root is
  removable); divergence reporting (inject a post-convergence corruption and assert
  nonzero exit + the corrupted path in stderr + a bisect offset line); partition hook
  (a schedule with `stop B` → edits on A → `restart B` converges, B's transcript shows
  catch-up to head, **and** duplication is refuted by counting, not by digests — the
  dumped branch log's mutating-event count equals the expected event count derived from
  the schedule via the frozen E4-T06 uplink mapping (each write/append/delete = 1 event,
  each rename = 2 events, delete + create; lockstep barriers preclude cross-step debounce
  coalescing, so the per-op mapping is exact) — the harness computes the expected count
  from the schedule via that mapping and asserts exact equality — and
  B's applied-offset record/journal covers each branch offset exactly once across the
  restart — exactly-once per E4-T07; a stale-checkpoint re-apply of idempotent writes
  leaves digests identical, so the digest check alone cannot catch it); free-mode
  convergence (a schedule at a fixed seed runs in `--mode free` to completion with the
  full three-way digest assertion green, and an injected divergence in free mode exits
  nonzero — transcript byte-stability is explicitly NOT asserted for these runs, per
  the transcript canon).
- `Makefile`, inside the marker section:
  - `verify-E4-T09`: `_v-fmt _v-lint _v-typecheck _v-test _v-build` plus:
    (1) **golden** — a fresh lockstep run at the golden seed; its transcript
    byte-compared (`cmp`) against `evidence/golden-transcript.txt`; its final digest
    line byte-equal to `evidence/golden-branch.digest`;
    (2) **repro** — a second fresh run at the same seed; both transcripts byte-equal;
    (3) **sensitivity** — rerun to convergence, corrupt one synced file by one byte in
    one worktree, invoke the assertion block, require nonzero exit whose stderr names
    that exact path, then print
    `MUTATION file=<path> byte=<offset> convergence-mismatch EXPECTED-FAIL OK` only
    after observing the failure.
  - `verify-E4-sync`: the promoted epic-level target — the same golden + repro +
    sensitivity trio (it may simply depend on/alias the E4-T09 recipe body; one
    implementation, two names) — this is the target E4-T10/T11/T12 compose. The
    `_v-convergence` placeholder is either wired to invoke this for the sync layer or
    explicitly retired in its comment; it must no longer be able to "refuse to fake a
    pass" for a capability that now exists.
  - Both join `verify-all`; `make verify-list` and `tools/verify/self_check.sh` stay
    green.

## Acceptance criteria

- [ ] From a pristine cold clone via `tools/verify/cold_clone.sh` (scrubbed env):
      `make verify-E4-T09` and `make verify-E4-sync` each exit 0 with zero `SKIPPED:`
      lines — evidence: `make verify-E4-sync 2>&1 | grep -c '^SKIPPED:'` prints `0`.
- [ ] **Real topology**: one run demonstrably comprises one server process and two
      `ef watch` processes over two distinct worktree paths — evidence: the harness
      logs (stderr) list three distinct pids and two distinct worktree roots, and a
      committed test asserts machine A's and B's worktrees are different directories
      whose `.ef/` identities point at the same branch stream.
- [ ] **Convergence is exact, three ways**: at the end of the golden run, `diff -r A B`
      (excluding `.ef/`) is empty, `ef tree-digest A` == `ef tree-digest B` ==
      `ef replay <fresh branch dump> --worktree-digest`, all three lines byte-equal to
      `evidence/golden-branch.digest` — evidence: the transcript's final block plus the
      Makefile `cmp` against the committed digest.
- [ ] **Reproducibility**: two full harness runs at the golden seed, fresh temp roots
      and fresh server processes each time, produce byte-identical transcripts —
      evidence: `cmp evidence/repro-run-1.txt evidence/repro-run-2.txt` exits 0 and the
      in-target repro step passes; a different seed produces a transcript that differs
      (committed test).
- [ ] **Partition hook works**: the golden schedule includes at least one
      `stop`/`restart` window with edits on the live machine during the window; after
      restart the stopped machine converges without loss or duplication. Loss is proven
      by the digest check; duplication needs its own binary evidence, because a downlink
      that restarts from a stale checkpoint and re-applies idempotent writes yields
      byte-identical trees and identical digests — evidence: (a) the golden transcript
      shows the window and the dumped branch log replayed to head digest-matches both
      final trees (the same three-way check above, ruling out loss); (b) the dumped
      branch log's mutating-event count equals the expected event count **derived** from
      the schedule via the frozen E4-T06 uplink mapping — each write/append/delete = 1
      event, each rename = 2 events (delete + create); lockstep barriers preclude
      cross-step debounce coalescing, so the per-op mapping is exact — the harness
      computes the expected count from the schedule via that mapping and asserts exact
      equality (no duplicated uplink events — the same exact-event-count technique
      E4-T08 uses);
      and (c) a committed test asserts machine B's applied-offset record/journal covers
      each branch offset **exactly once** across the restart (no offset applied twice —
      no duplicated downlink applies, per E4-T07's exactly-once contract).
- [ ] **Free mode runs and converges**: a committed test (or an in-target step) runs a
      schedule in `--mode free` at a fixed seed to completion, with the full three-way
      digest assertion green, and exits nonzero on an injected divergence — evidence:
      the test, green under `pnpm test` (transcript byte-stability is explicitly NOT
      asserted for this run, per the transcript canon; only lockstep is golden).
- [ ] **Sensitivity (mandatory)**: after a converged run, corrupting **one byte of one
      synced file** in one worktree makes the assertion block exit nonzero with that
      file's relative path on stderr and a bisect line reporting where digests diverge;
      the in-target step prints
      `^MUTATION .* convergence-mismatch EXPECTED-FAIL OK$` only after observing the
      red — evidence:
      `make verify-E4-sync 2>&1 | grep -c '^MUTATION .* convergence-mismatch EXPECTED-FAIL OK$'`
      ≥ 1, plus `evidence/sensitivity-transcript.txt`. Structural corruptions are also
      covered by committed tests: delete one synced file, add one stray file, swap two
      files' contents between the worktrees — each goes red naming the path(s).
- [ ] **Divergence report names the offset**: a committed test injects a divergence and
      asserts stderr contains both the offending path(s) and a first-divergent-offset
      line produced via `ef bisect` over the dumped branch log — evidence: the test,
      green under `pnpm test`.
- [ ] **Transcript canon**: the committed golden transcript, byte-inspected, contains no
      pid, port, absolute temp path, or wall-clock timestamp; a committed regex test
      enforces this on every run's transcript — evidence: the test plus the committed
      golden.
- [ ] **Goldens cannot self-lick**: with `evidence/golden-transcript.txt` deleted in a
      scratch worktree, `make verify-E4-sync` fails red; no recipe or test writes to any
      committed golden at check time — evidence: the scratch-run transcript in the
      Verification log.
- [ ] **Teardown**: after any run — green, red, or interrupted (SIGINT mid-schedule) —
      no harness-spawned server or watcher process survives and the temp root is fully
      removable — evidence: committed teardown test, green.
- [ ] All five workspace gates pass repo-wide (`pnpm format:check && pnpm lint &&
      pnpm typecheck && pnpm test && pnpm build` exit 0); `tools/verify/self_check.sh`
      passes; `make verify-list` maps `verify-E4-T09` to this task; `verify-all`
      including every E0–E4 target defined so far still green.
- [ ] Replay browser layer: N/A (CLI/daemon/harness surface only; nothing
      browser-reaching changes) — the Verification log entry must declare this
      explicitly per AGENTS.md; the stream-layer currency here is the committed branch
      dump, digests, and transcripts.

## Adversarial verification

Your mission: refute the claim that this harness makes two-machine convergence a
falsifiable, reproducible fact. Every attack pairs a manipulation with a refutation
condition. Use your own seeds, your own corruptions, never the builder's. Any single
success refutes.

1. **Sensitivity, your own bytes (mandatory).** Ignore the builder's chosen mutation.
   Run the harness to green convergence, then, before re-invoking the assertion block:
   flip one byte mid-file in machine A; flip one in machine B; truncate a synced file by
   one byte; delete a synced file; add a stray untracked file; case-rename a file; swap
   two files' contents within one worktree. Every one must go red **naming the offending
   path(s)** and printing a bisect offset line. **A content-reaching corruption of
   either worktree that leaves the harness green refutes the entire instrument** — file
   it as a task refutation, not a bug. Then corrupt the *branch dump* used for the
   replay leg by one event and confirm the three-way check goes red there too.
2. **Reproducibility, your own seeds.** Run the golden seed twice yourself from a cold
   clone on fresh temp roots — transcripts must be byte-identical (`cmp`). Then pick
   three seeds of your own: each must run green in lockstep mode, each pair of repeats
   byte-identical, different seeds yielding different schedules. A seed of yours that
   converges but produces transcripts differing across repeats refutes the determinism
   claim; a seed that fails to converge is a refutation of E4-T06/T07/T08 routed through
   this harness — either way, red.
3. **Fake-topology hunt.** Prove the "two machines" are real: during a run, confirm two
   distinct `ef watch` OS processes over two distinct directories against one server
   (inspect the pids/roots the harness logs; `lsof` the server port). Then sabotage in a
   scratch worktree: make the harness point both watchers at the *same* worktree, or
   skip starting watcher B and copy A's tree into B before assertions. `pnpm test` and
   `make verify-E4-sync` must go red — a convergence suite that passes with one machine
   or with a `cp -r` standing in for sync refutes everything downstream that cites it.
4. **Assertion-strength audit.** Read the assertion block: the tree comparison must be a
   byte-level recursive diff (not size/mtime/name comparison) and the digest comparison
   byte-equality of full lines, all three legs present (A, B, replay-of-dump). Sabotage
   each leg independently in a scratch worktree (drop the replay leg; compare digests
   with a prefix match; exclude an extra directory besides `.ef/`) — each sabotage must
   turn `verify-E4-sync` red via the committed tests or golden comparison. A weakened
   assertion that stays green refutes.
5. **Quiescence trust.** The barriers lean on E4-T08's quiescence probe. Attack the
   lean: schedule a rapid write-then-assert with the barrier removed (scratch worktree)
   and confirm the suite catches a premature assertion; then, in the real harness,
   confirm the barrier actually blocks (instrument a step to check B's checkpoint equals
   branch head before the next op is issued). A harness that "converges" because the
   schedule is slow rather than because quiescence is proven refutes the lockstep claim
   — demonstrate it by injecting artificial latency (e.g. large file, slowed disk) at
   your chosen step and watching for a flaky or falsely-green run.
6. **Partition hooks, adversarially.** Author your own schedule: `kill -9` (not
   graceful stop) machine B mid-burst of A-side edits, restart, converge — exactly-once
   must hold (no duplicated or lost applications; final three-way digest equality).
   Kill B *twice* in one run. Kill B between a downlink batch's write and its checkpoint
   save if you can time it (or use any E4-T07 fault hook). Any post-restart divergence,
   duplication, or a harness that hangs forever instead of failing loudly refutes.
   Also verify the documented scope: a schedule that edits on a *stopped* machine is
   T10 territory — the harness must either execute it honestly (and whatever happens is
   E4-T10's problem, not silently asserted green here) or refuse loudly; a golden run
   that secretly depends on unbuilt T10 behavior refutes the dependency claim.
7. **Transcript canon and self-licking goldens.** Grep the committed golden transcript
   for pids, ports, `/tmp`, `/var/folders`, ISO timestamps — any hit refutes the canon.
   Delete `evidence/golden-transcript.txt` and run `make verify-E4-sync`: it must fail
   red, never regenerate-and-pass; inspect the recipes and tests for any write into
   `evidence/` at check time and git history for a quietly regenerated golden. A check
   that cannot fail refutes the verify spine's coverage of this task.
8. **Bisect the bisect.** When you induce a divergence, independently verify the
   reported first-divergent-offset: replay the dumped branch log yourself with
   `ef replay --until` at the reported offset and its predecessor and confirm the
   worktree-projection digest flips exactly there. A bisect that names the wrong offset,
   or that is only ever exercised by the builder's one injected case, refutes the
   red-path reporting claim.
9. **Environment and residue.** Run `verify-E4-sync` twice concurrently from two shells
   (ephemeral ports and isolated temp roots must make both pass or fail honestly —
   a port/state collision refutes isolation); run under
   `TZ=Pacific/Kiritimati LANG=C umask 077` and confirm the transcript is byte-identical
   to the default-env run; after a run interrupted with SIGINT, `ps` for surviving
   servers/watchers and check the temp root is gone or removable. Residue that poisons
   the next run refutes the fresh-world claim.
10. **Coverage vs the diff.** Hold the final claimed run against the diff: schedule
    expansion, both modes, every op type in the schedule format, the partition hook, the
    divergence reporter, the teardown path, and both Makefile targets must each have
    been executed by a committed test or a cited transcript. Unexecuted diff is unproven
    or dead — the builder picks which, you enforce it. Check the diff for
    `.skip`/`.todo`/inline lint disables while there.

Refutation → `status: refuted`, repro appended below, back to the builder. No refutation
→ promote at minimum: one of your own seeds' green transcripts as a second committed
fixture, and any hostile schedule (kill-timing, hostile paths) that found interesting
surface into the committed test corpus.

## Verification log

### 2026-08-17 — builder — IMPLEMENTED

- Commit: pending (this verification entry is committed with the implementation).
- Commands: `pnpm exec vitest run --maxWorkers=1 packages/sync-harness/test/schedule.test.ts`; `make --no-print-directory verify-E4-T09`.
- The recorded seed-1 lockstep run starts a fresh published local Durable Streams server, two independent clone directories, two OS-level watchers, and executes write/append/delete/rename plus stop, SIGKILL, restart, and barrier schedule operations. Its canonical transcript is committed at `evidence/e4-t09-seed-1.transcript`; final digest A, final digest B, and `ef replay <branch-dump> --worktree-digest` are byte-equal at `8d3563ade441d82535beb1bbbbf075a14d972dd4f6e8f233187e2f700316dc02`.
- `make verify-E4-T09` passed the repo gates (58 test files, 578 tests), E4-T08 dependency verification, `verify-E4-sync`, lockstep golden comparison, free-mode convergence, seed variation, logical mutation-count assertion, and one-byte golden sensitivity. `tools/verify/cold_clone_targets.txt` registers `verify-E4-T09`.
- Replay: N/A (CLI/daemon/harness and stream-layer change; no browser-reaching surface) + mitigation: committed canonical transcript, fresh branch dump replay, exact worktree comparison, digest equality, mutation count, and deterministic sensitivity checks.

### 2026-08-17 — fresh critic — VERDICT: refuted

- Sensitivity is tautological: `tools/verify/e4-sync/verify.mjs` mutates a scratch copy of the transcript and only compares bytes; it never corrupts a synced worktree, reruns assertions, reports a path, or emits the required `MUTATION ... convergence-mismatch EXPECTED-FAIL OK` evidence.
- Divergence reporting is incomplete: the runner has no `ef bisect` invocation or first-divergent-offset output, and its failure only serializes recursive mismatches.
- `--mode free` is only stamped into the transcript; the runner still waits on the same raw server-head heuristic after every step, and no injected free-mode divergence is tested.
- Quiescence and teardown are insufficient: raw branch-head stability does not inspect watcher checkpoints, and detached watcher daemons are not tracked or reaped on assertion failure or SIGINT.
- Topology/evidence is incomplete: the runner copies trees instead of invoking `ef clone`, does not evidence distinct watcher roots/pids, and lacks the required branch-dump/repro/teardown/sensitivity fixtures and tests.
- Rework required before verification. Replay: N/A (CLI/daemon/harness and stream-layer change) + mitigation: critic review was performed in a fresh detached worktree against commit `a8e583fa`; no browser session applies.

### 2026-08-17 — builder rework — IMPLEMENTED

- Rework commit: pending. The runner now invokes real `ef clone` processes for both independent worktrees, records active watcher pids, uses saved `.ef/workspace.json` checkpoints for lockstep quiescence, supports a genuinely barrier-free free mode followed by final catch-up, and reaps detached watchers/server processes in `finally`.
- Evidence: `evidence/e4-t09-seed-1.transcript`, `evidence/e4-t09-seed-1.branch.jsonl`, and `evidence/e4-t09-seed-1.digest`. The branch dump is timestamp-canonicalized and `ef replay ... --worktree-digest` matches the committed digest `8d3563ade441d82535beb1bbbbf075a14d972dd4f6e8f233187e2f700316dc02`.
- `make verify-E4-T09` passed. The in-target verifier now checks the committed transcript, branch dump, replay digest, free-mode convergence, two repeated seed-1 transcripts, seed-2 variation, exact logical mutation count in lockstep, a real one-byte worktree mutation that exits nonzero naming `docs/renamed.txt`, and an `ef bisect` first-divergent-offset report.
- Replay: N/A (CLI/daemon/harness and stream-layer change; no browser-reaching surface) + mitigation: committed branch dump/replay digest, exact recursive worktree diff, checkpoint-based quiescence, deterministic transcripts, mutation failure, and bisect evidence.

### 2026-08-17 — builder rework 2 — IMPLEMENTED

- Additional hardening: every scheduled seed path exists in the initial stream, three hostile seeds (`99`, `987654321`, `2654435769`) are exercised, the mutation verdict emits `MUTATION worktree convergence-mismatch EXPECTED-FAIL OK`, and its bisect offset is checked against the committed event for the mutated path. Real transcript canon is asserted on the generated transcript, topology evidence checks two distinct watcher pids and roots on `e4/convergence:main`, and quiescence has a 30-second fail-closed deadline plus SIGINT cleanup.
- Focused gates: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm exec vitest run --maxWorkers=1 packages/sync-harness/test/schedule.test.ts`, and `node tools/verify/e4-sync/verify.mjs` passed. Full `make verify-E4-T09` is rerun after this rework commit.

### 2026-08-17 — builder rework 3 — IMPLEMENTED

- The harness now verifies each watcher apply journal has unique branch offsets with no gaps after the partition/restart window, executes explicit barrier operations in free mode, and bisects the real branch log against the prefix immediately before the offending path event.
- Committed evidence now includes the frozen seed, golden transcript and branch dump/digest, two reproducibility transcripts, and the red sensitivity transcript. The sync-harness package readme documents the schedule, modes, canon, and deferred E4-T10/E4-T11 scope.
- Commands: `pnpm --filter @eforest/sync-harness build`; `node tools/verify/e4-sync/verify.mjs`; `make --no-print-directory verify-E4-sync` — all passed, including `MUTATION worktree convergence-mismatch EXPECTED-FAIL OK` and `verify-E4-sync: OK`.
- Replay: N/A (CLI/daemon/harness and stream-layer change; no browser-reaching surface) + mitigation: committed canonical transcript, branch dump replay digest, exact worktree comparison, applied-offset journal uniqueness/gap check, deterministic seed/repro checks, and expected-red mutation evidence.

### 2026-08-17 — independent critic — VERDICT: verified

- Commit: `808f9c9f` (`test: assert interrupted teardown residue is cleared`).
- Commands: `pnpm exec prettier --check tools/verify/e4-sync/run.mjs tools/verify/e4-sync/verify.mjs`; `node tools/verify/e4-sync/verify.mjs`; targeted interrupted run with `--teardown-report`.
- Evidence: the focused verifier passed the lockstep golden, free convergence, repeat/seed checks, structural/content red paths, bisect checks, and `TEARDOWN interrupted-run EXPECTED-FAIL OK`; the teardown report asserted `scratchRemoved: true` and `survivingPids: []`. A fresh critic inspected exact commit `808f9c9f` and found no remaining blocker.
- Replay: N/A (CLI/daemon/harness and stream-layer change; no browser-reaching surface) + mitigation: committed branch dump, replay digest, canonical transcripts, applied-offset journals, expected-red mutation output, and post-SIGINT teardown report.
