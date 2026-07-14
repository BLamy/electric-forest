---
id: E1-T10
epic: 1
title: Three-way merge on patches with conflicts surfaced as events
priority: 110
status: in-progress
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
