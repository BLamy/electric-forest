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
  + mitigation accepted: official `DurableStreamTestServer` attacks, exact digest replay,
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
  + mitigation: official `DurableStreamTestServer` event logs, exact live/double-replay
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
  + mitigation: official `DurableStreamTestServer` logs, exact live/double-replay digests,
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
  + mitigation accepted: official `DurableStreamTestServer` counterexamples, exact stream
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
  + mitigation: official `DurableStreamTestServer` logs, exact live/double-replay digests,
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
  + mitigation: official `DurableStreamTestServer` event logs, exact live/double-replay
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
  + mitigation: official `DurableStreamTestServer` event logs, exact live/double-replay
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
