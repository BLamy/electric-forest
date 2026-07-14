---
id: E1-T10
epic: 1
title: Three-way merge on patches with conflicts surfaced as events
priority: 110
status: implemented
depends_on: [E1-T03, E1-T04, E1-T09]
estimate: L
capstone: false
---

## Goal

Add deterministic three-way merge as StreamFS application behavior on published Durable
Streams. Reconstruct base, target, and source from canonical application events; append a
merge event when patches compose cleanly; append explicit conflict events when they do
not. Never add transport behavior or rely on non-Electric endpoints.

## Acceptance criteria

- [x] Clean disjoint text edits merge deterministically and replay to one digest.
- [x] Overlapping edits produce stable conflict events containing base, target, and
      source references; no side is silently selected.
- [x] Binary and non-patchable conflicts are surfaced explicitly.
- [x] Writer races use official `Stream-Seq` semantics and never leave a partially
      visible merge.
- [x] CLI, replay, watch, and materialization consume the same merge event model.
- [x] Tests run against `DurableStreamTestServer`; browser evidence is N/A with
      stream-layer fixtures and digest comparisons as mitigation.

## Adversarial verification

Mutate each side independently, swap target/source order, replay twice, race an ordinary
target write with merge, corrupt a conflict reference, and verify every failure is
deterministic and head-neutral.

## Verification log

### 2026-07-14 — builder — implemented

- Implementation commit: `1226349` (`feat: add deterministic three-way merge`).
- `planThreeWayMerge` reconstructs the fork base and both live heads, emits a
  canonical SHA-256 merge id, composes only disjoint patch edits, and classifies
  overlap, binary/full-write, delete-edit, rename-rename, and add-add cases without
  selecting a side. `resolveMergeConflict` records the current target digest as an
  explicit resolution and snapshot bootstrap rehydrates unresolved conflict state
  from the resolved canonical log.
- One published-client streaming POST submits `fs/merge-change` and
  `fs/merge-conflict` audit records followed by terminal v2 `fs.branch.merge`; the
  official `Stream-Seq` is the first planned application offset. The reducer buffers
  all effects until the terminal record and rejects any staged/terminal mismatch.
  Both forced race schedules prove either the ordinary writer or the whole merge wins;
  no prefix of a merge becomes visible.
- The real server/CLI process test executes `ef merge --three-way`, then
  `ef replay --digest` over the mixed v1/v2 log. Permanent official-server tests also
  cover live watch offsets, byte materialization, snapshot/bootstrap, source and target
  head advancement, inverted target/source order, corrupt conflict references, and
  repeated deterministic planning/replay.
- Final gates: `CI=true make verify-E1-T10` exited 0 after `format:check`, lint,
  typecheck, 12 test files / 96 tests, build, 6 official-focused files / 20 tests,
  verifier self-check, and queue listing. The evidence verifier reproduced clean digest
  `15456682ddfbadbf8b2f0491e61509deb6d52eade66a800d3d81d01b3001aaf9`, conflict
  digest `fa10d67c98fc7bfb85c0d6d8cfbcf07481124fc5fef5aa58a29f34aa4576ec41`, and
  byte-sensitive digest `b0d1aeae403243db263459b08b5f575dbdd42faa27553bcd4e709dc193957422`.
- Evidence: `evidence/e1-t10-clean.jsonl`, `evidence/e1-t10-clean-source.jsonl`,
  `evidence/e1-t10-conflicts.jsonl`, `evidence/e1-t10-conflicts-source.jsonl`,
  `evidence/e1-t10-byte-sensitive.jsonl`, `evidence/e1-t10-summary.json`, and
  `evidence/e1-t10-verification.txt`. `tools/verify/e1_t10_evidence.mjs` replays the
  goldens twice, mutates a same-length inserted byte and expects
  `patch/result-mismatch`, then corrupts a valid SHA-256 conflict reference and expects
  `merge/staged-record-mismatch`.
- Claim: the recording demonstrates that deterministic clean and conflicted three-way
  merges run entirely as atomic application behavior on Electric's published Durable
  Streams transport, replay to exact digests, survive snapshot/watch/materialization,
  and fail head-neutrally under stale or corrupted inputs.
- Replay: N/A (protocol, CLI, and server-internal merge behavior with no browser
  surface) + mitigation: official `DurableStreamTestServer` event logs, exact live/replay
  digest comparisons, real CLI processes, forced atomic races, and two independent
  mutation-sensitivity failures.

### 2026-07-14 — critic

VERDICT: refuted

- P1 conflict-reference integrity — FAILED. Predicted that changing a valid
  `base.treeDigest` in both copies of one conflict reference would deterministically
  fail replay; the committed `e1-t10-conflicts.jsonl` instead reduced successfully
  with the same tree digest
  `fa10d67c98fc7bfb85c0d6d8cfbcf07481124fc5fef5aa58a29f34aa4576ec41` and exposed
  the corrupted `eeee…` reference. The current evidence mutation changes only the
  staged copy, so it proves duplicate equality, not reference integrity. Citations:
  `evidence/e1-t10-conflicts.jsonl` offsets
  `0000000000000000_0000000000000006` and
  `0000000000000000_0000000000000008`;
  `packages/streamfs/src/reducer.ts:411-424`;
  `tools/verify/e1_t10_evidence.mjs:69-80`. Bind the merge id to the complete terminal
  plan and validate the correlated staged/terminal reference against it; promote the
  two-copy mutation as a permanent sensitivity test.
- P1 source-only rename — FAILED. Predicted that a source-only `old.txt → new.txt`
  rename would apply and remain readable/snapshot-able. The official server accepted a
  delete/create/write plan and terminal merge at offset
  `0000000000000000_0000000000000007`, but both `readFile("new.txt")` and
  `createSnapshot()` failed: `full write has no content event matching
9e848…/6`. The plan reuses the inherited content stream while materialization expects
  a new full-write body. Citations: `packages/streamfs/src/merge.ts:276-372`;
  `packages/streamfs/src/fs.ts:761-870`;
  `packages/streamfs/src/snapshot.ts:242-381`. Preserve rename identity with a rename
  change or otherwise make the adopted bytes reconstructable, then cover read,
  snapshot, watch, replay, and CLI consumers.
- P1 non-patchable history — FAILED. Predicted that a target full write followed by a
  patch, raced against a source patch, would remain an explicit non-patchable conflict.
  The official server plan observed target post-fork events
  `[fs.file.write, fs.file.patch]` but emitted no conflicts and one clean patch. The
  planner remembers only the last mutation kind. Citations:
  `packages/streamfs/src/merge.ts:135-146` and `:486-492`. Inspect the complete
  post-fork mutation history and promote full-write-before-patch cases on both sides.
- P1 nested delete/edit — FAILED. Predicted that source deletion of `dir/file.txt` plus
  `rmdir dir`, against a target edit of the file, would surface one stable delete-edit
  conflict. Planning instead threw `cannot remove non-empty directory dir; contains
dir/file.txt`; both heads remained unchanged but no conflict event could be produced.
  The conflict filter drops descendants but retains a conflicting path's ancestor
  removal. Citations: `packages/streamfs/src/merge.ts:559-565` and `:589-597`. Suppress
  or conflict the ancestor operation and add nested directory delete/edit coverage.
- P1 independent same-byte add/add — FAILED. Predicted two independently created
  `same.txt` files with identical bytes but distinct content-stream identities would
  surface `add-add`. The official server produced distinct tree digests and stream ids,
  yet the plan returned `conflicts=[]`, `changes=[]`, silently retaining the target
  identity. Citations: `packages/streamfs/src/merge.ts:81-85` and `:468-475`. Do not
  collapse independently added nodes on digest/size equality alone.
- P2 reducer-state portability and malformed staging — NEEDS EVIDENCE. Unresolved
  conflicts live only in WeakMaps: a canonical JSON state round-trip loses them, and
  generic CLI bootstrap then rejects a valid resolution with `merge/conflict-not-found`;
  only the StreamFS-specific bootstrap replays the full log to compensate. Separately,
  replay accepted a valid snapshot inserted between staged conflict records, and a
  truncated staged prefix remains latent state. Citations:
  `packages/streamfs/src/tree.ts:4-6,48-73`;
  `packages/streamfs/src/snapshot.ts:384-393,554-556`;
  `packages/cli/src/replay-command.ts:314-355`;
  `packages/streamfs/src/reducer.ts:370-424`. Define the portable conflict state and
  reject non-contiguous or unterminated merge groups in replay.
- COVERAGE — INSUFFICIENT. The final recording never exercises all
  `sourceAdoptionChanges` branches, rename materialization, correlated conflict
  mutations, prior full-write history, nested ancestor removal, same-byte add/add,
  generic bootstrap, or reordered/truncated staging. Each behavior above needs a
  permanent official-server or deterministic replay regression before resubmission.
- SURVIVED. A scrubbed authorized cold clone passed `verify-E1-T10` (12 files / 96
  tests; six official-focused files / 20 tests; evidence and self-check). Independent
  sabotages of first-offset fencing, overlap detection, source-hunk application,
  staged/terminal equality, and patch-result checking all made their intended tests go
  red. No skips, TODOs, lint suppressions, mocks replacing the published server, or
  environment-dependent merge semantics were found.
- SUITE: no promotion until the refutations clear. Critic diagnostics remain under the
  task's ignored `work/` directory for builder rework.

Commands: `node tools/verify/e1_t10_evidence.mjs`; `pnpm exec vitest run
packages/streamfs/test/three-way-merge.test.ts
packages/streamfs/test/three-way-merge.integration.test.ts
packages/cli/src/official.integration.test.ts`; `tools/verify/cold_clone.sh --keep
verify-E1-T10`; official-server attacks in `work/critic-lead/` plus the parallel
coverage and sabotage scratch worktrees.

### 2026-07-14 — builder — reworked and implemented

- Rework implementation commit: `90482bd` (`fix: harden three-way merge evidence`).
  The merge id now binds the complete base/target/source revision tuple, changes, and
  conflict identities; terminal reduction independently checks every conflict reference.
  A correlated valid-SHA mutation in both staged and terminal copies now fails with
  `merge/reference-mismatch`.
- Source-only file and directory moves are emitted as identity-preserving `fs.rename`
  changes. Official-server regressions apply both forms and prove byte reads, recursive
  directory materialization, source immutability, snapshot/bootstrap, and exact digests.
  Full-write-then-patch histories on either side remain non-patchable conflicts; nested
  delete/edit suppresses unsafe ancestor removals; independent same-byte additions with
  distinct content streams surface `add-add`.
- Unresolved conflicts are now canonical, serializable reducer state while remaining
  outside the content-tree digest. Repository, snapshot, replay, bootstrap, and
  materialize boundaries reject truncated staged batches, and the reducer rejects valid
  snapshots or ordinary filesystem events interleaved into a merge group. The evidence
  verifier round-trips conflicted state through canonical JSON and resolves it through
  the generic CLI bootstrap path.
- Final gates: `CI=true make verify-E1-T10` exited 0 after format, lint, typecheck,
  13 test files / 101 tests, build, seven official-focused files / 25 tests, evidence
  sensitivity, self-check, and queue listing. The stable clean, conflict, and
  byte-sensitive digests remain `15456682ddfbadbf8b2f0491e61509deb6d52eade66a800d3d81d01b3001aaf9`,
  `fa10d67c98fc7bfb85c0d6d8cfbcf07481124fc5fef5aa58a29f34aa4576ec41`, and
  `b0d1aeae403243db263459b08b5f575dbdd42faa27553bcd4e709dc193957422`.
- Evidence: the committed `evidence/e1-t10-*.jsonl` logs and summary plus
  `tools/verify/e1_t10_evidence.mjs`. The permanent verifier proves patch-byte
  sensitivity, correlated-reference sensitivity, interleaving rejection, truncated
  batch rejection, portable unresolved conflicts, and generic CLI bootstrap resolution.
- Claim: the reworked recording demonstrates deterministic, atomic three-way merge
  behavior over the published Durable Streams transport and directly covers every prior
  critic refutation without changing either source or target head during planning.
- Replay: N/A (protocol, CLI, and server-internal merge behavior with no browser
  surface) + mitigation: official `DurableStreamTestServer` event logs, exact digest
  replay, real CLI bootstrap, atomic race schedules, committed goldens, and independent
  mutation sensitivity.

### 2026-07-14 — critic — VERDICT: refuted

- P1 source replacement rename — FAILED. Predicted that an unchanged target plus a
  source which deletes `b.txt` and renames inherited `a.txt → b.txt` would produce a
  deterministic adoption plan or an explicit conflict. A fresh official-server attack
  instead made `planThreeWayMerge` throw `cannot create existing path b.txt`; target
  head `…0003` and source head `…0006` were unchanged before and after. The pure-rename
  path refuses an occupied base destination, then `sourceAdoptionChanges` schedules a
  write followed by a create/rebind using the inherited main-stream identity, which the
  reducer rejects for an existing path. Citations: `packages/streamfs/src/merge.ts:309-405`,
  `packages/streamfs/src/merge.ts:507-547`, and
  `packages/streamfs/src/reducer.ts:185-203`; promoted coverage only exercises
  absent destinations at `packages/streamfs/test/three-way-merge-adversarial.integration.test.ts:51-91`.
  Represent replacement/permutation renames with ordered identity-preserving changes or
  surface a stable conflict, then prove planning and all consumers.
- P1 chained source rename materialization — FAILED. Predicted that a source-only
  `first.txt → middle.txt → final.txt` chain with an empty final destination would
  remain readable after merge. An independent official-server attack observed the
  planner fall through to delete/create/write, the batch apply successfully, and
  `readFile("final.txt")` then fail because no content event matched the inherited
  stream's synthesized full write. Neither individual historical rename matches the
  final source tree, so the fast path at `packages/streamfs/src/merge.ts:458-528` misses
  the composed move; fallback adoption at `:529-547` fabricates write metadata without
  source bytes in the target history. Coalesce rename chains by final identity or make
  fallback adoption byte-reconstructable; cover read, snapshot, replay, watch, and CLI
  materialization.
- PRIOR REFUTATIONS — SURVIVED. Fresh inputs rejected a correlated valid-SHA reference
  mutation with `merge/reference-mismatch` head-neutrally; classified target full-write
  then patch versus a distant source patch as `edit-edit/non-patchable`; reduced a
  depth-two ancestor delete/edit to one conflict and zero unsafe changes; classified
  independent empty same-byte additions as `add-add`; preserved unresolved conflicts
  through canonical JSON; and rejected content-event interleaving and truncated staging
  with `merge/interleaved-batch` and `merge/incomplete-batch`. A new clean disjoint run
  produced identical live, receipt, and double-replay digest
  `27e80c779f5b38e17449264446a2a8d3caaf85a1c076e6be4c588a404508184f`;
  fresh overlap and binary inputs surfaced the expected explicit conflicts.
- COVERAGE — INSUFFICIENT. Every previous failure now has a permanent regression, but
  the rename tests cover only one-hop moves into absent destinations and miss replacement,
  permutation, and chained-rename identity. Add official-server cases for both failures
  above. Also promote negative boundary tests proving truncated three-way dumps fail at
  repository, snapshot, and `ef materialize` finalization, not only reducer/replay
  finalization.
- SURVIVED. A scrubbed cold clone of exact tip `875aefc` passed `verify-E1-T10`: 13 test
  files / 101 tests, seven official-focused files / 25 tests, build, committed evidence,
  verifier, and self-check. Ten isolated sabotages covering reference binding, file and
  directory rename adoption, full-write history on either side, ancestor filtering,
  same-byte identity, serialized conflicts, interleaving, and truncation all turned
  their intended tests red. No skips, TODOs, lint suppressions, replacement server mocks,
  or environment-dependent merge semantics were found.
- Replay: N/A (protocol, CLI, and server-internal merge behavior with no browser surface)
  - mitigation accepted: official `DurableStreamTestServer` attacks, exact digest replay,
    real CLI processes, cold clone, atomic race schedules, committed goldens, and mutation
    sensitivity. The verdict rests on stream-layer counterexamples, not absent browser
    evidence.
- SUITE: retain the rework's promoted regressions. Do not promote the failing diagnostics
  until the builder fixes both rename paths and records deterministic success artifacts.

Commands: `node tools/verify/e1_t10_evidence.mjs`; `pnpm exec vitest run
packages/streamfs/test/three-way-merge-adversarial.integration.test.ts
packages/streamfs/test/three-way-merge.integration.test.ts
packages/streamfs/test/three-way-merge.test.ts packages/cli/src/official.integration.test.ts`;
`CI=true make verify-E1-T10` in a scrubbed cold clone; fresh official-server rename,
conflict, history, portability, and malformed-batch attacks; ten isolated sabotage runs.

### 2026-07-14 — builder — rename-program rework implemented

- Rework implementation commit: `19afe43` (`fix: preserve ordered rename programs`).
  The planner groups connected source rename histories and replays their original
  structural order only when target subtrees still match the fork inputs. This preserves
  inherited content-stream identity through empty-destination moves, destination
  replacement, multi-hop chains, recursive directory replacement, and temp-path swap
  permutations. Unsafe rename-versus-edit components become explicit
  `rename-rename/non-patchable` conflicts instead of partial metadata adoption.
- Permanent official-server tests reproduce both critic counterexamples and extend them
  through a recursive directory replacement and three-step file swap. They assert ordered
  plan changes, source immutability, exact replay digest, SSE watch events, byte reads,
  snapshot creation/bootstrap, and conflict preservation. A real `ef materialize` process
  consumes a byte-backed replacement-rename log and produces `b.txt` with the inherited
  `A\n` bytes.
- Repository `treeAt`, snapshot-tail reduction, `ef replay`, and `ef materialize` now have
  promoted negative-path coverage for truncated staged merge groups. CLI finalization
  reports the deterministic `merge/incomplete-batch` reason instead of an unclassified
  process failure.
- Final gates: `CI=true make verify-E1-T10` exited 0 after format, lint, typecheck,
  13 test files / 104 tests, build, seven official-focused files / 27 tests, evidence,
  self-check, and queue listing. New replacement-rename live/replay digest:
  `401aab748178b6fd9107989f49ebbd2366cdaa22e3dac66773f748a60b1e2bb6`.
  The clean, conflict, and byte-sensitivity digests remain unchanged.
- Evidence: `evidence/e1-t10-renames.jsonl`,
  `evidence/e1-t10-renames-source.jsonl`, the prior E1-T10 goldens and summary, and
  `tools/verify/e1_t10_evidence.mjs`. The verifier requires ordered delete-plus-rename
  changes and reproduces the rename digest twice.
- Claim: the recorded stream evidence demonstrates that source rename history is applied
  as identity-preserving structural events across all consumers, while any target-touched
  rename component surfaces a stable conflict and no staged prefix is accepted as a tree.
- Replay: N/A (protocol, CLI, and server-internal merge behavior with no browser surface)
  - mitigation: official `DurableStreamTestServer` event logs, exact live/double-replay
    digests, real CLI materialization, SSE watch assertions, snapshots, cold deterministic
    gates, and committed byte evidence.

### 2026-07-14 — critic

VERDICT: refuted

- P1 converged rename programs — FAILED. Predicted identical target/source structural
  histories would be recognized as already converged. Fresh official-server cases gave
  target, source, and post-merge digest
  `c41600e43461a9114fc43b6a0f1455c93e0402291f189171b307976c63700acf` for the same
  one-hop rename and `82f8c10ff65291e78db57b3e935e33ba990d0cab7c05628c36335dd704aba6da`
  for the same three-step swap, yet each plan persisted one
  `rename-rename/non-patchable` conflict. The structural simulation compares fork state
  with the already-renamed target and rejects before the general target/source equality
  check at `packages/streamfs/src/merge.ts:296-325,665-715`. Recognize identical final
  identities/programs before rejection and promote one-hop plus permutation regressions.
- P1 unilateral rename programs with content — FAILED. Predicted an unchanged target
  would cleanly adopt source-only `rename → write`, `write → rename`, recursive directory
  `rename → nested write`, `create → rename`, and `rename → delete` histories. Fresh
  probes instead returned zero changes and a head-neutral
  `rename-rename/non-patchable` conflict; representative file heads remained target
  `…0003` / source `…0005`, and directory heads target `…0005` / source `…0007`.
  `sourceStructuralStep` discards create/write/patch operations and the final subtree
  comparison then rejects the incomplete simulation at
  `packages/streamfs/src/merge.ts:199-215,255-325`. Replay or coalesce the complete
  component program and prove read, snapshot, replay, watch, and CLI materialization.
- P1 replacement-collision references — FAILED. Predicted a target edit of occupied
  destination `b.txt` against source `delete b.txt; rename a.txt → b.txt` would cite the
  target's actual collision. The only conflict instead had path/target node `a.txt` and
  digest `06f961…`, while target `b.txt` held the changed digest `f1d4f0…`; the causal
  target path/content was absent. The rejected-component projection follows the moved
  source identity at `packages/streamfs/src/merge.ts:314-325,672-688`. Surface references
  for every target-touched destination/component so the explicit conflict is sufficient.
- COVERAGE — INSUFFICIENT. `tools/verify/e1_t10_evidence.mjs:39-70` replays only
  `e1-t10-renames.jsonl`; the committed `e1-t10-renames-source.jsonl` is never read.
  Permanent tests cover source-only replacement, chain, directory replacement, swap,
  and target-edit/source-rename, but not identical programs, unilateral rename+content,
  causal destination references, rejected directory components, or the defensive catch
  at `packages/streamfs/src/merge.ts:305-310`. Truncation is covered at repository,
  snapshot-tail, reducer, and materialize boundaries, but not by permanent real-process
  `ef replay` and bootstrap truncation tests.
- SURVIVED. Independent replacement-plus-chain components preserved exact order, bytes,
  source neutrality, and live/receipt digest `6fd3e8…`; a target-owned transient swap
  path produced one explicit conflict without changing content digest `3ed2cf…`.
  The committed verifier and focused official/CLI suite passed (5 files / 19 tests), and
  a scrubbed cold clone passed `verify-E1-T10` (13 files / 104 tests; seven
  official-focused files / 27 tests). Sabotage proved grouping, prerequisite deletion,
  effective ordering, equality checks, rejected-conflict creation, and the repository
  boundary are sensitive. Independent sensitivity for snapshot `reduceMetadata` was not
  established, and the CLI/verifier mutation was not run.
- Replay: N/A (protocol, CLI, and server-internal behavior with no browser surface) +
  mitigation accepted: official `DurableStreamTestServer` counterexamples, exact digest
  comparisons, focused CLI processes, cold clone, committed goldens, and sabotage.
- SUITE: retain the builder's passing regressions. The failing critic diagnostics remain
  under the ignored task `work/` directory; promote them when the implementation can
  satisfy their deterministic expectations.

Commands: `node tools/verify/e1_t10_evidence.mjs`; fresh official-server rename-program
probe under `work/critic3/`; `pnpm exec vitest run
packages/streamfs/test/three-way-merge-adversarial.integration.test.ts
packages/streamfs/test/three-way-merge.integration.test.ts
packages/streamfs/test/three-way-merge.test.ts packages/cli/src/official.integration.test.ts
packages/cli/src/materialize.test.ts`; `tools/verify/cold_clone.sh --keep verify-E1-T10`;
isolated sabotage worktrees.

### 2026-07-14 — builder — rename/content rework implemented

- Rework implementation commit: `7cec67a` (`fix: compose rename programs with content`).
  Rename components now replay every causally connected source filesystem event in its
  original order, including create, write, patch, and post-rename delete operations.
  Identical target/source rename programs short-circuit as converged, while rejected
  programs cite the first target-divergent path instead of projecting an unrelated moved
  identity.
- Permanent official-server regressions cover identical one-hop and swap programs,
  rename-before-write, write-before-rename, rename-before-patch, directory
  rename-before-nested-write, create-before-rename, rename-before-delete, target-touched
  destination replacement, and target-touched directory renames. They prove exact reads,
  source neutrality, SSE event order, raw replay, snapshots, and bootstrap. Real `ef
replay`, bootstrap, and materialize processes prove both rename-plus-content bytes and
  truncated-stage rejection.
- Final recorded command: `CI=true make verify-E1-T10` at `7cec67a`. It exited 0 after
  format, lint, typecheck, 13 test files / 109 tests, build, seven official-focused files
  / 30 tests, the evidence verifier, self-check, and task listing.
- Evidence: `evidence/e1-t10-rename-content.jsonl` and
  `evidence/e1-t10-rename-content-source.jsonl` join the existing E1-T10 goldens. The new
  bundled content log double-replays to
  `96c8ba1ba15271c8ad1d2a77cda0548fb09fbc5b9a323db6f3c8729f5c97efcd`, decodes the
  adopted bytes, and matches the source's ordered rename/write/handoff program. The
  replacement source digest is
  `430ca53d2893c5d3cb6926ba7f14ef77f2d14f601f386c98d8ea96b84403b6eb`, and reversing
  its causal delete/rename order fails deterministically.
- Claim: the stream evidence demonstrates that uncontested rename programs compose with
  their content history across every consumer, already-converged programs add no conflict,
  and target-touched programs remain explicit with a causal collision reference.
- Replay: N/A (protocol, CLI, and server-internal merge behavior with no browser surface)
  - mitigation: official `DurableStreamTestServer` logs, exact live/double-replay digests,
    real CLI processes, SSE assertions, snapshots/bootstrap, committed byte evidence, and
    mutation sensitivity.

### 2026-07-14 — critic

VERDICT: refuted

- P1 common rename plus unilateral content — FAILED. Predicted that when target and
  source both rename `before.txt → after.txt`, a subsequent full write on only the source
  would compose as the one-sided content delta, while a subsequent full write on only the
  target would require no merge change and preserve the target. Fresh official-server
  probes instead produced one head-neutral `rename-rename/non-patchable` conflict at
  `before.txt` in both directions. The source-edit case observed base/target/source tree
  digests `6eeb80…` / `8384cc…` / `95549f…`; the target-edit case observed source/target
  digests `e5b2b8…` / `9b3379…`. The component convergence test requires every final root
  to be equal, then its simulation compares the pre-rename base directly with the
  already-renamed target and rejects the shared rename at
  `packages/streamfs/src/merge.ts:287-323`. Factor or replay the common structural prefix
  before composing the remaining one-sided content history, then promote both directions.
- P1 sibling rename components with one causal ancestor removal — FAILED. Predicted that
  an untouched target would cleanly adopt source history `rename src/x.txt → dest/x.txt;
rename src/y.txt → dest/y.txt; rmdir src`, including the variant with interleaved full
  writes to both destination files. Both programs are valid when replayed in complete
  source order, but planning emitted one head-neutral `rename-rename/non-patchable`
  conflict at `src`; the pure/content source digests were `9aeed2…` / `e647d0…` and target
  digests were `61a471…` / `c7a50f…`. `renameComponents` groups only overlapping rename
  endpoints at `packages/streamfs/src/merge.ts:222-245`; the shared `fs.dir.remove` is then
  included independently in each component at `:287-296`, so each isolated simulation
  moves one child, sees the other, and rejects at `:306-335`. Include causal non-rename
  dependencies when forming components, or replay the globally ordered connected source
  program, then prove both byte-preserving variants.
- COVERAGE — INSUFFICIENT. Permanent tests cover pure identical one-hop/swap convergence
  separately from unilateral rename-plus-content on a structurally untouched target, so
  they never cross a common rename prefix with a one-sided content delta. They also omit
  non-overlapping sibling rename components sharing one ancestor operation. The planner
  admits `fs.dir.create` at `packages/streamfs/src/merge.ts:209-210`, but no permanent
  test, golden, or critic run proves a directory-create event causally connected to a
  rename program. The committed verifier replays only one replacement component and one
  unilateral rename-content program. Add official-server regressions for source-only and
  target-only content after a common rename, pure/content shared-ancestor programs, and
  connected `fs.dir.create`; exercise read, replay, snapshot/bootstrap, watch, and real
  CLI materialization where applicable.
- PRIOR REFUTATIONS — SURVIVED. Fresh inputs passed identical one-hop and three-step swap,
  source-only rename→full-write, write→rename, rename→patch, directory rename→nested edit,
  create→rename, rename→delete, and target-touched destination collision with the conflict
  anchored to `b.txt` and its actual target digest. The committed evidence verifier passed
  with rename-content digest `96c8ba…`, replacement digest `401aab…`, source digest
  `430ca5…`, and all mutation checks true; the focused official/CLI suite passed three
  files / 46 tests. A scrubbed cold clone passed the complete gate with 13 files / 109
  tests and seven official-focused files / 30 tests, proving the failures are uncovered
  semantics rather than a gate regression.
- SENSITIVITY — SURVIVED. Isolated sabotages of `fs.file.write` admission into rename
  programs, overlap-based relevance, final convergence, divergent collision-path
  selection, and direct/bootstrap incomplete-stage finalizers each made their intended
  checks fail. The apparatus measures those covered claims; it does not cover the common
  prefix or cross-component causal cases above.
- Replay: N/A (protocol, CLI, and server-internal merge behavior with no browser surface)
  - mitigation accepted: official `DurableStreamTestServer` counterexamples, exact stream
    heads and digests, real CLI processes, a scrubbed cold clone, committed goldens, and
    independent mutation sensitivity.
- SUITE: retain the builder's passing regressions. The four failing diagnostics remain in
  `work/critic4-lead/`; promote them only after the implementation satisfies the clean
  predictions, together with a new connected-`fs.dir.create` regression.

Commands: `pnpm exec vitest run --config
/Users/brettlamy/Dev/electric-forest/.eforest/tasks/epic-1-the-trunk/E1-T10-three-way-merge-conflicts/work/critic4-lead/vitest.config.ts`
(one prior-refutation breadth test passed; four clean
predictions failed); `pnpm exec vitest run
packages/streamfs/test/three-way-merge-adversarial.integration.test.ts
packages/cli/src/materialize.test.ts packages/cli/src/cli.test.ts` (46 passed);
`node tools/verify/e1_t10_evidence.mjs`; `tools/verify/cold_clone.sh --keep verify-E1-T10`;
isolated sabotage worktrees for admission, relevance, convergence, conflict paths, and
direct/bootstrap finalization. Submission: `94b901b`.

### 2026-07-14 — builder — shared rename-history rework implemented

- Rework implementation commit: `bd57735` (`fix: align shared rename histories`). The
  planner now transforms a fork-base projection through the structural prefix already
  present on both target and source, retains an original-path map for fork-byte reads and
  conflict references, and merges only the remaining content delta. Rename components are
  also unioned when a non-rename operation such as an ancestor removal touches multiple
  components, so the complete causal program replays once in source order.
- Permanent official-server regressions cover source-only and target-only writes after a
  common rename, disjoint patches after a common rename, pure and content-bearing sibling
  moves sharing `rmdir src`, and a created directory tree renamed as an ancestor. They
  assert exact plans, source neutrality, SSE order, reads, raw replay, snapshots, and
  bootstrap. Real `ef replay` and `ef materialize` processes consume both new committed
  byte-bearing logs.
- Final recorded command: `CI=true make verify-E1-T10` at `bd57735`. It exited 0 after
  format, lint, typecheck, 13 test files / 113 tests, build, seven official-focused files
  / 33 tests, the evidence verifier, self-check, and task listing.
- Evidence: `evidence/e1-t10-common-rename-content.jsonl` plus its source log double-replay
  to `1eb95e90d83a14a812fc4391a1f939e9d0208c8a1a28e006ab563602534d27be` and prove the
  common rename is absent from the merge delta. `evidence/e1-t10-sibling-renames.jsonl`
  plus its source log double-replay to
  `38956280bd5d5e81fb009c8ba9e4185a0fa9f9eab38ab34c75c6a22866071a55`, decode both
  edited files, and fail when `rmdir src` is moved before the second child move.
- Claim: common structural history is aligned rather than replayed or conflicted, while
  distinct source history is grouped by all causal path dependencies and preserved in
  exact order across the event log, watcher, snapshot, replay, and CLI consumers.
- Replay: N/A (protocol, CLI, and server-internal merge behavior with no browser surface)
  - mitigation: official `DurableStreamTestServer` logs, exact live/double-replay digests,
    real CLI materialization, SSE assertions, snapshots/bootstrap, byte-bearing committed
    evidence, and order sensitivity.

### 2026-07-14 — critic

VERDICT: refuted

- P1 patch history across a shared rename — FAILED. Predicted disjoint text patches would
  compose when one side patched `before.txt`, both sides renamed it to `after.txt`, and
  the other side patched a distant line afterward. Fresh official-server probes in both
  ordering directions instead returned one `edit-edit/non-patchable` conflict and zero
  changes. `isPatchOnlyMutation` searches only the final path, so it never sees a patch
  recorded under the pre-rename path even though byte composition is clean. Citations:
  `packages/streamfs/src/merge.ts:135-143,851-860`; diagnostics
  `work/critic5/behavior.test.ts:173-204`. Track mutation history by file identity or
  transformed path and promote both orderings as permanent regressions.
- P1 semantically equivalent structural programs — FAILED. Predicted a direct rename and
  an equivalent two-hop chain ending at the same identity would align before unilateral
  content was merged. Both structural directions, a target-only content variant, and a
  two-file swap using different temporary names instead produced
  `rename-rename/non-patchable` conflicts. The swap conflict cited the wrong source-side
  identity, while the source-write chain cases cited the original source path as missing.
  Alignment compares canonical event prefixes rather than equivalent final identity.
  Citations: `packages/streamfs/src/merge.ts:350-443`; diagnostics
  `work/critic5/behavior.test.ts:66-135`. Align chains and permutations semantically, then
  compose the remaining content delta and prove both content directions.
- P1 shared structural prefix plus source suffix — FAILED. Predicted common `a.txt → b.txt`
  followed only on the source by `b.txt → c.txt` would adopt one clean suffix rename. The
  plan instead returned zero changes and one `rename-rename/non-patchable` conflict. The
  legacy final-identity loop runs before structural alignment and mistakes target `b.txt`
  versus source `c.txt` for unrelated divergent renames. Citations:
  `packages/streamfs/src/merge.ts:743-786`; diagnostics
  `work/critic5/behavior.test.ts:206-221`. Factor the common prefix before divergent-rename
  detection and promote the suffix case.
- COVERAGE — INSUFFICIENT. Permanent tests cover identical structural programs and
  patches performed after the shared rename, but not equivalent direct/chain programs,
  different temporary swap names, pre/post-rename patch ordering, or a shared prefix plus
  one-sided structural suffix. The committed common-rename and sibling-rename goldens
  therefore prove narrower programs than the claim.
- SURVIVED. An identical shared two-hop chain plus source full write composed cleanly;
  overlapping edits after an exact common rename produced one `edit-edit` conflict with
  the original-path base reference; and a shared rename plus source suffix against a
  target edit produced one complete conflict without partial adoption. Three rename
  components connected transitively through directory-create/remove operations replayed
  in order, and editing one input rejected the whole component with no partial changes.
  All promoted prior counterexamples passed in the focused committed suite (five files /
  27 tests), and a scrubbed cold clone passed `verify-E1-T10` (13 files / 113 tests;
  seven official-focused files / 33 tests).
- SENSITIVITY — SURVIVED FOR COVERED CLAIMS. Isolated sabotages of common-prefix
  alignment, causal component union, original base-path mapping, and committed evidence
  order checks made their intended tests or verifier fail. The apparatus measures those
  covered behaviors, but has no sensor for the three refutations above.
- EVIDENCE. `node tools/verify/e1_t10_evidence.mjs` passed all committed digests and
  mutations, including common-rename digest `1eb95e90d83a14a812fc4391a1f939e9d0208c8a1a28e006ab563602534d27be`
  and sibling-rename digest `38956280bd5d5e81fb009c8ba9e4185a0fa9f9eab38ab34c75c6a22866071a55`.
  The evidence is valid for its exact histories but insufficient for the broader claim.
- Replay: N/A (protocol, CLI, and server-internal behavior with no browser surface) +
  mitigation accepted: official `DurableStreamTestServer` counterexamples, exact stream
  heads and digests, real CLI processes, cold-clone gates, committed goldens, and
  independent mutation sensitivity.
- SUITE: retain the passing promoted regressions. The failing diagnostics remain under
  ignored `work/critic5/`; promote them only after all three semantics are corrected.

Commands: `pnpm exec vitest run --config
.eforest/tasks/epic-1-the-trunk/E1-T10-three-way-merge-conflicts/work/critic5/vitest.config.ts`;
targeted shared-rename patch, suffix, and transitive-component probes; `pnpm exec vitest
run packages/streamfs/test/three-way-merge-adversarial.integration.test.ts
packages/streamfs/test/three-way-merge.integration.test.ts
packages/streamfs/test/three-way-merge.test.ts packages/cli/src/materialize.test.ts
packages/cli/src/official.integration.test.ts`; `node tools/verify/e1_t10_evidence.mjs`;
`tools/verify/cold_clone.sh --keep verify-E1-T10`. Submission: `09e474f`.

### 2026-07-14 — builder — equivalent rename-history rework implemented

- Rework implementation commit: `78f7692` (`fix: align equivalent rename histories`).
  Patch-only classification now follows a file through every pre/post-rename alias, so
  disjoint edits on opposite sides of a shared rename compose without weakening the
  full-write refusal. Rename alignment projects each side's complete structural program
  from the fork base and compares final identity, allowing direct/two-hop chains and
  swaps with different temporary paths to converge semantically. Divergent programs
  remain conflicts under the component planner, while an exact shared prefix plus a
  source-only suffix is adopted cleanly.
- Permanent official-server tests cover both pre/post-rename patch directions, both
  direct/chained structural directions with source content, target/source content after
  different-temporary swaps, the shared-prefix/source-suffix case, and a genuinely
  divergent rename control. The complete suite now passes 13 files / 119 tests; the
  seven official-focused files pass 38 tests.
- Final recorded command: `CI=true make verify-E1-T10` at `78f7692`. It exited 0 after
  format, lint, typecheck, full tests, build, the official focused suite, evidence
  verification, self-check, and task listing (`verify-E1-T10: OK`).
- Evidence: `evidence/e1-t10-cross-rename-patches.jsonl` and its source log double-replay
  to `4921dace23fa14eae0cc4e84e776c6fc388512c2e2010d6c02d36d5847651398`, contain one
  final-path patch, and materialize both the pre-rename target edit and post-rename source
  edit. `evidence/e1-t10-equivalent-renames.jsonl` and its source log double-replay to
  `b04abc28904e21105d659ee96791b85532b318405ce8599a2eddbc6a44dbbdb4`, retain the
  source's two-hop history, omit the semantically equivalent structure from the merge
  delta, and materialize the adopted source bytes. The verifier also re-earned all prior
  E1-T10 digests and mutation failures.
- Claim: transformed path histories and structurally different but identity-equivalent
  rename programs now merge their remaining content or structural delta deterministically,
  while truly divergent destinations and non-patchable histories remain explicit,
  head-neutral conflicts across replay, materialization, snapshot, and live-server paths.
- Replay: N/A (protocol, CLI, and server-internal merge behavior with no browser surface)
  - mitigation: official `DurableStreamTestServer` event logs, exact live/double-replay
    digests, real `ef materialize` and `ef replay` processes, committed byte-bearing
    goldens, branch-direction matrices, divergent controls, and mutation sensitivity.

### 2026-07-14 — critic

VERDICT: refuted

- P0 shared-prefix/source-suffix atomicity — FAILED. Predicted that shared `a.txt → b.txt`
  followed by a target full write at `b.txt` and source-only suffix `b.txt → c.txt` would
  produce one complete rename conflict and no related change. Planning was head-neutral,
  but returned a `delete-edit` conflict at `b.txt` plus `fs.file.create(c.txt)` and
  `fs.file.write(c.txt)`. Applying that accepted plan produced matching live/receipt digest
  `fcd451431667b283360703fc8bd3345663296e2f457a5e1270a41301a216fe07`, listed both
  paths, and made reads of both files fail with `full write has no content event matching
f34848ca…/5`. The aligned-but-unsafe component is discarded at
  `packages/streamfs/src/merge.ts:489-490`; later path-local adoption and conflict filtering
  at `:853-873,952-964` no longer know that `b.txt` and `c.txt` are one identity. Reject
  and exclude the whole causal component, then prove read, replay, snapshot, and materialize.
- P1 identity-scoped patch classification — FAILED. Predicted disjoint patches on one
  inherited identity would compose even when a renamed-away path or replacement destination
  was reused by another identity's full write. Three independent official-server attacks
  instead returned zero changes and one `edit-edit/non-patchable` conflict: a new file at
  the pre-rename path, a discarded destination occupant, and a full write to the other
  identity in an equivalent swap. `mutationPathAliases` closes rename endpoints
  bidirectionally as path strings at `packages/streamfs/src/merge.ts:135-162`, so the write
  check at `:164-177` cannot distinguish identity handoffs or path reuse. Track an
  event-ordered identity cursor and promote replacement, reuse, swap cross-talk, and
  intermediate-alias regressions.
- P1 divergent-directory evidence — FAILED. Predicted `original → target-dir` versus
  `original → source-dir` would cite the actual directory nodes in its explicit conflict.
  The plan correctly emitted zero changes and one rename conflict, but both side references
  were `{kind: "missing", path: "original"}`. Rejected components resolve moved identities
  only for files at `packages/streamfs/src/merge.ts:493-501`; preserve actual target/source
  directory destinations and promote the divergent-directory control.
- COVERAGE — INSUFFICIENT. The new goldens exercise one happy pre/post-rename patch and one
  direct/two-hop content adoption, but no path reuse, replacement occupant, mixed
  conflict-plus-suffix, or divergent directory references. The promoted suite therefore
  executes the new alias traversal without proving its identity boundary, and it omitted a
  prior source-suffix-over-target-edit survivor. Each counterexample remains under ignored
  `work/critic6-*` until a human authorizes rework and the permanent suite proves it.
- SURVIVED. Both direct/two-hop patch directions, clean different-temporary swaps, exact
  shared-prefix suffix adoption, and a transient create/delete direct-versus-chain control
  behaved deterministically. `node tools/verify/e1_t10_evidence.mjs` reproduced every
  committed digest, including cross-rename `4921dace23fa14eae0cc4e84e776c6fc388512c2e2010d6c02d36d5847651398`
  and equivalent-rename `b04abc28904e21105d659ee96791b85532b318405ce8599a2eddbc6a44dbbdb4`.
  The focused suite passed five files / 33 tests; a scrubbed cold clone of exact submission
  `959b19b` passed 13 files / 119 tests, seven official-focused files / 38 tests, build,
  evidence, and self-check. No skips, mocks, suppressions, or environment coupling were
  found. Sabotage made each new verifier/CLI sensor fail, so the recorded happy paths are
  valid but insufficient.
- LOOP — HALTED. This is the sixth refutation after five reworks, beyond the default two-
  rework budget in `.eforest/loop.md`. Project state is `invalid_loop` with reason
  `retry-budget-exhausted`; no automatic rework or later queue item may start without a
  human transition.
- Replay: N/A (protocol, CLI, and server-internal behavior with no browser surface) +
  mitigation accepted: independent official `DurableStreamTestServer` counterexamples,
  exact heads/digests, real CLI processes, scrubbed cold clone, committed goldens, and
  mutation sensitivity.
- SUITE: retain the passing regressions and goldens. Do not promote a verification verdict;
  the three failing diagnostic families must become permanent tests if human-directed
  rework resumes.

Commands: `node tools/verify/e1_t10_evidence.mjs`; `pnpm exec vitest run
packages/streamfs/test/three-way-merge-adversarial.integration.test.ts
packages/streamfs/test/three-way-merge.integration.test.ts
packages/streamfs/test/three-way-merge.test.ts packages/cli/src/materialize.test.ts
packages/cli/src/official.integration.test.ts`; critic configs under `work/critic6-judge/`
and `work/critic6-behavior/`; scrubbed cold-clone `CI=true make verify-E1-T10` at
`959b19b`. Submission: `959b19b`.

### 2026-07-14 — builder — identity-scoped merge-history rework implemented

- Human override commit `300627d` returned the project from `invalid_loop` to `building`
  without changing the task's acceptance criteria, gates, or evidence requirements.
  Implementation commit `d647233` (`fix: track merge histories by identity`) replaces
  the undirected alias closure with an event-ordered identity cursor: patches and full
  writes are classified only at the identity's path at that point in history; renames
  advance the cursor; deletion terminates it; reuse of a vacated path by another identity
  cannot taint the moved file.
- Structurally aligned components now fall through to byte composition only when the
  remaining delta is content-only. A colliding rename/delete/directory suffix rejects
  and excludes the entire causal component, preventing path-local partial adoption.
  Rejected components carry original, target, and source paths by replaying branch
  structure, so divergent directory conflicts cite their actual destination nodes.
- Permanent official-server regressions cover intermediate aliases, path reuse by an
  unrelated full-written identity, a discarded replacement occupant, both pre/post
  rename patch histories, the source-suffix-over-target-edit atomic conflict, and actual
  divergent-directory references. They exercise reads, raw replay, snapshots/bootstrap,
  and exact conflict/change shapes.
- Final recorded command: `CI=true make verify-E1-T10` at `d647233`. It exited 0 after
  format, lint, typecheck, 13 test files / 122 tests, build, seven official-focused files
  / 40 tests, evidence verification, self-check, queue listing, and
  `verify-E1-T10: OK`.
- Evidence: `evidence/e1-t10-alias-reuse.jsonl` plus its source log double-replay to
  `b124bf4e30bc9cabf7ad63810aebddd766345fa598c155afc0e27e86fe880768`, prove one
  identity-scoped patch while materializing both the unrelated replacement at `a.txt`
  and the two-sided merged identity at `b.txt`. `evidence/e1-t10-suffix-conflict.jsonl`
  plus its source log double-replay to
  `6982c8356a0f00af78c235b26d005513998117af23d4ebe5b613b4ac73f09728`, contain zero
  accepted changes, one original/target/source rename conflict, readable target bytes,
  and no `c.txt`. Real `ef replay` and `ef materialize` consume both logs.
- Claim: merge history is identity- and chronology-scoped across aliases, structural
  conflict rejection is component-atomic, and explicit conflict references remain
  sufficient for files and directories across live reads, replay, snapshot, and CLI
  materialization.
- Replay: N/A (protocol, CLI, and server-internal merge behavior with no browser surface)
  - mitigation: official `DurableStreamTestServer` event logs, exact live/double-replay
    digests, real `ef replay` and `ef materialize` processes, committed byte-bearing
    goldens, head-neutral diagnostics, and all prior mutation-sensitivity checks.

### 2026-07-14 — critic

VERDICT: refuted

- P0 same-byte replacement identity — FAILED. Predicted that a source delete/recreate
  of inherited `doc.txt` with byte-identical content but a distinct content-stream
  identity, against a target patch to the inherited node, would surface an explicit
  non-patchable conflict. Two fresh official-server probes proved distinct stream ids
  and tree digests, but planning returned `changes=[]`, `conflicts=[]`; applying and
  replaying the plan silently retained the target identity and bytes. `equalNode`
  compares only digest and size, and the source-equals-base shortcut then discards the
  replacement. Citations: `packages/streamfs/src/merge.ts:78-85,880-889`;
  `work/critic7-behavior/behavior.test.ts:238-280`; independent judge diagnostic
  `work/critic7-judge/attacks.test.ts`. Make existing-node equality identity-sensitive
  so no branch replacement can be silently selected.
- P1 structural identity isolation — FAILED. Predicted that equivalent two-hop rename
  programs ending at `c.txt` would still compose disjoint patches when the target
  reused vacated `a.txt` for an unrelated full-written identity. The head-neutral plan
  instead emitted one `rename-rename/non-patchable` conflict and zero changes. In a
  second family, after a shared parent `old -> new`, a target patch to one child and
  source-only sibling rename, file delete, directory create, or directory remove were
  each directly reducer-valid yet all falsely conflicted at `old`. Path-overlap
  component selection and final whole-subtree comparison still conflate unrelated
  identities and siblings. Citations: `packages/streamfs/src/merge.ts:406-490`;
  `work/critic7-behavior/behavior.test.ts:283-359`; independent judge equivalent-chain
  and sibling diagnostics. Scope alignment and final comparison to the causal identity
  paths while retaining atomic rejection for genuinely overlapping components.
- P1 conflict-reference sufficiency — FAILED. Shared `a -> b` plus target-only
  `b -> c` versus a source edit cited target `{missing,b.txt}` rather than the actual
  `c.txt` file; target directory `src -> lib` versus a source nested edit likewise
  cited missing `src/notes.txt` rather than `lib/notes.txt`. In the reverse replacement
  direction, shared rename plus target edit plus source `delete; spare -> live` cited a
  missing original source path for both file and directory cases, not the actual
  replacement at `live`. Atomic zero-change rejection survived, but the references do
  not identify the conflicting nodes. Citations:
  `packages/streamfs/src/merge.ts:342-358,393-400,495-522,873-958`;
  `work/critic7-behavior/behavior.test.ts:68-149`; independent judge moved-target and
  replacement-reference diagnostics. Resolve each side by event-ordered identity and
  occupancy, in both branch directions.
- COVERAGE — INSUFFICIENT. Removing identity-deletion termination or the final-path
  guard at `packages/streamfs/src/merge.ts:148-160` left the permanent focused suite
  green; a fresh official-server delete-plus-rename-reuse attack caught both sabotages
  by exposing an illicit clean patch. Reverting rejected-root expansion at `:521`
  also left the entire adversarial file green. Promote
  `work/critic7-cold/deletion-edge.test.ts`, add an ancestor-directory-removal variant,
  and add a permanent sensor for every rejected root (or remove redundant roots).
- EVIDENCE — SURVIVED FOR THE RECORDED HISTORIES. The verifier reproduced every golden
  and mutation flag, including alias-reuse digest
  `b124bf4e30bc9cabf7ad63810aebddd766345fa598c155afc0e27e86fe880768`
  and suffix-conflict digest
  `6982c8356a0f00af78c235b26d005513998117af23d4ebe5b613b4ac73f09728`.
  Real CLI materialization consumed both. The official-focused suite passed seven files /
  40 tests serially. Equivalent directory-alias patches composed, a rejected rename
  component remained local while an independent file merged, prior terminal-merge
  expansion composed, and cursor advancement, remaining-structure rejection, path
  projection, golden, and CLI sabotages all turned their intended sensors red.
- COLD GATE — FLAKY. The first scrubbed exact-`43a931b` cold clone exited 2 with
  119/122 tests because three adversarial cases hit the fixed 5000 ms aggregate timeout;
  every case and the whole adversarial file passed alone. One controlled fresh cold clone
  then passed 13 files / 122 tests, seven focused files / 40 tests, build, evidence,
  self-check, and `verify-E1-T10: OK`. This is not a semantic counterexample, but the
  next submission must re-earn a stable deterministic cold gate without weakening or
  merely inflating the timeout.
- LOOP — CONTINUES. Human override commit `300627d` remains authoritative, so this new
  refutation returns E1-T10 to `in-progress` while the project stays `building`; no
  later queue task is eligible. These are new counterexamples, not a reason to reinstate
  `invalid_loop` solely from the historical retry count.
- Replay: N/A (protocol, CLI, and server-internal behavior with no browser surface) +
  mitigation accepted: independent official `DurableStreamTestServer` counterexamples,
  exact heads/digests, real CLI processes, scrubbed cold clones, committed goldens, and
  mutation sensitivity.
- SUITE: retain the valid promoted regressions and goldens. Promote the failing
  diagnostics only after all refutations clear; do not publish this submission.

Commands: `node tools/verify/e1_t10_evidence.mjs`; serial and isolated
`pnpm exec vitest run` over the seven official-focused files; real CLI materialization
test; independent configs under `work/critic7-judge/` and `work/critic7-behavior/`;
two scrubbed exact-`43a931b` cold clones; disposable coverage sabotages. Submission:
`43a931b`.

### 2026-07-14 — builder — implemented

- Implementation commit: `a62ff2145a47bc1b026eb8792a3a0cd4bb64e915`
  (`fix: isolate merge planning by causal identity`). Existing-file equality now includes
  the content-stream identity, so byte-identical delete/recreate histories cannot take the
  source-equals-base shortcut. Structural alignment follows base identities through every
  target rename rather than selecting by path overlap, and final convergence is scoped to
  the remaining source program's roots rather than an unrelated renamed parent subtree.
- Conflict references resolve each base file by live content-stream identity, then by the
  side's event-ordered projected path and actual occupancy. Shared-rename suffix conflicts,
  target file/directory moves, and file/directory replacements now cite live base, target,
  and source nodes. The unproven rejected-root expansion and unreachable non-empty ancestor
  `dir.remove` identity guard were removed instead of retained without a sensitivity proof.
- Permanent `DurableStreamTestServer` coverage in
  `packages/streamfs/test/three-way-merge-identity-boundaries.integration.test.ts` adds 11
  tests: same-byte replacement identity, three-hop equivalent rename plus vacated-alias
  reuse, shared-parent disjoint rename/delete/directory-create/directory-remove suffixes,
  moved target file and descendant references, live file/directory replacement references,
  and delete-plus-terminal-path reuse. The focused official matrix now contains eight files
  / 51 tests. The critic's exact behavior matrix passed 10/10 and judge matrix passed 8/8.
- Sensitivity: a disposable combined sabotage removed identity equality, deletion/final-path
  guards, causal target-step selection, suffix-local convergence, and live-reference
  resolution. Nine of the 11 promoted tests failed for the predicted reasons; restoring the
  implementation returned the file to 11/11. The pre-existing bisect corpus test was split
  into per-fixture cases, preserving every malformed-input assertion and the unchanged
  5000 ms timeout; its isolated file passed 14/14 in 20.15 s.
- Final recorded command: `CI=true make verify-E1-T10` at `a62ff21`. It exited 0 after
  format, lint, typecheck, 14 files / 140 tests, build, eight official-focused files / 51
  tests, evidence verification, self-check, queue listing, and `verify-E1-T10: OK`.
  All committed goldens reproduced, including alias-reuse digest
  `b124bf4e30bc9cabf7ad63810aebddd766345fa598c155afc0e27e86fe880768`
  and suffix-conflict digest
  `6982c8356a0f00af78c235b26d005513998117af23d4ebe5b613b4ac73f09728`.
- Cold clone: `tools/verify/cold_clone.sh --keep verify-E1-T10` cloned exact
  `a62ff2145a47bc1b026eb8792a3a0cd4bb64e915` into
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.Q4VrClcVuX` with scrubbed
  `NODE_OPTIONS`, `NODE_ENV`, and `npm_config_*`; it passed 14/140, focused 8/51, build,
  all evidence checks, self-check, and the queue target without increasing any timeout.
- Claim: merge planning is identity-sensitive across replacement and path-reuse histories;
  structurally equivalent programs ignore unrelated occupants; disjoint suffixes below a
  shared parent compose; true conflicts remain component-atomic and cite the live node on
  every side. The same deterministic event/replay/CLI evidence layer remains green.
- Replay: N/A (protocol, CLI, server-internal merge behavior and test-harness stabilization
  have no browser-reachable surface) + mitigation: official `DurableStreamTestServer`
  event histories, exact live/replay digests, real `ef replay`/`ef materialize`, committed
  byte-bearing goldens, head-neutral critic diagnostics, a scrubbed cold clone, and a
  nine-failure mutation-sensitivity proof.

### 2026-07-14 — critic

VERDICT: refuted

- P1 source transient-alias identity isolation — FAILED. Predicted that target direct
  `A: a -> c` and source equivalent `A: a -> temporary -> c`, followed by the unrelated
  source-only move `B: other -> temporary`, would preserve the equivalent A move and
  adopt only B's residual rename. Repeated official-server plans instead returned
  `changes=[]` plus one stable `rename-rename/non-patchable` conflict at `a`; file,
  directory, disjoint-patch, and three-hop/two-reused-alias variants all failed with both
  heads unchanged. Removing the unrelated occupancy produced the expected residual
  rename, whose apply/read/double-replay/snapshot/bootstrap digest was
  `69496c5717c452f1943c67979ea51be96dffa5a3ecbcd9285795d9f6d7b111ff`.
  `renameComponents` unions rename endpoints by path overlap before chronology or identity
  exists, so the later identity-aware selection cannot separate a vacated alias's new
  occupant. Citations: `packages/streamfs/src/merge.ts:239-280,485-604` and outer task
  diagnostic `work/e1-t10-critic8-behavior/behavior.test.ts:71-221`. Build components
  from event-ordered identities and promote the file/directory plus multi-alias matrix.
- P1 causal structural scaffolds — FAILED. Predicted disjoint patches to compose when
  both sides move the same inherited file to `final/a.txt` through different temporary
  directory programs, and when one side uses atomic `old -> new` while the other uses
  the equivalent `mkdir new; old/a.txt -> new/a.txt; rmdir old`. Both target/source
  orientations in each family returned `changes=[]` and one
  `rename-rename/non-patchable` conflict despite identical final structure and live
  conflict references. Target structural selection keeps zero-original `fs.dir.create`
  only when its serialized change exactly matches the source program; a differently named
  but required scaffold is omitted, so structural projection cannot prove equivalent
  identity programs. Citations: `packages/streamfs/src/merge.ts:347-399,507-527` and
  `work/critic8-judge/attacks.test.ts:46-119`. Track causal support operations, then prove
  both orientations preserve both edits and replay to one digest.
- COVERAGE — INSUFFICIENT. The promoted identity-boundary file exercises target-side
  vacated-alias reuse and exact shared-parent suffixes, but no source-side transient reuse
  after an identity leaves the alias and no equivalent program requiring a non-identical
  directory scaffold. The permanent 140-test suite remained green while both fresh
  families failed. Promote both diagnostics and add mutation sensors that make chronology-
  free component union and scaffold omission go red.
- SURVIVED. Existing-file identity equality, delete termination, causal target-step
  selection, suffix-local convergence, and live reference projection each retained a
  red sabotage sensor. Same-content target writes intentionally remained semantic no-ops
  without losing the target offset, while a source-side same-byte identity handoff was
  explicitly adopted. The core clean/overlap/binary/reference-corruption/race controls,
  existing identity/reference matrix, and committed evidence verifier all passed.
- COLD GATE — PASSED. A pristine scrubbed clone of exact submission `e221175` passed
  `verify-E1-T10`: 14 files / 140 tests, eight official-focused files / 51 tests, build,
  evidence, self-check, queue listing, and `verify-E1-T10: OK`. The verdict rests on
  semantic counterexamples, not gate instability.
- LOOP — CONTINUES. Human override `300627d` remains authoritative. E1-T10 returns to
  `in-progress` while the project stays `building`; historical retry count alone does not
  restore `invalid_loop`, and no later task is eligible.
- Replay: N/A (protocol, CLI, and server-internal behavior with no browser surface) +
  mitigation accepted: independent official `DurableStreamTestServer` counterexamples,
  exact heads/digests, real CLI/evidence processes, scrubbed cold clone, committed goldens,
  and sabotage sensitivity.
- SUITE: retain the valid promoted regressions and goldens. Promote the two failing
  diagnostic families only after the implementation corrects both causal boundaries; do
  not publish this submission.

Commands: `node tools/verify/e1_t10_evidence.mjs`; official behavior config under outer
task `work/e1-t10-critic8-behavior/`; `pnpm exec vitest run --config
work/critic8-judge/vitest.config.ts`; scrubbed `tools/verify/cold_clone.sh --keep
verify-E1-T10`; isolated implementation sabotages. Submission: `e221175`.

### 2026-07-14 — builder — implemented

- Implementation commit: `8983c460c094608394696b953daeaf44c7d2f237`
  (`fix: trace merge programs by causal identity`). Merge planning now traces the logical
  file or directory occupying each path at each event. Components join through moved
  identities, replacement/swap dependencies, created parents, and directory cleanup—not
  raw endpoint overlap—so a later occupant of a vacated temporary alias remains disjoint.
- Structural alignment distinguishes the identity actually moved from destination
  dependencies used only to keep atomic programs together. A closure over the target's
  causal graph selects differently named `mkdir` scaffolds required by an equivalent
  final structure. Patch-generated `fs.file.create` records retain the inherited logical
  identity unless a real delete first terminated it. The unproven live identity-search
  fallback was deleted; event-ordered projection and actual occupancy cover every
  permanent reference case.
- Permanent official-server coverage grew from 11 to 19 identity-boundary tests. New
  cases cover source-side transient reuse for files and directories, patched one- and
  two-alias histories, differently named directory scaffolds in both orientations, and
  atomic-directory versus decomposed-child moves in both orientations. Plans are
  repeated head-neutrally, applications preserve both edits, and raw logs replay twice
  to the receipt digest; the source log remains unchanged where asserted.
- Sensitivity: adding chronology-free raw path tokens made all four transient-reuse tests
  fail; treating patch-generated file creates as new logical identities made all three
  patch-chain tests fail; reducing scaffold selection to one forward pass made three of
  four scaffold cases fail. Restoring the implementation returned the promoted file to
  19/19.
- Final recorded command: `CI=true make verify-E1-T10` at `8983c46`. It exited 0 after
  format, lint, typecheck, 14 files / 148 tests, build, eight official-focused files / 59
  tests, evidence verification, self-check, queue listing, and `verify-E1-T10: OK`.
  Existing committed goldens reproduced, including alias-reuse digest
  `b124bf4e30bc9cabf7ad63810aebddd766345fa598c155afc0e27e86fe880768`
  and suffix-conflict digest
  `6982c8356a0f00af78c235b26d005513998117af23d4ebe5b613b4ac73f09728`.
- Cold clone: `tools/verify/cold_clone.sh --keep verify-E1-T10` cloned exact
  `8983c460c094608394696b953daeaf44c7d2f237` into
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.jQd0Vn25JK` with scrubbed
  `NODE_OPTIONS`, `NODE_ENV`, and `npm_config_*`; it passed 14/148, focused 8/59, build,
  all evidence checks, self-check, and queue validation.
- Claim: equivalent structural programs are aligned by causal node identity even when
  their temporary aliases and directory scaffolds differ; vacated aliases can be reused
  by unrelated identities without false conflicts; disjoint patches still compose; and
  swaps, replacements, cleanup, true conflicts, replay, and references retain their
  prior deterministic guarantees.
- Replay: N/A (protocol, CLI, and server-internal merge behavior has no browser-reachable
  surface) + mitigation: official `DurableStreamTestServer` histories, double replay and
  receipt digests, real CLI/evidence processes, committed goldens, three mutation
  sensitivity families, and a scrubbed exact-commit cold clone.

### 2026-07-14 — critic

VERDICT: refuted

- P1 created-sibling isolation — FAILED. Predicted that one source-created file renamed
  onto an independently created target file would surface its explicit conflict without
  suppressing a second clean source-created sibling under the same inherited directory.
  A fresh official-server run from base directory `d` instead returned stable
  `changes=[]` plus one `rename-rename/non-patchable` conflict for `d/final.txt`, silently
  omitting the independently valid `d/clean.txt` write/create. Repeated planning was
  head-neutral. Removing the conflicting rename made nested `d/clean.txt` merge, and
  retaining the conflict while moving the clean add to root also merged and replayed to
  the receipt digest, isolating the failure to shared-parent coupling. Every create adds
  the unchanged base parent identity at `packages/streamfs/src/merge.ts:346-357`; causal
  closure then joins all siblings sharing it at `:395-429`, and the rejected rename
  component absorbs those non-rename steps at `:636-644`. Citation:
  `work/e1-t10-critic9-behavior/behavior.test.ts:41-76`. Keep supporting-parent
  dependencies for scaffold ordering without treating an unchanged inherited parent as
  ownership of every created child; promote the conflict-plus-clean-sibling regression.
- COVERAGE — INSUFFICIENT. Permanent new-content cases create at repository root, while
  shared-parent create coverage belongs to an inherited parent rename. No test proves
  that independently created siblings under an unchanged inherited directory remain in
  separate causal components. The full 148-test submission stayed green while the fresh
  official-server counterexample failed.
- COLD GATE — FLAKY/FAILED. Exact submission `ea2385a` in a scrubbed cold clone exited 2
  with 146/148 tests: `packages/cli/src/materialize.test.ts:403` completed in 5539 ms and
  `packages/cli/src/bisect.test.ts:85` in 6360 ms against fixed 5000 ms test budgets. Both
  files immediately passed together, 22/22 in 21.67 s, so this is contention-sensitive
  gate instability rather than a semantic counterexample; nevertheless the required
  deterministic cold gate was not re-earned and repeats the prior warning.
- SURVIVED. The judge's six predicted official-server controls passed: recreated
  directory-alias reuse, a source-only three-file cycle, equivalent directory
  decomposition with both ordinary and newly created unrelated siblings, and the two
  created-sibling isolation controls all applied/read/replayed to their receipt digests.
  The behavior critic's transient-alias control produced the exact residual rename. The
  structural-vs-destination dependency sensor, transient aliases, patch handoff, scaffold
  closure, replacement references, existing goldens, and source-head immutability remain
  exercised. No skips, TODOs, lint suppressions, environment-conditioned merge semantics,
  or replacement server mocks were found.
- LOOP — CONTINUES. Human retry override `300627d` remains authoritative. E1-T10 returns
  to `in-progress` and the project stays `building`; historical retry count alone does
  not restore `invalid_loop`, and E1-T11 remains blocked.
- Replay: N/A (protocol, CLI, and server-internal behavior with no browser surface) +
  mitigation accepted: independent official `DurableStreamTestServer` counterexamples,
  deterministic plans, exact heads, apply/read/snapshot/replay controls, committed
  goldens, mutation sensitivity, and the scrubbed cold-clone attempt.
- SUITE: retain the valid promoted causal-identity regressions and goldens. Promote the
  created-conflict-plus-clean-sibling diagnostic only after it passes with apply/read and
  double-replay digest agreement; do not publish this submission.

Commands: `pnpm exec vitest run --config
.eforest/tasks/epic-1-the-trunk/E1-T10-three-way-merge-conflicts/work/e1-t10-critic9-behavior/vitest.config.ts`;
judge predictions and six controls under `work/e1-t10-critic9-judge/`;
`tools/verify/cold_clone.sh --keep verify-E1-T10`; isolated materialize/bisect rerun.
Submission: `ea2385a` (implementation `8983c460c094608394696b953daeaf44c7d2f237`).

### 2026-07-14 — builder — implemented

- Implementation commit: `c511e0c9f1da23527a274b759cbf2170fc5dd2ec`
  (`fix: isolate created merge siblings`). New file and directory creates no longer
  inherit their unchanged containing directory as causal ownership. Required scaffolds
  remain connected through the identities that a real rename moves, so rejected rename
  components cannot absorb independent clean siblings merely because both were created
  under the same pre-existing directory.
- The critic-9 counterexample is now a permanent official-server regression in
  `packages/streamfs/test/three-way-merge-identity-boundaries.integration.test.ts`.
  Repeated plans retain one explicit `d/final.txt` conflict plus the independent
  `d/clean.txt` write/create; applying the plan preserves exact bytes, leaves the source
  unchanged, and two raw-log replays reproduce the receipt digest. The promoted causal
  identity suite passes 20/20.
- Sensitivity: temporarily restoring inherited-parent coupling made the new regression
  fail because `d/clean.txt` disappeared from `changes`; restoring the implementation
  returned the promoted suite to 20/20.
- The two previously flaky CLI aggregates were split into individually named cases
  without weakening their assertions or increasing the unchanged 5000 ms per-test
  timeout. Materialization still executes all 11 fixtures. Bisect still executes the
  committed malformed corpus plus all 225 generated cases across nine deterministic
  seed ranges, with explicit range-coverage assertions.
- Final recorded command: `CI=true make verify-E1-T10` at `c511e0c`. It exited 0 after
  format, lint, typecheck, 14 files / 170 tests, build, eight official-focused files / 60
  tests, evidence verification, self-check, queue listing, and `verify-E1-T10: OK`.
  Existing goldens reproduced, including alias-reuse digest
  `b124bf4e30bc9cabf7ad63810aebddd766345fa598c155afc0e27e86fe880768` and
  suffix-conflict digest
  `6982c8356a0f00af78c235b26d005513998117af23d4ebe5b613b4ac73f09728`.
- Two independent scrubbed exact-commit cold clones passed every gate without timeout
  changes. `tools/verify/cold_clone.sh --keep verify-E1-T10` verified 14/170 full tests
  and 8/60 focused tests in
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.r6cariIaeq` and
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.y1Lkw0kKnN`.
- Claim: causal merge components now connect changes only through actual moved or
  replaced identities and their required scaffolds. A genuine created-file rename
  conflict remains explicit while an unrelated created sibling under the same inherited
  directory applies and replays independently; prior alias, patch, scaffold, conflict,
  race, materialization, and digest guarantees remain intact.
- Replay: N/A (protocol, CLI, and server-internal merge behavior has no browser-reachable
  surface) + mitigation: official `DurableStreamTestServer` histories, double replay and
  receipt digests, real CLI/evidence processes, committed goldens, mutation sensitivity,
  and two scrubbed exact-commit cold clones.

### 2026-07-14 — critic

VERDICT: refuted

- P1 newly-created-parent conflict locality — FAILED. Predicted that two matching
  post-fork directory scaffolds would remain alignable when a source-created file is
  renamed onto a target-created file: the true `d/final.txt` collision should be explicit
  while independent `d/clean.txt` still applies. Two fresh official-server attacks instead
  returned one broad conflict at the newly created parent and `changes=[]`; repeated plans
  left both heads unchanged. Removing only the rename localized the conflict and let the
  clean child apply/read/double-replay, proving same-path directory creation is not itself
  subtree-atomic. Citations:
  `work/e1-t10-critic10-behavior/behavior.test.ts:91-128` and the nested reproduction at
  `work/e1-t10-critic10-judge/attacks.test.ts:59-118`. Common created scaffolds remain in
  the rename program, simulation rejects the first already-present mkdir at
  `packages/streamfs/src/merge.ts:693-705`, and the resulting raw parent root excludes
  every descendant at `:1081-1088` and `:1191-1200`. Align matching scaffolds without
  widening a child conflict, then promote both depths.
- P1 vacated created-directory alias isolation — FAILED. Predicted that a rejected source
  directory move `temporary -> final` would not suppress a later, unrelated directory
  identity created at the now-vacant `temporary` path. The fresh official-server plan
  correctly surfaced the `final` file/directory conflict but returned `changes=[]`,
  dropping the later `temporary/clean.txt`; changing only the later alias to `reused`
  applied/read/double-replayed exactly. Citation:
  `work/e1-t10-critic10-behavior/behavior.test.ts:228-272`. Although causal tracing gives
  the later directory a distinct identity, rejected components export raw historical roots
  at `packages/streamfs/src/merge.ts:717-733`, and descendant exclusion ignores which
  identity occupies that path later at `:1081-1088`. Make rejection/exclusion identity-
  and chronology-aware, then promote the failing and control cases.
- COVERAGE — INSUFFICIENT. The new permanent regression proves only an unchanged inherited
  parent. It does not exercise a matching parent created on both sides or a new identity
  reusing a rejected component's vacated alias, so the full 170-test suite remained green
  while both independent counterexamples failed. The latest production removal, promoted
  regression, and CLI splits all executed; no dead production hunk was found.
- COLD GATE — PASSED. A scrubbed clone of exact submission `64fc33e` at
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.G2EIZwNwse` passed format, lint,
  typecheck, 14 files / 170 tests, build, eight focused files / 60 tests, evidence,
  self-check, queue validation, and the committed digests. Verbose CLI coverage enumerated
  all 11 bisect fixtures, nine 25-case chunks (225 total), and both split materialization
  rows under the unchanged 5000 ms default timeout. The inherited-parent sabotage made the
  promoted regression fail and was fully restored. No skips, TODOs, suppressions,
  replacement server mocks, or environment-conditioned semantics were found.
- SURVIVED. The inherited-parent promoted case passed 20/20 with its surrounding identity
  suite. Fresh common-renamed-parent and both file/directory sibling orientations preserved
  clean changes, bytes, source-head neutrality, and receipt/double-replay digests. Six
  additional behavior families survived; the refutation is confined to rejected programs
  crossing newly created scaffolds or path aliases whose occupant changes later.
- LOOP — CONTINUES. The human retry override remains authoritative. E1-T10 returns to
  `in-progress`, the project stays `building`, historical retry count alone does not restore
  `invalid_loop`, and E1-T11 remains blocked.
- Replay: N/A (protocol, CLI, and server-internal behavior with no browser surface) +
  mitigation accepted: independent official `DurableStreamTestServer` counterexamples,
  exact heads, apply/read/double-replay controls, committed goldens, scrubbed cold clone,
  and mutation sensitivity.
- SUITE: retain the valid promoted regression, CLI test splits, and existing goldens. Do
  not promote the two failing diagnostics until both causal boundaries are corrected and
  recorded as deterministic successes.

Commands: `pnpm exec vitest run --config
.eforest/tasks/epic-1-the-trunk/E1-T10-three-way-merge-conflicts/work/e1-t10-critic10-behavior/vitest.config.ts`;
`pnpm exec vitest run --config
.eforest/tasks/epic-1-the-trunk/E1-T10-three-way-merge-conflicts/work/e1-t10-critic10-judge/vitest.config.ts`;
`pnpm exec vitest run packages/streamfs/test/three-way-merge-identity-boundaries.integration.test.ts`;
`tools/verify/cold_clone.sh --keep verify-E1-T10`; verbose CLI coverage and inherited-parent
sabotage. Submission: `64fc33e` (implementation
`c511e0c9f1da23527a274b759cbf2170fc5dd2ec`).

### 2026-07-14 — builder — implemented

- Implementation commit: `f75e07985c1d894f77cbfbe7fb738e11b76ef331`
  (`fix: scope rejected renames by causal identity`). Causal tracing now returns the
  final logical identity occupying every source path. Accepted and rejected rename
  programs carry both their historical roots and the identities they actually own, so
  exclusion applies only while one of those identities still occupies a path (or the
  source truly removed it). A later independent occupant of a vacated alias therefore
  remains eligible for ordinary three-way adoption.
- Exact matching `fs.dir.create` prefixes now align the comparison base before a rename
  program is simulated. Independently created equivalent scaffolds no longer turn a
  nested file collision into a parent-wide conflict; the explicit conflict stays at the
  colliding final path while unrelated nested siblings apply normally.
- Three permanent official-server regressions promote both critic-10 findings and the
  renamed-alias control. They repeat plans head-neutrally, assert exact conflict
  locality, apply and read the clean occupant, preserve target conflict bytes and the
  complete source log, and reduce the target log twice to the receipt digest. The
  promoted identity-boundary suite passes 23/23; the original behavior and judge attack
  matrices pass 9/9 and 4/4.
- Sensitivity: removing created-directory prefix alignment made the nested regression
  fail with conflict path `d/new` instead of `d/new/nested/final.txt`. Replacing the new
  identity-aware exclusion with historical raw-root exclusion made the vacated
  `temporary` regression fail with `changes=[]`. Restoring both protections returned the
  focused promoted cases to 3/3.
- Final recorded command: `CI=true make verify-E1-T10` at `f75e079`. It exited 0 after
  format, lint, typecheck, 14 files / 173 tests, build, eight official-focused files / 63
  tests, evidence verification, self-check, queue listing, and `verify-E1-T10: OK`.
  Existing goldens reproduced, including alias-reuse digest
  `b124bf4e30bc9cabf7ad63810aebddd766345fa598c155afc0e27e86fe880768` and
  suffix-conflict digest
  `6982c8356a0f00af78c235b26d005513998117af23d4ebe5b613b4ac73f09728`.
- Cold clone: `tools/verify/cold_clone.sh --keep verify-E1-T10` cloned exact
  `f75e07985c1d894f77cbfbe7fb738e11b76ef331` with scrubbed environment into
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.5m85gLOovE`; it passed 14/173
  full tests, 8/63 focused tests, build, evidence, self-check, queue validation, and the
  committed digests.
- Claim: rejected rename programs are now bounded by causal identity and event-time
  occupancy instead of timeless path ancestry. Equivalent new scaffolds align before
  conflict detection, true child collisions remain explicit, clean siblings survive,
  and later identities may safely reuse vacated aliases without weakening prior rename,
  patch, replacement, race, CLI, replay, or digest guarantees.
- Replay: N/A (protocol, CLI, and server-internal merge behavior has no browser-reachable
  surface) + mitigation: official `DurableStreamTestServer` histories, exact conflict
  paths and source heads, apply/read/double-replay receipt digests, real CLI/evidence
  processes, committed goldens, two mutation-sensitivity failures, and a scrubbed
  exact-commit cold clone.

### 2026-07-14 — critic

VERDICT: refuted

- P1 sibling-collision completeness — FAILED. Predicted that two independent source-created
  file identities renamed onto `d/final-a.txt` and `d/final-b.txt` beneath the same exactly
  matching created parent would produce two local conflicts. The deterministic plan emitted
  only `d/final-a.txt`; `d/final-b.txt` was silently left at the target version while clean
  file and directory siblings applied/read/double-replayed. The created parent identity joins
  both rename components, and simulation stops the combined program at its first failure.
  Citations: `work/e1-t10-critic11-behavior/behavior.test.ts:90-135`;
  `packages/streamfs/src/merge.ts:325-330,395-429,715-757`. Keep independent child identities
  as independent rejected programs even when they share required scaffolding, then promote the
  two-collision case.
- P1 alias-generation isolation — FAILED. Predicted an accepted first directory generation,
  one rejected second generation at `blocked`, and an independently deleted/recreated third
  `temporary` occupant. The plan instead returned `changes=[]`, conflicts at `blocked` and
  spurious `temporary`, and the latter's source reference pointed at `accepted`; the valid
  accepted and clean generations were both lost. Citations:
  `work/e1-t10-critic11-behavior/behavior.test.ts:249-288`;
  `packages/streamfs/src/merge.ts:395-429,715-757`. Bound program membership, rejection, and
  references to the same event-time identity generation, then promote the mixed-generation
  sequence.
- P1 replacement occupant beneath a rejected historical root — FAILED. Predicted that a target
  edit to inherited `old/base.txt` would remain protected by the explicit `old` rename conflict
  while the source's later independent `old/clean.txt` occupant applied. The plan emitted the
  conflict but `changes=[]`; the raw conflict-ancestor filter discarded the identity-safe clean
  change after causal exclusion had admitted it. Citations:
  `work/e1-t10-critic11-behavior/behavior.test.ts:290-319`;
  `packages/streamfs/src/merge.ts:1219-1228`. Filter conflicted changes by causal identity and
  generation, not timeless path ancestry.
- P1 planned-versus-durable conflict parity — FAILED. Predicted that conflicts in the frozen
  plan would be the same unresolved conflicts after application and double replay. When rejected
  identity A was renamed to `final`, deleted, and `final` was recreated as independent identity
  B, the planner produced both `add-add` and `rename-rename` at the same path and attributed both
  source references to B. Application and two replays reached the exact receipt digest, but the
  durable reducer retained only `rename-rename`: conflict state is keyed by `mergeId + path`, so
  the planned `add-add` record was silently overwritten. Citations:
  `work/e1-t10-critic11-judge/attacks.test.ts:215-240`;
  `packages/streamfs/src/merge.ts:1085-1117,1190-1205`;
  `packages/streamfs/src/tree.ts:50-76`. Emit one truthful conflict per durable identity, or give
  distinct conflicts distinct durable identities and references; promote the extinct/recreated
  destination case.
- COLD/COVERAGE — PASSED. Exact submission `1523328` (implementation
  `f75e07985c1d894f77cbfbe7fb738e11b76ef331`) passed a scrubbed cold clone at
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.DMiB5oyeu7`: format, lint,
  typecheck, 14 files / 173 tests, build, eight focused files / 63 tests, evidence digests,
  self-check, and queue validation. Three independent sabotages were sensitive: removing
  created-directory alignment broadened the nested conflict, restoring raw-root exclusion
  removed the clean alias, and refusing missing-identity exclusion failed 9/23 identity tests.
  All mutations were restored, 23/23 passed, and no dead production hunk, skip, todo, suppression,
  substitute server, or environment-conditioned semantic was found.
- SURVIVED. Exact-prefix scaffolds with divergent descendants; two-hop file alias reuse;
  file-to-directory and directory-to-file alias reuse; delete/recreate at a vacated alias; and
  target-only alias preservation all kept deterministic/head-neutral plans, exact conflict
  locality, source immutability, applied bytes, and receipt/double-replay digests. The four
  behavior controls and permanent 23/23 identity suite also passed. Retain the three promoted
  critic-10 regressions, existing goldens, and sensitivity apparatus; promote the new failing
  diagnostics only after their semantics are corrected.
- LOOP — CONTINUES. The human retry override remains authoritative. E1-T10 returns to
  `in-progress`, the project stays `building`, historical retry count alone does not restore
  `invalid_loop`, and E1-T11 remains blocked.
- Replay: N/A (protocol, CLI, and server-internal behavior with no browser surface) +
  mitigation accepted: independent official `DurableStreamTestServer` counterexamples,
  deterministic plans, exact source logs and bytes, apply/read/double-replay receipts, committed
  goldens, a scrubbed exact-commit cold clone, and three mutation-sensitivity failures.
- SUITE: retain the existing promoted suite and evidence. Do not promote the four failing
  diagnostics until the sibling, generation, path-filter, and durable-conflict boundaries are
  corrected and recorded as deterministic successes.

Commands: `pnpm exec vitest run --config
/Users/brettlamy/Dev/electric-forest/.eforest/tasks/epic-1-the-trunk/E1-T10-three-way-merge-conflicts/work/e1-t10-critic11-behavior/vitest.config.ts`;
`pnpm exec vitest run --config
.eforest/tasks/epic-1-the-trunk/E1-T10-three-way-merge-conflicts/work/e1-t10-critic11-judge/vitest.config.ts`;
`pnpm exec vitest run packages/streamfs/test/three-way-merge-identity-boundaries.integration.test.ts`;
`tools/verify/cold_clone.sh --keep verify-E1-T10`; three restored causal/exclusion sabotages.
Submission: `1523328` (implementation `f75e07985c1d894f77cbfbe7fb738e11b76ef331`).

### 2026-07-14 — builder — implemented

- Implementation commit: `714a739065d4972283e15b508ba9abf40c5a0f26`
  (`fix: preserve causal generations across merge conflicts`); deterministic-gate
  stabilization commit: `ce093a1a840b016999214d6bfdf3b79cf5ead4af`
  (`test: isolate CLI reducer process cases`). The latter splits one three-process CLI
  aggregate into two independently budgeted assertions; it keeps the default 5000 ms
  timeout and every success, determinism, and missing-reducer assertion.
- Causal analysis now separates moved identities from directional scaffold support.
  Independent sibling moves no longer collapse merely because they share a created
  parent, while required source scaffolds still replay in causal order. Rename adoption,
  conflict filtering, and exclusions are scoped to event-time identity generations, so
  extinct generations disappear and later occupants beneath rejected historical paths
  remain eligible.
- Conflict drafting emits at most one truthful current-state conflict per path, matching
  the reducer's durable `mergeId + path` identity. Six new official-server regressions
  promote critic-11's boundary cases: two sibling collisions beneath one scaffold;
  accepted/rejected/extinct/recreated aliases; a replacement occupant below a rejected
  inherited root; created extinct/recreated destinations; fully extinct source-created
  collisions; and inherited extinct/recreated current-state conflicts. The promoted
  identity-boundary suite passes 29/29.
- Sensitivity was proven and restored across six independent mutations: coupling support
  scaffolds into direct identities lost the second sibling conflict; removing generation
  residual filtering created a spurious alias conflict; raw path-only filtering lost the
  replacement occupant; disabling extinct-generation removal resurrected a stale
  conflict; disabling current-state replacement retained a stale rename conflict; and
  removing directional scaffold propagation broke source-long and source-atomic
  structural equivalence.
- Final recorded command: `CI=true make verify-E1-T10` at `ce093a1`. It exited 0 after
  format, lint, typecheck, 14 files / 180 tests, build, eight focused files / 69 tests,
  evidence verification, self-check, queue listing, and `verify-E1-T10: OK`. The first
  sandboxed attempt was rejected by `listen EPERM 127.0.0.1`; the identical authorized
  integration run passed, isolating the failure to loopback sandbox policy rather than
  implementation behavior.
- A scrubbed exact-commit cold clone passed the same verifier from
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.sGRYONqyIA` with 14/180 full
  tests and 8/69 focused tests. Evidence reproduced alias-reuse digest
  `b124bf4e30bc9cabf7ad63810aebddd766345fa598c155afc0e27e86fe880768` and
  suffix-conflict digest
  `6982c8356a0f00af78c235b26d005513998117af23d4ebe5b613b4ac73f09728`.
- Claim: merge planning now preserves causal generation boundaries through accepted,
  rejected, extinct, and recreated identities; reports every independent collision;
  admits later replacement occupants; and emits exactly the conflict state that apply
  and double replay retain, without weakening structural-equivalence or prior merge,
  race, CLI, materialization, and digest guarantees.
- Replay: N/A (protocol, CLI, and server-internal merge behavior has no browser-reachable
  surface) + mitigation: official `DurableStreamTestServer` histories, deterministic
  plan and durable-conflict parity, exact source heads and bytes, apply/read/double-replay
  receipt digests, real CLI/evidence processes, committed goldens, six mutation
  sensitivities, and a scrubbed exact-commit cold clone.

### 2026-07-14 — critic

VERDICT: refuted

- P1 transient-alias generation loss — FAILED. Predicted that source identity A moving
  `temporary → middle → final` past a target occupant at transient path `middle`, followed
  by independent source identity B created at the now-vacant `middle`, would adopt A at
  free `final` and surface one `add-add` conflict whose source node was B at `middle`.
  Fresh file and directory runs instead produced `changes=[]` and one conflict at
  `middle` whose source node was the older A generation at `final`. Apply retained the
  target's `middle`, silently omitted both source `final` A and current `middle` B, and
  two raw reductions agreed only with that incomplete plan. Independent file reproduction:
  `work/e1-t10-critic12-judge/attacks.test.ts:246-279`; behavior file/directory matrix:
  `work/e1-t10-critic12-behavior/behavior.test.ts:139-225` and
  `work/e1-t10-critic12-behavior/RESULTS.md:16-49`. `liveReferencePath` projects a raw
  path through every rename before checking the actual current occupant, while rejected
  rename exclusion removes A's otherwise adoptable final state:
  `packages/streamfs/src/merge.ts:578-608,764-813,1181-1202`. Make current-state
  references generation-aware and ensure every live source identity is either adopted or
  named by a truthful explicit conflict.
- COLD GATE — FAILED/UNSTABLE. A scrubbed clone of exact submission `6e83ce4` at
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.dpZk4lsM2T/repo` passed format,
  lint, and typecheck, then exited 2 with 8 passing / 6 failing files and 164 passing /
  15 failing / 1 skipped tests. Every failure was a fixed-budget timeout under aggregate
  load (official-server setup, four bisect rows, seven materialization rows, two durable-
  stream rows, rename-content, and conflict-matrix cases), not a semantic assertion.
  The split CLI reducer assertions retained the unchanged 5000 ms budget and passed, but
  the submission did not independently re-earn a deterministic cold gate. Stabilize the
  remaining aggregates without merely inflating timeouts, then restart the full gauntlet.
- COVERAGE/SENSITIVITY — SUFFICIENT FOR THE SUBMITTED DIFF. The latest causal-generation
  hunks, promoted six-family matrix, and CLI split all execute; no dead hunk, skip, todo,
  lint suppression, replacement server mock, or environment-conditioned merge semantic
  was found. Restored sabotages of support/direct identity separation, directional
  scaffold propagation, and generation-residual filtering each made the intended tests
  fail. Coverage is nevertheless insufficient for the broader claim because no permanent
  test covers a moved generation crossing a transient target collision followed by a new
  occupant of that alias.
- SURVIVED. Three independent sibling collisions plus a clean sibling retained exact
  planned/durable conflict parity; two extinct rejected generations reduced to one
  current conflict; both three-child atomic/decomposed scaffold orientations composed;
  a different-temporary three-file cycle preserved all identities and disjoint edits;
  and target-only plus source-replacement occupants beneath a rejected root survived
  apply/read/double replay. The behavior critic's seven other scaffold, cleanup,
  permutation, and collision families also passed. The committed evidence verifier
  reproduced every golden digest and mutation rejection.
- LOOP — CONTINUES. Human override `300627d` remains authoritative. E1-T10 returns to
  `in-progress`, the project stays `building`, historical retry count alone does not
  restore `invalid_loop`, and E1-T11 remains blocked.
- Replay: N/A (protocol, CLI, and server-internal behavior with no browser surface) +
  mitigation accepted: independent official `DurableStreamTestServer` counterexamples,
  exact heads and identity references, apply/read/double-replay state, committed goldens,
  mutation sensitivity, and a scrubbed exact-tip cold-clone attempt.
- SUITE: retain the 29 promoted identity-boundary regressions and existing goldens. The
  transient file/directory diagnostics remain under ignored `work/`; promote them only
  after the planner satisfies their current-generation and final-adoption predictions.

Commands: `pnpm exec vitest run --config
.eforest/tasks/epic-1-the-trunk/E1-T10-three-way-merge-conflicts/work/e1-t10-critic12-behavior/vitest.config.ts`;
`pnpm exec vitest run --config
.eforest/tasks/epic-1-the-trunk/E1-T10-three-way-merge-conflicts/work/e1-t10-critic12-judge/vitest.config.ts`;
`node tools/verify/e1_t10_evidence.mjs`; `tools/verify/cold_clone.sh --keep verify-E1-T10`;
three restored causal-generation sabotages. Submission: `6e83ce4` (implementation
`714a739065d4972283e15b508ba9abf40c5a0f26`; gate stabilization `ce093a1`).

### 2026-07-14 — builder — implemented

- Implementation and deterministic-gate commit:
  `1095e4931265c53b2c61c4d4f6dff91a6e49e87e`
  (`fix: preserve transient generations and stabilize verification`); process-entrypoint
  correction: `b17380c2e04175e5327359335ccadaacf2d4eb69`
  (`fix: prebuild server for process tests`).
- A source-created identity whose historical rename crosses a target-only transient
  occupant now falls back to current-state comparison instead of excluding its whole
  rename program. For fork-missing paths, conflict references prefer the observed live
  path before projecting historical aliases. The promoted file/directory regressions
  therefore adopt identity A at `final` with exact bytes and content id while reporting
  exactly one `add-add` at `middle` against current identity B; apply, durable conflict
  state, double replay, and the unchanged source head agree.
- Critic-12's nine-case behavior matrix passed 9/9 after the fix, and the promoted
  identity-boundary suite passed 31/31. Removing the source-created fallback loses the
  adopted final identity; removing observed-path preference makes the conflict cite A at
  `final` instead of B at `middle`. Both mutations fail the two permanent regressions,
  and the restored implementation passes them.
- Cold-gate hardening partitions aggregate integration cases into independently budgeted
  tests, reuses already built packages without weakening standalone self-build behavior,
  keeps the 10,000-record bisect complexity proof in-process while retaining eleven real
  CLI fixture processes, and serializes the pristine-clone critic after semantic attack
  fan-out. No timeout was increased. The final prebuild contract explicitly builds the
  server and CLI process entrypoints and fails fast if `EFOREST_TEST_PREBUILT=1` is
  asserted without them.
- `CI=true make verify-E1-T10` at exact tip `b17380c2` passed format, lint, typecheck,
  14 files / 212 tests, build, eight focused files / 86 tests, evidence mutation checks,
  verify-spine self-check, queue listing, and `verify-E1-T10: OK`. Alias-reuse digest was
  `b124bf4e30bc9cabf7ad63810aebddd766345fa598c155afc0e27e86fe880768`;
  suffix-conflict digest was
  `6982c8356a0f00af78c235b26d005513998117af23d4ebe5b613b4ac73f09728`.
- The first pristine clone exposed that submission `1095e493` marked tests prebuilt
  without building `@eforest/server`; it failed loudly on a missing server entrypoint.
  After the process-entrypoint correction and a full restart from format/lint, a new
  scrubbed clone of exact tip `b17380c2` at
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.RodNBLkvTu` passed the same
  14/212 full and 8/86 focused matrices and ended `verify-E1-T10: OK`.
- Claim: the submission preserves every live source generation across transient alias
  collisions, emits only truthful current-state conflicts, and remains deterministic
  through apply, replay, materialization, races, CLI processes, and a pristine clone.
  The verification hardening makes fixed budgets measure the submission rather than
  sibling critic contention while preserving real process and standalone-build coverage.
- Replay: N/A (protocol, CLI, server-internal merge behavior, and verification harness
  changes have no browser-reachable surface) + mitigation: official
  `DurableStreamTestServer` histories, exact identity and byte assertions, deterministic
  plan/durable-conflict/double-replay parity, real CLI/server processes, committed
  goldens, two mutation sensitivities, and a scrubbed exact-tip cold clone.

### 2026-07-14 — critic — VERDICT: refuted

- P1 inherited-generation completeness — FAILED. Predicted that target-edited inherited
  identity A, moved by the source `middle -> final`, plus current source identity B
  recreated at `middle`, would account for both live source identities. The official-
  server rerun emitted `changes=[]` and only one `middle` conflict whose source node was
  A at `final`; B was neither adopted nor named. Apply and two raw reductions preserved
  that incomplete plan at digest
  `e81da668fc65baa652764981065e4ce677b96f4cec01580a0ed6fef3646e2315`.
  Citation: `work/e1-t10-critic13-behavior/behavior.test.ts:213-238`; production boundary
  `packages/streamfs/src/merge.ts:596-610,794-823,1173-1228`. Make inherited and current
  generations independently representable by truthful conflicts or safe adoptions.
- P1 directory replacement planning — FAILED. Predicted that target-edited
  `old/base.txt`, source directory move `old -> final`, and current file B recreated at
  `old` would produce an applicable plan or explicit conflicts. Planning instead threw
  `cannot remove non-empty directory old; contains old/base.txt`; target head `...0003`
  and source head `...0006` stayed unchanged, but no conflict event could be recorded.
  Citation: `work/e1-t10-critic13-behavior/behavior.test.ts:241-301`;
  `packages/streamfs/src/merge.ts:995-1015,1334-1375` and
  `packages/streamfs/src/reducer.ts:266-281`. Order or filter ancestor removals safely
  and name both live generations.
- P1 pristine standalone test contract — FAILED. Predicted that the newly conditional
  CLI bootstrap could run its direct bisect test from exact submission `d91f65f` with no
  package `dist/` output and `EFOREST_TEST_PREBUILT` unset. Vitest failed before test
  collection while resolving `@eforest/streamfs` from `replay-command.ts`; the
  `beforeAll` at `packages/cli/src/bisect.test.ts:61-71` never ran. Citation:
  `work/e1-t10-critic13-coverage/RESULTS.md:14-39` and import-time boundary
  `packages/cli/src/bisect.test.ts:1-7`. Add a pre-Vitest bootstrap or equivalent source
  resolution, then prove the direct command with generated entrypoints absent.
- COVERAGE/SENSITIVITY — PARTIAL. Four fresh behavior families survived with exact
  source immutability, reads, planned/durable conflict parity, receipt digest, and double
  replay; the two submission guards each failed their promoted file/directory regression
  when removed and passed 2/2 after restoration. The evidence verifier reproduced alias
  digest `b124bf4e30bc9cabf7ad63810aebddd766345fa598c155afc0e27e86fe880768`,
  suffix digest `6982c8356a0f00af78c235b26d005513998117af23d4ebe5b613b4ac73f09728`,
  and all mutation rejections. The serialized cold-attacker workflow parses and its
  ordering is internally consistent, but no deterministic orchestration run exercises
  start/finish ordering or the missing-result verdict cap; add bounded workflow evidence.
  No full cold clone was run after correctness was independently refuted.
- LOOP — CONTINUES. Human override `300627d` remains authoritative. E1-T10 returns to
  `in-progress`, the project stays `building`, historical retry count alone does not
  restore `invalid_loop`, and E1-T11 remains blocked.
- Replay: N/A (protocol, CLI, server-internal merge behavior, and verification harness
  scheduling have no browser surface) + mitigation accepted: independent official
  `DurableStreamTestServer` counterexamples, exact heads, deterministic plans and double
  reductions, committed digests, pristine no-`dist` process evidence, and restored
  mutation sensitivity.
- SUITE: retain the 31 promoted identity regressions, test partitions, and goldens. Do
  not promote the two failing semantic diagnostics until both live-generation cases are
  corrected and replay deterministically.

Commands: `pnpm exec vitest run --config
.eforest/tasks/epic-1-the-trunk/E1-T10-three-way-merge-conflicts/work/e1-t10-critic13-behavior/vitest.config.ts
--reporter=verbose`; `env -u EFOREST_TEST_PREBUILT CI=true pnpm exec vitest run
packages/cli/src/bisect.test.ts -t 'keeps binary-search probes logarithmic on ten thousand
records'` after removing package `dist/` output in the exact-tip scratch clone; `node
tools/verify/e1_t10_evidence.mjs`. Submission: `d91f65f` (implementation
`1095e4931265c53b2c61c4d4f6dff91a6e49e87e`; process prebuild correction
`b17380c2e04175e5327359335ccadaacf2d4eb69`).

### 2026-07-14 — builder — implemented

- Implementation commit: `1bfbed923e2f6df5cdbcb3b88716b783eca7246b`
  (`fix: preserve inherited merge generations`). Rejected inherited rename programs now
  keep the original fork path as their base reference while assigning a distinct public
  conflict path to the still-live moved generation when the original path contains a new
  generation. Generic conflict references compare causal identities independently on
  target and source, so current B is never projected through inherited A's rename.
- Directory-to-file replacement only adopts when the target directory subtree still
  matches the fork. A changed descendant therefore produces explicit `final` and `old`
  conflicts instead of scheduling an invalid non-empty `fs.dir.remove`; pure directory
  deletion retains its single child-level delete/edit conflict.
- Two permanent official-server regressions promote critic 13's failures. The inherited
  file case emits `final` for moved A and `middle` for current B; the directory case emits
  `final` for moved directory A and `old` for current file B. Both plans are repeated
  deterministically, head-neutral, source-immutable, exactly equal to durable unresolved
  state, and equal across two raw reductions. The complete identity-boundary suite passes
  33/33.
- Critic 13 independently reran its corrected six-case matrix on the stable restored
  tree: 6/6 passed. The inherited file digest was
  `e81da668fc65baa652764981065e4ce677b96f4cec01580a0ed6fef3646e2315`;
  the directory-to-file digest was
  `2e0a7779909395ef2b74af71a7165d11411f621cd444cb3aa382fc9af69128ca`.
  The four multi-alias, nested-directory, mixed-component, and mirror controls also
  retained their exact prior digests.
- Three independent sensitivity mutations were restored: collapsing the moved conflict
  back onto the original path lost both `final` conflicts; disabling observed source
  generation selection made the `middle` conflict cite stale A at `final`; and removing
  subtree safety restored the non-empty-directory reducer exception. Each promoted test
  failed for its intended reason, then the restored cases passed.
- The pristine standalone contract is now real: Vitest resolves `@eforest/streamfs` to
  source before hooks run. A no-`dist` clone of exact commit `1bfbed9` at
  `/private/tmp/e1t10-direct-1bfbed9` installed from the lockfile and passed direct
  `packages/cli/src/bisect.test.ts` 40/40 with `EFOREST_TEST_PREBUILT` unset.
- `packages/streamfs/test/verify-task-workflow.test.ts` executes the actual workflow in a
  bounded fake orchestration runtime, holds all four semantic attackers pending, proves
  `mock-env-hunt` has not started, then proves its start occurs after every parallel
  attacker settles. It is part of the E1-T10 focused verifier.
- `CI=true make verify-E1-T10` at exact tip `1bfbed9` passed format, lint, typecheck,
  15 files / 215 tests, build, nine focused files / 89 tests, evidence mutations,
  verify-spine self-check, queue listing, and `verify-E1-T10: OK`. A scrubbed clone of the
  same commit at `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.crfomNifDX`
  passed the same 15/215 and 9/89 matrices. Alias-reuse digest remained
  `b124bf4e30bc9cabf7ad63810aebddd766345fa598c155afc0e27e86fe880768`;
  suffix-conflict digest remained
  `6982c8356a0f00af78c235b26d005513998117af23d4ebe5b613b4ac73f09728`.
- Claim: every live inherited and replacement generation is now represented by a
  truthful conflict or safe adoption, including directory-to-file replacement, without
  regressing deletion, alias, race, replay, materialization, CLI, or prior identity
  boundaries; the verification harness's serialized cold phase is behaviorally proven
  and both standalone and full pristine-clone paths succeed.
- Replay: N/A (protocol, CLI, server-internal merge behavior, and verification harness
  scheduling have no browser-reachable surface) + mitigation: independent official
  `DurableStreamTestServer` matrix, exact generation references and digests, planned /
  durable / double-replay parity, three sensitivity failures, real no-`dist` CLI
  processes, executable workflow scheduling evidence, committed goldens, and a scrubbed
  exact-tip cold clone.

### 2026-07-14 — critic — VERDICT: refuted

- P1 rejected-swap completeness — FAILED. Predicted that source's live inherited A/B
  identities plus current C at a reused temporary path would each be adopted or named by
  an explicit conflict. The official-server attack instead produced `changes=[]`: the
  `a` conflict named only A at source path `b`, the `tmp` conflict named C, and live B at
  `a` appeared in neither changes nor any source conflict reference. Apply and two raw
  reductions retained target A/B at digest
  `c7a55f30a68c252fcfcc6e801fa63a868019da9ca12c9400f6941ae76205b895`.
  Citation: ignored diagnostic
  `work/e1-t10-critic14-behavior/behavior.test.ts:224-262`; rejected-component drafting
  at `packages/streamfs/src/merge.ts:807-837,1193-1212`. Preserve or explicitly name
  every live identity when a structural program is rejected.
- P1 same-kind directory generations — FAILED. Predicted that moved inherited directory
  A at `final` and current replacement directory B at `old` would receive distinct,
  non-overlapping conflict identities. The first run instead keyed A's source node at
  `final` under one `old` conflict while adopting only B's disjoint child; apply and
  double replay agreed at
  `3c85440cec0237129d058e02b45856211fd76efa3d784844758d8efe7694c79d`.
  When B reused `old/a.txt`, the plan emitted overlapping `old` and `old/a.txt` keys
  rather than `final` and `old/a.txt`, with deterministic digest
  `c28189607dc8ec57d54b052bb91ed91ec523af359ebc72e8a9d188433e0f67b3`.
  Citation: `work/e1-t10-critic14-behavior/behavior.test.ts:84-146`; the submitted
  conflict-path split is file-only at `packages/streamfs/src/merge.ts:821-829`. Make
  directory generations independently addressable without ancestor/descendant key
  collapse.
- COVERAGE — INSUFFICIENT. The new target-side causal-identity guard has no committed
  sensitive mirror regression: removing it kept the full 15-file / 215-test suite green,
  while the scratch target-replacement diagnostic changed back to the current-B target
  reference. Promote a permanent official-server mirror case that fails when the guard
  is removed, plus permanent same-kind-directory and rejected-swap completeness cases.
- SURVIVED. Critic 13's corrected matrix passed 6/6; the permanent identity-boundary
  suite passed 33/33; committed evidence reproduced alias digest
  `b124bf4e30bc9cabf7ad63810aebddd766345fa598c155afc0e27e86fe880768`
  and suffix digest
  `6982c8356a0f00af78c235b26d005513998117af23d4ebe5b613b4ac73f09728`.
  The coverage arm independently passed pristine no-`dist` bisect 40/40, materialize
  18/18, replay/CLI 32/32, and the authorized official process case 1/1; the other
  implementation and harness sabotages were sensitive. No full cold clone was run after
  the correctness refutation.
- LOOP — CONTINUES. Human override `300627d` remains authoritative. E1-T10 returns to
  `in-progress`, the project stays `building`, historical retry count alone does not
  restore `invalid_loop`, and E1-T11 remains blocked.
- Replay: N/A (protocol, CLI, server-internal behavior, and verification harness changes
  have no browser surface) + mitigation accepted: fresh official
  `DurableStreamTestServer` counterexamples, exact identity references, apply/read/double-
  replay digests, real CLI/server processes, committed goldens, and mutation sensitivity.
- SUITE: retain the 33 promoted identity regressions, workflow-order proof, and goldens.
  Keep critic-14 diagnostics under ignored `work/` until the builder fixes and promotes
  the two failed behavior families and target-side mirror sensitivity.

Commands: `pnpm exec vitest run --config
.eforest/tasks/epic-1-the-trunk/E1-T10-three-way-merge-conflicts/work/e1-t10-critic14-behavior/vitest.config.ts
--reporter=verbose`; `node tools/verify/e1_t10_evidence.mjs`; pristine no-`dist` direct
CLI matrices and isolated target-identity mutation. Submission: `79f26a1`
(implementation `1bfbed923e2f6df5cdbcb3b88716b783eca7246b`).

### 2026-07-14 — builder — implemented

- Implementation commit: `2f40620e0f54d41b063cfa38c80d70454288c0ea`
  (`fix: preserve every live merge generation`). A rejected structural component now
  emits one conflict draft per live inherited root identity. Directory descendants stay
  attached to their root generation, while later occupants of vacated aliases remain
  available to the generic current-state comparison. This preserves both inherited
  sides of a rejected swap and every current replacement without duplicate conflict
  keys.
- Same-kind directory replacement is identity-sensitive. Moved inherited A is keyed at
  `final`; current directory B is keyed at `old` when its disjoint children can be
  adopted, or at the exact descendant such as `old/a.txt` when that child collides. Root
  conflict identity filtering deliberately leaves safe child adoption executable.
- Four permanent official-server regressions promote critic 14's attacks: disjoint and
  colliding directory-generation splits, rejected inherited A/B swap plus current C,
  and current target-generation citation after an inherited alias is vacated. They
  prove repeated head-neutral planning, exact source immutability, live reads, durable
  unresolved-conflict parity, receipt/replay digest equality, and two identical raw-log
  reductions. The promoted identity-boundary suite now passes 37/37.
- Three sensitivity mutations failed for their intended reason and were restored:
  collapsing inherited roots lost B and made swap planning invalid; disabling the
  directory-generation guard lost the `old` conflict; disabling target causal-identity
  selection cited inherited A at `final` instead of current B at `old`. Restored focused
  adversarial and identity matrices passed 69/69.
- The exact builder gate `CI=true make verify-E1-T10` passed at `2f40620`: format, lint,
  typecheck, 15 files / 219 tests, build, nine focused files / 93 tests, evidence
  mutations, verify-spine self-check, queue listing, and `verify-E1-T10: OK`. The
  committed evidence verifier retained alias-reuse digest
  `b124bf4e30bc9cabf7ad63810aebddd766345fa598c155afc0e27e86fe880768`
  and suffix-conflict digest
  `6982c8356a0f00af78c235b26d005513998117af23d4ebe5b613b4ac73f09728`.
- The hardened scrubbed cold-clone path was exercised from the exact implementation
  commit, including fresh lockfile installation and official-server binds:
  `tools/verify/cold_clone.sh --keep verify-E1-T10` passed 15/219 and 9/93 at
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.PSKgzzf9a6`.
- Claim: every live inherited, moved, swapped, and replacement generation is now either
  represented by a truthful non-overlapping conflict or safely adopted, with causal
  target/source references and deterministic durable replay from both the working tree
  and a pristine exact-tip clone.
- Replay: N/A (protocol, CLI, and server-internal merge behavior has no browser-reachable
  surface) + mitigation: permanent official `DurableStreamTestServer` generation
  attacks, exact conflict identities, planned/durable/double-replay parity, three
  mutation-sensitivity failures, committed event-log digests, full verifier, and a
  scrubbed exact-tip cold clone.
