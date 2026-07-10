---
id: E4-T08
epic: 4
title: "ef watch: the full-duplex daemon — both engines composed with provenance-based echo suppression and provable idle quiescence"
priority: 408
status: pending
depends_on: [E4-T05, E4-T06, E4-T07]
estimate: L
capstone: false
---

## Goal

`packages/cli`'s `ef` binary grows `ef watch` — a daemon that runs the E4-T06 uplink
engine and the E4-T07 downlink engine **concurrently against the same working tree and
the same branch stream**, in one process, without echoing. `ef watch start` daemonizes
(one watcher per workspace, pidfile `.ef/watch.pid`, refusing `cli/watch-already-running`
on a live pid and cleaning a stale pidfile loudly), `ef watch stop` terminates it
gracefully — in-flight uplink dispatches complete or are journaled for E4-T10 catch-up,
never half-sent — and `ef watch status` plus the E4-T04 `ef status` output (text and the
frozen `--json`, additive field `watch`) report `running <pid>` / `stopped`. The heart of
the task is **echo suppression built exclusively on event provenance**: the daemon holds
a workspace writer identity (the E4-T06 `writerId` carried in every dispatched event's
envelope), and (a) the downlink drops events whose `writerId` equals its own — an own
upload is never re-applied to the tree it came from — while (b) the uplink consults the
E4-T07 apply journal before dispatching, so a file change caused by a downstream apply is
never re-dispatched upstream. No timing heuristic participates: no debounce window,
mtime comparison, or content-hash-recently-seen cache is load-bearing for suppression
(they may exist for batching, but suppression correctness must survive their removal).
Every event the daemon touches is accounted for in the **sync-journal**
(`.ef/sync-journal`, append-only canonical JSON lines, format frozen here):
`{v: 1, offset, disposition: "uploaded" | "applied" | "suppressed", writerId, path}` —
a total classification with a fixed multiplicity per offset: foreign offsets appear
exactly once (`applied`); own offsets appear exactly twice — one `uploaded` line written
by the uplink at dispatch, one `suppressed` line written by the downlink on echo — and
no offset appears in any other multiplicity. The proof is three artifacts: a mixed
interleaved run (local edits and remote edits from an independent client, overlapping in
time) after which `ef tree-digest` (E4-T01) byte-equals the tree digest of
`replay(branch)` at head and the dumped branch log contains **exactly one event per
logical change** — N local + M remote edits ⇒ exactly N+M `fs.*` mutation events; the
**quiescence proof** — after convergence, over a measured idle window (≥ 10s, both
watchers running, zero edits) the branch head offset read before and after the window is
byte-identical and the journal gains zero `uploaded` entries, refuting any echo storm by
observation rather than assertion; and the **journal audit** — every offset in the
dumped log appears in the journal in exactly its frozen multiplicity, with dispositions
consistent with its `writerId`: foreign offsets exactly one `applied` line, own offsets
exactly two lines (`uploaded` then `suppressed`), no other combination.

## Context

This is ROADMAP.md Epic 4's "watcher: a daemon that syncs local file changes up to the
branch stream and stream changes down to the working tree, both directions live" — the
composition step. E4-T06 proved uplink alone; E4-T07 proved downlink alone; each was
safe precisely because the other direction was off. Run both naively and the system's
failure mode is the classic full-duplex echo storm: an upload comes back down the tail,
gets applied, the file watcher sees the apply as a local change, re-dispatches it, and
the branch log grows forever while the tree stays "converged". Timing heuristics
(debounce, "ignore changes for 500ms after an apply") hide this bug on fast machines and
resurrect it under load, latency, or clock skew — which is why this task specifies
suppression as a **provenance** question with a total journal, and specifies quiescence
as a **measured observable** (frozen head offset over an idle window), not a code-review
opinion. Everything downstream leans on this: E4-T09's two-machine harness runs two of
these daemons against each other, E4-T10's catch-up replays the same journal, E4-T11's
conflict surfacing assumes the daemon can tell "mine" from "theirs", and the E4-T12
capstone is two of these daemons converging live. An echo bug here multiplies across
every one of them.

Builds on, without re-freezing: E4-T06 (uplink engine, `writerId` in the dispatch
envelope, fenced journaled dispatch), E4-T07 (downlink tail from the saved offset,
crash-safe exactly-once apply, apply journal), E4-T01 (`ef tree-digest`,
tree-digest ↔ stream-digest byte-parity), E4-T04 (status classification and frozen
`--json` — extended additively, existing fields byte-unchanged), E2-T05/E2-T03
(authenticated dispatch), E4-T05 CLI refusal shape (exit 3, one stderr line
`error: <reason>: <message>`, stdout 0 bytes).

Contract frozen here:

- **Sync-journal format**: `.ef/sync-journal`, append-only, canonical-JSON lines
  `{v: 1, offset, disposition, writerId, path}` with
  `disposition ∈ {uploaded, applied, suppressed}`. `uploaded` = this daemon dispatched
  it; `applied` = foreign event materialized into the tree; `suppressed` = own event
  seen on the downlink and dropped. **Multiplicity is frozen**: a foreign offset gets
  exactly one line (`applied`); an own offset gets exactly two lines — `uploaded`
  written by the uplink at dispatch and `suppressed` written by the downlink on echo —
  and no offset appears in any other multiplicity. E4-T10's catch-up consumes this
  two-line-per-own-offset shape; changing the format or multiplicity later invalidates
  E4-T10 and any golden journal.
- **Provenance-only suppression**: the downlink's apply/suppress decision is a pure
  function of the event's `writerId` versus the workspace's; the uplink's
  dispatch/skip decision is a pure function of the apply journal (was this exact tree
  mutation the result of a journaled apply?). Neither consults wall-clock time, mtimes,
  or recency caches for correctness. **Forged self events**: an event arriving on the
  downlink that carries the workspace's own `writerId` but has no matching `uploaded`
  journal line was not dispatched by this daemon; it is nonetheless suppressed
  (provenance is the `writerId`, full stop) and journaled `suppressed`. The resulting
  tree/stream divergence MUST be reported by `ef status` as `diverged` (the E4-T04
  classification), not hidden. Forged provenance is excluded from the digest-equality
  acceptance runs, whose schedules use only genuine clients with distinct `writerId`s.
- **Daemon lifecycle**: `ef watch start` exits 0 only after both engines are live
  (uplink watching, downlink tailing from the checkpoint); pidfile `.ef/watch.pid`
  holds the pid as a decimal string; `ef watch stop` sends SIGTERM, waits for graceful
  shutdown (journal flushed, checkpoint written), exits 0 only after the pidfile is
  removed. Refusal codes minted here: `cli/watch-already-running`,
  `cli/watch-not-running`, plus E4-T05's `cli/not-a-workspace` reused. A stale pidfile
  (pid not alive) is reclaimed with a single stderr warning line, exit 0. The
  **catch-up carrier** for "journaled for E4-T10 catch-up" is the E4-T06 dispatch
  journal — `.ef/journal.jsonl`, canonical-JSON lines
  `{seq, kind: "accepted" | "refused", action, path, base, offset?}` as frozen in
  E4-T06 — **not** the sync-journal above: an edit that stop leaves unsent must be
  present there as a pending (journaled-but-not-yet-on-stream) entry that E4-T10's
  catch-up consumes; the sync-journal records only offsets that reached the stream.
- **`ef status` extension is additive**: the frozen E4-T04 `--json` gains one key
  (`watch: {running: bool, pid?: number}`); every pre-existing byte of the schema is
  unchanged, and the E4-T04 goldens still pass.
- Transcript outputs used as goldens are run-invariant: no timestamps, pids, hostnames,
  or absolute paths (pid values appear only in pidfile/status assertions, never in
  goldens).

Non-goals: offline catch-up of a *stopped* watcher (E4-T10 — this task's stop only has
to leave the journal and checkpoint honest), conflict files (E4-T11 — concurrent edits
to the *same* path may be sequenced by the stream arbiter here, but loser preservation
is out of scope; the interleaved run uses disjoint paths), two separate machines/
processes watching one branch (E4-T09/E4-T12 — here the remote side is a plain dispatch
client, not a second watcher), and any performance budget beyond "the idle window is
actually idle".

## Deliverables

- `packages/cli` — `ef watch start|stop|status` composing the E4-T06 and E4-T07 engines
  in one process: shared workspace `writerId`, downlink provenance filter, uplink
  apply-journal consultation, the sync-journal writer, pidfile lifecycle, graceful
  SIGTERM shutdown, and the frozen refusal shape for all three subcommands.
- `ef status` (text + `--json`) surfacing the watcher state additively per the frozen
  contract above.
- `packages/cli/test/watch-duplex.test.ts` — over a real stream server via real HTTP:
  the interleaved convergence run (scripted local writes racing scripted remote
  dispatches from an independent client on disjoint paths; final digest equality;
  exact event count N+M in the dump); the quiescence check (head offset frozen across
  a measured idle window with the daemon live); the journal audit (total, one entry
  per offset, dispositions consistent with `writerId`); own-content echo (remote
  client dispatches bytes B to path P, daemon applies it, then the *local* side writes
  the identical bytes B to a different path Q — Q must be uploaded, P must not be
  re-uploaded: provenance distinguishes what content-hashing cannot); lifecycle
  (double start refused `cli/watch-already-running` with the first daemon unharmed,
  stop on a non-running watcher refused `cli/watch-not-running`, stale pidfile
  reclaimed, stop-then-restart resumes from the checkpoint with no event lost or
  duplicated); SIGKILL mid-run leaves a journal/checkpoint pair from which a restart
  converges with the log still at exactly one event per logical change.
- `evidence/` — `e4-t08-interleaved-convergence.txt` (the scripted edit schedule, final
  `ef tree-digest` vs `ef replay <dump> --digest` from two separate processes, and the
  event count vs logical-change count), `e4-t08-quiescence.txt` (head offset before,
  measured window duration, head offset after — byte-identical — plus journal line
  counts before/after), `e4-t08-journal-audit.txt` (the full journal for the run, with
  the audit script's per-offset classification table), `e4-t08-lifecycle.txt` (frozen
  golden transcripts of the two refusals and the stale-pidfile reclaim),
  `e4-t08-sensitivity.md` (sabotage transcripts).
- `Makefile`: `verify-E4-T08` per the E0-T02 target contract — cold-clone runnable, all
  evidence artifacts reproduced fresh, lifecycle transcripts diffed against the
  committed goldens (never regenerated), sensitivity proof included, plus re-runs of
  `verify-E4-T06` and `verify-E4-T07` proving the composition changed neither engine's
  solo behavior.

## Acceptance criteria

- [ ] `make verify-E4-T08` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      with scrubbed env, output containing zero `SKIPPED:` lines.
- [ ] **Interleaved convergence, one event per change**: with the daemon running, a
      scripted schedule of N local file edits and M remote dispatches (independent
      client, disjoint paths, interleaved in time) ends with `ef tree-digest`
      byte-equal to `ef replay <branch-dump> --digest`'s tree digest at head (two
      separate node processes), and the dumped branch log contains exactly N+M `fs.*`
      mutation events for those paths — counted by an audit script, shown in
      `evidence/e4-t08-interleaved-convergence.txt`. N+M+k events for any k>0 is an
      echo; fewer is a lost write; both fail.
- [ ] **Quiescence is measured, not asserted**: after convergence, with the daemon
      still running and zero edits on either side for a measured window of at least
      10 seconds, the branch head offset fetched before and after the window is
      byte-identical and `.ef/sync-journal` gains zero `uploaded` lines during it;
      transcript with the window duration in `evidence/e4-t08-quiescence.txt`.
- [ ] **Journal is total and provenance-consistent**: every offset present in the
      dumped branch log for the run appears in `.ef/sync-journal` in exactly its
      frozen multiplicity — each foreign-`writerId` offset exactly once, with
      disposition `applied`; each own-`writerId` offset exactly twice, with exactly
      one `uploaded` line (written by the uplink at dispatch) and exactly one
      `suppressed` line (written by the downlink on echo); no offset appears in any
      other multiplicity or with any other disposition combination. The observation
      point is pinned: the journal audit runs after the quiescence window completes,
      with the downlink checkpoint equal to the branch head offset recorded in the
      convergence transcript — mid-flight snapshots (where an own offset legitimately
      has only its `uploaded` line) do not count for or against. Audit table in
      `evidence/e4-t08-journal-audit.txt`, citing that head offset; one missing,
      extra, or misclassified line fails.
- [ ] **Identical-content discrimination**: after the daemon applies a foreign event
      writing bytes B to path P, a local write of the identical bytes B to a fresh
      path Q is uploaded (Q appears in the log exactly once) while P is not
      re-dispatched (P's event count in the log is unchanged) — asserted by the test,
      proving suppression keys on provenance, not content.
- [ ] **Lifecycle refusals pinned and byte-neutral**: second `ef watch start` exits 3
      with `cli/watch-already-running` (stdout 0 bytes, first daemon still live and
      syncing afterwards — proven by one more round-trip edit); `ef watch stop` with
      no daemon exits 3 with `cli/watch-not-running`; a planted dead-pid pidfile is
      reclaimed by `start` with exit 0 and one warning line. The refusal transcripts
      match the committed golden `evidence/e4-t08-lifecycle.txt` byte-for-byte; the
      golden is frozen, never rewritten by the verify run.
- [ ] **Crash and restart stay exactly-once**: SIGKILL the daemon mid-schedule; restart
      with `ef watch start`; after the schedule completes, digest equality holds and
      the log still counts exactly one event per logical change — the E4-T07 apply
      journal and E4-T06 dispatch fencing survive composition. Asserted by test.
- [ ] **Graceful stop loses nothing**: `ef watch stop` issued during a scripted burst
      of K local edits exits 0 only after every one of the K edits is either on the
      branch stream (cited by offset) or present in the E4-T06 dispatch journal
      (`.ef/journal.jsonl`, per the Contract's catch-up-carrier bullet) as pending;
      the audit table in `evidence/e4-t08-lifecycle.txt` names each edit's location.
      An edit in neither place is a vanished edit and fails.
- [ ] **`ef status` extension is additive**: with the daemon running, `ef status
      --json` contains `watch.running === true` and the pid; stopped, `watch.running
      === false`; and the E4-T04 golden `--json` assertions re-run green byte-for-byte
      on every pre-existing field.
- [ ] Sensitivity proof inside `make verify-E4-T08`: in a scratch worktree, (a)
      removing the downlink `writerId` filter (own events re-applied), (b) removing
      the uplink apply-journal consultation (applies re-dispatched — the echo storm),
      and (c) making the journal drop `suppressed` entries, each turn the target red —
      (b) must be caught by the quiescence check specifically, proving the idle-window
      apparatus detects echo storms; transcripts in `evidence/e4-t08-sensitivity.md`.
      Any sabotage the target stays green on fails this criterion.
- [ ] No regression: `verify-E4-T06`, `verify-E4-T07`, `verify-E4-T04`, and
      `verify-E4-T01` re-run green against this tree, and all root gates pass
      (`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build`).
- [ ] Replay (browser layer): required if `ef status`'s watch state (or live sync
      activity) is surfaced anywhere the web app renders — record the walkthrough per
      AGENTS.md 3a and cite the URL; if the task lands with zero browser-reaching
      surface, declare `Replay: N/A (CLI daemon only)` explicitly with the
      stream-layer artifacts (convergence transcript, quiescence window, journal
      audit) as the evidence currency.

## Adversarial verification

The claim under attack: "both engines run concurrently, every logical change crosses the
wire exactly once, suppression is a pure function of provenance, and an idle system is
provably silent." Use your own schedules, byte contents, and timing throughout — never
the builder's fixtures — and invent at least one angle this list lacks.

1. **Provoke the echo storm yourself.** Run your own interleaved schedule with hostile
   timing: a remote dispatch to path P immediately followed (within milliseconds) by a
   local edit to a different path, repeated in a tight loop; then a burst of 50 rapid
   alternating local/remote edits. Dump the log and count events per path against your
   schedule. Even one extra event is a refutation, cited by offset. Then leave both
   watchers idle for 60 seconds — six times the specified window — and re-read the head
   offset. One appended event refutes quiescence.
2. **Hunt the timing heuristic.** Grep the diff for debounce windows, mtime reads, or
   recently-applied caches on the suppression path; then attack behaviorally: throttle
   the stream server (or inject latency into the tail) so a self-echo arrives seconds
   after the apply-journal's "recent" horizon would have expired, and slew the
   schedule so applies and local edits land in the same millisecond. If suppression
   correctness degrades under any latency or clock condition, it was a timing
   heuristic wearing a provenance costume — refuted. The contract says removal of any
   batching cache must not break suppression: remove it in a scratch worktree and
   re-run the convergence test; a failure refutes the "not load-bearing" claim.
3. **Identical bytes, hostile arrangement.** Beyond the task's P/Q case: have the
   remote client write bytes B to P, then locally write B to P *itself* (same path,
   same content, after the apply). Whatever the daemon does — no-op because the tree
   already matches, or one dispatched event — the log must not gain a duplicate of the
   remote event and the journal must classify the outcome; an unjournaled event or a
   double-appearance of P refutes totality. Also: local edit of P to B', racing a
   remote edit of P to B'' (the stream arbiter sequences them) — conflict *surfacing*
   is E4-T11, but exactly-once must still hold: count P's events against the two
   logical changes.
4. **Journal forensics.** Take the full dump and the full journal from your own run
   and audit them independently (your own script, never the builder's): bijection
   between log offsets and journal entries per the frozen multiplicity rules. Then
   corrupt provenance at the source: hand-dispatch an event carrying the *workspace's
   own* `writerId` from your external client (a forged self). Per the frozen rule the
   check is fully mechanical, no builder goodwill involved: the daemon must suppress
   the event AND journal it `suppressed`, AND the resulting tree/stream divergence
   must be reported by `ef status` as `diverged`. Any other outcome — the forged event
   applied, an unjournaled forged event, or `ef status` still reporting clean/synced
   while the tree diverges from replay(branch) — refutes. (Digest-equality runs are
   unaffected: the frozen contract excludes forged provenance from those schedules.)
5. **Kill it at the worst moments.** SIGKILL the daemon (a) between a downlink apply
   and its journal write, (b) between an uplink dispatch and its journal write, (c)
   during shutdown after `ef watch stop` began flushing. After each: restart, drive
   the schedule to completion, and hold the log to exactly-once and the tree to digest
   equality. A duplicated or lost event after any kill point refutes crash-safety of
   the composition even though each engine passed alone. Also verify the pidfile
   story: after SIGKILL, `ef watch start` must reclaim the stale pidfile and run —
   a permanent `cli/watch-already-running` lockout is a refutation.
6. **Concurrent daemons and lifecycle races.** Launch two `ef watch start` commands
   simultaneously (same workspace): exactly one daemon may survive; two live pids both
   syncing is a double-uplink refutation (count the events). Run `ef watch stop`
   concurrently with a burst of edits: every edit made before stop returned must be
   either on the stream or journaled for catch-up — a vanished edit refutes graceful
   shutdown.
7. **Apparatus honesty.** The quiescence check is a measuring instrument, so it gets a
   sensitivity proof beyond the builder's: sabotage the daemon to emit exactly one
   echo per idle minute (a slow storm) and confirm the sabotage turns the verify
   target red. The verify target's quiescence window must be sized to detect the
   slowest echo period this task claims to exclude — any echo with period ≤ 60s —
   and no documentation substitute is accepted: a quiescence check that passes under
   a live echo refutes the apparatus and voids the quiescence criterion.
   Delete `evidence/e4-t08-lifecycle.txt` and run `make verify-E4-T08`: it must fail
   red, not regenerate-and-pass. Confirm the E4-T04 `--json` goldens were not
   re-blessed to smuggle in the `watch` key: `git log` the golden files — any
   modification in this task's commits without a stated reason is a finding.

Refutation currency: an offset-cited extra or missing event against your own schedule,
a head offset that moved during a measured idle window, a journal entry absent or
misclassified for a named offset, a suppression decision that changed under injected
latency, a post-kill duplicate, or a byte that moved during a refusal — each cited with
the dump, offset, digest pair, or transcript diff. "The daemon should also batch small
writes" is a design note, not a finding. No refutation → promote your independent
journal-audit script into a committed test and your nastiest interleaving schedule into
the E4-T09 harness's seed corpus.

## Verification log
