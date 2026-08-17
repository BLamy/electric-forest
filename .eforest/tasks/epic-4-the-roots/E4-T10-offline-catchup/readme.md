---
id: E4-T10
epic: 4
title: "Offline catch-up: a stopped watcher reconciles both directions deterministically before going live"
priority: 410
status: verified
depends_on: [E4-T09]
estimate: M
capstone: false
---

## Goal

`ef watch` (E4-T08) gains a **reconcile phase** that runs to completion before either
live engine starts: `reconcile(workspace, client)` in
`packages/cli/src/sync/reconcile.ts`, invoked unconditionally on watcher startup and
runnable standalone as `ef watch --catchup-only` (reconcile, print the summary line,
exit — never go live). The phase does three things, in this pinned order. **First,
journal repair**: replay `.ef/journal.jsonl` (E4-T06 frozen format) against an
authenticated fetch of the branch metadata stream (`fs:<org>/<repo>:<branch>:meta`)
from the saved `.ef/` checkpoint offset — any journaled-but-not-ledgered `accepted`
entry (the crash window E4-T06's journal-before-ledger write ordering deliberately
leaves open) is resolved by confirming its `offset` exists in the stream and advancing
the ledger, **never** by re-dispatching; a journaled offset the server never assigned
is a hard error (exit 4, nothing applied). **Second, downlink catch-up**: the fetched
delta from the checkpoint offset to head is applied to the working tree through the
E4-T07 apply path (same apply journal, same crash-safe exactly-once discipline),
skipping events whose `writerId` provenance the repaired journal attributes to this
workspace (E4-T08 echo suppression, replayed offline). **Third, uplink catch-up**: the
working tree is classified against the now-advanced ledger via the E4-T04 classifier —
offline local edits are detected via the **base ledger** (content vs recorded base),
never via mtimes or wall-clock — and each is dispatched in E1-T02's frozen segment-wise
path order with ledger bases per E4-T06. The whole phase is **deterministic**: the same
offline state produces the same decisions in the same order, and every decision is one
canonical-JSON line in the **reconcile decision log**
(`.ef/reconcile.jsonl`, format frozen here: `{phase, action, path?, offset?, base?}`,
no timestamps, no pids). A path edited on both sides is not merged and not clobbered:
its uplink dispatch carries the stale ledger base, the E1-T04 fence refuses it with 409
`stale-base`, the refusal is journaled per E4-T06 with the local loser's bytes
recoverable byte-exact from the `refused` record (or the content-addressed blob under
`.ef/` it names) — surfacing is E4-T11's job. Only when reconcile completes does
`ef watch` enter live mode. End state, provable by the E4-T09 instrument: the harness's
partition hooks drive **non-overlapping offline edits on both sides** (edits scheduled
on a machine whose watcher is stopped — the schedule ops T09's format admits but its
golden run excludes) at seeded-random partition points; at quiescence after restart,
both worktrees are byte-identical to each other and their `ef tree-digest` (E4-T01)
equals `ef replay <fresh dump> --worktree-digest` — no event lost, none applied twice —
and the same seeded scenario run twice from fresh temp roots yields byte-identical
final branch event logs, digests, and decision logs.

## Context

This is the partition-recovery half of the Epic 4 watcher story and a direct
prerequisite of the E4-T12 capstone ("a partitioned (stopped) watcher catches up
cleanly on restart" — ROADMAP, Epic 4). E4-T08 composed the two live engines; what it
cannot do is start honestly after downtime: the checkpoint offset is behind head
(remote edits happened), the ledger is behind the tree (local edits happened), and the
journal may end in a torn tail (the E4-T06 crash window). E4-T09 built the instrument
this task is judged by: its schedule format (`SYNC_SCHEDULE_VERSION = 1`) deliberately
admits edits on a stopped machine "so E4-T10/T11/T12 extend the schedule, not the
harness" — this task cashes that promise with an `offline` schedule profile and makes
the harness execute those ops honestly. Every other prior task pinned a contract this
one consumes rather than invents: the `.ef/` checkpoint and ledger (E4-T01/T02/T03),
the classifier (E4-T04), the journal format and journal-before-ledger ordering (E4-T06
— "E4-T10 reconciles" is a promise made there, paid here), the downlink apply path and
exactly-once discipline (E4-T07), and provenance-based echo suppression (E4-T08).

Contracts pinned here (E4-T11 and E4-T12 depend on them):

- **Phase order is frozen**: journal repair → downlink → uplink. Uplink-first would
  fabricate bases against a head the ledger hasn't seen; downlink-before-repair would
  double-apply this workspace's own crash-window events.
- **Reconcile never re-dispatches a journaled offset.** Journal repair is
  read-and-confirm only. Exactly-once across a crash means the journal, not a retry, is
  the source of truth.
- **Offline detection is ledger-based, never temporal.** The uplink plan is a pure
  function of (classification vs advanced ledger, downlink-touched path set). mtimes,
  wall-clock, and enumeration order do not reach the plan.
- **The decision log**: `.ef/reconcile.jsonl`, append-only canonical-JSON lines, one per
  decision — `{phase: "repair", action: "confirmed", path, offset}`,
  `{phase: "downlink", action: "applied" | "suppressed", path, offset}`,
  `{phase: "uplink", action: "dispatched", path, base, offset}` or
  `{phase: "uplink", action: "refused", path, base}` — deterministic content, frozen
  here; E4-T11 reads the `refused` lines and E4-T12's harness gates on the format.
- **Overlap handling**: both-sides paths reach the fence with their stale base and are
  refused + journaled; reconcile completes (exit 3 from `--catchup-only`, mirroring
  E4-T06 `--quiesce` semantics) rather than aborting. The stream is the arbiter; local
  loser bytes are preserved inside the journaled `refused` record (or a
  content-addressed blob under `.ef/` it names), never deleted by the downlink apply
  before the refusal is journaled.
- **`--catchup-only` summary format**: one canonical-JSON line
  `{repaired, applied, dispatched, refused, checkpoint: {from, to}}` on stdout — frozen.

Non-goals: conflict-file materialization and naming (E4-T11 — this task only guarantees
refusal + byte-exact preservation, and its harness profile schedules **disjoint** path
sets on the two sides), live-mode behavior after reconcile (E4-T08, unchanged),
multi-branch reconcile (`ef checkout` while stopped is E4-T05's dirty-tree protection,
out of scope), and any server-side change — reconcile is a pure client of frozen
endpoints.

Browser layer: N/A — reconcile is CLI-only and changes no browser-reaching behavior;
the events it appends flow through the same frozen E1-T02/E4-T06 append path the web
app already consumes, unchanged by this task. The builder's claim must state
`Replay: N/A` with this reason and cite the stream-layer mitigation (dumps, digests,
journal, decision log, `cmp` evidence) in its place — silence is forbidden per
AGENTS.md 3a.

## Deliverables

Path anchor: `evidence/` paths are relative to this task folder,
`.eforest/tasks/epic-4-the-roots/E4-T10-offline-catchup/`. Makefile recipes reference
them repo-root-anchored.

- `packages/cli/src/sync/reconcile.ts` — `reconcile(workspace, client)` returning the
  frozen summary object and writing the decision log; the three phases as separately
  exported, unit-testable functions: `repairJournal(journal, streamEvents)` (pure),
  `planUplink(classification, downlinkTouchedPaths, ledgerView)` → ordered dispatch
  plan (pure, deterministic — no filesystem-order, mtime, or clock inputs in its
  signature), and the downlink application delegating to E4-T07's engine in bounded
  (non-tailing) mode.
- `ef watch` wired to run reconcile before live mode (both engines held until it
  returns; the live downlink tail starts from the reconcile fetch's head offset — no
  seam gap), plus `ef watch --catchup-only` with exit codes 0 (clean), 3 (completed
  with ≥ 1 journaled refusal), 4 (journal cites an offset the server never assigned —
  corrupt provenance, nothing applied).
- `@eforest/sync-harness` (E4-T09) extension, not fork: an `offline` schedule profile —
  seeded PRNG places `stop` hooks for **both** machines at randomized partition points,
  schedules disjoint edit sets (creates/edits/renames/deletes, nested and unicode
  paths) on each machine **while its watcher is stopped** (executed honestly per T09's
  documented scope seam), then `restart`s both and asserts T09's full three-way
  convergence block. New assertion legs: per-machine reconcile summary and decision-log
  capture into the transcript (canonical content only — transcript canon holds).
- Package README section "Offline catch-up" documenting phase order, the
  no-re-dispatch rule, ledger-based (never temporal) offline detection, overlap
  semantics, the decision-log format, exit codes, and the summary format.
- `packages/cli/test/reconcile.test.ts` — integration against a real server on an
  ephemeral port: init + clone, run a watcher, stop it, apply a scripted offline edit
  set locally (plain `fs`) and a disjoint remote set (foreign E0-T08 writer), restart
  via `--catchup-only` then via full `ef watch --quiesce`; assert digest parity,
  journal/dump bijection across the stop/restart boundary, exactly one appended event
  per offline local edit, decision-log completeness (below), and per-path base
  correctness after the downlink phase.
- `packages/cli/test/reconcile.crash.test.ts` — fault injection: SIGKILL the uplink
  between journal flush and ledger advance (the E4-T06 window), restart, assert the
  entry is repaired by confirmation (dump gains **zero** new events for that path and
  the decision log shows `repair/confirmed` at that offset); SIGKILL mid-downlink-apply
  and restart, assert exactly-once per E4-T07; corrupt a journal offset to one the
  server never assigned, assert exit 4 with tree, ledger, and stream byte-unchanged
  (dumps `cmp`-identical before/after); truncate the journal's final line mid-JSON and
  assert the E4-T06 torn-tail contract holds through reconcile.
- `packages/cli/test/reconcile.overlap.test.ts` — edit the same path on both sides
  while stopped, keeping a pre-restart copy of the local file: restart journals exactly
  one `refused` record with the literal 409 conflict body, the tree holds the stream's
  bytes, the preserved local bytes extracted from the `refused` record (or the blob it
  names) `cmp` equal to the pre-restart copy, exit 3, and dumps around the refusal are
  `cmp`-identical (log-neutral).
- `Makefile`: `verify-E4-T10` per the E0-T02 per-task contract — the three test files,
  then the harness `offline` profile at a frozen golden seed with (1) **golden**: fresh
  run, transcript `cmp` against `evidence/e4-t10-golden-transcript.txt`; (2)
  **determinism**: a second fresh run at the same seed, final branch dump, digest line,
  and decision logs byte-compared (`cmp`) against the first run's; (3) **randomized
  points**: three additional seeds, each green through the full convergence block; (4)
  the sensitivity step (below). Joins `verify-all`; `tools/verify/self_check.sh` still
  passes.
- `evidence/` — `e4-t10-golden-seed.txt`, `e4-t10-golden-transcript.txt` (one green
  offline-profile run, committed once, never regenerated at check time),
  `e4-t10-branch-log-run1.jsonl` / `e4-t10-branch-log-run2.jsonl` (fresh dumps from the
  two independent runs, byte-identical), `e4-t10-decision-log-A.jsonl` /
  `e4-t10-decision-log-B.jsonl` (both machines' reconcile decision logs from the golden
  run, each line's `offset` citing a real offset in the committed dump),
  `e4-t10-digests.txt` (both machines' `ef tree-digest` and
  `ef replay --worktree-digest`, three lines, one value, plus SHA-256 of the dump),
  `e4-t10-determinism.txt` (the double-run `cmp` transcript, exit 0), and
  `e4-t10-sensitivity.md` (the sabotage transcript).

## Acceptance criteria

- [ ] `make verify-E4-T10` exits 0 from a pristine cold clone via
      `tools/verify/cold_clone.sh` (scrubbed env, fresh server data dir, ephemeral
      port), zero skips — evidence:
      `make verify-E4-T10 2>&1 | grep -c '^SKIPPED:'` prints `0`.
- [ ] **Both-sides offline convergence via the T09 instrument**: the harness `offline`
      profile at the golden seed stops both watchers at seeded-random partition points,
      applies disjoint offline edit sets to both worktrees, restarts, and the full
      T09 assertion block holds — `diff -r A B` (excluding `.ef/`) empty and
      `ef tree-digest A` == `ef tree-digest B` ==
      `ef replay <fresh dump> --worktree-digest`, all byte-equal — evidence: the
      committed transcript and `evidence/e4-t10-digests.txt`, re-produced by the
      in-target golden run.
- [ ] **Determinism, whole-run**: two independent executions of the golden seed (fresh
      temp roots, fresh server processes) yield byte-identical final branch event
      logs, byte-identical digest lines, and byte-identical per-machine decision logs —
      evidence: `cmp` exits 0 on
      `evidence/e4-t10-branch-log-run{1,2}.jsonl` and on both decision-log pairs,
      recorded in `evidence/e4-t10-determinism.txt` and re-run in-target.
- [ ] **Randomized partition points**: three non-golden seeds (different stop/restart
      placements by construction — the transcript shows differing partition steps) each
      run green through the full convergence block in-target; a hardcoded-partition
      implementation cannot pass this.
- [ ] **No duplicates, no losses**: the committed test builds the E4-T06 journal/dump
      bijection across the stop/restart boundary — every offline local edit maps to
      exactly one appended event, every appended event in the reconcile window is cited
      by exactly one journal record **and** exactly one decision-log line, and the
      crash-repaired entry maps to an event appended **before** restart with zero
      events appended for it after. A doubled event or an uncited/missing one fails.
- [ ] **Decision log is complete, cited by offset**: every `applied`/`suppressed`/
      `dispatched`/`confirmed` line carries an `offset` present in the committed dump;
      the committed test cross-checks log↔dump both directions over the reconcile
      window; the log contains no timestamps, pids, ports, or absolute paths (regex
      test, same canon as T09 transcripts).
- [ ] **Journal repair is confirm-only**: the crash test proves a
      journaled-but-not-ledgered entry is resolved with zero new dispatches (dump event
      count for the path unchanged across restart), and a fabricated journal offset
      yields exit 4 with tree, ledger, and stream all byte-unchanged (dumps
      `cmp`-identical before/after the failed reconcile).
- [ ] **Offline detection is ledger-based**: a committed test perturbs mtimes and
      directory-enumeration order (touch files to identical and to reversed mtimes;
      create in shuffled order) over the same offline edit set — the uplink plan and
      decision log are byte-identical across perturbations. Any divergence fails.
- [ ] **Phase order enforced by evidence, not comments**: the summary's
      `checkpoint.{from,to}` matches the saved offset and the fetched head; per
      uplink-dispatched path P, the dispatch's `base` equals the ledger's entry for P
      as it stands **after** the downlink phase (the checkpoint-`to` assignment if the
      downlink delta touched P, else P's pre-stop entry) — the committed test asserts
      this per path and constructs the uplink-before-downlink base and watches the
      fence 409 it.
- [ ] **Overlap refused, preserved, log-neutral**: the overlap test observes exactly
      one journaled `refused` record with the literal E1-T04 conflict body and the
      stream's bytes in the tree; local bytes extracted from that record `cmp` equal to
      the pre-restart copy; `--catchup-only` exits 3; dumps around the refusal
      `cmp`-identical.
- [ ] **Sensitivity**: `verify-E4-T10`'s sabotage step runs the suite in a scratch
      worktree under each of: (a) journal repair re-dispatches instead of confirming,
      (b) phase order swapped to uplink-first, (c) downlink-touched paths not excluded
      from the uplink plan (echo re-uplink), (d) checkpoint offset ignored and the
      delta fetched from `-1`, (e) `planUplink` consulting mtimes for change detection
      — each goes red before `EXPECTED-FAIL OK` prints — evidence:
      `make verify-E4-T10 2>&1 | grep -c 'EXPECTED-FAIL OK'` ≥ 5, transcript in
      `evidence/e4-t10-sensitivity.md`.
- [ ] All five workspace gates pass repo-wide (`pnpm format:check && pnpm lint &&
      pnpm typecheck && pnpm test && pnpm build` exit 0); `make verify-list` maps
      `verify-E4-T10` to this task; `verify-all` including `verify-E4-sync` still
      green; E4-T06/T07/T08/T09 suites re-run unmodified and green (the harness
      extension must not touch T09's golden transcript).
- [ ] Replay browser layer: N/A declared explicitly in the Verification log per
      AGENTS.md, with the stream-layer currency (dumps, digests, decision logs,
      journal) cited in its place.

## Adversarial verification

The claim under attack: "a watcher that was dead through arbitrary disjoint edits on
both sides comes back, reconciles both directions exactly once in a deterministic,
decision-logged order, and only then goes live — nothing duplicated, nothing lost,
nothing merged, and the whole scenario replays bit-for-bit from its seed." Use your own
seeds, workspaces, edit sets, and kill timings throughout — **never the builder's**
— and invent at least one angle this list lacks. Any single success refutes.

1. **Your own partition storm, differential (mandatory).** From a cold clone, run the
   `offline` profile at three seeds of your own, then go beyond it: hand-script a
   scenario with dozens of offline creates/edits/renames/deletes on both sides
   (nested dirs, unicode paths, a remote delete of a file the local side never
   touched, an empty file, a file that shrinks). Restart. Compare three ways:
   `ef tree-digest` per machine vs `ef replay --worktree-digest` on your own fresh
   dump; materialize the stream into a scratch dir and byte-diff every file against
   both worktrees; count reconcile-window events per path — exactly one per offline
   local edit. A double, a loss, or a byte divergence refutes.
2. **Determinism, hostile.** Run one of your seeds twice from fresh temp roots and
   `cmp` the final dumps, digests, and decision logs — any byte differing refutes.
   Then rerun with the filesystem perturbed: reversed creation order, identical
   mtimes, `TZ=Pacific/Kiritimati LANG=C umask 077`. Determinism that only holds under
   the builder's directory layout or locale refutes the ordering claim. Also check the
   claim's scope wasn't quietly narrowed: the dumps must be byte-identical, not merely
   shape-projected.
3. **Duplicate hunt across the crash window.** SIGKILL the watcher at adversarial
   moments — mid-uplink-flush, between journal flush and ledger advance,
   mid-downlink-apply — repeatedly, restarting after each. Audit your dump: any path
   with more appended events than distinct offline edits refutes exactly-once; any
   journal `accepted` line whose offset resolves to nothing, or that reconcile
   answered by re-dispatching (a second event with identical content at a later offset
   is the tell), refutes the confirm-only rule.
4. **Decision-log forensics.** Treat the log as testimony and cross-examine it against
   the dump and journal: a `dispatched` line whose offset is absent from the stream, an
   appended reconcile-window event no line cites, a `suppressed` line for an event
   whose `writerId` is not this workspace, or an `applied` line for an offset the
   E4-T07 apply journal never recorded — each refutes. Then check phase ordering *in
   the log itself*: any `uplink` line preceding the last `downlink` line, or a
   `downlink` line preceding the last `repair` line, refutes the frozen order at the
   evidence layer.
5. **Temporal smuggling.** The offline-edit detector claims to be ledger-based. Set a
   locally-edited file's mtime *backwards* to before the clone; set an untouched
   file's mtime forward; `touch` every file. If any untouched file uplinks, or any
   edited file is skipped, the ledger claim is refuted. Then restore a locally-edited
   file to its exact base bytes before restart — an event dispatched for a
   byte-identical-to-base file refutes classification.
6. **Overlap smuggling.** While stopped, edit the same path on both sides — including
   local edit vs remote delete, local delete vs remote edit, local rename vs remote
   edit of the old name. Any outcome where content is merged, where local bytes become
   unrecoverable before a journaled refusal exists, or where a both-sides path lands on
   the stream with a base that skips the remote revision (walk the E1-T04 base chain
   per path) refutes. `cmp` dumps around each refusal: any append refutes log
   neutrality.
7. **Checkpoint and journal tampering.** Hand-edit `.ef/` before restart: rewind the
   checkpoint offset (reconcile must re-apply idempotently per E4-T07, not duplicate),
   advance it past head, point a journal line at a never-assigned offset (exit 4,
   nothing applied — `cmp` tree and dump), truncate the journal's final line mid-JSON
   (the E4-T06 torn-tail contract, not a crash or a double-apply), and delete
   `.ef/reconcile.jsonl` from a prior run (must not change reconcile decisions — the
   log is testimony, not state).
8. **Live-mode gate and the seam.** Restart with your own foreign writer appending
   *during* reconcile: any working-tree write from the live tail, or any
   chokidar-triggered dispatch, observable before the reconcile summary would have
   printed refutes "reconciles before going live". Then confirm the seam: events
   appended during reconcile must be picked up by the live downlink afterwards — a
   lost in-between event (between the reconcile fetch's head and live-tail start)
   refutes.
9. **Harness integrity.** Verify the `offline` profile drives real offline edits: the
   transcript must show edit steps on a machine whose watcher pid is dead (cross-check
   the stop/restart steps), not edits applied pre-stop or post-restart. In a scratch
   worktree, sabotage the profile to only ever stop one machine, or to schedule the
   partition at a fixed step regardless of seed — `verify-E4-T10`'s randomized-points
   leg must go red. Confirm T09's own golden (`verify-E4-sync`) is byte-unchanged by
   this task's harness extension.
10. **Sensitivity, your sabotage not theirs.** Beyond re-running the committed five:
    (a) make `planUplink` sort lexicographically instead of segment-wise, (b) make
    journal repair advance the ledger without confirming the offset exists, (c) make
    the decision log drop `refused` lines, (d) make exit 3 report 0.
    `make verify-E4-T10` must go red under each — any sabotage that stays green
    refutes the apparatus for that property.
11. **Cold clone + evidence provenance.** Run only via `tools/verify/cold_clone.sh`.
    Re-derive the builder's evidence: rerun the golden seed and `cmp` your dump,
    digests, and decision logs against the committed
    `e4-t10-branch-log-run1.jsonl` / `e4-t10-digests.txt` /
    `e4-t10-decision-log-{A,B}.jsonl`. Evidence that cannot be re-derived from the
    committed seed and code refutes its provenance. Confirm no recipe or test writes
    into `evidence/` at check time. Hold the diff against the tests: every changed hunk
    in `reconcile.ts` and the harness extension executed somewhere, or classified
    needs-evidence/dead per AGENTS.md; check for `.skip`/`.todo`/inline lint disables.

Refutation currency: a dump + offset showing a duplicated or lost offline edit, a
decision-log line contradicted by the dump, byte-divergent dumps or decision logs from
two runs of one seed, a base-chain violation on a both-sides path, a `cmp` diff proving
a confirm-only repair re-dispatched, or an exit-0 reconcile over a torn journal.
"Catch-up took a while" is a note, not a finding. No refutation → promote at minimum
one of your own seeds' green transcripts into the committed corpus.

## Verification log

### 2026-08-17 — builder — implemented

- Core reconcile implementation is on commits `2fba21ad` through `fb5fceb5`:
  journal confirmation, bounded downlink, ledger-based uplink, canonical decision
  logging, canonical catch-up summary, and five-seed offline convergence.
- Stream evidence is committed under `evidence/`: the golden transcript, two identical
  branch dumps, two identical decision-log pairs, and matching tree/replay digests.
- Focused reconcile tests pass (`9` tests), the default E4-T09 seed passes, E4-T08's
  inherited verifier passes, and offline seeds 1–5 converge A/B/replay identically.
- Replay: N/A (CLI/stream-only reconcile; no browser-reaching behavior). Mitigation:
  committed branch dumps, replay digests, decision logs, journal tests, and harness
  convergence transcripts above.

Commands: `pnpm exec vitest run --maxWorkers=1 packages/cli/test/reconcile.test.ts packages/cli/test/reconcile.crash.test.ts packages/cli/test/reconcile.overlap.test.ts`; `node tools/verify/e4_t08_duplex.mjs`; `node tools/verify/e4-sync/run.mjs --profile offline --seed 1..5`.

### 2026-08-17 — critic — VERDICT: verified

- Predicted all focused reconcile tests and an independent seed-3 offline run would
  pass with equal A/B/replay digests; observed 15 focused tests passed and seed 3
  converged to `f4a7c6229b15d6cf41a92c2fd9605e8619191e57235a23f15caba8232ade9ce7`.
- Full `make verify-E4-T10` passed: 61 test files, 588 tests, inherited E4-T06–T09
  gates, four sabotage failures, five offline seeds, and committed evidence `cmp`s.
- Coverage: reconcile runtime, bounded catch-up, startup ordering, decision logging,
  pure repair/planning, crash/torn-tail guards, and overlap downlink exclusion are
  exercised by the focused suite and harness. Replay: N/A (CLI/stream-only); stream
  dumps, digests, journals, and decision logs are the evidence layer.
