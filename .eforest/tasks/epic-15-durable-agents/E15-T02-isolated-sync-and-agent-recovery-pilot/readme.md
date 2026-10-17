---
id: E15-T02
epic: 15
title: "Exercise isolated Electric Sync and Agents recovery against pinned contracts"
priority: 542
status: pending
depends_on: [E15-T01]
estimate: L
capstone: false
---

## Goal

An isolated, repeatable pilot executes E15-T01's pinned Electric Sync and Agents
contracts against real upstream services, compares their behavior with Forest's
current event/reducer boundary, and records supported or unsupported results for every
case. The pilot measures rebuildability, process/outage recovery, scoped writes,
fresh critic contexts and externally visible tool effects without adopting either
provider into Forest production.

## Context

All upstream code, disposable PostgreSQL/Electric processes, data directories and
credentials live under this task's gitignored `work/`. Only the harness, frozen input
fixtures, normalized transcripts and evidence manifests are committed. Pin upstream
dependencies inside the disposable evaluation workspace; do not add database clients
or upstream Agents packages to Forest's root/workspace production dependency graph.
The harness does not read Railway secrets, connect to production services, rewrite the
real queue or start a builder against the actual repository.

The pilot uses two independent clients and a tiny dedicated local Forest fixture when
testing dispatch integration. Agent tools may call only the fixture's scoped dispatch
capability and a local instrumented effect endpoint. Builder and critic are separate
processes with disjoint capabilities and inputs; a deterministic upstream-compatible
agent adapter may supply scripted work so the provider behavior is measurable without
depending on model prose. Actual upstream services may not be replaced with mocks.

Unsupported semantics are honest successful evaluation results when their counterexample
is preserved and selection fails closed. Missing services, an unexecuted case, or a
fabricated compatibility layer is `needs-evidence`, not an unsupported result that
allows the task to pass. A duplication observed in a raw upstream tool path must not be
reported as exactly-once; any proposed idempotency adapter is separately tested.

## Deliverables

- `tools/verify/electric_evaluation.sh` orchestrating scrubbed, pinned upstream
  checkouts/services inside the task workshop with explicit start, timeout and cleanup.
- Isolated harness fixtures for two-client reads, scoped Forest dispatch, durable
  agent runs and an external-effect sink that records durable effect IDs/counts.
- `evidence/pilot-results.json`, request/process traces, authoritative event dumps,
  independently calculated digests, control-plane export/rebuild observations and
  repeated-trial measurements keyed to the frozen contract digest.
- An outcome table distinguishing stream/session recovery from PostgreSQL registry,
  wake/scheduling and any non-rebuildable control-plane state.
- Proposed `make verify-E15-T02`, one sensitivity leg per claimed measurement family,
  and a source/dependency audit proving no production integration was introduced.

## Acceptance criteria

- [ ] `make verify-E15-T02` exits 0 cold with real pinned Sync/Agents services and zero
      skipped catalog cases. `evidence/pilot-results.json` binds every result to exact
      input/contract/source/image digests, executed commands, exit status and evidence
      paths. A case failure is classified unsupported with a reproducible witness.
- [ ] The two-client Sync catalog executes initial sync, a permitted update,
      reconnect and unauthorized read/write cases at the declared proxy/server boundary.
      `evidence/sync-read-write-matrix.json` records exact expected/observed bytes,
      requests and refusals. A support row requires parity and the expected refusals;
      a reproducible mismatch is an unsupported row and does not fail evaluation
      completeness. No claim treats Sync as Forest's write door.
- [ ] Pinned client collections execute reducer materialization, accepted dispatch,
      optimistic-state isolation, reconnect and clear/rebuild cases. Compare canonical
      collection bytes with independent Forest replay in
      `evidence/client-collection-matrix.json`. Support requires parity and no bypass
      of dispatch; a reproduced mismatch is unsupported, while a skipped case fails
      evaluation completeness.
- [ ] The agent scenario kills the handler before tool submission, after accepted
      fixture dispatch, after effect acceptance but before its response, and before
      recording completion. It also repeats a wake and presents an expired runner
      capability. `evidence/agent-boundaries.json` records run/tool/event identities,
      source offsets, effects and canonical final state for every boundary.
- [ ] A supported adapter produces one logical Forest mutation and at most one visible
      effect per idempotency key across all lost-response trials. If raw or adapted
      upstream behavior duplicates an effect, loses a mutation, or permits stale writes,
      its precise variant is unsupported and cannot be selected; request counts and
      independent effect-sink counts appear in `evidence/external-effects.json`.
- [ ] Separate builder/critic, builder-only-marker, source-write, tool reuse,
      cancellation and permission-revocation cases all execute. Inputs, refusals and
      before/after stream digests are in `evidence/role-isolation.json`. A support row
      requires fresh declared inputs, no leaked marker, no critic source write/tool
      reuse and no later write after revocation. An observed violation is a reproduced
      unsupported result; it cannot be selected for adoption. Unexecuted cases remain
      needs-evidence and fail completeness.
- [ ] During separate Agents server, Electric, PostgreSQL and Durable Streams outages,
      the harness records accepted/refused operations, restart/replay results and
      registry/wake/schedule recovery. Destruction of disposable control-plane state
      tests whether published rebuild procedures actually work; non-rebuildability is
      explicit in `evidence/control-plane-recovery.json`, never hidden by a warm process.
- [ ] Measurements use E15-T01's fixed limits and repetitions. Sabotaging digest
      comparison, the effect counter, and stale-capability enforcement separately makes
      a named assertion fail; `evidence/sensitivity.json` records all three red results.
      Normalized logs contain no real credentials or unrelated data.
- [ ] Production manifests, package dependencies and service bindings remain outside
      the pilot. The claim declares `Replay: N/A (isolated protocol/runtime experiment
      with no product browser change) + mitigation` and names event replay, request/
      process traces, refusal evidence and independent effect counts.

## Adversarial verification

1. Supply your own small fixture and seeds within the frozen catalog limits. A result
   that only passes the builder's canned ordering refutes the supported classification.
2. Drop the HTTP response after an accepted tool effect, then restart both runner and
   server and repeat the wake. More than one visible effect or accepted mutation for a
   supported idempotency key refutes that support row.
3. Revoke the actual fixture capability and replay a saved runner request. Any later
   append, including a delayed callback, refutes the fencing claim.
4. Start the critic with its real read-only capability and plant builder-only context
   in a nearby process/file. Any leaked marker or accepted source write refutes fresh
   role separation; prompt instructions alone are insufficient enforcement.
5. Destroy only PostgreSQL state while retaining streams, then the converse. Compare
   recoverable entities, wakes and schedules with the declared matrix; undocumented
   loss or a claim that a warm cache is a rebuild refutes the report.
6. Replace one actual upstream service with a fake endpoint or omit one outage leg.
   A green completeness check refutes the harness; unavailable capability must stop the
   verification with `needs-evidence`.
7. Disable the external-effect counter and hash comparison in separate scratch copies.
   Each must turn the corresponding sensitivity check red, not merely change a printed
   summary. Cold-start again with empty local data to hunt inherited warm state.

## Verification log
