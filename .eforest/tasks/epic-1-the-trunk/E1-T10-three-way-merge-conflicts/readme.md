---
id: E1-T10
epic: 1
title: Three-way merge on patches with conflicts surfaced as events, never silently resolved
priority: 110
status: pending
depends_on: [E0-T11, E1-T01, E1-T02, E1-T03, E1-T04, E1-T09]
estimate: L
capstone: false
---

## Goal

`packages/stream-fs` (`@eforest/stream-fs`) merges genuinely divergent branch histories:
when the target has advanced past the fork point (E1-T09's fast-forward refusal case),
`merge(source, target)` replays **both** sides from the fork-point base and produces a
**merge plan** — a pure function of `(baseTree, oursEvents, theirsEvents)` — that is
appended to the target as one atomic, fenced batch. Per file: edits touching disjoint
regions of the same base compose deterministically into ordinary frozen content events
(E1-T03 `fs/patch` / full-write) followed by a closing `fs/merge` event recording
`{ sourceStream, sourceHead, baseOffset, kind: "three-way", resultTreeDigest,
conflicts }`; **overlapping** edits (intersecting base byte spans, same-position inserts,
delete-vs-edit, divergent rename-vs-rename) each append an `fs/merge-conflict` event
carrying the base content plus both sides in full (`{ path, kind, mergeId,
base: {digest, content}, ours: {digest, content}, theirs: {digest, content} }`), leaving
the path **conflicted** in reduced state — its content stays the target's pre-merge
bytes, and every non-resolution write to it is refused typed
(`merge/path-conflicted`) until an `fs/merge-resolve` event
(`{ path, mergeId, content, resultDigest }`) clears it. Rename-on-one-side plus
edit-on-the-other composes cleanly — renames are explicit E1-T02 events, so the edit
deterministically lands at the renamed path; nothing is ever inferred. An **aborted
merge appends nothing**: the plan is computed offline and appended with E1-T04 fencing
anchored at the observed target head — a racing target append yields E1-T09's typed
`merge/target-advanced` refusal with the head offset unchanged, as does `--dry-run` and
merging into a target with unresolved conflicts (`merge/target-conflicted`). The overlap
rule, conflict taxonomy (`edit-edit`, `delete-edit`, `rename-rename`,
`add-add`), event payload shapes, and resolution protocol are **frozen here** under the
E1-T01 fs envelope — changing them invalidates this task's golden merge fixtures.
`make verify-E1-T10` proves it end-to-end: the committed fixture corpus replays to
golden digests or exact expected conflict events, the same merge run twice from fresh
servers yields byte-identical event batches and digests, and a committed fuzz corpus of
concurrent edit interleavings shows every clean merge digest-matching an independent
oracle and every overlap surfacing as conflict events — **no silent wrong merge, ever**.

## Context

This is the divergent-history half of bet 2 ("branches are forks of the log; merge is
log-aware — replay both sides from the fork point"). E1-T08 gave us branch streams with
`(parent, forkOffset)`; E1-T09 gave us the trivial merge (fast-forward when the target
never moved, typed refusal when it did). This task answers the refusal: both sides
moved, and the merge must either compose their edits deterministically or say so out
loud. It is the substrate for Epic 5's pull requests (a merged PR *is* a replayable
negotiation ending in a merge event) and Epic 4's watcher conflict surfacing ("the
stream is the arbiter; local losers are preserved") — both inherit the conflict taxonomy
and resolution protocol frozen here.

The design center is the headline invariant: **a conflict is an event, never a
judgment call**. The merge planner has exactly three outputs per file — clean composed
events, a conflict event carrying all three versions, or (merge-level) a refusal that
appends nothing. There is no fourth path where the system quietly picks a side. The
E1-T03 patch op grammar makes this checkable: ops address explicit byte spans over an
explicitly-digest-anchored base, so "overlapping" is a decidable predicate over base
coordinates, not a heuristic — the frozen `overlap-predicate` block below states the
rule verbatim.

The four frozen blocks below are the byte-level source of truth for the doc-sync
check in the Frozen contract acceptance criterion. Each is delimited by a
`<!-- frozen:E1-T10:<block> -->` / `<!-- /frozen:E1-T10:<block> -->` marker pair; the
text between each pair must be reproduced byte-for-byte in the `packages/stream-fs`
readme under identical markers.

<!-- frozen:E1-T10:overlap-predicate -->
Two same-file edits conflict iff their base-coordinate spans intersect, or both
insert at the same base position, or one deletes the file the other patches, or both
add the same path with different content (`add-add`), or both rename the same file to
different names. Disjoint-span edits compose by rebasing theirs' ops through ours'
offset shifts — deterministic, order-fixed (ours' events replay first, then composed
theirs), and digest-verified against `resultDigest` on every emitted event just like
any E1-T03 patch.
<!-- /frozen:E1-T10:overlap-predicate -->

<!-- frozen:E1-T10:conflict-taxonomy -->
The conflict taxonomy is the closed set of `fs/merge-conflict` `kind` values:
`edit-edit`, `delete-edit`, `rename-rename`, `add-add`.
<!-- /frozen:E1-T10:conflict-taxonomy -->

<!-- frozen:E1-T10:payload-shapes -->
Event payload shapes: `fs/merge` carries `{ sourceStream, sourceHead, baseOffset,
kind: "three-way", resultTreeDigest, conflicts }`; `fs/merge-conflict` carries
`{ path, kind, mergeId, base: {digest, content}, ours: {digest, content},
theirs: {digest, content} }`; `fs/merge-resolve` carries
`{ path, mergeId, content, resultDigest }`.
<!-- /frozen:E1-T10:payload-shapes -->

<!-- frozen:E1-T10:resolution-protocol -->
A path with a pending `fs/merge-conflict` stays conflicted in reduced state — its
content stays the target's pre-merge bytes — and every content mutation to it is
refused typed `merge/path-conflicted` until a matching `fs/merge-resolve` (validated:
`mergeId` matches, `resultDigest` matches the resolved content) clears it. Resolution
is always an explicit event with explicit content; there are no auto-resolution
strategies.
<!-- /frozen:E1-T10:resolution-protocol -->

Contracts frozen here (documented verbatim in the package readme, enforced by tests):

- **Base = fork point.** The three-way base is the target tree at the branch's recorded
  `forkOffset` (E1-T08), obtained by replay — never a search, never a heuristic
  common-ancestor. `oursEvents` = target events after `forkOffset`; `theirsEvents` =
  source branch events.
- **Plan purity.** `planThreeWayMerge(baseTree, oursEvents, theirsEvents): MergePlan`
  is pure and deterministic: same inputs → byte-identical canonical plan. No time,
  randomness, env, or iteration-order dependence.
- **Atomicity.** The plan lands as a single fenced batch (E1-T04 `Stream-Seq` anchored
  at the observed target head) terminated by the `fs/merge` event. Refused batch ⇒
  zero events appended, head unchanged, typed error. There is no partial merge state
  on the log.
- **Conflicted-state gate.** A path with a pending `fs/merge-conflict` refuses every
  content mutation except a matching `fs/merge-resolve` (validated: `mergeId` matches,
  `resultDigest` matches the resolved content). Reduced state exposes the conflict
  (path → `{conflicted: true, mergeId, kind}`); the canonical tree digest **includes**
  the conflicted flag so a conflicted tree can never digest-equal a clean one.
- **Abort appends nothing.** `--dry-run`, `merge/target-advanced`,
  `merge/target-conflicted`, and any plan-time error all leave both streams'
  head offsets byte-identical to before the call.

Non-goals: no auto-resolution strategies (no "ours"/"theirs" flags — resolution is
always an explicit event with explicit content), no cross-file semantic conflicts, no
PR/review surface (Epic 5), no CLI working-tree conflict markers (Epic 4). Dependency
convention: `depends_on` lists every **direct contract dependency** — tasks whose
frozen contracts this spec builds on by name — even when they are transitively implied
by another listed dependency. Hence E0-T11 (the validated dispatch door the new
conflict/resolve payloads are wired through — a named deliverable requirement),
E1-T01 (the fs event envelope the payload shapes frozen here live under),
E1-T02 (explicit rename events — the `rename-vs-edit` clean-compose fixture, a frozen
proof, is built directly on that contract), E1-T03 (patch op grammar and digest
anchoring), E1-T04 (`Stream-Seq` fencing — the Atomicity contract above is built
directly on it), and E1-T09 (the `fs/merge` event, merge entry point, and refusal
plumbing this task extends) are all listed, while E1-T08 is not: this task consumes
no E1-T08 contract directly — its branch metadata arrives only through E1-T09.

## Deliverables

- `packages/stream-fs/src/merge/plan.ts` — `planThreeWayMerge(baseTree, oursEvents,
  theirsEvents): MergePlan` — pure; returns the ordered composed events, the conflict
  events, and the closing `fs/merge` payload. `MergePlan` is canonically encodable so
  determinism is byte-checkable.
- `packages/stream-fs/src/merge/compose.ts` — span algebra over E1-T03 ops:
  `opSpans(ops)` (base-coordinate spans touched), `spansOverlap(a, b)` (the frozen
  overlap predicate, including same-position inserts), and `rebaseOps(theirs, ours)`
  (deterministic composition for disjoint spans) — each pure, each property-tested.
- `packages/stream-fs/src/merge/three-way.ts` — the driver extending E1-T09's merge
  entry point: reads `forkOffset`, replays base/ours/theirs, plans, appends the fenced
  batch, maps every failure to the typed refusal set (`merge/target-advanced`,
  `merge/target-conflicted`, plus plan-time validation errors). Supports `dryRun`.
- Reducer + dispatch-door extensions: `fs/merge-conflict` and `fs/merge-resolve` apply
  semantics, the conflicted-state gate (`merge/path-conflicted` refusal), conflicted
  flag folded into the canonical tree digest, all wired through the E0-T11 validated
  dispatch door so malformed conflict/resolve payloads never reach the log.
- `packages/stream-fs/fixtures/merges/` — the committed merge-fixture corpus. Each
  fixture: `base.events.jsonl` (shared history to the fork point), `ours.events.jsonl`,
  `theirs.events.jsonl` (frozen divergent legs), and `expected.json` — for clean
  fixtures the golden post-merge tree digest and the golden composed event batch
  (canonical bytes, offsets excluded); for conflicting fixtures the exact expected
  `fs/merge-conflict` events (path, kind, all three digests) and the post-merge digest
  with conflicts pending. Minimum fixtures, under these exact directory names:
  **`clean-disjoint`** (disjoint edits to the same file + edits to different files),
  **`conflict-spans`** (intersecting spans and a same-position insert pair),
  **`delete-vs-edit-a`** / **`delete-vs-edit-b`** (each direction),
  **`rename-vs-edit`** (clean: the edit lands at the renamed path — this fixture is
  the frozen proof renames compose), **`rename-vs-rename`** (conflict), and
  **`add-add`** (same path, different content — conflict; identical content — clean).
  Plus one **`resolution`** fixture: a conflicting merge followed by
  `fs/merge-resolve` events replaying to a golden clean digest.
- `packages/stream-fs/fixtures/fuzz/merge-interleavings/` — the committed fuzz corpus:
  seeded generator output (seeds committed) of concurrent edit-sequence pairs over
  shared base files, each case a JSON record of `(base, oursEdits, theirsEdits)` plus
  the oracle's verdict (`clean` with expected merged bytes per file, or `conflict`
  with expected paths+kinds). ≥ 200 cases covering every taxonomy kind and clean
  composition at span boundaries (adjacent-but-disjoint spans must merge clean).
- `packages/stream-fs/test/merge.plan.test.ts` — span algebra accept/conflict matrix
  (adjacent spans clean, off-by-one intersections conflict, same-position inserts
  conflict), rebase byte-exact vectors including multi-byte UTF-8 boundaries, taxonomy
  coverage per kind, plan purity (two calls → byte-identical canonical plans).
- `packages/stream-fs/test/merge.lifecycle.test.ts` — against a live server: full
  merge appends the exact fixture batch; conflicted path refuses writes typed with
  head unchanged; resolve clears the gate and replays to the golden digest; dry-run,
  target-advanced (race injected between plan and append), and target-conflicted each
  append nothing (head offset read before/after, byte-equal); a second merge of the
  same source into an already-merged target fast-forwards or no-ops per E1-T09,
  never re-conflicts.
- `packages/stream-fs/test/merge.fuzz.test.ts` — replays the committed interleaving
  corpus through real merges: every `clean` case's merged file bytes equal the
  oracle's expected bytes and the tree digest is verified; every `conflict` case
  yields exactly the expected conflict events; **zero cases** land clean with bytes
  differing from the oracle.
- `tools/verify/three_way_merge.sh` — the Makefile leg: boots a fresh file-backed
  server per scenario; replays every fixture and prints one line each — for clean
  fixtures `fixture=<name> digest=<d> expected=<d> batch=match conflicts=<n> OK`,
  where the `batch=match` field may only be printed after the appended batch has been
  canonically byte-compared against the committed golden batch and found equal (digest
  equality alone must not produce it); for conflicting fixtures
  `fixture=<name> digest=<d> expected=<d> conflicts=<n> OK`; the
  **determinism leg** runs one clean and one conflicting fixture merge twice from
  scratch servers and asserts byte-identical event batches and digests, printing
  `DETERMINISM fixture=<name> class=clean OK` for the clean fixture and
  `DETERMINISM fixture=<name> class=conflict OK` for the conflicting one (the
  `class=` field is frozen into the line format so the clean/conflicting requirement
  is grep-checkable); the same leg then proves its own comparator: it
  perturbs one byte of a copy of the second batch, runs the identical byte-comparison
  against the unperturbed first batch, asserts the comparator exits nonzero, and only
  then prints `DETERMINISM-SENSITIVITY EXPECTED-FAIL OK` (mirroring the mutation-leg
  pattern); the **mutation leg** flips one byte inside one
  committed fixture leg and asserts replay/merge goes red (nonzero observed before
  printing `MUTATION fixture=<name> byte=<offset> EXPECTED-FAIL OK`), and additionally
  perturbs one byte of a copy of one clean fixture's committed golden batch, runs the
  batch byte-comparison against the real appended batch, asserts it exits nonzero
  (proving the `batch=match` comparator's red path, not just the digest comparator's),
  and only then prints
  `MUTATION-BATCH fixture=<name> byte=<offset> EXPECTED-FAIL OK`; the **fuzz leg**
  runs the committed corpus and prints `FUZZ cases=<n> clean=<n> conflict=<n> OK`,
  then proves its own comparator: it perturbs one oracle expectation (or one case's
  expected bytes) in a copy of the corpus, asserts the comparison exits nonzero, and
  only then prints `FUZZ-SENSITIVITY EXPECTED-FAIL OK`.
- `Makefile`: `verify-E1-T10` in the marker section composing the frozen `_v-*` gates
  plus `three_way_merge.sh`; joins `verify-all`; `make verify-list` maps it;
  `tools/verify/self_check.sh` still passes.

## Acceptance criteria

- [ ] `make verify-E1-T10` exits 0 from a pristine cold clone
      (`tools/verify/cold_clone.sh` path) with zero `SKIPPED:` lines — evidence:
      `make verify-E1-T10 2>&1 | grep -c '^SKIPPED:'` prints `0`.
- [ ] **Fixture corpus.** Every committed fixture under `fixtures/merges/` merges to
      its expected outcome: clean fixtures' post-merge `ef replay --digest` equals the
      committed golden digest and the appended batch canonically byte-equals the
      committed golden batch, attested by the `batch=match` field on the fixture's
      output line (printed only after the byte comparison passes — digest equality
      alone must not produce it); conflicting fixtures append exactly the expected
      `fs/merge-conflict` events (same paths, kinds, and all three content digests) —
      evidence: one `fixture=<name> ... OK` line per fixture in `make verify-E1-T10`
      output, with every required fixture class present under its exact directory
      name: `clean-disjoint`, `conflict-spans`, `delete-vs-edit-a`,
      `delete-vs-edit-b`, `rename-vs-edit`, `rename-vs-rename`, `add-add`, and
      `resolution` — checked per name:
      `make verify-E1-T10 2>&1 | grep -c '^fixture=<name> .* OK$'` prints ≥ `1` for
      each of the eight names (a bare directory count is not acceptable evidence);
      **and** every clean fixture's line carries the batch attestation — evidence:
      `make verify-E1-T10 2>&1 | grep -c '^fixture=.* batch=match .* OK$'` prints a
      count equal to the number of clean fixtures, and per pinned name
      `make verify-E1-T10 2>&1 | grep -c '^fixture=clean-disjoint .*batch=match.* OK$'`
      and `... '^fixture=rename-vs-edit .*batch=match.* OK$'` each print `1`.
- [ ] **Determinism.** Merging the same source into the same target twice, from two
      fresh server processes seeded with identical logs, appends canonically
      byte-identical event batches and replays to identical digests — for at least one
      clean and one conflicting fixture, with the class frozen into the line format —
      evidence, one grep per class:
      `make verify-E1-T10 2>&1 | grep -c '^DETERMINISM fixture=.* class=clean OK$'`
      prints ≥ `1` **and**
      `make verify-E1-T10 2>&1 | grep -c '^DETERMINISM fixture=.* class=conflict OK$'`
      prints ≥ `1` (a run whose determinism leg exercises only clean fixtures fails
      the second grep), **and**
      the comparator's red path proven inside the same run: the script perturbs one
      byte of a copy of one batch, asserts the byte-comparison exits nonzero, and only
      then prints its sensitivity line — evidence:
      `make verify-E1-T10 2>&1 | grep -c '^DETERMINISM-SENSITIVITY EXPECTED-FAIL OK$'`
      prints `1`.
- [ ] **Conflicted-state gate.** After a conflicting merge, dispatching an ordinary
      write/patch to a conflicted path is refused `merge/path-conflicted` with the head
      offset unchanged; a matching `fs/merge-resolve` is accepted, clears the flag, and
      the resolution fixture replays to its committed golden clean digest; and a
      committed assertion materializes a conflicted tree and a clean tree with
      byte-identical file contents and asserts their canonical tree digests are
      unequal (the exact pair adversarial angle 4 attacks) —
      evidence: committed lifecycle test assertions, `pnpm test --filter
      @eforest/stream-fs` exit 0.
- [ ] **Abort appends nothing.** Dry-run, target-advanced (a write raced in between
      plan and append), and target-conflicted merges each leave the target stream's
      head offset and dumped log byte-identical to before the attempt — evidence:
      committed lifecycle test reading offsets and diffing dumps before/after each
      refusal.
- [ ] **Fuzz: no silent wrong merge.** The committed interleaving corpus (≥ 200 cases,
      committed seeds) replayed through real merges yields: every oracle-`clean` case
      digest-verified against independently composed expected bytes, every
      oracle-`conflict` case surfacing the expected conflict events, and zero cases
      where a merge lands clean with bytes differing from the oracle — evidence:
      `FUZZ cases=<n> ... OK` in `make verify-E1-T10` output with `cases` ≥ 200,
      **and** the fuzz comparator's red path proven inside the same run (mirroring
      the determinism and mutation legs): the leg perturbs one oracle expectation
      (or one case's expected bytes) in a copy of the corpus, asserts the comparison
      exits nonzero, and only then prints `FUZZ-SENSITIVITY EXPECTED-FAIL OK` —
      evidence: `make verify-E1-T10 2>&1 | grep -c '^FUZZ-SENSITIVITY EXPECTED-FAIL OK$'`
      prints `1`.
- [ ] **Sensitivity.** The mutation leg runs inside `make verify-E1-T10`: one byte of
      a committed fixture leg flipped → the pipeline goes red before
      `MUTATION fixture=<name> byte=<offset> EXPECTED-FAIL OK` prints (the `byte=<offset>`
      field is required so the flipped offset is in the transcript) — evidence:
      `make verify-E1-T10 2>&1 | grep -c '^MUTATION .*byte=.*EXPECTED-FAIL OK$'` ≥ 1
      (anchored to the mutation leg's own line prefix so the
      DETERMINISM-SENSITIVITY line cannot satisfy it); **and** the golden-batch
      comparator's red path is proven in the same run: one byte of a copy of one clean
      fixture's committed golden batch perturbed, the batch byte-comparison asserted
      nonzero — evidence:
      `make verify-E1-T10 2>&1 | grep -c '^MUTATION-BATCH .*byte=.*EXPECTED-FAIL OK$'`
      prints ≥ `1`.
- [ ] **Frozen contract.** The four frozen blocks of this readme's Context section —
      `overlap-predicate`, `conflict-taxonomy`, `payload-shapes`, and
      `resolution-protocol`, each already delimited above by
      `<!-- frozen:E1-T10:<block> -->` / `<!-- /frozen:E1-T10:<block> -->` marker
      pairs — are reproduced byte-for-byte (the text between the markers) in the
      `packages/stream-fs` readme under identical marker pairs, with the
      golden-invalidation rule stated, and the sync is checked mechanically: a
      committed doc-sync assertion in the test suite or a
      `diff <(extract spec blocks) <(extract readme blocks)` step inside
      `tools/verify/three_way_merge.sh` compares the delimited blocks byte-level and
      goes red on any drift; property tests carry committed seeds;
      no `.skip`/`.todo` tests and no new inline lint disables in `src/` — evidence:
      committed files, the doc-sync check present and green in `pnpm test` or the
      `make verify-E1-T10` transcript, plus `pnpm test` exit 0.
- [ ] All workspace gates pass repo-wide: `pnpm format:check && pnpm lint &&
      pnpm typecheck && pnpm test && pnpm build` exit 0; `make verify-list` shows
      `verify-E1-T10`; `tools/verify/self_check.sh` passes.
- [ ] Durable evidence committed under this task's `evidence/`: the final
      `make verify-E1-T10` transcript (all fixture, DETERMINISM,
      DETERMINISM-SENSITIVITY, FUZZ, FUZZ-SENSITIVITY, MUTATION, and MUTATION-BATCH
      lines), plus one
      conflicting
      fixture's full post-merge dumped log and its
      `ef replay --digest` output — cited by path and digest in the Verification log.
- [ ] Replay browser layer: N/A (no browser-reaching surface; stream-fs merge
      internals) — mitigation: stream-layer evidence above is the currency; the
      Verification log entry declares this explicitly per AGENTS.md.

## Adversarial verification

Your mission: manufacture one silent wrong merge — one pair of divergent histories
where the system either composes bytes neither side wrote and calls it clean, quietly
picks a side, or resolves a conflict without an explicit resolution event. The
builder's fixtures and corpus are the floor; bring your own histories everywhere.

1. **Differential oracle, your own histories.** Generate your own divergent pairs (do
   not reuse the corpus): edits straddling multi-byte UTF-8 boundaries, adjacent but
   disjoint spans, insert-at-EOF on both sides, one side emptying the file, CRLF/LF
   churn, an edit whose span abuts a deletion. For each, compute the expected outcome
   independently — `git merge-file` / `diff3 -m` on the three materialized versions,
   or a from-scratch script folding both op sets — and compare against the merge's
   result: clean merges must byte-match your oracle (where diff3 semantics agree with
   the frozen predicate; where they differ, the *frozen spec* is the oracle — check the
   result against the spec text by hand); anything your oracle calls overlapping must
   surface as `fs/merge-conflict`. **One clean merge with wrong bytes refutes the
   task outright; one silently-resolved overlap refutes the headline claim.**
2. **Conflict-suppression sabotage.** In a disposable worktree: (a) widen
   `spansOverlap` to return false for same-position inserts, (b) make delete-vs-edit
   keep the edit, (c) drop the `add-add` content comparison, (d) have the planner emit
   "ours" for any conflict. For each sabotage, `pnpm test` **and** `make verify-E1-T10`
   must both go red. A sabotage that stays green refutes the suite it slipped past —
   and (d) staying green refutes the fuzz oracle specifically.
3. **Abort atomicity attack.** Read the target head offset, then force every refusal
   path yourself: race a write between plan and append (patch the code or use a
   breakpoint dispatch if the harness lacks a hook — a missing hook is a finding),
   merge into a conflicted target, dry-run a conflicting merge, feed a source whose
   fork metadata is corrupt. After each, re-read the head offset and byte-diff the
   dumped log. **Any appended event across any refusal refutes atomicity.** Also check
   the batch itself: kill the server mid-append and verify on restart the log holds
   either the whole batch or none of it (E0-T07 durability + fencing) — a torn merge
   on the log refutes.
4. **Resolution-gate fuzz.** Against a conflicted path, dispatch: ordinary writes and
   patches (must refuse `merge/path-conflicted`, head unchanged), resolves with wrong
   `mergeId`, wrong `resultDigest`, a resolve for a non-conflicted path, a double
   resolve, a resolve carrying ops anchored to the wrong base. Every invalid case must
   refuse typed with the log untouched; a resolve that half-applies, or any ordinary
   write that lands on a conflicted path, refutes the gate. Then verify the digest
   claim: materialize a conflicted tree and a clean tree with identical file bytes and
   confirm their canonical tree digests differ — equal digests refute "a conflicted
   state only a resolution event clears" at the evidence layer.
5. **Determinism and environment.** Run the same fixture merge on two fresh servers
   and byte-diff the canonical batches yourself (don't trust the harness's DETERMINISM
   line — recompute). Repeat under `TZ=Pacific/Kiritimati LANG=C`, a different cwd,
   and with ours/theirs event dumps fed in a different arrival order where the API
   permits. Grep the merge modules for `Date.now`, `Math.random`, `Set`/`Map`
   iteration feeding output order, `localeCompare`, `Intl`. Any byte of divergence
   refutes plan purity.
6. **Fuzz beyond the corpus.** Run the generator with your own fresh seed (cite it)
   for ≥ 500 new cases, and extend it: three-plus edits per side to the same file,
   rename chains (a→b on ours, b edited on theirs), a file deleted and re-added on one
   side, patches interleaved with full-write fallbacks (E1-T03's mixed mode). Every
   clean result must match the oracle's bytes; every overlap must conflict. Promote
   every novel surviving case into `fixtures/fuzz/merge-interleavings/`. Any silent
   wrong merge — however contrived — refutes.
7. **Golden rot.** Regenerate the fixture expectations from the committed legs with
   the committed code and byte-diff against `expected.json` — drift refutes plan
   determinism or reveals check-time regeneration (inspect the harness: no consuming
   check may recompute its own golden). Then flip your own byte (different fixture and
   offset than the harness's mutation leg) in a committed leg and confirm the pipeline
   goes red. A green pipeline over a corrupted fixture refutes the measuring
   apparatus.
8. **E1-T09 boundary honesty.** Merge a source whose target never advanced: it must
   take E1-T09's fast-forward path (no `fs/merge-conflict` possible, no three-way
   events), and re-merging an already-merged source must not re-conflict or duplicate
   events. A three-way plan produced where fast-forward applies — or vice versa —
   refutes the boundary between the two tasks.
9. **Cold-clone + scope audit.** Run `make verify-E1-T10` via
   `tools/verify/cold_clone.sh`, twice back-to-back (no warm state). Then hold the
   diff against the evidence: every conflict kind, every refusal type, the rebase
   path, and the resolve path must each have been executed by a test or transcript;
   check nothing out-of-scope was smuggled in (no auto-resolution strategies, no PR
   surface, no working-tree markers). Unexecuted diff is unproven or dead — builder
   chooses which, you enforce it.

Refutation → `status: refuted`, repro appended below, back to the builder. No
refutation → promote at minimum: your angle-1 histories as committed fixtures and
every novel angle-6 case into the interleaving corpus.

## Verification log
