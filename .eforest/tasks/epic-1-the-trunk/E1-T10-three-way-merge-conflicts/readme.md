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
