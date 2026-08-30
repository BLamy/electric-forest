---
id: E6-T03
epic: 6
title: "Project state machine: server-enforced building, complete, paused, and invalid_loop"
priority: 603
status: in-progress
depends_on: [E5]
estimate: M
capstone: false
---

## Goal

`packages/platform` gains a replay-derived project-state entity and a single validated
transition door for `building`, `complete`, `paused`, and `invalid_loop`. Every guarded
loop mutation consults that state at a cited offset: paused, complete, and invalid loops
cannot launch or advance agents; only an authenticated human transition can resume a
paused/invalid project; every transition records `statusReason`, actor, and `updatedAt`.

## Context

`.eforest/loop.md` defines project states as an enforcement contract, not a decorative
badge. Epic 3 rendered a badge, but Epic 6 must make forbidden work impossible at the
server. This task freezes the event/reducer and authorization boundary independently of
queue derivation and retry policy, which append transitions through this door later.

The authoritative record is a project-state stream. `.eforest/project.json` is a
deterministic projection for folder compatibility, never an independently writable
source. `updatedAt` is the accepted event timestamp and participates in replay; tests use
frozen timestamps.

## Deliverables

- `packages/platform/src/loop/project-events.ts`, `project-reducer.ts`,
  `project-transition.ts`, and `project-guard.ts`.
- Stable refusal reasons for paused, complete, invalid, stale-offset, unauthorized
  resume, and invalid transition attempts.
- Deterministic `.eforest/project.json` projector and frozen transition fixtures.
- Integration tests covering all state/actor/action combinations through real HTTP.
- `Makefile` target `verify-E6-T03` producing event logs, digests, and refusal goldens.

## Acceptance criteria

- [ ] `make verify-E6-T03` exits 0 cold with zero skips; replaying the committed state
      log twice yields the same digest and byte-identical `project.json` projection.
- [ ] The server refuses loop launch, task claim, verdict append, and automatic resume
      while `paused` or `invalid_loop`, and refuses launch/advance while `complete`; each
      refusal leaves all relevant stream heads byte-identical.
- [ ] Only a human-authorized dispatch can transition `paused -> building` or
      `invalid_loop -> building`; an agent token receives the frozen refusal status and
      reason with zero project-state events appended.
- [ ] Automatic `building -> complete` is accepted only with a supplied queue proof that
      every task including the sole capstone is verified at the cited queue offset;
      tampering one task status causes stale/false-proof refusal.
- [ ] Every accepted transition has nonempty `statusReason`, actor identity, and frozen
      timestamp, and projection of the same log is independent of host clock, locale,
      data path, and process id.
- [ ] No code path writes authoritative project status by editing `project.json` or any
      database/side table; a direct projection-file edit is overwritten by replay and
      cannot change the server guard decision.
- [ ] Browser evidence is declared `Replay: N/A (server state/guard contract; the live
      project controls and badge integration land in E6-T06)`; mitigation is the real
      HTTP authorization matrix, state logs, projection bytes, and replay digests.

## Adversarial verification

1. Enumerate every state x actor-role x loop-action tuple through real HTTP. Any action
   admitted outside the matrix or any allowed action refused refutes enforcement.
2. Race a human pause against an agent launch using the same expected offset. Exactly one
   append may win; a launched run after the accepted pause offset refutes atomicity.
3. Forge complete proofs with a missing capstone, pending optional-looking task, duplicate
   task id, and stale queue head. Any accepted proof refutes completion semantics.
4. Edit/delete `project.json` while the server is running, restart cold, and compare the
   guard state and projected bytes to replay. Influence from the file refutes stream
   authority.
5. Remove the invalid-loop guard in a scratch worktree. `verify-E6-T03` must fail on an
   attempted launch; green refutes sabotage sensitivity.

## Verification log
