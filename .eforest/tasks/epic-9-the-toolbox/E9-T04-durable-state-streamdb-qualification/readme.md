---
id: E9-T04
epic: 9
title: Qualify Durable State StreamDB as an opt-in Electric Forest provider
priority: 904
status: pending
depends_on: [E9-T03, E15-T03]
estimate: M
capstone: false
---

## Goal

Electric Forest records a pinned qualification result for the published `@durable-streams/state/db` StreamDB integration. It is an opt-in provider only for combinations proven to fit the public State protocol and Electric Forest's reducer and validated-mutation boundaries; unsupported combinations are explicitly refused without reinterpreting Electric Forest event formats or implementing transport.

## Context

StreamDB may fit some app state use cases, but its published contract must be checked against the exact package/runtime versions in use. The result can be supported or explicitly unsupported. Electric Forest continues to consume official Durable Streams transport and owns its application event/reducer semantics above that layer.

## Deliverables

- A qualification harness using pinned published package versions and the E9-T03 collection/mutation conformance cases.
- A committed provider matrix with protocol/runtime versions, tested capabilities, outcome, rationale, and refusal behavior.
- `make verify-E9-T04` and its request traces, event logs, and digest comparisons under `evidence/`.

## Acceptance criteria

- [ ] `evidence/streamdb-provider-matrix.json` pins package version and integrity, public contract/runtime tested, each tested capability, and exactly one outcome per combination: `supported` or `unsupported` with a concrete reason.
- [ ] The matrix contains at least one pinned package/runtime/capability combination and a nonempty outcome; an all-`unsupported` result is valid only when its refusal fixture proves startup or state acceptance is blocked.
- [ ] A `supported` row passes collection/replay parity and authenticated-write conformance against E9-T03; an `unsupported` row has a fixture proving the adapter refuses it before accepting state or advancing an offset. The observed result is recorded in `evidence/streamdb-conformance.json`.
- [ ] The request/process trace shows all transport calls use the published Durable Streams client and no new transport implementation or alternate Electric Forest event encoding is introduced; trace is committed as `evidence/streamdb-boundary.json`.
- [ ] An unsupported row cannot be selected by an `AppManifestV1`; `make verify-E9-T04` exits 0 with the rejection in `evidence/unsupported-manifest.json`.

## Adversarial verification

1. Select every unsupported provider/runtime row from a manifest. Any accepted configuration or state write refutes fail-closed qualification.
2. Change the provider package version without updating the pinned matrix. If qualification remains green without rerunning the conformance cases, the result is stale and refuted.
3. Forge a StreamDB-shaped event with fields that conflict with the Electric Forest event contract. Any silent reinterpretation or reducer digest change refutes the format boundary.
4. Inspect network and process traces for a locally implemented transport or bypass writer. Any such path refutes the official transport and dispatch claims.

## Roadmap alignment — 2026-10-16

This is later application-platform work after public launch, design, provider decisions and
changeset migration. Reuse E15's pinned contract/pilot/decision evidence before provider
qualification; optional app providers do not move Forest core authority out of streams.
Application source manifests pin E14 changeset identity and complete file-version/content
references. Derive comparisons in memory rather than storing patch artifacts outside redacted
agent logs.

Browser claims use named Replay QA journeys in `proj-electric-forest-ms8w0nv1` through the
configured managed tunnel; an epic capstone also requires the integrated exploration. Earlier
recording references mean recordings attached to those runs, never a direct local browser
recording substituted as final proof. Cite project/journey/test-run/exploration IDs and paired
stream/object digests. Any fallback follows AGENTS.md and cannot waive a stricter task
requirement.

Generated comparison scenes follow E14-T05's recording masks; do not persist derived
patch text in QA or Playwright evidence outside agent logs.

## Verification log
