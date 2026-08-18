---
id: E4-T12
epic: 4
title: "Capstone: two-machines-one-branch — two watched working directories converge live, survive a partition with a surfaced conflict, and digest-match replay(branch), cold start via make verify-E4-*"
priority: 412
status: in-progress
depends_on: [E4-T11]
estimate: L
capstone: true
---

## Goal

The Epic 4 roadmap demo runs end-to-end from a **cold start** — fresh clone via
`tools/verify/cold_clone.sh`, scrubbed env, fresh server data dir, ephemeral port — as
one command: `make verify-E4-capstone`. The scenario, driven by the E4-T09 harness (no
new sync machinery; this task *composes and proves*, it does not implement): `ef init`
adopts a seeded tree in directory **A** (E4-T02), `ef clone` materializes the same
branch into directory **B** (E4-T03), both run the full-duplex `ef watch` daemon
(E4-T08). **Phase 1 — live convergence:** scripted edits land on either side
(creates, patches, renames, deletes, nested and unicode paths) and appear in the other
working tree within a pinned bound `CONVERGENCE_BOUND_S` (a named constant in the
harness config, stated in the transcript, default ≤ 10 s per edit phase), verified by
phase-gated quiescence (E4-T08's provable idle) plus exact-diff assertions (E4-T09).
**Phase 2 — partition:** B's watcher is stopped; both sides keep editing, including
exactly one **true conflict** (both sides rewrite the same path from the same base) and
several non-conflicting edits. **Phase 3 — reunion:** B's watcher restarts, performs
offline catch-up (E4-T10), and the conflict is surfaced per E4-T11's frozen contract —
the stream is the arbiter, B's losing bytes are preserved byte-exact in an offset-named
conflict file, nothing silently dropped. **Verdict:** at final quiescence the two
working trees (conflict file included) are **byte-identical** (`diff -r` empty), and
each side's `ef tree-digest` (E4-T01) byte-equals `ef replay <fresh dump>
--worktree-digest` of the branch stream — three digest lines, one value, from two
independent instruments. Browser layer: the E3-T07 file viewer, open on the same branch
in Replay Chromium for the whole run, live-tails every phase with no reload, and its
DOM-exposed offset/digest (E3-T02 contract) matches the server head at convergence.
Every artifact of the run — full event-log dump, journal excerpts and offsets from both
sides, all digests, both convergence diffs, the conflict-file bytes — is committed
under `evidence/`.

## Context

ROADMAP.md, "Epic 4 — the-roots", capstone **two-machines-one-branch**: "two separate
working directories (simulating two machines) both run watchers on the same branch;
edits on either side appear on the other within seconds; a partitioned (stopped)
watcher catches up cleanly on restart; final trees are byte-identical and match
`replay(branch)`." This task is that paragraph made executable and hostile-critic-proof.

Everything it needs already exists and is cited, not re-derived: the digest apparatus
and `.ef/` format (E4-T01), init/clone (E4-T02/T03), status classification (E4-T04),
branch/checkout (E4-T05 — the demo forks its demo branch through the CLI rather than
riding main, exercising the fork+rematerialize path under real sync), uplink/downlink
(E4-T06/T07), the composed watcher with echo suppression and quiescence (E4-T08), the
two-machine harness with partition hooks and exact-diff assertions promoted as
`verify-E4-sync` (E4-T09), offline catch-up (E4-T10), and conflict surfacing (E4-T11).
`depends_on: [E4-T11]` is the transitive frontier: E4-T11 → T10 → T09 → T08 →
{T05, T06, T07}, and the CLI adoption chain T04 → T03 → T02 → T01 → E3 hangs off
that — one edge covers the entire epic.

Per `.eforest/tasks/README.md`, a capstone additionally requires the demo performed
end-to-end from a cold start — no state left over from development. So the harness run
that produces the committed evidence is itself the cold-start run: fresh clone, fresh
server data dir, fresh browser profile for the Replay recording. Nothing in this task
may relax, fork, or shadow a frozen contract (worktree digest v1, `.ef/` v1, the
journal format, the conflict-file naming) — if the demo needs a contract change, that
is a refutation of the earlier task, not a patch here.

Non-goals: no new sync engine behavior, no new CLI flags beyond harness plumbing, no
merge/rebase tooling (the conflict is *surfaced*, not resolved — resolution is a human
edit that then syncs like any other), no multi-branch topology (one branch, two trees),
and no real second machine (two directories + two watcher processes against one server
is the roadmap's stated simulation; the harness must nonetheless forbid any cross-talk
between A and B except through the server — separate workspace roots, separate `.ef/`
state, separate auth-token env).

## Deliverables

Path anchor: `evidence/` paths are relative to this task folder,
`.eforest/tasks/epic-4-the-roots/E4-T12-two-machines-one-branch/`. Makefile recipes
reference them repo-root-anchored.

- `packages/cli/test/capstone-e4.ts` (or the E4-T09 harness's scenario directory) — the
  **capstone scenario** expressed as an E4-T09 harness script: seed tree, `ef init` A,
  `ef branch` + `ef checkout` the demo branch, `ef clone` B, start both watchers, the
  three phases above with phase gates on quiescence, the single true conflict
  constructed deterministically (same path, same recorded base, divergent bytes on each
  side during the partition), final assertions. The scenario is seeded and re-runnable;
  the seed is committed.
- `Makefile`: `verify-E4-capstone` inside the marker section — runs the scenario from
  `tools/verify/cold_clone.sh` semantics (scrubbed env, fresh server data dir,
  ephemeral port), asserts every acceptance criterion below, includes the sensitivity
  step, and joins `verify-all`. `make verify-list` maps it to this task;
  `tools/verify/self_check.sh` still passes. An alias or dependency edge from
  `verify-E4-capstone` to re-running `verify-E4-sync` (E4-T09) unmodified is required —
  the capstone must not fork the harness.
- Browser evidence run: `tools/replay/record-run.sh -o e4-t12-final` recording the
  E3-T07 file viewer open on the demo branch (fresh browser profile) across all three
  phases: live updates during phase 1, a visibly static view during B's partition-side
  edits that never reached the stream, the catch-up burst and conflict file appearing
  in the tree view at reunion, zero console errors, zero document navigations, and the
  DOM-exposed offset/digest equal to the server head at final convergence. URL cited in
  the Verification log.
- `evidence/` from the recorded cold-start run:
  - `e4-t12-transcript.txt` — the full `make verify-E4-capstone` transcript, including
    the stated `CONVERGENCE_BOUND_S` and per-phase timings.
  - `e4-t12-branch-log.jsonl` — the complete dumped branch metadata log, plus
    `e4-t12-branch-log.sha256`.
  - `e4-t12-digests.txt` — A's `ef tree-digest`, B's `ef tree-digest`, and
    `ef replay --worktree-digest` on the fresh dump, three lines byte-equal, labeled by
    instrument, plus the head offset at final quiescence.
  - `e4-t12-diff-A-vs-B.txt` and `e4-t12-diff-A-vs-replay.txt` — the two convergence
    diffs (`diff -r` A vs B; `diff -r` A vs a fresh `ef materialize` of the dump), both
    empty, with the exact commands that produced them.
  - `e4-t12-journals/` — both sides' `.ef/journal.jsonl` files and both `.ef/`
    head-offset checkpoints at final quiescence.
  - `e4-t12-conflict.txt` — the conflict dossier: the contested path, the base
    revision, both sides' bytes (winner and loser), the offset-named conflict file's
    exact name and SHA-256, the stream offsets of the winning and refused events, and
    the E4-T11 journal records on B.
  - `e4-t12-partition-timeline.txt` — offsets and wall-clock marks for: B stopped, each
    partition-side edit on A (with its append offset), B's local edits (journal seq,
    no offsets yet), B restarted, catch-up complete, final head.
  - `e4-t12-sensitivity.md` — the sabotage transcript (below).

## Acceptance criteria

- [ ] Cold start: `make verify-E4-capstone` exits 0 from a pristine clone via
      `tools/verify/cold_clone.sh` — scrubbed env, fresh server data dir, ephemeral
      port, zero skips — evidence:
      `make verify-E4-capstone 2>&1 | grep -c '^SKIPPED:'` prints `0`, transcript
      committed as `evidence/e4-t12-transcript.txt`.
- [ ] Live convergence within the bound: every phase-1 edit is observed in the opposite
      working tree, byte-exact, within `CONVERGENCE_BOUND_S` seconds of the edit's
      dispatch offset landing — the harness records per-edit latency and the transcript
      states the bound and the observed maximum; an edit that converges only at a later
      phase gate, or a bound stated after the fact to fit the data (the constant must
      be in the committed scenario, not derived from the run), fails.
- [ ] Partition realism: while B's watcher is stopped, the harness proves B received
      nothing (B's `.ef/` head-offset checkpoint is byte-identical before and after A's
      partition-phase edits) and sent nothing (the dump gains no events attributable to
      B's journal during the window) — both assertions in the committed scenario,
      offsets recorded in `evidence/e4-t12-partition-timeline.txt`.
- [ ] Exactly one true conflict, surfaced per E4-T11: on reunion, B's catch-up produces
      exactly one conflict file, named per E4-T11's frozen offset-naming contract,
      whose bytes are byte-identical to B's partition-side version of the contested
      path (SHA-256 recorded in `evidence/e4-t12-conflict.txt`); the contested path
      itself carries the stream winner's bytes on both sides; no other path on either
      side gained a conflict file; nothing was silently dropped — every partition-side
      edit from both machines is accounted for as either a converged path or the
      conflict file.
- [ ] Byte-identical trees: at final quiescence `diff -r <A> <B>` (excluding only
      `.ef/`) exits 0 and is committed as `evidence/e4-t12-diff-A-vs-B.txt`; the
      conflict file is present in both trees and inside the diffed set (it syncs like
      any file per E4-T11).
- [ ] Digest match against replay: A's `ef tree-digest`, B's `ef tree-digest`, and
      `ef replay <fresh dump> --worktree-digest` print the identical lowercase-hex line
      (committed in `evidence/e4-t12-digests.txt`), and a fresh
      `ef materialize <dump> --out <dir>` diffs empty against A
      (`evidence/e4-t12-diff-A-vs-replay.txt`) — the digest agreement is corroborated
      by a byte-level materialize diff, never digests alone.
- [ ] Journal/offset accounting: both sides' committed journals satisfy the E4-T06
      bijection against the committed dump — every accepted journal offset resolves to
      a matching event, every event appended during the run is cited by exactly one
      journal record from exactly one side, and B's journal contains the E4-T11 records
      for the conflict — asserted by the harness on every run, not once by hand.
- [ ] Browser layer: the cited Replay recording (fresh profile, `-o e4-t12-final`)
      shows the E3-T07 viewer across all three phases with zero console errors and zero
      document navigations, where "live" means, checkable at points in the recording via
      the DOM-exposed offset (E3-T02 contract): the offset strictly advances during
      phase 1 (monotonically increasing across sampled points, no reload between them),
      is unchanged for the entire partition window (every sample during B's stopped
      window shows the same offset), jumps at reunion (a strictly larger offset after
      B's restart than at any partition-window sample), and at final quiescence equals
      the final head offset — with the DOM-exposed offset/digest equal to the final head
      offset and digest recorded in `evidence/e4-t12-digests.txt`; the conflict file
      appears in the tree view at reunion. A poll-with-refetch or reload-driven viewer
      fails the zero-navigations check; the offset checks above must hold within the
      single continuous recording. URL cited in the Verification log — `Replay: N/A` is
      not available to a capstone.
- [ ] Sensitivity: `verify-E4-capstone`'s sabotage step runs the scenario in a scratch
      worktree under each of: (a) the conflict-file writing disabled (E4-T11 loser
      dropped) — must redden the conflict-dossier SHA-256 assertion (conflict file
      missing or wrong bytes); (b) B's catch-up started from offset 0 instead of its
      checkpoint — must redden the "exactly one conflict file" count assertion or the
      journal-bijection assertion (an event cited by more than one journal record, or a
      spurious conflict file from re-applying already-seen events); (c) one byte flipped
      in B's working tree after final quiescence, before the verdict assertions run —
      must redden the honest `diff -r <A> <B>` final-diff assertion (this leg proves the
      final-diff assertion points at A vs B, not A vs A: a diff wired A-vs-A stays green
      here and the leg fails to fail, which itself fails the criterion); (d)
      `CONVERGENCE_BOUND_S` set to 0 — must redden the per-edit latency assertion. Each
      leg must go red via its named assertion, and the transcript must show that
      assertion's failure line *before* the corresponding `EXPECTED-FAIL OK` — the
      sabotage driver matches the named assertion's failure output, not merely a nonzero
      exit — evidence:
      `make verify-E4-capstone 2>&1 | grep -c 'EXPECTED-FAIL OK'` ≥ 4, transcript
      (including the four named failure lines) in `evidence/e4-t12-sensitivity.md`.
- [ ] Nothing forked: `verify-E4-sync` (E4-T09) and the full E4-T01…T11 verify targets
      re-run unmodified and green in the same cold clone; all five workspace gates pass
      repo-wide (`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test &&
      pnpm build` exit 0); `make verify-list` maps `verify-E4-capstone` to this task;
      `verify-all` green — evidence: the re-run output (each target name, its exit
      status, and the cold-clone path it ran in) is appended to
      `evidence/e4-t12-transcript.txt` or committed as
      `evidence/e4-t12-rerun-verify.txt`, and "unmodified" is proven in the same
      transcript by a `git diff --stat` over the harness and verify paths (`Makefile`,
      `tools/verify/`, the E4-T09 harness directory) showing empty output inside the
      cold clone before the re-runs.

## Adversarial verification

The claim under attack: "two watched directories on one branch converge live, survive a
partition with exactly one honestly-surfaced conflict, and both equal replay(branch) —
from a cold start, with nothing staged." You are refuting a *demo*, so your first
suspicion is choreography: that the green depends on the builder's timing, seeds, or
leftover state. Use your own machines' worth of directories, your own edit scripts and
seeds, your own partition windows. Any single success refutes.

1. **Cold start or it didn't happen (mandatory).** Run `make verify-E4-capstone` only
   via `tools/verify/cold_clone.sh` on a machine/profile the builder didn't prepare:
   scrub `EF_*`/`REPLAY_*` env beyond what the script scrubs, point `HOME` at a temp
   dir, verify the server data dir is created fresh during the run (`find` it before
   and after). Any dependence on pre-existing state — a pre-created project, a cached
   token, a warm browser profile, a data dir that survives the scrub — refutes the
   cold-start claim outright.
2. **Your own scenario, same skeleton.** Rewrite the edit phases with your own seed:
   more paths, hostile names (unicode, `a/b` vs `a!` ordering traps, near-temp-pattern
   names), rapid bursts faster than the debounce, edits landing on both sides in the
   same second. Keep the one-conflict structure. Converge, then run the full verdict
   yourself: `diff -r`, three digests, materialize-and-byte-diff. Divergence under your
   seed refutes convergence; digest agreement with byte divergence refutes the E4-T01
   apparatus and is filed against it.
3. **Conflict honesty, both directions.** (a) Make the "conflict" not a conflict: have
   B's partition edit land on a path A never touched — a conflict file appearing
   anyway refutes E4-T11 precision. (b) Make it two conflicts, and a conflict where B's
   losing bytes are large/binary — every loser must survive byte-exact in its own
   offset-named file; a truncated, text-normalized, or missing loser refutes. (c) After
   reunion, byte-compare the conflict file against the exact bytes B had on disk at
   partition end (capture them yourself before restart). Any delta refutes "preserved
   byte-exact". (d) Verify the offset in the conflict file's name resolves in your own
   fresh dump to the event it claims — a decorative offset refutes.
4. **Partition forensics.** During the stopped window, snapshot B's `.ef/` bytes and
   the server's head offset repeatedly. Any advance of B's checkpoint, any event in the
   dump traceable to B (journal bijection), or any byte of A's edits appearing in B's
   tree before restart refutes the partition (it means A and B share a channel other
   than the server — check for shared temp dirs, shared journal paths, a harness that
   copies files between the trees to "help" convergence; grep the harness for any
   `cp`/`rsync`/direct-write into the *other* side's tree — one hit refutes the whole
   demo).
5. **Timing attack on the bound.** The bound must be honest: inject load (run the
   scenario with a deliberately slowed downlink poll or under `nice`d CPU contention)
   and confirm the harness *fails red* when convergence genuinely exceeds
   `CONVERGENCE_BOUND_S`, rather than waiting indefinitely and passing. A phase gate
   that blocks until convergence and then reports "within bound" refutes the bound —
   it measures nothing. Then read the committed scenario: the constant must predate the
   run (git history), not be tuned to it.
6. **Kill it mid-demo.** SIGKILL A's watcher mid-phase-1, restart it, and let the
   scenario continue: the final verdict must still hold (T10's catch-up is claimed
   crash-safe; the capstone inherits that claim). A final green that only holds when
   no process ever dies refutes robustness the roadmap paragraph promises implicitly;
   a torn journal or a double-applied event after the kill is filed against
   T07/T10 with this scenario as the repro.
7. **Replay interrogation.** Open the cited recording via the Replay MCP: confirm the
   viewer's DOM offset advances through phase 1, holds flat on stream state during B's
   silence, jumps at reunion, and ends equal to the committed final head; confirm zero
   console errors and zero navigations across the whole timeline; pull network activity
   to confirm live tail (no reload/refetch loop); confirm the conflict file's
   appearance in the DOM tree view at an offset consistent with
   `e4-t12-partition-timeline.txt`. A recording from a warm profile, or one whose
   final DOM digest disagrees with `e4-t12-digests.txt`, refutes the browser claim.
8. **Sabotage beyond theirs.** In a scratch worktree, break it your own ways: (a) echo
   suppression disabled in T08 (the capstone must detect the resulting event storm or
   divergence), (b) B's clone pointed at a different branch, (c) the harness's
   exact-diff assertion made to skip dotfiles. `make verify-E4-capstone` must go red
   under each; any sabotage that stays green refutes the capstone's power to notice.
9. **Evidence provenance.** Re-derive everything committed: replay
   `evidence/e4-t12-branch-log.jsonl` yourself and match `e4-t12-digests.txt`; check
   the journal bijection yourself; confirm the transcript's head offset, the dump's
   length, the timeline's offsets, and the conflict dossier are mutually consistent.
   Committed evidence that cannot be re-derived from the committed dump + scenario, or
   that is internally inconsistent by even one offset, refutes its provenance.

Refutation currency: a byte diff between the two trees or between a tree and the
materialized dump, a conflict loser's missing or altered bytes, an offset in the
evidence that resolves to nothing, a checkpoint that moved during a claimed partition,
a red-under-load bound that passed anyway, or a cold clone that needed warm state.
"Convergence felt slow but passed the bound" is a note, not a finding.

## Verification log

### 2026-08-18 — builder — implemented, evidence incomplete

- Local `node tools/verify/e4_t12_capstone.mjs` passed for the composed live and mixed
  scenarios. Both machine digests and replay digests matched; the mixed scenario emitted
  exactly one conflict event and the recorded loser/conflict bytes matched byte-for-byte
  with SHA-256 `782541010298d382ccf73ea85014c3e59e1da1508c20514b1904690ee8029592`.
- `tools/verify/cold_clone.sh verify-E4-capstone` was started from commit `77e06142` with
  scrubbed environment and lockfile-hydrated dependencies, but the nested runner stopped
  producing a result and was terminated after the wrapper remained waiting. This is not a
  cold-clone pass.
- Replay: N/A (local `tools/replay/preflight.sh` found authenticated Replay Chromium but
  the installed `replayio` package rejected `mcp` with `unknown command 'mcp'`) + mitigation:
  stream evidence is committed above; the mandatory fresh-profile browser recording was not
  claimed.
- Status remains `in-progress`; no critic verification or queue advancement is claimed.

### 2026-08-18 — builder — rework, evidence still under critic review

- `node tools/verify/e4_t12_capstone.mjs --write-evidence` regenerated the committed
  stream fixtures intentionally; the normal verifier now runs in scratch and compares
  its generated stable evidence against the committed files without rewriting them.
- The capstone now records a real head offset (`0000000000000000_0000000000000020`),
  both worktree and reducer-tree digests, and four disposable sabotage runs. Byte,
  delete, stray-file, and swap mutations each failed with a named convergence mismatch;
  the captured failures are in `evidence/e4-t12-sensitivity.md`.
- `tools/verify/cold_clone.sh --keep verify-E4-capstone` passed from a pristine clone at
  `8ee7d85a` after the full build, 64 test files / 609 tests, E4-T09/T10/T11 gates, and
  the T12 capstone. The preserved clone was `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.XPXsFdPihr`.
- The committed-branch browser harness passed with final checkpoint
  `0000000000000000_0000000000000020`, reducer-tree digest
  `03ca5c547f72c97acb5ed50ba4adfdcf591e189fec427076f80ecde3541396c1`, visible offset-named
  conflict file, zero browser console errors, and zero document navigations. Replay MCP
  remains unavailable because the installed CLI rejects `replayio mcp`; this run is
  therefore recorded as `Replay: N/A (local MCP command unavailable) + mitigation: fresh
  Replay Chromium Playwright run, committed transcript, stream dump, materialize digest,
  exact byte diffs, and cold-clone gate`.
- A fresh independent critic found the prior evidence refuted; this rework is not yet
  marked `verified`, and the queue is intentionally not advanced.
- Targeted `node tools/verify/e4_t12_capstone.mjs` and the branch-matched browser harness
  pass. A subsequent broader `make verify-E4-capstone` attempt was stopped upstream by
  `packages/cli/test/uplink.fencing.test.ts` timing out after 608/609 tests passed; no
  T12 verification claim is made from that partial gate.
