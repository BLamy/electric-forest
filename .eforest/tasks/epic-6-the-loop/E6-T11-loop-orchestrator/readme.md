---
id: E6-T11
epic: 6
title: "Loop orchestrator: pick, build, criticize, rework, stop, and advance from replayed state"
priority: 611
status: pending
depends_on: [E6-T08, E6-T09, E6-T10]
estimate: L
capstone: false
---

## Goal

`packages/loop` exposes a resumable `LoopController` and authenticated platform command
that, from replayed queue/project/task/run state only, performs the exact cycle: select
the sole eligible task, run a builder, run a fresh critic, rework on refutation, advance
on verification, complete when the sole capstone and every task are verified, and stop
loudly on pause or invalid_loop. Every decision and child run reference is appended to a
loop-session stream.

## Context

This is `.eforest/loop.md` as executable product code, composing earlier tasks rather
than duplicating their policies. The controller is deliberately boring: it has no hidden
job table, in-memory retry counter, or optimistic status. On restart it folds the loop
session, task, queue, and project streams, verifies all cited heads, and takes the one
legal next action.

The test adapters include a scripted refute-once scenario and failure paths, but the
controller is adapter-agnostic. UI controls and timeline rendering land in E6-T12; the
multi-stream proof harness lands in E6-T13.

## Deliverables

- `packages/loop/src/controller/controller.ts`, `decision.ts`, `session-events.ts`,
  `resume.ts`, and `complete.ts`.
- Authenticated start/stop/status/resume endpoints and CLI commands, guarded by project
  state and fenced source heads.
- Deterministic scenario harnesses for verify-first, refute/rework/verify, pause,
  invalidation, crash at every decision boundary, and multi-task advancement.
- `Makefile` target `verify-E6-T11` with complete loop-session/task/run/project dumps.

## Acceptance criteria

- [ ] `make verify-E6-T11` exits 0 cold with zero skips and replays all member streams of
      each scenario to byte-identical per-stream and composite digests.
- [ ] In the refute-once scenario the exact event order is lease -> builder run -> claim
      -> fresh critic run -> refuted -> rework builder run -> second claim -> fresh critic
      run -> verified, with distinct run/process/workspace ids and no extra lifecycle
      event.
- [ ] After verification the queue advances to the next eligible task; project complete
      appends only after every task and the unique final capstone are verified, using the
      current queue proof.
- [ ] Pause or invalid_loop observed before any decision or child mutation stops the
      controller with one terminal session event and no later agent/task/branch event;
      human resume starts a new fenced session, not a hidden continuation.
- [ ] Killing the controller after every accepted child event and restarting produces
      the same final event logs/digests as an uninterrupted run with no duplicate agent
      invocation, claim, verdict, or completion transition.
- [ ] Starting two controllers concurrently yields one accepted session/lease; the loser
      is refused and cannot launch a child run.
- [ ] Loop decisions contain all input stream heads and can be recomputed independently;
      a decision from stale task/queue/project state is refused before action.
- [ ] Browser evidence is declared `Replay: N/A (headless controller; launch and live
      timeline land in E6-T12)`; mitigation is the complete member-stream dumps,
      uninterrupted/recovered digest comparison, and controller-race transcripts.

## Adversarial verification

1. Crash after every event in the refute-once schedule and compare each recovered final
   log to the uninterrupted golden. One duplicate/missing event or digest drift refutes.
2. Race two controllers, then delay the winner's heartbeat until lease expiry while it
   tries to claim. Two active children or a late accepted claim refutes fencing.
3. Pause or invalidate at each decision boundary. Any action whose cited inputs include a
   terminal project offset refutes enforcement.
4. Tamper a recorded decision head and recompute it outside controller code. Acceptance
   of the stale decision or mismatch with independent recomputation refutes replay-only
   control.
5. Replace the controller's replay resume with empty in-memory state in a scratch
   worktree. Restart scenarios must go red; green refutes sensitivity.

## Verification log
