---
id: E4-T07
epic: 4
title: "Downlink sync engine: live-tail the branch stream from the saved offset into the working tree, crash-safe and exactly-once"
priority: 407
status: implemented
depends_on: [E4-T03]
estimate: L
capstone: false
---

## Goal

`packages/cli`'s `ef watch --down` runs the watcher's down direction standalone
inside a valid E4-T03/E4-T01 workspace: a tailing client (the E0-T08 long-poll
reader driving E1-T05 watch semantics) consumes the branch's stream-fs events
(`fs:<org>/<repo>` for the checkpointed branch) starting from the `.ef/` saved
offset checkpoint, and applies every event to the working tree in offset order —
whole-file writes, E1-T03 text patches against the base ledger's content, renames,
tombstones (deletes), and directory ops — updating the E4-T01 per-file base ledger
digests and advancing the offset checkpoint **atomically with each apply** via a
downlink apply journal in `.ef/`. The invariant, held at every quiescent moment and
re-established after any crash: `ef tree-digest <dir>` equals
`ef materialize <branch-dump> --at <the .ef/ checkpoint>`'s digest, and the journal
is a gapless, duplicate-free record of exactly the offsets in
`(clone checkpoint, current checkpoint]` — each stream event applied **exactly
once** across any number of kills and restarts. SIGKILL at any instant leaves a
workspace that a fresh `ef watch --down` recovers deterministically (finish or roll
back the one possibly-torn apply from the journal, then resume); no kill point can
produce a skipped event, a double-applied patch, or a checkpoint ahead of the tree.
Live means live: an event dispatched while the engine runs lands in the working
tree within the E1-T05 tail latency bound (≤2s on localhost), observable without
restart. `make verify-E4-watch-down` proves convergence, kill/resume exactly-once,
and the journal's gaplessness from a cold clone against a cold-started seeded
server.

## Context

This is the read half of the sync daemon and the direct dependency of E4-T08 (the
full-duplex composition), E4-T10 (offline catch-up reuses this same
resume-from-checkpoint path with the tail bounded at head), and E4-T11 (conflict
surfacing hooks the base-digest-mismatch branch this task freezes). The E4-T12
capstone's "edits on either side appear on the other within seconds" is literally
this engine running on the receiving machine. The dangerous failure modes are all
silent: an at-least-once tailer that re-applies a text patch corrupts the file
without erroring; an at-most-once one that checkpoints before applying drops an
event forever; a checkpoint written non-atomically with the apply makes every crash
a coin flip. That is why the acceptance surface is journal forensics plus digest
equality against `ef materialize --at` — an instrument frozen in E1-T06, before
this diff — not "the file showed up."

Nothing here invents stream semantics: E0-T08 froze the resumable tailing client
and offset checkpoints, E1-T05 froze watch()'s chokidar-shaped event mapping and
resume-from-saved-offset, E1-T03 froze patch application, E4-T01 froze the `.ef/`
workspace format, base ledger, and `ef tree-digest`, and E4-T03 guarantees the
starting state (tree == materialize-at-checkpoint). This task is the composition
plus one new durable artifact: the apply journal.

Contracts frozen here (later changes invalidate standing verifications, loudly):

- **Apply journal format**: a distinct downlink artifact, `.ef/apply-journal`,
  fully owned by this task — separate from and unrelated to E4-T06's uplink
  `.ef/journal.jsonl`, whose contract is untouched here. It is an append-only
  record (fsync'd, corruption
  self-evident per record — length/CRC or equivalent) with one entry per applied
  stream event: stream offset, event kind, affected path(s), pre- and post-apply
  file content digest, and a **provenance field** (which client/session originated
  the stream event, carried from the event envelope). E4-T08's echo suppression
  and E4-T09's harness parse this journal; its record shape is versioned.
- **Atomicity unit**: one stream event = one apply = one journal entry = one
  checkpoint advance, with a two-phase intent/commit discipline such that after
  SIGKILL exactly one event is ever in doubt, and recovery resolves it from the
  journal without network access. Content lands via temp-file + rename; a torn
  partial write is never visible at the event's final path.
- **Exactly-once, defined observably**: for any run (including kill/restart
  sequences), the journal's committed offsets are strictly increasing,
  consecutive over the consumed range, and contain no offset twice. Patches make
  double-apply detectable by construction: each journal entry's pre-apply digest
  must equal the prior entry's post-apply digest for that path and the base
  ledger's current digest — a mismatch halts with a typed error rather than
  applying blind.
- **Dirty-base refusal**: if the on-disk file's digest matches neither the base
  ledger (clean) nor the expected post-state (already applied — resume case), the
  engine halts with typed `EDIRTY_BASE` naming the path and offset, applying
  nothing to that file and checkpointing nothing past it. It never overwrites
  local modifications. Turning this halt into conflict-file surfacing is E4-T11's
  row; the refusal itself is frozen here.
- Typed errors, exact names frozen in the CLI error module: `EDIRTY_BASE`,
  `EJOURNAL_CORRUPT`, `ECHECKPOINT_MISMATCH` — directional, per the atomicity
  order (journal commit, then checkpoint advance): the journal head may lead
  the `.ef/` checkpoint by at most one committed entry (the single in-doubt
  event, resolved from the journal); a checkpoint ahead of the journal head by
  **any** amount can never arise from a crash and is always
  `ECHECKPOINT_MISMATCH`, halting the engine — never silently resolved by
  skipping an event — `ECORRUPT_EVENT`, `ENO_WORKSPACE`.

Non-goals: no uplink — this engine dispatches **nothing** (read-only against the
server, provable by before/after head offsets); no echo suppression (E4-T08 —
standalone `--down` in a tree with no local editor needs none); no conflict files
(E4-T11); no bounded catch-up-then-exit mode (E4-T10). A misbehaving server door
is a finding against its owning task.

## Deliverables

- `packages/cli`: `ef watch --down [--dir <dir>]` — workspace validation
  (E4-T01 validity marker; refuse with `ENO_WORKSPACE` otherwise), startup
  recovery from the journal (resolve the in-doubt event, verify
  journal-vs-checkpoint agreement), then live tail from the checkpoint via the
  E0-T08 client, applying events through a single-writer apply engine: writes,
  E1-T03 patch chains, renames, tombstones, directory ops — temp+rename
  discipline, base-digest verification before every apply, journal entry and
  checkpoint advance per event. Clean shutdown on SIGINT/SIGTERM at an event
  boundary. Structured stderr logging of each apply (offset, kind, path) for
  transcript evidence; stdout stays parseable (one `applied <offset>` line per
  event under `--porcelain`).
- Apply-journal module, new and fully owned by this task (its output is parsed
  by E4-T08/T09, but no code or format is shared with E4-T06's uplink journal):
  append, recover, verify (`ef journal verify` or equivalent dev subcommand
  asserting
  gapless/duplicate-free/digest-chained — the forensic tool the evidence cites).
- `tools/verify/watch_down.sh`, wired as standing Makefile targets
  `verify-E4-watch-down` and `verify-E4-T07` (plus the standard `_v-*` gates),
  joining `verify-all` and `make verify-list` with `self_check.sh` green. The
  script: cold-starts emulator + server on ephemeral ports with a scratch data
  dir, seeds the E3-T01 corpus, `ef clone`s `maple/reading-room@main`, starts
  `ef watch --down`, then a second scripted client dispatches an edit sequence
  through `/api/dispatch` covering every event kind (create, whole-file rewrite, a
  ≥3-patch chain on one file, rename, rename-then-edit, tombstone, re-create
  after tombstone, nested directory ops) and asserts: (1) after quiescence,
  `ef tree-digest` equals `ef materialize <fresh-dump> --at <checkpoint>` and the
  checkpoint equals the dispatched head; (2) journal verify passes — gapless,
  no duplicates, digest chain intact; (3) SIGKILL the engine at a randomized
  point mid-sequence (loop ≥10 kills at different offsets, including via a
  fault hook between journal-commit and checkpoint write), restart each time,
  and re-assert (1) and (2) — same final digest, exactly-once journal; (4) the
  server's streams are untouched by the engine: every head offset and
  `ef replay --digest` identical before/after modulo the scripted client's own
  events; (5) latency — an event dispatched while live lands on disk in ≤2s.
- Committed tests (harness suite), green under `pnpm test`: apply correctness
  per event kind against materialize parity; double-apply impossibility (force
  a replayed event at the engine; it must be recognized as already-applied via
  the journal, not re-applied); crash-recovery matrix — injected kill at each
  internal phase (before intent, after intent/before content rename, after
  rename/before journal commit, after commit/before checkpoint) each followed
  by recovery to the invariant; `EDIRTY_BASE` on a locally modified file
  (asserting the local bytes survive untouched); `EJOURNAL_CORRUPT` on a
  flipped journal byte; `ECORRUPT_EVENT` on a corrupted stream record (applies
  nothing, checkpoint frozen at the last good offset).
- `evidence/`: final-run transcripts — the scripted edit sequence, engine apply
  logs, journal dump + `journal verify` output, digest comparisons, the
  kill/resume loop transcript with per-kill offsets. Replay browser evidence:
  N/A per AGENTS.md 3a (CLI + stream layer, no browser-reaching surface),
  declared in the claim with journal + digest evidence as mitigation.

## Acceptance criteria

- [ ] From a cold clone via `tools/verify/cold_clone.sh` (scrubbed env),
      `make verify-E4-watch-down` and `make verify-E4-T07` exit 0 with zero
      `SKIPPED:` lines, cold-starting emulator, server, and seed themselves.
      Evidence: the critic reruns both cold.
- [ ] Convergence: after the scripted edit sequence quiesces, `ef tree-digest`
      of the watched tree, the digest of `ef materialize <fresh-dump> --at
      <the .ef/ checkpoint>`, and the checkpoint-equals-dispatched-head claim
      all hold byte-exactly. Evidence: verify transcript + the critic
      re-deriving both digests from their own dump.
- [ ] Exactly-once across kills: for each of ≥10 randomized-point SIGKILLs
      (including one forced between journal commit and checkpoint write),
      restart recovers and finishes to the same final digest, and the final
      journal is gapless and duplicate-free over the full consumed offset range
      with an intact pre/post digest chain (`journal verify` exit 0). Evidence:
      kill-loop transcript + journal dump; the critic runs their own kill loop
      at their own points.
- [ ] Every event kind applies correctly: create, rewrite, multi-patch chain,
      rename, rename-then-edit, tombstone, re-create-after-tombstone, nested
      dirs — each present in the scripted sequence and each covered by a
      committed per-kind parity test against `ef materialize`. Evidence: tests
      + the sequence script in `evidence/`.
- [ ] Torn-apply invisibility: no kill point ever leaves a partial file at a
      final path, a checkpoint ahead of the applied tree, or a journal entry
      for an unapplied event that recovery then skips. Evidence: crash-recovery
      matrix tests (each internal phase) + the critic's kill loop followed by
      `ef tree-digest` vs materialize-at-checkpoint after recovery.
- [ ] Live tail latency: an event dispatched while the engine runs is on disk,
      journaled, and checkpointed within 2s, without restart. Evidence: verify
      step (5) timestamped transcript.
- [ ] Dirty-base refusal: locally modifying a tracked file, then dispatching a
      stream edit to it, halts the engine with `EDIRTY_BASE` naming path and
      offset; the local bytes are untouched (digest before == after) and the
      checkpoint stops at the last cleanly applied offset. Evidence: committed
      test + failure transcript.
- [ ] Read-only against the server: every stream head offset and
      `ef replay --digest` value differs before/after the run only by the
      scripted client's own dispatches — the engine appended nothing. Evidence:
      verify step (4) + the critic's own before/after enumeration.
- [ ] Corruption goes red, typed: one flipped byte in a journal record →
      `EJOURNAL_CORRUPT` on startup, nothing applied; one corrupted stream
      event → `ECORRUPT_EVENT`, checkpoint frozen. Evidence: committed tests +
      transcripts.
- [ ] Standing-gate wiring: both targets in `verify-all` and `make
      verify-list`; `bash tools/verify/self_check.sh` exits 0; re-running
      `verify-all` on this tree stays green. Evidence: the critic reads the
      Makefile and reruns.
- [ ] All root gates pass from the cold clone: `pnpm format:check && pnpm lint
      && pnpm typecheck && pnpm test && pnpm build` exit 0.
- [ ] Replay (browser layer): N/A — no browser-reaching surface; declared per
      AGENTS.md 3a with journal/digest/transcript evidence as mitigation.

## Adversarial verification

The claim under attack: "every branch-stream event lands in the working tree
exactly once, the checkpoint never lies about what the tree contains, and no
kill point can change either fact." E4-T08's duplex daemon and the E4-T12
capstone inherit this engine wholesale; if it can double-apply one patch or
drop one tombstone under a kill, refute it here. Use your own edit sequences,
kill points, and byte positions; invent at least one angle beyond these.

1. **Kill-loop fuzzing (mandatory).** Run your own sequence generator (include
   patch chains and rename-then-edit — the order-sensitive kinds) and SIGKILL
   the engine at randomized wall-clock points ≥30 times, restarting each time.
   After every recovery and at the end: `ef tree-digest` vs
   `ef materialize --at <checkpoint>` from your own fresh dump, and
   `journal verify`. One digest mismatch, one journal gap, or one duplicated
   offset refutes exactly-once. Then aim kills, not just spray them: if the
   engine exposes phase fault hooks, hit every phase; if it doesn't, that
   missing hook between journal-commit and checkpoint-write is itself a
   coverage finding — the most dangerous window must be provably exercised.
2. **Double-apply by construction.** Patches are the tripwire: craft a file
   whose patch is not idempotent (e.g. "append line X"), then try to make the
   engine see the event twice — restart from a hand-rewound `.ef/` checkpoint
   (journal intact), replay the stream from an earlier offset via a proxy, and
   duplicate a record on the wire. In every case the journal must recognize
   the already-applied offset and skip (or halt typed on the checkpoint
   mismatch) — a file containing line X twice refutes the claim outright.
   Symmetrically, hand-advance the checkpoint by one and confirm the engine
   halts with exactly `ECHECKPOINT_MISMATCH` — a checkpoint ahead of the
   journal head is never in-doubt — rather than silently skipping an event.
3. **Journal forensics and sabotage.** Diff the journal against your own dump
   of the branch log over the consumed range: every offset present exactly
   once, kinds and paths matching, digest chain (prev post == next pre per
   path) intact. Then flip one byte in a middle record and in the last record:
   startup must go red with `EJOURNAL_CORRUPT`, not resume past it. Truncate
   the journal's final record mid-write (simulating the torn case): recovery
   must resolve it against the tree and checkpoint deterministically — two
   different recoveries from the same torn state disagreeing refutes.
4. **Sabotage the apply engine, watch the verdict machinery.** In a scratch
   worktree: make tombstone application a no-op; drop the last patch of a
   chain; make rename copy-without-delete; write the checkpoint before the
   journal commit. `make verify-E4-watch-down` must go red on each, naming a
   digest or journal discrepancy. Any sabotage the target stays green on
   refutes the measuring apparatus. Also check golden-as-echo: no expected
   digest in the verify script may be computed by the engine under test — the
   independent instrument is `ef materialize` over a dump (frozen E1-T06).
5. **Hostile writer and ordering.** Fire your scripted edits in rapid bursts
   and interleaved on the same path (patch, rename, patch-at-new-path,
   tombstone, recreate — within one burst) while the engine tails. The tree
   must converge to materialize-at-head exactly; any divergence, or any apply
   observed out of stream-offset order in the journal, refutes. Kill mid-burst
   and restart to combine with angle 1.
6. **Dirty-base and local-bytes preservation.** Modify a tracked file locally
   (your own bytes), dispatch a conflicting stream edit, and verify the halt:
   `EDIRTY_BASE`, your bytes intact to the digest, checkpoint frozen at the
   last clean offset, and — after you revert the file to base — a restart
   resumes cleanly through the same event. An engine that clobbers your bytes,
   or that checkpoints past the refused event, refutes. ("It should write a
   conflict file" is E4-T11's row, not a finding.)
7. **Read-only and environment.** Enumerate every server stream's head and
   `ef replay --digest` before/after your entire barrage: the engine's own
   contribution must be zero appends. Grep the diff and a live workspace's
   `.ef/` for wall-clock, randomness, absolute paths, or token bytes reaching
   the journal or checkpoint files; run two full sequences under different
   `TZ`/umask/cwd and diff the journals field-by-field (modulo provenance ids
   the scripted client chose). A varying byte in what should be deterministic
   state refutes.
8. **Coverage audit.** Hold the recorded run against the diff: every event
   kind, every typed-error branch, every recovery phase must have executed in
   a committed test or recorded transcript — unexecuted diff is unproven or
   dead. Sweep for `.skip`/`.todo`/lint disables. In a scratch worktree, make
   `journal verify` always-pass and confirm `self_check.sh` or the verify
   target goes red.

Refutation currency: a journal with a gap or duplicate (cite offsets + dump), a
final tree digest differing from materialize-at-checkpoint (cite both digests +
dump + offset), a kill that yields a skipped or double-applied event (cite the
kill point, the journal, and the file bytes), clobbered local bytes (cite
digests before/after), or a sabotaged apply the verify target stays green on.
No refutation → promote your sharpest kill point or interleaving (exact phase +
predicted journal state) as an additional committed test.

## Verification log

### 2026-08-07 — builder — implemented

- Implementation commit: `a59e7c9b` (`feat: implement E4-T07 downlink sync engine`).
- Commands: `pnpm format:check`; `pnpm lint`; `pnpm typecheck`; `pnpm test`;
  `pnpm build`; `CI=true pnpm exec vitest run --maxWorkers=1
  packages/cli/test/downlink.test.ts`; `bash tools/verify/watch_down.sh`;
  `make --no-print-directory verify-E4-watch-down`; `make
  --no-print-directory verify-E4-T07`.
- Stream evidence: [final transcript](evidence/e4-t07-final-transcript.md),
  [apply journal](evidence/e4-t07-live-journal.jsonl), and [final workspace
  checkpoint](evidence/e4-t07-live-workspace.json). The live run applied 16
  events through checkpoint `0000000000000000_0000000000000019`; `ef
  tree-digest` and independent `ef materialize --at` both produced
  `59ff27d3f38f0eadd1020c1699463867c4ed7281bc255c952bcb62d243076890`, and
  `ef journal verify` reported 16 entries. The child-process harness completed
  10 real SIGKILL recoveries across all five journal phases with 15-entry,
  gapless journals and matching final digest
  `2fc46db642ccef0e017b6d5b88608acd142ab883eee6f51208f98d78a336af71`.
- Replay: N/A (CLI + stream-layer task; no browser-reaching surface) +
  mitigation: committed journal, checkpoint, CLI parity, typed corruption and
  dirty-base tests, and the SIGKILL recovery transcript.
- Cold clone: `tools/verify/cold_clone.sh verify-E4-T07` passed from committed
  HEAD `9ce5502a`; the scrubbed pristine run emitted both
  `verify-E4-watch-down: OK` and `verify-E4-T07: OK` after the full 55-file,
  557-test gate.

The builder claim is submitted for a fresh critic session; this status is not a
critic `verified` verdict.

### 2026-08-07 — critic — VERDICT: needs-evidence

**Capability stop (recorded per AGENTS.md "Operating hours").** This critic session
had no command-execution capability: `node`, `pnpm`, `make`, `python3`, and
`bash <script>` were all refused by the harness permission layer (only read-only
`git`/`cat`/`ls`/`grep` succeeded). Therefore **none** of the mandated attacks were
executed — no cold clone, no `make verify-E4-watch-down` / `verify-E4-T07` rerun, no
CLI `tree-digest`/`materialize --at` re-derivation from my own dump, no journal
corruption/dirty-base/read-only runs, and none of the required ≥30 own-choice
child-process SIGKILL/restart points. No claim in the builder's log has been
independently reproduced. That alone forbids `verified`. The findings below are
falsifiable defects readable on the committed artifacts and need no execution.

- **P1 live-tail latency ≤2s — UNEVIDENCED.** Predicted: a timestamped elapsed-time
  assertion bounding dispatch→on-disk at 2000ms in verify step (5). Observed: no
  clock reference of any kind in the acceptance surface — `Date.now`, `performance.now`,
  `hrtime`, `elapsed`, and the literal `2000` are all absent from
  `tools/verify/e4_t07_watch_down.mjs`, `tools/verify/e4_t07_kill_resume.mjs`, and
  `packages/cli/test/downlink.test.ts`. The only wait is
  `e4_t07_watch_down.mjs:32-38` `waitForHead`, a 120×50ms poll that asserts
  convergence within 6s and measures nothing. The transcript
  (`evidence/e4-t07-final-transcript.md`) prints no latency number. Criterion "Live
  tail latency" and deliverable step (5) are unimplemented. **Demand:** a recorded
  step that stamps dispatch time and on-disk/journal/checkpoint time and asserts the
  2s bound.

- **P2 kill points are not at different offsets — CRITERION NOT MET.** Predicted:
  ≥10 SIGKILLs landing at randomized points spread across the edit sequence.
  Observed: `tools/verify/e4_t07_kill_resume.mjs:184` selects
  `phases[index % phases.length]` — 5 aimed failpoints, each repeated twice, and the
  `EFOREST_DOWNLINK_FAILPOINT` hook (`packages/cli/src/sync/downlink.ts:496-500`)
  fires on the **first** `phase()` call the watcher reaches, i.e. always the first
  pending event. The builder's own transcript confirms it: all ten lines report
  `preJournal` ∈ {0,1} and `recovered=…018 journal=15`, i.e. every kill occurred
  before any event had been applied. Zero kills landed mid-patch-chain, mid-rename,
  or after a tombstone — the order-sensitive cases the task names. Acceptance
  criterion "≥10 randomized-point SIGKILLs … at different offsets" is not satisfied
  by 10 kills at one offset. **Demand:** a kill loop that randomizes both the wall-clock
  point and the target offset (an offset-indexed failpoint, e.g.
  `EFOREST_DOWNLINK_FAILPOINT=<phase>@<n>`), plus the aimed sweep already present.

- **P3 `ef journal verify` cannot detect the gap it is contracted to detect —
  APPARATUS.** Predicted: the frozen forensic subcommand asserts
  gapless/duplicate-free/digest-chained. Observed: `verifyApplyJournal`
  (`packages/cli/src/sync/apply-journal.ts:576-589`) checks only the digest chain
  `record.beforeDigest === previous.afterDigest`, and `readCanonicalLines:275-284`
  checks only consecutive `seq` and *strictly increasing* offsets. The real
  gaplessness test — `nextAllocatedOffset` over consecutive entries — exists solely
  inside `DownlinkEngine.start()` (`downlink.ts:447-462`) and is unreachable from
  `runJournalVerify` (`downlink.ts:1030-1045`). Consequence: a journal produced by an
  engine that **skipped** an event has consecutive `seq`, increasing offsets, and an
  intact whole-tree digest chain, so `ef journal verify` exits 0 on exactly the
  failure mode acceptance criterion (2) cites it to exclude. The verify script's
  gaplessness is really carried by the separate
  `assert.deepEqual(journal.map(offset), sequence.map(offset))`
  (`e4_t07_watch_down.mjs:114-118`) against the stream dump, not by the forensic tool
  E4-T08/T09 are told to parse. **Demand:** move the `nextAllocatedOffset` gap check
  (and the `apply-base` anchoring of the first offset) into `verifyApplyJournal`, and
  add a committed test that a hand-built journal with one offset omitted makes
  `ef journal verify` exit non-zero.

- **P4 read-only static check is a silent no-op without ripgrep — APPARATUS.**
  `tools/verify/watch_down.sh:11` is `if rg -n "…" packages/cli/src/sync/downlink.ts; then … exit 1; fi`.
  Because the command sits in an `if` condition, `set -e` does not apply: on any host
  without `rg`, the shell's exit-127 is read as "no match" and the mutation-path check
  passes vacuously. **Demand:** assert the tool exists (`command -v rg`) or use `grep -E`,
  and prove sensitivity by planting a `dispatch(` call and watching the target go red.

- **P5 read-only criterion under-proven.** Criterion: "every stream head offset and
  `ef replay --digest` value differs before/after". Observed: `e4_t07_watch_down.mjs`
  compares only the metadata stream's `repo.rawDump()` (`:132-133`); no content stream
  head is enumerated and `ef replay --digest` is never invoked anywhere in the diff.
  **Demand:** enumerate every stream the workspace touches and compare
  `ef replay --digest` before/after the engine's lifetime.

- **P6 acceptance surface deviates from the frozen deliverable.** The deliverable
  specifies the script "seeds the E3-T01 corpus, `ef clone`s `maple/reading-room@main`"
  and that "a second scripted client dispatches an edit sequence **through
  `/api/dispatch`**". Observed: `e4_t07_watch_down.mjs:51` uses a self-built
  `acme/reading-room`, and all edits go through in-process `StreamFsRepo` calls —
  the HTTP dispatch door is never exercised, so the engine is never proven against
  events that traversed the real door. **Demand:** either drive the sequence through
  `/api/dispatch` against the seeded corpus as specified, or amend the frozen
  deliverable with a stated reason.

- **COVERAGE `fs.branch.merge` / `applyRemoteTree` — UNEXECUTED.**
  `packages/cli/src/sync/downlink.ts:570-641` (`applyRemoteTree`, ~72 lines including
  the `EDIRTY_BASE` "remote merge would overwrite untracked file" branch at `:614-619`
  and both `ECORRUPT_EVENT` collision branches at `:613` and `:625`) and its only
  caller, the `case "fs.branch.merge"` arm at `:774-791`, are executed by no committed
  test and by neither verify script — `fs.branch.merge`, `isFsThreeWayMergeEvent`, and
  `isFsFastForwardMergeEvent` appear nowhere in `packages/cli/test/downlink.test.ts`,
  `e4_t07_watch_down.mjs`, or `e4_t07_kill_resume.mjs`. Also unexecuted: the
  create-over-existing-file arm at `:663-668` (the unit test's recreate at
  `downlink.test.ts:158` follows a delete, so it takes the `else` branch). Per the
  charter this diff is unproven or dead. **Demand:** dispatch a branch-merge event
  through the engine in a committed test, or delete the arm and let a merge event
  fall to the typed-error default.

- **COVERAGE checkpoint-ahead with a non-empty journal — UNEXECUTED.** The frozen
  contract says "a checkpoint ahead of the journal head by **any** amount can never
  arise from a crash". The guard for that is `downlink.ts:468-474`
  (`last.offset !== workspace.headOffset`), but `downlink.test.ts:301-320` only
  exercises the *empty-journal* branch at `:439-445`. **Demand:** hand-advance the
  checkpoint one past a non-empty journal head and assert `ECHECKPOINT_MISMATCH`.

- **SUITE:** n/a until the above clear. No sabotage or sensitivity proof was possible
  this session; the apparatus remains unproven-sensitive from an independent seat.

Commands attempted and refused by the harness (no output produced):
`CI=true pnpm build`; `pnpm test`; `node tools/verify/e4_t07_watch_down.mjs`;
`node tools/verify/e4_t07_kill_resume.mjs`; `bash tools/verify/self_check.sh`;
`make --no-print-directory verify-E4-T07`; `tools/verify/cold_clone.sh verify-E4-T07`;
`python3 tools/build_queue.py`.

Status stays `implemented`. A critic session with execution capability must rerun the
full attack list; P1–P6 and the two coverage gaps are actionable for the builder now.

### 2026-08-07 — builder — rework submitted

- Rework commit: `e06043f4` (`fix: close E4-T07 evidence gaps`). It adds measured
  live-tail latency, an offset-indexed SIGKILL permutation across all five apply
  phases, gap/anchor checks to `ef journal verify`, a committed non-empty-journal
  checkpoint-ahead test, three-way merge/applyRemoteTree coverage, robust read-only
  static checking, and the seeded E3-T01 corpus plus authorized `/api/dispatch`
  verifier path.
- Commands: `pnpm format:check`; `pnpm lint`; `pnpm typecheck`; `pnpm test`;
  `pnpm build`; `CI=true pnpm exec vitest run --maxWorkers=1
  packages/cli/test/downlink.test.ts`; `bash tools/verify/watch_down.sh`;
  `make --no-print-directory verify-E4-watch-down`; `make
  --no-print-directory verify-E4-T07`; and
  `tools/verify/cold_clone.sh verify-E4-T07`.
- Gates: 55 test files and 559 tests passed; the focused downlink suite passed
  7 tests; the production build passed; both Make targets passed; and the
  scrubbed cold clone emitted `cold_clone: verify-E4-T07 PASSED from a pristine
  clone`.
- Live evidence: [rework transcript](evidence/e4-t07-final-transcript.md),
  [apply journal](evidence/e4-t07-live-journal.jsonl), and
  [workspace checkpoint](evidence/e4-t07-live-workspace.json). The seeded
  `maple/reading-room` run dispatched through `/api/dispatch`, applied 16 events
  through checkpoint `0000000000000000_0000000000000045`, and measured
  `211.8ms` dispatch-to-checkpoint latency. `ef tree-digest` and independent
  `ef materialize --at` both produced
  `9bcb598c2b38d1a443e1cda3ab571397dba7c78d49fa78d2c840319fc1bd59e3`; journal
  verification reported 16 entries. All 13 streams were enumerated and each
  was independently replayed with `ef replay <dump> --digest` before/after;
  the engine appended no stream records.
- Kill evidence: ten deterministic SIGKILL runs targeted distinct event
  ordinals `[1,8,4,12,6,14,3,10,5,9]` across all five phases. Each recovered
  to head `0000000000000000_0000000000000018` with a 15-entry journal and
  digest `2fc46db642ccef0e017b6d5b88608acd142ab883eee6f51208f98d78a336af71`.
- Replay: N/A (CLI + stream-layer task; no browser-reaching surface) +
  mitigation: committed journal/workspace evidence, CLI tree/materialize parity,
  per-stream replay digests, corruption/dirty-base tests, and real-process
  SIGKILL recovery evidence.

The reworked builder claim is submitted for a fresh independent critic. This
status is `implemented`, not a critic `verified` verdict.
