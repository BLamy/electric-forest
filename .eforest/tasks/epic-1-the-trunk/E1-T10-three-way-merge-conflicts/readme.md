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
- [ ] Overlapping edits produce stable conflict events containing base, target, and
      source references; no side is silently selected.
- [ ] Binary and non-patchable conflicts are surfaced explicitly.
- [x] Writer races use official `Stream-Seq` semantics and never leave a partially
      visible merge.
- [ ] CLI, replay, watch, and materialization consume the same merge event model.
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
