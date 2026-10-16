---
id: E15-T01
epic: 15
title: "Pin Electric Sync and Agents contracts without changing Forest authority"
priority: 541
status: pending
depends_on: [E13-T03]
estimate: M
capstone: false
---

## Goal

A finite evaluation contract distinguishes Electric Sync's PostgreSQL read path,
Electric Agents' durable runtime and control plane, and electric-forest's existing
official Durable Streams application. `ElectricEvaluationContractV1` pins actual
upstream source/package identities, authority boundaries, test cases, and measurement
budgets before a pilot runs. A documented incompatibility is a valid finding; this task
does not authorize migrating platform state or changing the standing no-database rule.

## Context

The hosting-first order deliberately places this evaluation after the E13 design
capstone and before E14 changesets and the remaining E6 loop work. Priorities 541-543
express that global order independently of epic numbers. The Railway starter's Electric
Sync service is not presumed to implement the Durable Streams endpoint consumed by
Forest. The first production launch remains the E12 architecture.

Research starts with the current official sources, including
`https://electric.ax/docs/sync/`, `https://electric.ax/docs/agents/`, and
`https://github.com/electric-sql/electric/blob/main/docs/agents-development.md`.
References to mutable `main` or a Docker tag are discovery aids, not reproducible pins.
Pin full commit OIDs, package versions/integrity, and image digests used by the pilot.
Record PostgreSQL/control-plane requirements explicitly. A runtime's durable event
history does not by itself establish exactly-once external effects.

Only a disposable upstream evaluation under this task family's `work/` may require
PostgreSQL. No PostgreSQL client, schema, service, or authority enters Forest's runtime,
package dependency graph, Railway environments, or platform streams. Production
adoption that changes this boundary requires a separate explicit human architecture
decision; neither a successful pilot nor a provider recommendation supplies it.

## Deliverables

- `docs/decisions/electric-provider-evaluation.md` with current architecture, options
  `adopt`, `decline`, and `conditional`, required authority changes, and unresolved
  questions distinguished from proven observations.
- `ElectricEvaluationContractV1` and a machine-readable case catalog at
  `evidence/evaluation-contract.json`, with package/source/image pins and a SHA-256 over
  canonical contract bytes.
- Exact client-collection package/API pins and case rows for Forest reducer projection,
  accepted dispatch updates, optimistic isolation, reconnect and cold collection rebuild.
- A matrix separating Sync read delivery, Agents entity streams, Agents server registry/
  wake/schedule persistence, identity/principals, tool execution, and Forest dispatch.
- Frozen input logs, expected reducer/query results, tool-effect expectations, and
  predeclared latency/resource limits for E15-T02; no golden computed by the evaluated
  provider at verification time.
- Proposed `make verify-E15-T01` and its non-browser verification script; commands here
  are future deliverables, not assertions that those commands currently exist or pass.

## Acceptance criteria

- [ ] `make verify-E15-T01` exits 0 cold and validates every catalog row against a
      committed source excerpt/reference and immutable pin. Full source OIDs, package
      integrity and any image digest are recorded in `evidence/upstream-pins.json`;
      unavailable contracts are labeled unavailable, never inferred from branding.
- [ ] The contract names exact upstream APIs/endpoints and required persistent stores
      for each candidate. `evidence/authority-matrix.json` identifies owner, write path,
      replay source, rebuild procedure or explicit non-rebuildable result, and outage
      dependency for each of the six matrix concerns listed in Deliverables.
- [ ] The catalog contains finite cases for two-client read parity, revoked read/write,
      client-collection materialization, accepted update, optimistic isolation, reconnect
      and cold rebuild, process loss, duplicate wake, cancellation, stale runner fencing, a lost external
      effect acknowledgement, control-plane outage, and critic isolation. Every case
      names inputs, independent expected result or comparison rule, captured artifacts,
      timeout, and which outcome makes that candidate unsupported.
- [ ] `evidence/budgets.json` fixes fixture sizes, repetitions, latency/resource limits
      and measurement commands before the pilot. Two fresh processes canonicalize the
      contract and expected fixtures to identical pinned SHA-256 values in
      `evidence/contract-digests.txt`; changing one expected byte changes its digest.
- [ ] An authority audit in `evidence/no-production-adoption.json` records unchanged
      Forest runtime/dependency/service configuration and no new platform database
      authority. The ADR states the exact explicit human decision required for a
      contrary future architecture; no option silently relaxes ARCHITECTURE.md.
- [ ] The claim declares `Replay: N/A (contract and isolated evaluation planning only)
      + mitigation` and names source-pin validation, frozen fixtures and contract-digest
      evidence. No browser or runtime-adoption claim is made.

## Adversarial verification

1. Follow every pin from a fresh checkout. Replace a package integrity or full OID with
   a floating tag; a still-green validator refutes reproducibility.
2. Compare the actual published Sync URL/API and Agents server store configuration with
   the matrix. Calling a Postgres Shape endpoint a drop-in Durable Streams endpoint, or
   omitting required control-plane state, refutes the architecture analysis.
3. Choose the lost-acknowledgement case before viewing results. If its assertion counts
   tool invocations instead of externally visible effects, the experiment is inadequate.
4. Search the planned pilot for production credentials, an inherited Railway binding,
   a Forest package dependency on a database, or a second mutation path. Any such
   dependency refutes isolation and must be removed rather than waived.
5. Mutate one frozen expected byte and one budget field separately. The contract digest
   must change and prior pilot evidence must become stale; unchanged acceptance refutes
   the measuring apparatus.
6. Invent one additional bounded counterexample within the declared trust boundary and
   verify the contract can classify its observation without expanding to an unbounded
   claim or treating an unsupported provider as supported.

## Verification log
