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

- [ ] Clean disjoint text edits merge deterministically and replay to one digest.
- [ ] Overlapping edits produce stable conflict events containing base, target, and
      source references; no side is silently selected.
- [ ] Binary and non-patchable conflicts are surfaced explicitly.
- [ ] Writer races use official `Stream-Seq` semantics and never leave a partially
      visible merge.
- [ ] CLI, replay, watch, and materialization consume the same merge event model.
- [ ] Tests run against `DurableStreamTestServer`; browser evidence is N/A with
      stream-layer fixtures and digest comparisons as mitigation.

## Adversarial verification

Mutate each side independently, swap target/source order, replay twice, race an ordinary
target write with merge, corrupt a conflict reference, and verify every failure is
deterministic and head-neutral.

## Verification log
