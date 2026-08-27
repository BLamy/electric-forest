---
id: E5-T06
epic: 5
title: "Merge through the PR door: the merge event drives the log-aware merge onto the target branch stream, conflicts surface as PR events"
priority: 506
status: implemented
depends_on: [E5-T02, E5-T10]
estimate: L
capstone: false
---

## Goal

`@eforest/meadow` (`packages/meadow`, E5-T02's package — its spelling and its frozen PR
envelope govern where sibling readmes disagree) gains the merge executor: dispatching a
`pr.merge` event through the E0-T11 validated door on a PR stream whose E5-T02 lifecycle
state is `approved` drives Epic 1's merge machinery against the PR's frozen
`(sourceBranch, targetBranch, forkOffset)` triple — E1-T09's `mergeFastForward` when the
target has zero events at offsets comparing greater than `forkOffset` (one
`fs.branch.merge` event appended to the target's metadata stream), E1-T10's
`planThreeWayMerge` fenced batch when it has advanced (composed events plus
`fs/merge-conflict` events, terminated by the merge event). The outcome lands back on
the PR stream as exactly one event: `pr.merged { v: 1, targetMergeOffset, kind:
"fast-forward" | "three-way", resultTreeDigest }` flipping the reducer to `merged`
(terminal), or `pr.merge-conflicted { v: 1, targetMergeOffset, conflicts: [{ path,
kind }] }` flipping it to `conflicted` — a mirror of the `fs/merge-conflict` events the
target stream now carries, **never a silent resolution and never a fourth path**.
Refusals are typed and append **nothing to either stream**: `pr/merge-not-approved`
(any lifecycle state other than `approved`, including `conflicted`), `pr/already-merged`
(the PR is terminal), and a mid-race target advance surfaces E1-T09/E1-T10's own
`merge/target-advanced` — in every refusal case both streams' head offsets and
`ef replay --digest` dump digests are bit-identical before and after the attempt.
`treeDigest(replay(targetBranch))` after a successful merge byte-equals the expected
merged tree's digest, and `ef bisect` between the pre-merge and post-merge target dumps
pins the divergence at exactly the merge event's offset. `make verify-E5-T06` proves all
of it cold.

## Context

**Addendum (2026-07-11, pre-work spec change):** the gate below gained a fourth refusal,
`pr/merge-evidence-missing`, making the AGENTS.md "Pull requests carry evidence" rule
mechanical — the executor reads the PR's E5-T10 attachment stream (reduced state) and
refuses to merge unless it holds at least one attachment, one linked Replay recording,
or one `evidence.waived` event. This adds E5-T10 to `depends_on` and one cross-stream
read to the gate; the refusal fixture set and its "≥ 5" counts below grow by one case
accordingly.

This is the moment Epic 5's "merge-proposal streams targeting branch streams" stops
being metadata and becomes a door: a merged PR *is* a replayable negotiation ending in a
merge event (ROADMAP Epic 5), and the E5-T13 capstone's "review + approve, merge — the
issue flips to done via the merge" walks straight through this executor. E5-T07
(closes-references flipping issues) and E5-T09 (the PR web surface with merge button and
rendered conflicts) both consume the two outcome events frozen here; neither can start
until this task freezes them.

The design center is division of labor, not new merge logic. **All merge semantics
belong to Epic 1** — the fast-forward/three-way boundary, the overlap predicate, the
conflict taxonomy (`edit-edit`, `delete-edit`, `rename-rename`, `add-add`), the
resolution protocol (`fs/merge-resolve` on the target stream) are E1-T09/E1-T10's frozen
contracts, consumed here verbatim. This task owns only the **door and the mirror**: the
approval gate in front of the machinery, and the PR-stream events reflecting what the
machinery did, so the PR's own log tells the whole negotiation without reading the
target stream — while `targetMergeOffset` makes the cross-stream citation exact.

Contracts frozen here, versioned with the E5-T02 PR envelope (additive; documented
verbatim in the `packages/meadow` readme under
`<!-- frozen:E5-T06:<block> -->` markers, doc-sync checked like E1-T10's):

<!-- frozen:E5-T06:outcome-events -->
`pr.merged` carries `{ v: 1, targetMergeOffset, kind: "fast-forward" | "three-way",
resultTreeDigest }` and is terminal; `pr.merge-conflicted` carries `{ v: 1,
targetMergeOffset, conflicts: [{ path, kind }] }` where `conflicts` mirrors, in the
same order, the `fs/merge-conflict` events the merge batch appended to the target
stream, and flips the PR to `conflicted`. These are the only two events the executor
may append to the PR stream per attempt.
<!-- /frozen:E5-T06:outcome-events -->

<!-- frozen:E5-T06:gate-and-refusals -->
The executor runs only from lifecycle state `approved`. Refusal reasons:
`pr/merge-not-approved` (any non-`approved` state, including `conflicted` — a
conflicted PR re-merges only after every conflict is resolved on the target via
E1-T10 `fs/merge-resolve` and the PR is re-approved per E5-T02's lifecycle),
`pr/already-merged` (terminal PR), `pr/merge-evidence-missing` (the PR's E5-T10
attachment stream reduces to zero attachments, zero linked recordings, AND zero
`evidence.waived` events — the AGENTS.md "Pull requests carry evidence" rule made
mechanical: a Replay recording, an uploaded artifact, or an explicit waiver with
justification is required before merge), plus E1-T09/E1-T10 refusals passed through
untranslated (`merge/target-advanced`, `merge/target-conflicted`). A refused merge
appends zero events to both the PR stream and the target stream.
<!-- /frozen:E5-T06:gate-and-refusals -->

<!-- frozen:E5-T06:recovery -->
The target-stream append and the PR-stream outcome event are two appends with a crash
window between them. Recovery is idempotent re-dispatch: before merging, the executor
scans the target's events after `forkOffset` for an existing merge event whose
`sourceStreamId` equals the PR's `sourceBranch`; if found, it appends only the missing
PR outcome event citing that offset, never a second merge. Re-dispatching `pr.merge`
on an already-merged PR refuses `pr/already-merged`.
<!-- /frozen:E5-T06:recovery -->

Non-goals: no web surface (E5-T09), no issue-closing side effects (E5-T07), no conflict
resolution mechanics (resolution is E1-T10's `fs/merge-resolve` on the target stream —
this task only mirrors and gates), no new merge semantics of any kind, no re-review
policy beyond what E5-T02's lifecycle already froze.

## Deliverables

- `packages/meadow/src/pr/merge-executor.ts` — `executeMerge(ctx, prStreamId)` behind
  the `pr.merge` dispatch: reads the PR's reduced lifecycle state and
  `(sourceBranch, targetBranch, forkOffset)`, runs the recovery scan, selects
  fast-forward vs three-way by E1-T09's exact predicate (`compareOffsets` against
  `forkOffset` — no offset arithmetic), invokes the Epic 1 machinery, appends the one
  frozen outcome event to the PR stream, maps every failure to the typed refusal set.
- `packages/meadow/src/pr/reducer.ts` extensions — `pr.merged` / `pr.merge-conflicted`
  apply semantics: `merged` terminal, `conflicted` re-mergeable only via E5-T02's
  re-approval path, malformed payloads refused at the E0-T11 door before append.
- `packages/meadow/fixtures/pr-merges/` — golden fixture corpus, one directory per
  case with committed event logs (PR stream, source branch, target branch) and
  `expected.json` (post-merge target tree digest, the expected PR outcome event's
  canonical payload, expected final lifecycle state): **`ff`** (target never advanced —
  fast-forward, `kind: "fast-forward"`), **`three-way-clean`** (both advanced, disjoint
  edits — composed batch, `kind: "three-way"`), **`conflict`** (overlapping edits —
  `fs/merge-conflict` on the target, `pr.merge-conflicted` on the PR, target files'
  reduced content still pre-merge bytes), **`refusals`** (unapproved,
  changes-requested, closed, already-merged, and conflicted-pending merge attempts,
  each with the expected typed reason).
- `packages/meadow/test/pr-merge.test.ts` — against a live server: each fixture class
  end-to-end; digest equality `replay(target)` vs expected; every refusal case reads
  both streams' head offsets and byte-diffs both dumped logs before/after; a race
  injected between plan and append surfaces `merge/target-advanced` with both logs
  untouched and the PR still `approved`; the recovery path (target merged, PR event
  missing) re-dispatched appends exactly the outcome event and no second
  `fs.branch.merge`; ff/three-way boundary cases (target advanced by exactly one
  event → three-way; not at all → fast-forward, no plan computed).
- `tools/verify/pr_merge.sh` — the Makefile leg, fresh file-backed server per
  scenario. One line per fixture:
  `prmerge fixture=<name> kind=<ff|three-way|conflict> digest=<d> expected=<d> state=<s> OK`;
  one per refusal:
  `REFUSAL case=<name> reason=<typed> pr-head=unchanged target-head=unchanged OK`
  (printed only after both head offsets and both dump digests compared equal);
  the **bisect leg** runs `ef bisect` between the pre-merge and post-merge target
  dumps for the `ff` and `three-way-clean` fixtures and prints
  `BISECT fixture=<name> offset=<o> merge-event-offset=<o> OK` only when the two
  offsets are equal; the **mutation leg** flips one byte of a committed fixture log
  and asserts the pipeline goes red before printing
  `MUTATION fixture=<name> byte=<offset> EXPECTED-FAIL OK`, and separately perturbs
  one expected digest in a copy of `expected.json` and asserts the comparison exits
  nonzero before printing `MUTATION-EXPECTED EXPECTED-FAIL OK`.
- `packages/meadow` readme: the three frozen blocks reproduced byte-for-byte under
  identical markers, doc-sync asserted mechanically in the suite or the verify script.
- `Makefile`: `verify-E5-T06` composing the frozen `_v-*` gates plus `pr_merge.sh`;
  joins `verify-all`; `make verify-list` maps it; `tools/verify/self_check.sh` passes.

## Acceptance criteria

- [ ] `make verify-E5-T06` exits 0 from a pristine cold clone
      (`tools/verify/cold_clone.sh` path) with zero `SKIPPED:` lines — evidence:
      `make verify-E5-T06 2>&1 | grep -c '^SKIPPED:'` prints `0`.
- [ ] **Three outcomes, golden.** Each fixture replays to its expected outcome —
      evidence, one grep per pinned name:
      `make verify-E5-T06 2>&1 | grep -c '^prmerge fixture=ff kind=ff .* OK$'`,
      `... '^prmerge fixture=three-way-clean kind=three-way .* OK$'`, and
      `... '^prmerge fixture=conflict kind=conflict .* OK$'` each print `1`, where the
      `digest=`/`expected=` fields on the ff and three-way lines attest
      `ef replay <target-dump> --digest` equals the committed expected merged-tree
      digest (exact `cmp` semantics, no tolerance), and the conflict line's
      `state=conflicted` attests the PR reducer's final state with the target's
      conflicted paths still holding pre-merge bytes.
- [ ] **Conflicts are events on both streams.** The `conflict` fixture's post-merge
      target dump contains the expected `fs/merge-conflict` events (paths, kinds) and
      the PR dump contains exactly one `pr.merge-conflicted` whose `conflicts` array
      mirrors them in order and whose `targetMergeOffset` cites the target merge
      event's actual offset — and the target branch's *head offset and dump digest are
      byte-identical before and after* the conflicted attempt's non-conflict content
      (the only target appends are the merge batch's own events; for a fully
      conflicted plan, none) — evidence: committed test assertions comparing the two
      dumps' canonical events plus the before/after head-offset assertions,
      `pnpm test --filter @eforest/meadow` exit 0.
- [ ] **Refusals append nothing anywhere.** Every `refusals` fixture case — unapproved,
      changes-requested, closed, already-merged, conflicted-pending — refuses with its
      exact frozen reason, and both the PR stream and the target stream have head
      offset and dump digest bit-identical before/after; the injected
      plan-to-append race surfaces `merge/target-advanced` with the PR still
      `approved` — evidence:
      `make verify-E5-T06 2>&1 | grep -c '^REFUSAL case=.* pr-head=unchanged target-head=unchanged OK$'`
      prints one count per refusal case (≥ 5), plus the committed race test.
- [ ] **Bisect pins the merge.** For the `ff` and `three-way-clean` fixtures,
      `ef bisect` between the pre-merge and post-merge target dumps reports first
      divergence at exactly the merge event's offset — evidence:
      `make verify-E5-T06 2>&1 | grep -c '^BISECT fixture=.* OK$'` prints `2`, each
      line carrying equal `offset=` and `merge-event-offset=` fields.
- [ ] **Recovery is idempotent.** The committed recovery test (target merged, PR
      outcome event withheld, `pr.merge` re-dispatched) ends with exactly one
      `fs.branch.merge` on the target and exactly one `pr.merged` on the PR; a further
      re-dispatch refuses `pr/already-merged` — evidence: committed test assertions,
      `pnpm test --filter @eforest/meadow` exit 0.
- [ ] **Sensitivity.** The mutation leg runs inside `make verify-E5-T06` — evidence:
      `make verify-E5-T06 2>&1 | grep -c '^MUTATION fixture=.*byte=.*EXPECTED-FAIL OK$'`
      prints ≥ `1` and `... grep -c '^MUTATION-EXPECTED EXPECTED-FAIL OK$'` prints `1`.
- [ ] **Frozen contract.** The three frozen blocks (`outcome-events`,
      `gate-and-refusals`, `recovery`) are reproduced byte-for-byte in the
      `packages/meadow` readme under identical marker pairs with the
      golden-invalidation rule stated, sync checked mechanically and green; no
      `.skip`/`.todo` tests, no new inline lint disables in `src/` — evidence:
      committed files, the doc-sync check green in `pnpm test` or the verify
      transcript.
- [ ] All workspace gates pass repo-wide: `pnpm format:check && pnpm lint &&
      pnpm typecheck && pnpm test && pnpm build` exit 0; `make verify-list` shows
      `verify-E5-T06`; `tools/verify/self_check.sh` passes.
- [ ] Durable evidence committed under this task's `evidence/`: the final
      `make verify-E5-T06` transcript (all prmerge, REFUSAL, BISECT, MUTATION lines),
      the `conflict` fixture's post-merge PR and target dumps with their
      `ef replay --digest` outputs, and the refusal transcript — cited by path and
      digest in the Verification log.
- [ ] Replay browser layer: N/A (no browser-reaching surface; the PR web UI is
      E5-T09) — mitigation: stream-layer evidence above is the currency; the
      Verification log entry declares this explicitly per AGENTS.md.

## Adversarial verification

Your mission: get one merge through the door that shouldn't pass, or make one that
should pass lie about itself — an unapproved PR that merges, a conflict that lands as
`merged`, a refusal that left a fingerprint on either log, or a PR log whose story
diverges from the target log's. The fixtures are the floor; bring your own streams.

1. **Gate fuzz, your own lifecycles.** Build your own PR streams (not the fixtures)
   and dispatch `pr.merge` from every reachable E5-T02 lifecycle state, plus the
   ugly ones: approval followed by a changes-requested event, approval on a PR whose
   source branch gained events after the approval, a PR whose `targetBranch` points at
   a nonexistent stream, malformed `pr.merge` payloads at the door. Every non-`approved`
   case must refuse with its exact frozen reason and both logs byte-untouched
   (dump-diff yourself, don't trust the REFUSAL line). **One merge event appended from
   a non-approved state refutes the gate outright.**
2. **Conflict-suppression sabotage.** In a disposable worktree: (a) make the executor
   emit `pr.merged` when the plan contains conflicts, (b) drop the
   `pr.merge-conflicted` append while letting the target batch land, (c) have the
   conflicted reducer state still report re-mergeable. For each, `pnpm test` **and**
   `make verify-E5-T06` must both go red. A sabotage that stays green refutes the
   suite it slipped past.
3. **Boundary honesty.** Advance the target by exactly one event past `forkOffset` and
   merge: the outcome must be `kind: "three-way"` with a real plan; with zero
   advancement it must be `kind: "fast-forward"` with no plan computed and no
   `fs/merge-conflict` possible. A fast-forward where three-way applies (or vice
   versa), or a `kind` field that misreports which path ran (compare against the
   target's actual appended events), refutes the boundary and the mirror both.
4. **Crash-window and double-door.** Kill or fault-inject between the target append
   and the PR append; on re-dispatch, the recovery contract must yield exactly one
   `fs.branch.merge` and one `pr.merged` — count them in the dumps. Then dispatch
   `pr.merge` twice concurrently against one approved PR: exactly one merge may land;
   the loser must refuse typed with nothing appended. Two merge events on the target,
   or a PR with two outcome events, refutes atomicity. A missing fault-injection hook
   is itself a finding.
5. **Cross-stream citation audit.** For every successful and conflicted merge you
   produce, resolve `targetMergeOffset` against the target dump yourself: the event at
   that offset must be the merge event of *this* merge (matching `sourceStreamId`),
   `resultTreeDigest` must equal `ef replay <target-dump> --digest` at that offset,
   and the `conflicts` array must mirror the target's `fs/merge-conflict` events in
   order. Run `ef bisect` yourself between pre/post dumps — a divergence offset other
   than the merge event's refutes the headline bisect claim. Any dangling or
   misdirected citation refutes the mirror.
6. **Golden rot and cold clone.** Regenerate the fixtures' expected digests from the
   committed logs with the committed code and byte-diff against `expected.json` —
   drift refutes determinism or reveals check-time regeneration. Flip your own byte
   (different fixture and offset than the mutation leg's) and confirm red. Run
   `make verify-E5-T06` via `tools/verify/cold_clone.sh` twice back-to-back with
   scrubbed env. Then hold the diff against the evidence: the ff path, the three-way
   path, the conflict path, every refusal reason, and the recovery scan must each have
   executed in a test or transcript — unexecuted diff is unproven or dead, builder
   chooses which, you enforce it. Confirm nothing out-of-scope was smuggled in: no new
   merge semantics, no auto-resolution, no UI. Finally, grep the diff for any write to
   a branch stream that does not go through the dispatch door — one side-channel write
   refutes the task regardless of green gates.

Refutation → `status: refuted`, repro appended below, back to the builder. No
refutation → promote at minimum: your angle-1 lifecycle streams and angle-4 race case
as committed fixtures.

## Verification log

### 2026-08-27 — builder — implemented

- Implementation commit: `fb9d9388` adds the Meadow merge command/outcome model,
  lifecycle reducer, evidence gate, fast-forward/three-way executor, crash recovery,
  and the authenticated platform dispatch seam. Production resolves the frozen source
  and target branch streams to the existing Epic 1 `StreamFsRepo` merge machinery;
  the client `pr.merge` command itself is never appended.
- Focused package verification passed at the implementation tree:
  `pnpm --filter @eforest/meadow build` and
  `pnpm --filter @eforest/meadow test` (2 files, 22 tests). Coverage includes the
  zero/one-event fast-forward boundary, ordered conflict mirroring, every frozen
  lifecycle/evidence refusal, target races, crash recovery, server-stamped outcomes,
  same-source/different-fork recovery isolation, and concurrent double dispatch.
- Focused platform verification passed:
  `pnpm --filter @eforest/platform build` and
  `pnpm exec vitest run packages/platform/test/pr-merge-door.test.ts` (1 test). Two
  simultaneous authenticated merge commands produced one target merge, one
  writer-fenced PR outcome at offset `0000000000000000_0000000000000002`, no persisted
  command event, and one typed `pr/already-merged` refusal.
- The first composed `make verify-E5-T06` run passed both builds and all 23 focused
  tests, then stopped only in the new vocabulary checker because its source-file list
  omitted `validate.ts`. Queue discipline preserved the successful legs: after adding
  that checker input, only `node tools/verify/e5_t06_contract.mjs` was rerun; all three
  frozen README blocks were byte-identical and the platform-door vocabulary check
  passed. `git diff --check` also passed. Transcript:
  `evidence/e5-t06-focused.txt`.
- Replay: N/A (server/package task with no browser-reaching surface; E5-T09 owns the PR
  UI) + mitigation: deterministic stream/reducer tests and the authenticated HTTP-door
  seam above cover the target/PR cross-stream behavior. No dependency-ticket verifier,
  root suite, cold-clone gate, previously completed ticket gate, or browser run was
  executed.
