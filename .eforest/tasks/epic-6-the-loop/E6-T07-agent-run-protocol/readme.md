---
id: E6-T07
epic: 6
title: "Agent-run protocol: fenced leases, role-scoped capabilities, fresh sessions, and replayable run streams"
priority: 607
status: implemented
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

### 2026-08-31 — builder — implemented, not yet verified

- Implementation commit d7a12030863c9c5be82af7f97372c950ccd9ed2b on branch
  e6-t07-agent-run-protocol, stacked after the E6-T05 layer. Added the @eforest/loop
  runtime with versioned run events/replay, fenced leases, rotating opaque capabilities,
  role-scoped branch/evidence/verdict authorization, fresh builder/critic workspaces,
  secret scanning, crash-safe mutation intents, and a deterministic scripted adapter.
  PlatformGateway now exposes authenticated acquire, heartbeat, release, revoke, run-event,
  mutation, and inspect doors over the official Durable Streams adapter.
- The real HTTP race used two independent coordinators against one Durable Streams server:
  100 concurrent acquisitions produced exactly one 201 and 99 fenced refusals; the stale
  capability was refused after heartbeat rotation; the pause test appended one lease
  revocation and one terminal run.revoked before refusing the next event. The crash probe
  wrote one target mutation, recovered it after the simulated post-append crash, and
  appended one accepted record.
- Frozen stream evidence:
  .eforest/tasks/epic-6-the-loop/E6-T07-agent-run-protocol/evidence/e6-t07-run.jsonl
  (9 records; replay state digest
  df65453519c4f89b6f787e89091c6d38e36bdda2616804f8dfaa23d561b0710a; log digest
  349d94a0076e85b443420be874e5e785e2f903bbd33635aa606c134602fcf80b) and
  .eforest/tasks/epic-6-the-loop/E6-T07-agent-run-protocol/evidence/e6-t07-digests.json.
  The evidence verifier replays the frozen run twice and compares both digests to the
  committed expected record; the sensitivity verifier catches capability-scope,
  role-isolation, stale-fence, and canary-secret sabotage.
- Exact checks: CI=true pnpm --filter @eforest/loop build; CI=true pnpm --filter
  @eforest/platform build; the focused loop/platform suite (2 files, 8 tests); CI=true
  pnpm build (exit 0); make --no-print-directory verify-E6-T07 (exit 0); and
  bash tools/verify/cold_clone.sh verify-E6-T07 from pristine commit d7a12030 (exit 0,
  zero SKIPPED:, dependency integrity OK, 2 files/8 tests, frozen replay and sensitivity
  checks OK).
- Root audit results are disclosed: pnpm format:check found 7 pre-existing files;
  pnpm lint found 18 pre-existing errors, including the pre-existing _closes warning at
  packages/platform/src/gateway.ts:761; pnpm typecheck found the repository's 41
  pre-existing errors and no E6-T07 source error; pnpm test ran 129 files with 1,022
  passing tests and the 3 known baseline failures (meadow frozen-doc blank-line drift,
  the issue workflow matrix's pre-existing 7-vs-8 expectation, and the seeded PR property
  test timeout). No new E6-T07 failure appeared in those root gates.
- Replay: N/A (headless runtime, lease, and capability protocol; UI lands in E6-T12) +
  mitigation: real HTTP two-coordinator race, official-stream pause/revocation and
  crash/restart probes, committed run-log replay/digest comparison, secret-canary scan,
  capability sensitivity sabotage, focused tests, and the pristine cold-clone target.
- Claim: E6-T07's runtime boundary is implemented and reproducible from a clean clone;
  every accepted lease, run event, and task/evidence/verdict mutation is authenticated,
  offset-fenced, role-scoped, and represented by replayable digest-only run metadata.
  This is a builder claim; independent critic verification remains required before
  status verified.
