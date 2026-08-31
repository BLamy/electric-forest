---
id: E6-T07
epic: 6
title: "Agent-run protocol: fenced leases, role-scoped capabilities, fresh sessions, and replayable run streams"
priority: 607
status: in-progress
depends_on: [E6-T03, E6-T04]
estimate: L
capstone: false
---

## Goal

`packages/loop` defines the platform agent runtime shared by builders and critics: an
atomic task lease fenced to a queue proof, a role-scoped branch capability, a fresh
ephemeral workspace, and an append-only run stream recording inputs, tool/gate results,
artifacts, exit, and revocation. Builders can write only their task branch; critics get
read-only branch access plus the verdict/evidence door; no run can outlive project pause,
lease loss, or capability revocation.

## Context

Runnable agents are a security and evidence boundary before they are prompts. This task
freezes the transport-neutral `AgentAdapter` contract and deterministic scripted adapter
used by tests; E6-T08 and E6-T09 supply role behavior. A production adapter may invoke a
model process, but it must communicate through the same event/capability protocol.

Fresh critic sessions are structural: a critic run receives the task spec, claimed diff,
and cited evidence, but no builder transcript, hidden workspace, or reusable process.
Run streams are evidence metadata, not a database job table. Lease acquisition validates
E6-T04 source heads and E6-T03 project state in the same fenced operation.

## Deliverables

- `packages/loop/src/run/events.ts`, `reducer.ts`, `adapter.ts`, `workspace.ts`,
  `lease.ts`, and `capabilities.ts`.
- Platform endpoints for acquire/heartbeat/release/revoke and run-event append, all
  authenticated and offset-fenced.
- A deterministic scripted adapter and isolated workspace harness for builder and critic
  roles, including forced crash/restart.
- Frozen authorization matrix, run logs, and `Makefile` target `verify-E6-T07`.

## Acceptance criteria

- [ ] `make verify-E6-T07` exits 0 cold with zero skips and replays each frozen run stream
      twice to byte-identical state/run digests.
- [ ] Two agents racing the same queue proof yield exactly one accepted lease and one
      refusal; one task/run/branch tuple is recorded, and the loser can append no task or
      branch event with its rejected capability.
- [ ] Builder capability permits only its named task branch and run/evidence streams;
      critic capability refuses every branch-content write while permitting only its run
      stream and validated verdict/evidence endpoints. All refused stream heads remain
      unchanged.
- [ ] A critic workspace/process is fresh and receives only the committed task spec,
      diff manifest, claim, and evidence manifest; a planted builder-only secret and
      transcript are absent, proved by a scripted critic probe.
- [ ] Pausing or invalidating the project, revoking capability, or advancing the lease
      fence aborts the run before its next mutation, appends one terminal run event, and
      prevents all later writes even with the old token.
- [ ] Crash after a successful mutation but before local acknowledgement resumes by
      replaying the run stream and does not repeat that mutation; the logical action and
      accepted event each count exactly once.
- [ ] Run events and artifacts contain no raw auth token or environment secret, verified
      by a canary-secret scan over dumps and evidence.
- [ ] Browser evidence is declared `Replay: N/A (headless runtime, lease, and capability
      protocol; UI lands in E6-T12)`; mitigation is the real-HTTP race matrix, run logs,
      canary scan, independent replay, and crash/revocation sensitivity proof.

## Adversarial verification

1. Race 100 lease acquisitions with the same proof and delayed responses. More than one
   accepted lease or any unfenced branch mutation refutes exclusivity.
2. Steal/replay builder and critic capabilities against sibling tasks, main, evidence,
   verdict, and project endpoints. Any privilege outside the frozen matrix refutes role
   isolation.
3. Plant secrets in builder env/workspace/transcript, then launch a critic. Any canary in
   critic inputs, output, run dump, or evidence refutes fresh-session isolation.
4. Pause and revoke at every boundary between tool result, event append, and heartbeat.
   One post-revocation mutation refutes fencing.
5. Disable capability-scope checking in a scratch worktree. The verify target must go red
   on a critic branch write; green refutes sensitivity.

## Verification log
