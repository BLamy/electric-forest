---
id: E1-T09
epic: 1
title: "Fast-forward merge: a merge event appended when the target has not advanced, typed refusal when it has"
priority: 109
status: pending
depends_on: [E1-T04, E1-T06, E1-T08] # E1-T04 direct edge intentional despite being transitive via E1-T06: this task extends E1-T04's refusal-neutrality contract directly (refused merge leaves no trace), not just through the harness
estimate: M
capstone: false
---

## Goal

`@eforest/streamfs` (`packages/streamfs`, E1-T01's package — its spelling governs where
sibling readmes disagree) gains the easy half of the log-aware merge, and the merge is
**itself one event, never a copy and never a mutation**. `mergeFastForward(repo, target,
source)` goes through the server dispatch door and, when the target has **zero events at
offsets comparing greater than the source's recorded `forkOffset`** (per E0-T03's
`compareOffsets` — the target has not advanced since the fork), appends exactly one
frozen event to the target's metadata stream: `fs.branch.merge { v: 1, sourceStreamId,
forkOffset, mergedThroughOffset }`, where `mergedThroughOffset` is the source's head
offset at merge time, computed server-side. The merge event **adopts** the source's
events: resolution (the same frozen semantics as E1-T08's fork, one implementation) makes
`replay(target)` after the merge equal `replay(target events ≤ forkOffset) ++
replay(source's own events in (forkOffset, mergedThroughOffset])` — so
`treeDigest(replay(target))` post-merge byte-equals `treeDigest(replay(source resolved
per E1-T08))`, provable cold via `ef replay <target-dump> --merge-source <source-dump>
--digest` (a flag delivered here) and live via the E1-T06 harness guts: a tailing client
that watched the target across the merge converges to the same digest. If the target
**has** advanced past `forkOffset`, the dispatch is refused before append through
E0-T11's validator — HTTP 409, `error.class: 'validator-rejected'`, `error.reason:
'fs/merge-not-fast-forward'` — and the target log is untouched: head offset and
`ef replay --digest` dump digest bit-identical before and after the refused attempt.
Three-way merge of the divergent case is E1-T10's job, built on this same event shape.

## Context

E1-T08 gave us branches — fork at an offset, copy-on-write, independent divergence — but
no way back. This task is the first half of the log-aware merge ROADMAP.md promises for
Epic 1 ("branch streams (fork at offset with copy-on-write metadata, log-aware merge:
fast-forward, three-way on patches, conflict surfacing as events)"). E1-T10 reuses the
`fs.branch.merge` envelope for the three-way case, and the E1-T11 capstone's
"merge fast-forward, and digest-verify that `replay(main)` equals the merged tree" is
exactly this task's green path run cold. The adoption model is deliberate: fast-forward
does **not** copy the source's post-fork events into the target (a copy is a second
history that can drift); it appends one event that makes the target's resolved view
include them, exactly as a fork makes a branch's view include its parent's prefix.
Because the merge is one event, atomicity is by construction — there is no multi-event
copy to half-land.

Builds on: E1-T08 (`fs.branch.fork`, resolution semantics, `resolveBranchLog`, CoW
ownership, the frozen fork-offset domain, `ef replay --parent`), E1-T04 (fencing and the
refused-dispatch-leaves-no-trace discipline), E1-T06 (`ef materialize`, the two-client
convergence harness whose parameterized guts this task's live evidence runs on), E0-T11
(validated dispatch), E0-T03 (opaque offsets, `compareOffsets` — no offset arithmetic
anywhere in this task), E0-T04/T12 (`ef replay`, `ef bisect` as citation tools).

Contract frozen here, versioned with the fs envelope (`FS_EVENT_VERSION` history updated;
additive — no existing event shape changes):

- `fs.branch.merge { v: 1, sourceStreamId, forkOffset, mergedThroughOffset }` — appended
  only to a metadata stream, exact fields, no extras. `forkOffset` must equal the
  `forkOffset` recorded in the source's own `fs.branch.fork` event; `mergedThroughOffset`
  is the source's head offset at merge time and must satisfy
  `compareOffsets(forkOffset, mergedThroughOffset) <= 0`.
- **Resolution semantics (adoption)**: a target log containing `fs.branch.merge` resolves
  as target events before the merge event, then the source's **own** events (not the
  source's inherited parent prefix — that prefix *is* the target's own history ≤
  `forkOffset`) at offsets in `(forkOffset, mergedThroughOffset]`, in source order, then
  any later target events. Source events above `mergedThroughOffset` are invisible to the
  target forever — a merge adopts a frozen range, not a moving one. The source stream is
  never written: its head offset and dump digest are byte-identical across the merge.
- **Empty fast-forward is defined**: a source with zero post-fork events merges to a
  single `fs.branch.merge` with `mergedThroughOffset == forkOffset` (adopting the empty
  range); the target's tree digest is unchanged.
- **Door validation, frozen reason codes** (all `validator-rejected`, HTTP 409,
  `error.reason` set; documented next to E1-T08's reason table): `fs/merge-not-fast-forward`
  (any target event at an offset comparing greater than `forkOffset` — including a prior
  merge event), `fs/merge-source-not-found`, `fs/merge-unrelated-source` (the source's
  first event is not an `fs.branch.fork` naming this target as `parentStreamId`),
  `fs/merge-into-self`, `fs/merge-bad-range` (a raw-dispatched `fs.branch.merge` whose
  `forkOffset` mismatches the source's fork record, whose `mergedThroughOffset` is not
  the source's current head, or whose range is inverted). A hand-forged raw `/dispatch`
  of `fs.branch.merge` passes through this same validator — provenance is not trusted,
  fields are checked against actual source state at the door.
- **Refusal neutrality**: every refusal leaves the target *and* source logs untouched —
  no partial append, no refusal marker event, no metadata touch; decided server-side in
  the dispatch door, never client-side.
- **Replay-side validation** (same validator `ef replay` always uses — no second parser):
  `ef replay <target-dump> --merge-source <source-dump> [--parent <dump> ...] --digest`
  resolves `fs.branch.merge` records against supplied dumps matched by `sourceStreamId`.
  Rejected loudly (exit nonzero, stdout 0 bytes): a malformed payload; an inverted range;
  a supplied `--merge-source` whose stream id or fork record contradicts the merge event;
  a source dump missing events the adopted range requires; a merge event positioned where
  the target had already advanced past its `forkOffset` (the replay-time mirror of the
  door check — a dump a fast-forward could never have produced); a dump containing
  `fs.branch.merge` replayed **without** `--merge-source` (silent skip is forbidden).
- **Race discipline**: the not-advanced check and the append are atomic with respect to
  the dispatch door. A target append (fenced per E1-T04 or not) racing the merge yields
  exactly one of two logs: append-then-refused-merge, or merge-then-append. Never both
  events with the merge second.

Non-goals: three-way merge, conflict detection, conflict events (E1-T10); multi-hop
fast-forward chains beyond what the single not-advanced check implies; merging `main`
into a branch (the source must be a fork of the target — anything else is E1-T10's
problem or refused `fs/merge-unrelated-source`); snapshot/compaction interplay beyond
E1-T07's documented `410` path; branch deletion after merge; UI.

## Deliverables

- `packages/streamfs/src/events.ts` (extended) — `fs.branch.merge` payload schema plus
  runtime guards (exact fields, no extras, range ordering via `compareOffsets`); fs
  envelope version history records the additive extension.
- `packages/streamfs/src/merge.ts` — `mergeFastForward(repo, target, source):
  Promise<{ mergeOffset, mergedThroughOffset, treeDigest }>`: reads the source's fork
  record, computes `mergedThroughOffset` from the source head, performs the not-advanced
  check and the single-event append atomically through the door.
- `packages/streamfs/src/resolve.ts` (extended) — `resolveBranchLog` grows merge
  adoption per the frozen semantics; **one** resolution implementation feeds the server
  reducer path, the live tailing client's reducer, and `ef replay --merge-source`.
- Dispatch-door validators for the five frozen reason codes, registered via E0-T11's
  extension point; refusals leave both logs byte-identical.
- `packages/cli` (wherever E0-T04 put `ef`): `ef merge <repo> <target> <source>
  --ff-only` — on success prints exactly two stdout lines (the merge event's offset, the
  target's post-merge tree digest as one lowercase-hex SHA-256 line), exit 0; on refusal
  stdout is exactly 0 bytes, stderr carries the typed rejection JSON, exit nonzero. Plus
  `ef replay --merge-source <dump>` (repeatable), composing with `--parent`, digest
  output format unchanged.
- `packages/streamfs/fixtures/` — committed golden transcript with sibling
  `*.expected.json` (`{ fsEnvelopeVersion, forkOffset, mergedThroughOffset, mergeOffset,
  preMergeTargetDigest, sourceResolvedDigest, postMergeTargetDigest }`): build a tree on
  the target (E1-T01..T04 vocabulary: writes, mkdir, a rename, a tombstone, a patch, one
  fenced stale write refused), fork `feature` at head, edit only `feature` (including a
  CoW write to an inherited file), fast-forward merge back. Plus a refusal fixture: same
  shape but the target advances by one event before the merge attempt.
- `packages/streamfs/test/merge-ff.test.ts` — over real HTTP through `/dispatch`:
  - green path: post-merge target gains exactly one event; it is `fs.branch.merge` with
    the exact expected payload; `ef replay <target-dump> --merge-source <source-dump>
    --digest` byte-equals `ef replay <source-dump> --parent <target-dump> --digest`
    (source resolved per E1-T08) and the committed `postMergeTargetDigest`, in two
    separate node processes (distinct pids printed; harness fails on equal pids);
  - source inviolate: source head offset and dump digest byte-identical across the merge;
  - refusal per reason code: all five frozen codes fired (not-fast-forward with the
    target advanced by one event and by many; unknown source; a source forked from a
    *different* parent; self-merge; a raw-dispatched forged `fs.branch.merge` with a
    lying `forkOffset`, a lying `mergedThroughOffset`, and an inverted range), each
    asserting the exact `error.reason` string, HTTP 409, and before/after byte-equality
    of head offset and dump digest on both streams;
  - empty fast-forward: zero post-fork source events → single merge event,
    `mergedThroughOffset == forkOffset`, target digest unchanged;
  - double merge: an immediate second merge of the same source is refused
    `fs/merge-not-fast-forward` (the first merge event advanced the target);
  - race: a concurrent target append vs. the merge, repeated ≥ 20 interleavings — every
    resulting log is one of the two legal shapes, asserted by replaying it;
  - replay-side rejection: one committed hostile dump per replay-time invariant above,
    each exiting nonzero with stdout 0 bytes through the shared validator.
- `packages/streamfs/test/merge-replay-parity.test.ts` — differential test: for every
  dump in the committed corpus (all hostile dumps plus the golden dumps), runs the shared
  `resolveBranchLog` server path directly and `ef replay` as a subprocess, and asserts
  accept/reject parity — same verdict per dump, and identical tree digest wherever both
  accept.
- Live-watcher evidence path (the T06 guts, parameterized): a harness run where two
  independent client processes tail the **target** live from offset `-1` across the fork,
  the source-side edits, and the merge; both materialize post-merge and three-way-agree
  (client A == client B == `ef materialize` of the server's target dump resolved with
  `--merge-source`) with the committed digest; on mismatch the `ef bisect` line is
  printed.
- `evidence/` — `golden-merged-target.jsonl` + `golden-source.jsonl` (the transcript's
  dumps), `golden-premerge-target.jsonl` (the target's dump taken immediately before the
  merge dispatch — the `--parent` input for the cold equality check), `golden-merged.digest`, `golden-merge-offset.txt` (the merge event's exact
  offset), `refusal-before.jsonl` / `refusal-after.jsonl` (byte-identical pair around the
  refused attempt), `e1-t09-watch.txt` (the live-watcher three-way digest transcript),
  `e1-t09-race.txt` (interleaving outcomes), `e1-t09-sensitivity.md`. Produced once,
  committed; no consuming check regenerates them.
- `Makefile`: `verify-E1-T09` per the E0-T02 target contract — golden replay against the
  committed digest and merge offset, refusal-pair `cmp`, the live-watcher harness run,
  the sensitivity proof, plus re-runs of `verify-E1-T08` and `verify-E1-T06` proving the
  extension is additive; added to `verify-all`, passing `_v-meta` /
  `tools/verify/self_check.sh`.

## Acceptance criteria

- [ ] `make verify-E1-T09` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      with scrubbed env, zero `SKIPPED:` lines; `bash tools/verify/self_check.sh` exits 0
      and `make verify-list` shows E1-T09 covered.
- [ ] Post-merge digest equality, cold: `ef replay evidence/golden-merged-target.jsonl
      --merge-source evidence/golden-source.jsonl --digest` prints exactly one
      lowercase-hex line byte-equal to `evidence/golden-merged.digest` **and** to
      `ef replay evidence/golden-source.jsonl --parent
      evidence/golden-premerge-target.jsonl --digest`
      (the source's E1-T08-resolved tree), in two separate node processes. Evidence:
      committed test comparing process outputs plus the golden files.
- [ ] Post-merge digest equality, live: the harness run tails the target with two
      independent client processes (echoed command lines) across fork → source edits →
      merge; both clients' materialized trees are `diff -r`-empty against each other and
      their digests equal the committed `golden-merged.digest`; transcript committed as
      `evidence/e1-t09-watch.txt`. A mismatch prints an `ef bisect` line and exits
      nonzero.
- [ ] The merge is exactly one event at a knowable offset: the post-merge target log has
      exactly one more record than the pre-merge log; the record at the offset in
      `evidence/golden-merge-offset.txt` is `fs.branch.merge` with payload exactly
      `{ v: 1, sourceStreamId, forkOffset, mergedThroughOffset }` matching the
      transcript's fork record and source head. The Makefile check compares against the
      committed offset and digest files and goes red — not regenerate-and-pass — if
      either is deleted.
- [ ] Source inviolate: the source stream's head offset and dump digest are
      byte-identical before and after the merge (recorded in the green-path test), and
      no stream outside the target's metadata stream gains any event from the merge —
      checked, not assumed: the green-path test enumerates every stream in the repo
      (metadata + all content streams, both branches) and asserts head offsets and dump
      digests are byte-identical before and after the merge for every stream except the
      target's metadata stream, which gains exactly one record.
- [ ] Typed refusal leaves no trace: with the target advanced past `forkOffset`, the
      attempt returns HTTP 409, `error.class: 'validator-rejected'`, `error.reason:
      'fs/merge-not-fast-forward'` (literal), and `cmp evidence/refusal-before.jsonl
      evidence/refusal-after.jsonl` exits 0 — same length, same bytes, same head offset,
      same replay digest. Each of the other four frozen reason codes fires in its own
      test with its own before/after byte-equality check on both streams. The decision is
      server-side: a raw HTTP dispatch bypassing the CLI is refused identically.
- [ ] Replay-side validation: each committed hostile dump (malformed payload, inverted
      range, mismatched `--merge-source`, truncated source range, merge-after-advance
      shape, merge without `--merge-source`) makes `ef replay` exit nonzero with stdout
      exactly 0 bytes, and its stderr rejection JSON has the same shape (same top-level
      fields, `error.class`/`error.reason` present) as every other `ef replay` rejection
      in the suite — asserted by a committed test that collects all rejection outputs and
      checks them against one schema. Cold/server parity: the committed differential
      test `packages/streamfs/test/merge-replay-parity.test.ts` runs the shared
      `resolveBranchLog` server path over every dump in the corpus (hostile and golden)
      and asserts accept/reject parity with `ef replay` — same verdict per dump, and for
      accepted dumps the same digest.
- [ ] Race discipline: the committed race test's ≥ 20 interleavings each produce one of
      the two legal log shapes (append-then-refusal or merge-then-append), zero logs with
      the merge event landing after a post-fork target append — and the criterion is not
      vacuously satisfiable by uncontended runs: `evidence/e1-t09-race.txt` must show
      **both** legal outcomes occurring at least once across the interleavings, or the
      test must force the contended ordering (e.g. a barrier/hook releasing both
      dispatches simultaneously) and record in the evidence file that it did. Twenty
      identical uncontended logs fail this criterion.
- [ ] Empty fast-forward and double merge: zero-post-fork-event merge yields the single
      documented merge event with `mergedThroughOffset == forkOffset` and an unchanged
      target digest; an immediate second merge is refused `fs/merge-not-fast-forward`.
      Evidence: committed cases in `packages/streamfs/test/merge-ff.test.ts` asserting
      the exact merge event payload, digest byte-equality before/after the empty merge,
      and the literal `fs/merge-not-fast-forward` reason string on the second attempt
      (stream layer).
- [ ] CLI contract: on success `ef merge` prints exactly two stdout lines (merge offset,
      post-merge digest) and exits 0; on the golden transcript run, stdout line 1 must
      byte-equal `evidence/golden-merge-offset.txt` and line 2 must byte-equal
      `evidence/golden-merged.digest` — the printed bytes are pinned to the committed
      goldens, not merely counted. On refusal stdout is exactly 0 bytes, stderr is the
      typed rejection JSON, exit nonzero. Evidence: committed CLI test asserting the
      byte-equality against both golden files on the success branch and exact stdout byte
      counts on both branches.
- [ ] Sensitivity proof runs inside `make verify-E1-T09`: (a) one byte flipped in a copy
      of `golden-merged-target.jsonl`'s merge event flips the resolved digest or fails
      the parse; (b) in a scratch worktree, deleting the not-advanced check, and
      separately making resolution adopt the source range `(forkOffset,
      mergedThroughOffset)` exclusive of its endpoint, each turn the suite red;
      transcripts committed as `evidence/e1-t09-sensitivity.md`.
- [ ] No regression: `verify-E1-T08` and `verify-E1-T06` re-run green against this tree,
      and all root gates pass (`pnpm format:check && pnpm lint && pnpm typecheck &&
      pnpm test && pnpm build`).
- [ ] Replay (browser) layer: N/A — server/CLI stream surface, no browser-reaching
      change; declared explicitly per AGENTS.md, with golden digests, the refusal byte
      pair, the watcher transcript, and race outcomes as the stream-layer evidence.

## Adversarial verification

The claim under attack: "fast-forward is one adopting event — after it, the target
replays to the source's exact tree, cold and live; before it, a target that moved makes
the merge a typed 409 that moves nothing." Use your own trees, fork points, and
interleavings throughout; invent at least one more angle.

1. **Digest equality, differentially, cold (mandatory).** From a cold clone build your
   own scenarios with the full E1-T01..T04 vocabulary — rename chains, tombstone +
   recreate, patches, a fenced stale write — fork at offsets you choose (head and the
   empty-target-at-offset-0 degenerate), edit only the source (including a CoW write to
   an inherited file and a delete of one), merge, then compare three digests computed
   your own way: `ef replay <target> --merge-source <source> --digest`, the source
   resolved per E1-T08, and a from-scratch script that never imports `@eforest/streamfs`
   — concatenate target-≤-fork with the source's own post-fork events yourself and
   replay. Any pair differing refutes the adoption semantics; cite the `ef bisect` line
   pinning the first divergent offset. Also `diff -r` the `ef materialize` trees.
2. **Digest equality, live.** Run the watcher evidence path yourself, then sabotage it:
   in a scratch worktree make the live client's merge resolution diverge from the cold
   one (skip adoption, adopt an off-by-one range) — the harness must go red with the
   bisect line; green means the two clients or the cold/live paths are not independent
   and the watcher evidence is theater. Confirm the clients tail **live** across the
   merge (E1-T05 path), not a post-hoc dump copy.
3. **Refusal forensics, byte-level.** Advance the target by one event, by fifty, and by
   an event landing mid-flight (angle 6). After every refused attempt dump target *and*
   source and `cmp` against pre-attempt dumps; tail both streams live during the refusal.
   Refutation: any moved byte, any changed head offset, any emitted frame, any refusal
   decided client-side (raw HTTP accepted where the CLI refused), or any reason code
   other than the exact frozen string for the shape you sent.
4. **Forgery at the door.** Hand-craft raw `/dispatch` `fs.branch.merge` actions:
   `forkOffset` off by one position in the source log (use real neighboring offsets, no
   arithmetic), `mergedThroughOffset` below the source head, above it, equal to
   `forkOffset` when post-fork events exist, an inverted range, a `sourceStreamId` that
   never forked from this target, a self-merge, extra payload fields. Predict each
   outcome before sending. Any accepted lie, wrong code, or trace left refutes. Then the
   one truthful forgery — fields all consistent with actual source state — must be
   accepted and produce a log indistinguishable from `mergeFastForward`'s (replay both;
   digests equal), or provenance is being trusted somewhere.
5. **Hostile dumps at replay.** Forge dumps violating each replay-time invariant: merge
   event before its adopted range exists in the supplied source dump, a second merge
   event adopting the same range, a merge event positioned after a post-fork target
   event, a `--merge-source` for the wrong stream, a merge dump replayed with no
   `--merge-source` at all. Each must be rejected nonzero, stdout 0 bytes, by `ef replay`
   **and** judged identically by the server reducer — one dump the two mouths disagree
   on refutes the shared-validator claim. Flip one byte inside the golden merge event:
   digest must change or parse must fail.
6. **Race the door.** Two concurrent clients: one dispatching target appends (fenced and
   unfenced), one dispatching the merge, many interleavings beyond the builder's 20.
   Replay every resulting log. Refutation: any log where the merge event sits after a
   post-fork target append (the not-advanced check read stale state), any 5xx, any
   half-state. Then merge two different sources forked at the same offset concurrently —
   exactly one may win; the loser must be `fs/merge-not-fast-forward` with zero trace.
7. **Frozen-range and source-mutation hunt.** After a merge, keep appending to the
   source. Re-replay and re-tail the target: any post-`mergedThroughOffset` source event
   leaking into the target's tree, digest, or emitted frames refutes the frozen range.
   Confirm the source's own view never changes across the merge (target events remain
   invisible to it per E1-T08), and that the merge appended nothing source-side.
8. **Self-licking golden.** Inspect the Makefile recipe, tests, and git history: are
   `golden-merged.digest`, `golden-merge-offset.txt`, or the refusal pair ever recomputed
   by the code under test at check time? Delete each and run the consuming checks — red,
   not regenerate-and-pass, or the baseline proves nothing.
9. **Apparatus sabotage.** Not the builder's committed sabotages — your own: make the
   not-advanced check compare with `>=` instead of `>` at the boundary (the empty
   fast-forward must break), make adoption re-encode payloads instead of resolving them
   verbatim, swallow the 409 in the CLI and exit 0. `pnpm test` + `make verify-E1-T09`
   staying green under any of these refutes the suite. Sweep the diff for
   `.skip`/`.todo`/inline lint disables.
10. **Coverage.** Hold the claim's final run against the diff: the green path, all five
    refusal codes, every replay-time rejection, the empty fast-forward, the double
    merge, the race guard, and both CLI exit branches must each have been executed by a
    test or transcript. Unexecuted diff is unproven or dead — the builder picks which,
    you enforce it.

Refutation currency: a dump pair + offset where post-merge replay lies (cite via
`ef bisect`), a byte that moved under a refusal, a source byte that moved under a merge,
a race log with the merge landing second, or a forged event the door swallowed. "Merge
should also delete the source branch" is a design note, not a finding. No refutation →
promote your best forged dump and race interleaving into the committed corpus.

## Verification log
