---
id: E4-T10
epic: 4
title: "Offline catch-up: a stopped watcher reconciles both directions deterministically before going live"
priority: 410
status: pending
depends_on: [E4-T08]
estimate: M
capstone: false
---

## Goal

`ef watch` (E4-T08) gains a **reconcile phase** that runs to completion before either
live engine starts: `reconcile()` in `packages/cli/src/sync/reconcile.ts`, invoked
unconditionally on watcher startup and runnable standalone as `ef watch --catchup-only`
(reconcile, print a summary, exit — never go live). The phase does three things, in this
pinned order. **First, journal repair**: replay `.ef/journal.jsonl` (E4-T06 frozen
format) against an authenticated fetch of the branch metadata stream
(`fs:<org>/<repo>:<branch>:meta`) from the saved `.ef/` checkpoint offset — any
journaled-but-not-ledgered `accepted` entry (the crash window E4-T06's write ordering
deliberately leaves open) is resolved by confirming its `offset` exists in the stream
and advancing the ledger, **never** by re-dispatching; a journaled offset the server
never assigned is a hard error (exit 4, nothing applied). **Second, downlink catch-up**:
the fetched delta from the checkpoint offset to head is applied to the working tree
through the E4-T07 apply path (same ledger/journal discipline, same crash-safety),
skipping events whose offsets the repaired journal already attributes to this workspace
(E4-T08 echo suppression, replayed offline). **Third, uplink catch-up**: the working
tree is classified against the now-advanced ledger via the E4-T04 classifier, and every
offline local edit to a path the downlink delta did **not** touch is dispatched in
E1-T02's frozen segment-wise path order with ledger bases per E4-T06 — deterministic:
the same offline edit set produces the same dispatch order and the same event
**shape** (`{type, path}` projection) on every run. A path edited on **both** sides is
not merged and not clobbered: the uplink dispatch carries its stale ledger base, the
E1-T04 fence refuses it with 409 `stale-base`, and the refusal is journaled per E4-T06
— surfacing is E4-T11's job; this task's contract is that the stream copy wins the tree
and the local loser bytes are preserved in a concrete, journal-named artifact: the
journaled `refused` record for the path carries the local file's pre-refusal bytes
verbatim (or names a content-addressed blob under `.ef/` that does), so T11 — and any
verifier — recovers them from that record alone, byte-exact (nothing silently
dropped). Only when reconcile completes does `ef watch`
enter live mode. End state, provable: stop a watcher, edit **disjoint** file sets
locally and remotely, restart — at quiescence the local `ef tree-digest` (E4-T01) and
the server's `ef replay <fresh dump> --digest --reducer` are byte-identical, and the
dump contains exactly one event per offline local edit (no duplicates from journal
replay, no lost edits from mis-classification), verified by the E4-T06 journal/dump
bijection extended across the stop/restart boundary.

## Context

This is the partition-recovery half of the Epic 4 watcher story and a direct
prerequisite of the E4-T12 capstone ("a partitioned (stopped) watcher catches up
cleanly on restart" — ROADMAP, Epic 4). E4-T08 composed the two live engines; what it
cannot do is start honestly after downtime: the checkpoint offset is behind head
(remote edits happened), the ledger is behind the tree (local edits happened), and the
journal may end in a torn tail (the E4-T06 crash window). Every prior task pinned a
contract this one consumes rather than invents: the `.ef/` checkpoint and ledger
(E4-T01/T02/T03), the classifier (E4-T04), the journal format and
journal-before-ledger ordering (E4-T06 — "E4-T10 reconciles" is a promise made there,
paid here), the downlink apply path and exactly-once discipline (E4-T07), and echo
suppression via journal offsets (E4-T08).

Contracts pinned here (E4-T11 and E4-T12 depend on them):

- **Phase order is frozen**: journal repair → downlink → uplink. Uplink-first would
  fabricate bases against a head the ledger hasn't seen; downlink-before-repair would
  double-apply this workspace's own crash-window events.
- **Reconcile never re-dispatches a journaled offset.** Journal repair is read-and-
  confirm only. Exactly-once across a crash means the journal, not a retry, is the
  source of truth.
- **Overlap handling**: both-sides paths reach the fence with their stale base and are
  refused + journaled; reconcile completes (exit 3 from `--catchup-only`, mirroring
  E4-T06 quiescence semantics) rather than aborting. The stream is the arbiter; local
  loser bytes are preserved for T11 inside the journaled `refused` record itself (or a
  content-addressed blob under `.ef/` that the record names), never deleted by the
  downlink apply before the refusal is journaled.
- **`--catchup-only` summary format**: one canonical-JSON line
  `{repaired, applied, dispatched, refused, checkpoint: {from, to}}` on stdout — frozen;
  E4-T12's harness gates on it.

Non-goals: conflict-file materialization and naming (E4-T11 — this task only guarantees
refusal + preservation), live-mode behavior after reconcile (E4-T08, unchanged),
multi-branch reconcile (`ef checkout` while stopped is E4-T05's dirty-tree protection,
out of scope), and any server-side change — reconcile is a pure client of frozen
endpoints.

Browser layer: N/A — reconcile is CLI-only and changes no browser-reaching behavior;
the events it appends flow through the same frozen E1-T02/E4-T06 append path the web
app already consumes, unchanged by this task. The builder's claim must state
`Replay: N/A` with this reason and cite the stream-layer mitigation (dumps, digests,
journal, `cmp` evidence) in its place — silence is forbidden per AGENTS.md 3a.

## Deliverables

Path anchor: `evidence/` paths are relative to this task folder,
`.eforest/tasks/epic-4-the-roots/E4-T10-offline-catchup/`.

- `packages/cli/src/sync/reconcile.ts` — `reconcile(workspace, client)` returning the
  frozen summary object; the three phases as separately exported, unit-testable
  functions: `repairJournal(journal, streamEvents)` (pure), `planUplink(classification,
  downlinkTouchedPaths, ledgerView)` → ordered dispatch plan (pure, deterministic), and
  the downlink application delegating to E4-T07's engine in bounded (non-tailing) mode.
- `ef watch` wired to run reconcile before live mode (both engines held until it
  returns), plus `ef watch --catchup-only` with exit codes 0 (clean), 3 (completed with
  ≥ 1 journaled refusal), 4 (journal cites an offset the server never assigned —
  corrupt provenance, nothing applied).
- Package README section "Offline catch-up" documenting phase order, the
  no-re-dispatch rule, overlap semantics, exit codes, and the summary format.
- `packages/cli/test/reconcile.test.ts` — integration against a real server on an
  ephemeral port: init + clone a workspace, run a watcher, stop it, apply a scripted
  offline edit set locally (plain `fs`) and a disjoint remote set (foreign E0-T08
  writer), restart via `--catchup-only` then via full `ef watch --quiesce`; assert
  digest parity, journal/dump bijection across the boundary, exactly one event per
  offline local edit, and that a second identical run from a re-cloned workspace
  produces a byte-identical `{type, path}` event-shape projection (determinism).
- `packages/cli/test/reconcile.crash.test.ts` — fault injection: kill the uplink
  between journal flush and ledger advance (the E4-T06 window), restart, assert the
  entry is repaired by confirmation (dump gains **zero** new events for that path);
  kill mid-downlink-apply and restart, assert exactly-once per E4-T07; corrupt a
  journal offset to one the server never assigned, assert exit 4 with an untouched
  tree and ledger.
- `packages/cli/test/reconcile.overlap.test.ts` — edit the same path both sides while
  stopped, keeping a pre-restart copy of the local file: restart must journal exactly
  one `refused` record with the literal 409 conflict body, the working tree holds the
  stream's bytes for that path, the test extracts the preserved local bytes from the
  journaled `refused` record (or the content-addressed blob it names) and `cmp`s them
  against the pre-restart copy with exit 0, exit code 3, and head digest is unchanged
  by the refusal (log-neutral, `cmp` on dumps).
- `Makefile`: `verify-E4-T10` per the E0-T02 per-task contract — the three test files,
  replay of the committed branch log to its committed digest, the determinism
  double-run diff, and the sensitivity step (below); joins `verify-all`;
  `tools/verify/self_check.sh` still passes.
- `evidence/` — `e4-t10-edit-script.ts` (the scripted stop/edit-both-sides/restart
  sequence, local and remote sets and their disjointness stated in the script),
  `e4-t10-branch-log.jsonl` (fresh dump after reconcile + quiescence),
  `e4-t10-journal.jsonl` (the journal spanning pre-stop, offline, and reconcile),
  `e4-t10-digests.txt` (local `ef tree-digest` vs `ef replay --digest` at quiescence,
  byte-equal, plus SHA-256 of the dump), `e4-t10-summary.txt` (the `--catchup-only`
  summary line from the recorded run), `e4-t10-determinism.txt` (the two independent
  runs' shape projections and their `diff` exit 0), and `e4-t10-sensitivity.md`
  (the sabotage transcript).

## Acceptance criteria

- [ ] `make verify-E4-T10` exits 0 from a pristine cold clone via
      `tools/verify/cold_clone.sh` (scrubbed env, fresh server data dir, ephemeral
      port), zero skips — evidence:
      `make verify-E4-T10 2>&1 | grep -c '^SKIPPED:'` prints `0`.
- [ ] Digest convergence across a partition: after the committed script stops the
      watcher, applies disjoint local and remote edit sets, and restarts, quiescent
      `ef tree-digest` and `ef replay <fresh dump> --digest --reducer` are
      byte-identical — pair recorded in `evidence/e4-t10-digests.txt`, from the two
      independent instruments, re-asserted by the committed test.
- [ ] No duplicates, no losses: the committed test builds the E4-T06 journal/dump
      bijection across the stop/restart boundary — every offline local edit maps to
      exactly one appended event, every appended event in the reconcile window is cited
      by exactly one journal record, and the crash-repaired entry (from the fault-
      injection test) maps to an event appended **before** the restart, with zero
      events appended for it after. A doubled event or an uncited/missing one fails.
- [ ] Deterministic dispatch ordering: two independent executions of the same offline
      edit set (fresh clone each time) produce byte-identical `{type, path}` shape
      projections of the reconcile window — `diff` exits 0, committed as
      `evidence/e4-t10-determinism.txt` and re-run by `verify-E4-T10`.
- [ ] Journal repair is confirm-only: the crash test proves a journaled-but-not-
      ledgered entry is resolved with zero new dispatches (dump event count for the
      path unchanged across restart), and a fabricated journal offset yields exit 4
      with tree, ledger, and stream all byte-unchanged (dumps `cmp`-identical
      before/after the failed reconcile).
- [ ] Overlap is refused, preserved, log-neutral: the overlap test observes exactly
      one journaled `refused` record with the literal E1-T04 conflict body and the
      stream's bytes in the tree; the local bytes are extracted from that `refused`
      record (or the content-addressed blob it names) and `cmp`'d against a copy of
      the file taken before restart — exit 0, byte-exact; `--catchup-only` exits 3;
      and dumps around the refusal are `cmp`-identical.
- [ ] Phase order enforced by evidence, not comments: the reconcile summary's
      `checkpoint.{from,to}` matches the saved offset and the fetched head, and the
      committed test asserts, per path with no aggregate comparison: for each
      uplink-dispatched path P, the dispatch's `base` (E4-T06 frozen base semantics)
      equals the ledger's entry for P as it stands after the downlink phase completes
      — i.e. the checkpoint-`to` assignment for P if the downlink delta touched P,
      else P's pre-stop ledger entry (an uplink that ran before downlink would carry
      a base the fence provably rejects — the test constructs that case and watches
      it 409).
- [ ] Sensitivity: `verify-E4-T10`'s sabotage step runs the suite in a scratch worktree
      under each of: (a) journal repair re-dispatches instead of confirming, (b) phase
      order swapped to uplink-first, (c) downlink-touched paths not excluded from the
      uplink plan (echo re-uplink), (d) checkpoint offset ignored and delta fetched
      from `-1` — each must go red before `EXPECTED-FAIL OK` prints — evidence:
      `make verify-E4-T10 2>&1 | grep -c 'EXPECTED-FAIL OK'` ≥ 4, transcript in
      `evidence/e4-t10-sensitivity.md`.
- [ ] All five workspace gates pass repo-wide (`pnpm format:check && pnpm lint &&
      pnpm typecheck && pnpm test && pnpm build` exit 0); `make verify-list` maps
      `verify-E4-T10` to this task; `verify-all` still green; E4-T06/T07/T08 suites
      re-run unmodified and green.

## Adversarial verification

The claim under attack: "a watcher that was dead through arbitrary edits on both sides
comes back, reconciles both directions exactly once in a deterministic order, and only
then goes live — nothing duplicated, nothing lost, nothing merged." Use your own
workspaces, edit scripts, seeds, and kill timings throughout — **never the builder's
edit script** — and invent at least one angle this list lacks. Any single success
refutes.

1. **Your own partition storm, differential (mandatory).** From a cold clone, write
   your own seeded script (commit the seed): start the watcher, kill it, then apply a
   large disjoint pair of edit sets — dozens of local creates/edits/renames/deletes
   including nested dirs and unicode paths, and a remote set via your own foreign
   writer including deletes of files the local side never touched. Restart. Compare
   three ways: `ef tree-digest` vs `ef replay --digest` on your own fresh dump
   (byte-equal or refuted); materialize the stream into a scratch dir and byte-diff
   every file against the working tree; and count reconcile-window events per path —
   exactly one per offline local edit. A double, a loss, or a byte divergence refutes.
2. **Duplicate hunt across the crash window.** Kill the watcher with SIGKILL at
   adversarial moments — mid-uplink-flush, between journal flush and ledger advance,
   mid-downlink-apply — repeatedly, restarting after each. Then audit your dump: any
   path with more appended events than distinct offline edits refutes exactly-once;
   any journal `accepted` line whose offset resolves to nothing, or that reconcile
   answered by re-dispatching (a second event with identical content and a later
   offset is the tell), refutes the confirm-only rule.
3. **Determinism, hostile.** Run your own offline edit set through reconcile from two
   independently cloned workspaces — and a third time with filesystem enumeration
   perturbed (different creation order, different mtimes). Diff the `{type, path}`
   shape projections. Any divergence refutes; determinism that only holds under the
   builder's directory layout refutes the ordering claim.
4. **Overlap smuggling.** While stopped, edit the same path on both sides — including
   the nasty variants: local edit vs remote delete, local delete vs remote edit, local
   rename vs remote edit of the old name. Restart. Any outcome where local and remote
   content is merged, where the local bytes become unrecoverable before a journaled
   refusal exists, or where the fence is bypassed (a both-sides path lands on the
   stream with a base that skips the remote revision — walk the E1-T04 base chain
   per path) refutes. `cmp` dumps around each refusal: any append refutes log
   neutrality.
5. **Checkpoint and journal tampering.** Hand-edit `.ef/` state before restart: rewind
   the checkpoint offset (reconcile must re-apply idempotently, not duplicate — E4-T07
   exactly-once holds here or is refuted), advance it past head, point a journal line
   at a never-assigned offset (must exit 4, nothing applied — verify with `cmp` on
   tree and dump), and truncate the journal's final line mid-JSON (a torn tail must be
   handled per the E4-T06 crash contract, not crash reconcile or double-apply).
6. **Phase-order probe.** Construct the case the frozen order exists for: a remote
   edit to path P while stopped, plus a local edit to a different path whose dispatch
   would sort before P's downlink application. If any uplink dispatch is observable
   (dump timestamps/offsets) before the downlink delta finished applying, or carries
   a base predating the checkpoint head, the order claim is refuted regardless of the
   happy-path digest.
7. **Live-mode gate.** Instrument a restart with edits arriving live (your own writer
   appending during reconcile): any working-tree write from the live tail, or any
   chokidar-triggered dispatch, that lands before the reconcile summary would have
   printed refutes "reconciles before going live". Then confirm the seam: events
   appended during reconcile must be picked up by the live downlink afterwards, not
   dropped in the gap between the reconcile fetch's head and live-tail start — a lost
   in-between event refutes.
8. **Sensitivity, your sabotage not theirs.** Beyond re-running the committed four:
   (a) make `planUplink` sort paths lexicographically instead of segment-wise,
   (b) make journal repair advance the ledger without confirming the offset exists,
   (c) make exit 3 report 0. `make verify-E4-T10` must go red under each — any
   sabotage that stays green refutes the apparatus for that property.
9. **Cold clone + evidence provenance.** Run only via `tools/verify/cold_clone.sh`.
   Re-derive the builder's evidence: run `evidence/e4-t10-edit-script.ts` against a
   fresh server and diff your dump's shape projection and digests against the
   committed `e4-t10-branch-log.jsonl` / `e4-t10-digests.txt` /
   `e4-t10-determinism.txt`. Evidence that cannot be re-derived from the committed
   script and code refutes its provenance. Hold the diff against the tests: every
   changed hunk in `reconcile.ts` executed somewhere, or classified
   needs-evidence/dead per AGENTS.md.

Refutation currency: a dump + offset showing a duplicated or lost offline edit, a
base-chain violation on a both-sides path, byte-divergent shape projections from two
runs of one edit set, a `cmp` diff proving a confirm-only repair re-dispatched, or an
exit-0 reconcile over a torn journal. "Catch-up took a while" is a note, not a finding.

## Verification log
