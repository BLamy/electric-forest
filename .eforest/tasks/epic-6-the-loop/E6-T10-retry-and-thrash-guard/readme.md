---
id: E6-T10
epic: 6
title: "Retry and thrash guard: repeated refutations atomically stop the project at invalid_loop"
priority: 610
status: pending
depends_on: [E6-T03, E6-T09]
estimate: M
capstone: false
---

## Goal

`packages/loop` enforces the `.eforest/loop.md` retry contract: a task may receive at
most two rework attempts by default; a refutation beyond that budget, or the same stable
finding on two implemented -> refuted cycles, appends a single project transition to
`invalid_loop` with a structured reason and prevents all later automatic work. The task
verdict and project stop are an idempotent cross-stream dispatch plan recoverable across
crashes.

## Context

Without this guard the platform can spend forever producing green-looking activity. The
task event model preserves attempts and finding fingerprints, the critic supplies cited
findings, and E6-T03 owns the project transition door. This task decides policy and makes
the cross-entity consequence exact.

The default permits the original attempt plus two reworks; the third refutation is
`retry-budget-exhausted`. Independently, the second refutation carrying a fingerprint
already seen on a prior attempt is `repeated-finding`. Gate weakening and roadmap/queue
drift use the same `invalid_loop` door with distinct reason codes but are inputs to this
policy, not reimplemented scanners.

## Deliverables

- `packages/loop/src/policy/retries.ts`, `fingerprint.ts`, `invalid-plan.ts`, and
  `recover.ts`.
- Versioned `InvalidLoopReason` values and deterministic human-readable status reason
  projection.
- Crash-point and concurrent-verdict integration tests over real task/project streams.
- `Makefile` target `verify-E6-T10` with budget, repeated-finding, and recovery logs.

## Acceptance criteria

- [ ] `make verify-E6-T10` exits 0 cold with zero skips and independently replays every
      task/project fixture to committed per-stream and composite digests.
- [ ] Two distinct refutations allow two rework starts; the next refutation appends one
      `invalid_loop` transition with reason `retry-budget-exhausted`, task/attempt ids,
      triggering verdict offset, and configured budget, then every automatic launch or
      verdict attempt is refused.
- [ ] The second refutation with the same canonical finding fingerprint appends
      `invalid_loop` reason `repeated-finding` even when retry budget remains; changing
      only prose/order does not evade the fingerprint, while a materially different
      cited location/expected-observed tuple does not collide.
- [ ] Crash after task refutation but before project transition, and the inverse observed
      acknowledgement order, recover to exactly one verdict and one project transition
      sharing one dispatch-plan id; no intermediate recovery launches rework.
- [ ] Two critics racing terminal refutations cannot produce two project transitions or
      different reasons; replay selects the accepted verdict deterministically and the
      loser is refused stale.
- [ ] Only a human E6-T03 transition can leave invalid_loop, and resume preserves the
      full invalid reason/attempt history rather than resetting the retry counter.
- [ ] Default and configured budgets are events/config in the project stream and included
      in the policy digest; environment variables or process memory cannot change them.
- [ ] Browser evidence is declared `Replay: N/A (retry policy and cross-Durable Streams service
      plan; invalid-loop UI lands in E6-T12)`; mitigation is the task/project logs,
      composite digests, concurrency schedule, and crash-point sensitivity proof.

## Adversarial verification

1. Vary capitalization, whitespace, finding order, prose, and citation query ordering
   around the same defect. Failure to detect the second semantic repeat refutes thrash
   detection; collision with a different location refutes fingerprint safety.
2. Crash and restart at each append/ack boundary of the cross-stream invalidation plan.
   Duplicate verdict/state events or any rework launched in the gap refutes atomic
   recovery semantics.
3. Race distinct terminal findings and inspect accepted offsets/reason. Nondeterministic
   reason choice across identical schedules or two transitions refutes fencing.
4. Alter an environment retry variable after project creation. Any policy/digest change
   without an event refutes stream authority.
5. Remove the repeated-finding check in a scratch worktree. The verify target must fail
   on the two-cycle fixture; green refutes sensitivity.

## Verification log
