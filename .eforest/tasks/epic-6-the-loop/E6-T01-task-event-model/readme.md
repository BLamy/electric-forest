---
id: E6-T01
epic: 6
title: "Task event model: an issue with evidence and builder/critic verdicts"
priority: 601
status: pending
depends_on: [E5]
estimate: M
capstone: false
---

## Goal

`packages/tasks` defines and registers the durable-stream task entity: it reuses the
E5 issue workflow and attachment reference contracts, adds the builder/critic events
`task/claimed`, `task/refuted`, and `task/verified`, and reduces every task to one
canonical `TaskState`. Illegal transitions are rejected at dispatch, only a critic
verdict can produce `verified`, and replay of the task log is the sole source of task
status.

## Context

Epic 6 starts from ROADMAP.md's identity: **a task is an issue with evidence**. This
task freezes that identity rather than creating a parallel ticket system. It builds on
E5-T01's issue reducer, E5-T09's attachments, and the E5 capstone's proven multi-entity
stream model. Later tasks parse `.eforest` folders into this entity, schedule it, and
run agents against it.

The frozen lifecycle is `pending -> in-progress -> implemented -> verified`, with the
rework branch `implemented -> refuted -> in-progress`: `task/refuted` produces the
observable `refuted` state and `task/rework-started` begins the next attempt.
`task/claimed` is the only event that produces `implemented`; `task/verified` is the
only event that produces `verified`. Every claim and verdict references an agent-run
stream, task-branch stream, head offset, and attachment ids. Offsets remain opaque
strings.

## Deliverables

- `packages/tasks/src/events.ts`, `reducer.ts`, `validation.ts`, and `version.ts` with
  versioned event schemas and a registered `tasks/v1` reducer.
- `packages/tasks/src/state.ts` defining canonical `TaskState`, attempt history,
  evidence references, claim linkage, and verdict linkage without duplicating E5 issue
  or evidence types.
- Dispatch validation for actor role, legal predecessor state, current-claim linkage,
  and append-only attempt history.
- Frozen valid and invalid JSONL fixtures plus property tests over transition sequences.
- `Makefile` target `verify-E6-T01` producing a task-log dump and canonical digest.

## Acceptance criteria

- [ ] `make verify-E6-T01` exits 0 from `tools/verify/cold_clone.sh` with zero
      `SKIPPED:` lines and replays the committed valid fixture twice to byte-identical
      `tasks/v1` state digests.
- [ ] The valid fixture follows pending -> in-progress -> claimed/implemented ->
      refuted -> rework-started/in-progress -> claimed/implemented -> verified,
      preserves both attempts, and its final `verified` state references exactly the
      second claim offset and its critic run; the exact state and digest are committed
      as frozen artifacts.
- [ ] Dispatching `task/verified` as a builder, before a claim, against a stale claim,
      or after terminal verification is refused before append; the task stream head and
      digest remain byte-identical in every refusal transcript.
- [ ] A `task/refuted` event carries at least one finding with a stable fingerprint and
      evidence citation, and replay retains the complete finding instead of only the
      status change.
- [ ] Existing issue comments, labels, workflow metadata, and E5 attachment references
      round-trip through `TaskState`; no second attachment schema or database-backed
      task record is introduced.
- [ ] The reducer is total over fuzzed well-formed events and deterministically refuses
      unknown versions/types; 1,000 generated legal sequences replay identically in
      two fresh processes.
- [ ] Browser evidence is declared `Replay: N/A (task reducer and dispatch contract;
      no browser surface in this task)`; mitigation is the frozen task log, refusal
      transcripts, independent replay, and digest/sensitivity proof above.

## Adversarial verification

1. Generate transition sequences that try every status edge, duplicate each event, and
   reorder claim/refute/verify records. One illegal append accepted, one legal append
   refused, or one different final digest refutes the lifecycle.
2. Forge a critic verdict pointing to a claim from another task or an older attempt.
   Acceptance, head movement, or state mutation refutes claim linkage.
3. Mutate one byte in each frozen event kind and replay. A mutation that neither fails
   validation nor changes the digest refutes the measuring apparatus.
4. Remove the critic-role guard in a scratch worktree and prove `verify-E6-T01` goes red
   specifically on the builder-verifies refusal. A green sabotage run refutes coverage.
5. Scan the diff and dependency graph for a task table, KV sidecar, or duplicate issue /
   evidence model. Any authoritative state outside replay of the task stream refutes the
   architectural contract.

## Verification log
