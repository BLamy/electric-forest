---
id: E12-T06
epic: 12
title: Bound public traffic and concurrent writers against the frozen launch profile
priority: 528
status: pending
depends_on: [E12-T04]
estimate: M
capstone: false
---

## Goal

The hosted app sustains the exact public launch workload frozen by T01, refuses traffic
above its declared admission limits, and preserves every accepted mutation under
concurrent users and retries. Body ingestion, connections, timeouts and rate accounting
are bounded for the qualified single mutation-serving deployment topology.

## Context

The current adapter collects request bodies before routing, and rate counters are
process-local. Public launch needs a finite tested envelope including anonymous/auth
traffic, live readers and competing writers. This task consumes T01's committed numbers;
it does not invent an unlimited scale claim, silently lower performance thresholds after
failure, or use a second mutation-serving replica as a shortcut.

## Deliverables

- Admission/body/time/connection bounds and typed rate/overload responses, with explicit
  auth/anonymous policy and deployment/restart accounting behavior.
- A deterministic finite workload for the profile's users, tenants, follows, writers,
  rate, duration, response-time and memory budgets, plus just-over-limit cases.
- Retry/race invariants checked against event identities, acknowledged operation IDs,
  offsets and independently reduced state, not only HTTP success totals.
- `make verify-E12-T06`, redacted load/resource results and replayable fixture logs.

## Acceptance criteria

- [ ] `make verify-E12-T06` exits 0 and emits `evidence/e12-t06-load.json` binding the full
      source commit/image digest and exact T01 profile SHA-256. It runs every frozen
      workload dimension for the frozen duration and reports actual sample counts,
      p95 read, dispatch and follow latency, errors and peak resource observations against
      the unchanged numeric budgets. Missing measurements or modified thresholds fail.
- [ ] At the declared capacity, all eligible operations meet the frozen latency/error/
      memory budgets; independent clients converge to the same canonical state. In
      `evidence/e12-t06-streams.jsonl` and `evidence/e12-t06-operations.json`, every
      acknowledged operation appears exactly once, retry identities have one effect,
      per-branch offsets remain valid, and replays match `evidence/e12-t06-digests.json`.
- [ ] One-over-limit bodies, slow/incomplete bodies, excessive follows/connections,
      expired request deadlines, and exhausted authenticated/anonymous/auth-endpoint
      rate budgets receive their documented typed refusal/closure within the frozen
      timeout. Refused mutations preserve stream heads. Boundary cases and exact statuses
      are recorded in `evidence/e12-t06-admission.json`; ingestion is bounded before the
      full oversized body can be allocated.
- [ ] Independent tenants at the declared allocation both make forward progress; a noisy
      actor cannot consume an unbounded key/counter set or replace verified identity
      with a spoofed client header. Rate limits, Retry-After behavior, restart/reset
      semantics and old/new deployment admission follow the frozen profile and T01
      topology; the transcript proves no unsupported replica/overlap was introduced.
- [ ] Journey `E12-T06 concurrent users and overload recovery` runs through the configured
      managed tunnel in Replay QA project `proj-electric-forest-ms8w0nv1` on the same
      candidate, showing a typed limit/refusal and recovery with matching DOM state and
      no console errors. Cite actual journey/test-run, bugs, console/network and attached
      recording evidence; deployed-origin load/smoke is additional proof. If QA is
      unavailable, declare `Replay: N/A` with reason and explicit mitigation.
- [ ] Before a builder call, two fresh readers attest the same committed lifecycle
      snapshot and legal task/run eligibility. A fresh pre-critic freezes the threat
      model; a separate fresh critic alone may verify the task. Full verdict history,
      run ceilings, checkpoints, ordered gates and project stops remain intact. Any
      failed requirement is a blocker, never a gate waiver or ledger reset.

## Adversarial verification

1. Generate independent writer seeds, collide sequence values and retry after dropped
   responses. A missing acknowledgement, duplicate effect or divergent replay refutes
   concurrency even if the throughput graph is green.
2. Stream an oversized body slowly and hold follows at and above the profile cap. Memory
   growth beyond budget, unlimited waiting or delayed rejection refutes admission bounds.
3. Rotate untrusted identity/proxy headers and many distinct counter keys while another
   tenant uses its allocation. Spoofed quota, counter growth or starvation refutes limits.
4. Restart during a rate window and deployment replacement. Undeclared reset behavior or
   overlapping unfenced mutation-serving revisions refutes the topology claim.
5. Disable the body cap/rate guard in separate scratch candidates and alter one latency
   sample or profile digest. Each corresponding verifier must turn red.
6. Inspect all load inputs against T01; a smaller duration/rate/user count or changed
   threshold passed off as the frozen capacity refutes the measurement.

## Verification log

