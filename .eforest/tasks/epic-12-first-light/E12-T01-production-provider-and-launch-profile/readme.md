---
id: E12-T01
epic: 12
title: Qualify the production stream provider and freeze the public launch profile
priority: 523
status: pending
depends_on: [E5-T14, E12-T00, E12-T11]
estimate: M
capstone: false
---

## Goal

The public multi-user Railway launch has one committed, numeric launch profile and one
qualified production Durable Streams provider. The provider preserves Electric Forest's
existing stream contracts, the authenticated gateway remains the mutation door, and
missing production capabilities or credentials produce an explicit blocker before any
deployment is represented as ready.

## Context

The human requested hosting before further platform development, then prioritized real
Auth0 login and local CLI mirroring on the custom self-hosted server. T10/T11 provide
that first usable path; priorities 523-531 retain this full public qualification next.
E12 task identities remain stable. The target is Railway project
`e0864588-a320-4ba3-96df-95ad0a07ee81`, environment
`c1cbbfc7-b8f7-4e3e-a4ee-a6260bea7448`. Planning inventory found Postgres, electric and cache
starter services. T00 subsequently added a separate disposable preview, and T10 adds a
separate authenticated service with private persistent streams. The ElectricSQL starter
does not establish a Durable Streams endpoint. Re-inventory at implementation;
never infer running service health from a successful deployment record.

The human's 2026-10-16 implementation authorization reconciled the old two-active
inconsistency by explicitly deferring E5-T15 and E6-T12, preserving all findings and
run history. This production qualification follows the separately verified E12-T00
preview and the established E5-T14 platform, while E5-T15 resumes after E12. E12's own
independent proof cannot mark either deferred task verified or reset its ledger.

The human explicitly selected the pinned, patched `@durable-streams/server@0.3.8` for
the initial Railway deployment. This task qualifies that actual self-hosted provider
against every reachable existing contract; it does not require a managed account.
T10's working authenticated deployment is not this full conformance, capacity or recovery
qualification. Preserve the upstream ownership boundary and verified product behavior.
ElectricSQL/Postgres and agent-runtime adoption remain later explicit decisions.

## Deliverables

- A production provider decision and redacted service/credential topology, including
  private raw transport/admin access, backup ownership, and the exact supported provider
  version or managed contract identifier.
- A committed `launch-profile.json` with numeric concurrent-user, tenant, live-follow,
  concurrent-writer, write-rate, workload-duration, body-size, request-timeout, shutdown,
  readiness, live-staleness, p95 latency, error/loss tolerance, memory, RPO and RTO
  budgets; named units and workload are required.
- A provider conformance harness and `make verify-E12-T01`; outputs belong to this task's
  `evidence/`, with diagnostics confined to `work/`.

## Acceptance criteria

- [ ] `make verify-E12-T01` exits 0 from a cold clone and emits
      `evidence/e12-t01-provider-matrix.json`, `evidence/e12-t01-streams.jsonl`, and
      `evidence/e12-t01-digests.json`. Independent replay twice yields the recorded
      byte-identical canonical state digests; one altered event makes the verifier fail.
- [ ] The matrix executes create/read/append, canonical application offsets versus opaque
      transport cursors, Stream-Seq races, producer deduplication/close fences, native and
      historic forks, live follow/reconnect, snapshots, and the retention/dump/410 behavior
      required by the existing reachable app paths. Every row cites an exact request,
      response, event offset and expected outcome; there are no untested or assumed rows.
      Unsupported required behavior blocks public-launch qualification rather than
      weakening a verified contract or silently substituting a memory-only provider.
- [ ] The actual private transport boundary is specified for every caller, including
      `OfficialStreamAdapter`, `IdentityStore` and direct `StreamFsRepo` calls. For the
      chosen co-located provider, a dedicated fixture proves that only container-loopback
      server calls reach raw/admin transport; external/public calls cannot. If a separate
      credentialed provider is used, every caller must present authorized server
      credentials and missing/wrong credentials must fail. Neither topology exposes raw
      mutation/admin through the public origin. Redacted exact topology/call results are
      in `evidence/e12-t01-auth-boundary.json`; no caller is silently exempted.
- [ ] The launch profile contains concrete numeric budgets with explicit units, positive
      capacity/time limits and nonnegative error/loss tolerances,
      at least two simultaneous authenticated users and two isolated tenants, and a
      finite sustained/concurrent workload. `evidence/e12-t01-profile-check.json` records
      its SHA-256 and rejects missing fields, non-finite values and contradictory limits.
      T06/T07 consume this frozen profile; failed runs cannot lower its thresholds.
- [ ] `evidence/e12-t01-topology.json` specifies one mutation-serving platform replica and
      a deployment procedure with no overlapping mutation-serving revisions, unless an
      independently qualified dispatch fence proves safe overlap. It distinguishes public
      app access, private transport/admin access, regenerable caches and authoritative
      stream state. Existing starter services are retained; this planning/qualification
      task performs no destructive migration or restart of those services.
- [ ] The Verification log declares `Replay: N/A (provider qualification and launch
      profile; no browser surface changes) + mitigation: authenticated provider
      transcripts, frozen stream dumps and independent digest/sensitivity checks`.
- [ ] Before a builder call, two fresh readers attest the same committed lifecycle
      snapshot and legal task/run eligibility. A fresh pre-critic freezes the threat
      model; a separate fresh critic alone may verify the task. Full verdict history,
      run ceilings, checkpoints, ordered gates and project stops remain intact. Any
      failed requirement is a blocker, never a gate waiver or ledger reset.

## Adversarial verification

1. Point the harness at the starter ElectricSQL endpoint, a memory-only test server and
   a provider missing retention support. Any passing required matrix row without its
   actual protocol response refutes selection.
2. Race independent writers, retry an append after an unknown response, fork at both
   head and an earlier application offset, and resume across retention. Lost/duplicated
   accepted events, a wrong fork prefix or an invented transport cursor refutes parity.
3. Probe the selected topology from outside container loopback and attempt raw
   append/compaction from the public side. For a separate credentialed provider, also
   remove credentials at each caller and use a wrong account. A reachable raw/admin
   bypass, unqualified call site or secret in evidence refutes the boundary.
4. Delete a numeric budget, use `Infinity`, or lower a frozen threshold after a failing
   run. A green profile/verifier result refutes the measuring apparatus.
5. Mutate one byte of the conformance event fixture and sabotage one provider-contract
   check in a disposable worktree. Each mutation must turn its corresponding check red.
6. Attempt to start while the inherited active-task inconsistency remains, or treat
   Railway deployment success as provider readiness. Either accepted shortcut refutes
   the lifecycle/health claim.

## Verification log
