---
id: E6-T04
epic: 6
title: "Live task queue: a replay-built projection with deterministic eligibility and dependency proofs"
priority: 604
status: in-progress
depends_on: [E6-T01]
estimate: M
capstone: false
---

## Goal

`packages/tasks` derives a project's ordered task queue from task streams, resolves task
and bare-epic dependencies, and exposes a deterministic `nextEligible` decision with a
proof containing all task heads consumed. Priority, dependency, one-in-flight, and sole
capstone rules are enforced without a database; deleting the projection and replaying
the source streams reconstructs identical queue bytes and digest.

## Context

The runnable agents need one answer to "what is next?" that cannot drift from task
truth. This task productizes `tools/build_queue.py` semantics on streams while retaining
the human-readable `.eforest/tasks/QUEUE.md` projection. It depends only on the task
event model so queue work can proceed in parallel with folder sync and project guards.

Ordering is ascending numeric priority then id. A dependency is satisfied only by a
verified task, or for bare `E<n>`, that epic's unique verified capstone. Exactly one
task may be in-progress/implemented at a time. Cycles, missing ids, duplicate ids,
multiple capstones, and a capstone that is not last are invalid queue proofs, not empty
queues.

## Deliverables

- `packages/tasks/src/queue/projector.ts`, `eligibility.ts`, `proof.ts`, and
  `render-markdown.ts`.
- A derived queue stream/reducer and query endpoint returning queue digest, source heads,
  blocked reasons, in-flight task, and `nextEligible`.
- Differential fixtures shared with `tools/build_queue.py` plus graph fuzz tests.
- `Makefile` target `verify-E6-T04` proving rebuild and decision parity.

## Acceptance criteria

- [ ] `make verify-E6-T04` exits 0 cold with zero skips and rebuilds the committed queue
      fixture from source task logs to byte-identical JSON, Markdown, and digest after
      deleting every derived queue artifact.
- [ ] For every valid frozen graph, the TypeScript projector and `tools/build_queue.py`
      select the same task id and render the same ordered task/status/dependency tuples;
      any semantic difference fails the differential test.
- [ ] Task and bare-epic dependencies unblock only after the referenced task or unique
      capstone is verified; implemented, refuted, missing, or duplicate references remain
      blocked with an exact reason in the projection.
- [ ] When one task is in-progress or implemented, no second task is eligible; after its
      verified event the next decision changes at the new source head and cites it.
- [ ] Cycles, duplicate ids, missing dependencies, multiple/no capstones per completed
      epic, fractional priority without a reason, and a non-final capstone produce a
      deterministic invalid proof rather than `nextEligible: null`.
- [ ] Replaying source logs in all permutations consistent with per-stream order yields
      the same queue digest, proving the projection does not depend on fetch order.
- [ ] Browser evidence is declared `Replay: N/A (queue projector/query contract; board
      rendering lands in E6-T06)`; mitigation is Python/TypeScript differential output,
      rebuilt projections, exact queue digests, and graph sensitivity fixtures.

## Adversarial verification

1. Generate random DAGs and cyclic graphs, feed them independently to the Python and
   TypeScript implementations, and byte-diff normalized decisions. One mismatch refutes.
2. Change a dependency status at a source head after obtaining an eligibility proof, then
   submit the old proof. Acceptance of the stale selection refutes proof fencing.
3. Construct two concurrently in-progress tasks and two capstones. A normal-looking queue
   or arbitrary winner instead of an invalid proof refutes honesty.
4. Delete the derived stream and `QUEUE.md`, rebuild from shuffled source fetches, and
   compare exact bytes/digest in fresh processes. Drift refutes rebuildability.
5. Sabotage bare-epic dependency resolution. The verify target must fail a fixture where
   a non-capstone verifies before the capstone; green refutes sensitivity.

## Verification log
