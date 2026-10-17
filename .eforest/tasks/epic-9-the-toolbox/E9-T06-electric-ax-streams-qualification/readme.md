---
id: E9-T06
epic: 9
title: Qualify Electric Ax and Streams without a second transport or write door
priority: 906
status: pending
depends_on: [E9-T03, E15-T03]
estimate: M
capstone: false
---

## Goal

Electric Forest records a pinned qualification result for Electric Ax/Streams integrations against their published contracts and the official Durable Streams transport boundary. An integration is selectable only for tested capabilities; unsupported combinations fail closed, and no path adds a second transport or write door for Electric Forest state.

## Context

Electric Ax and Streams may provide useful app-facing abstractions, but their exact published contracts and runtime support must be established at implementation time. Qualification records what works without changing Electric Forest event schemas, authorization, or transport ownership. A clear unsupported result is a successful qualification outcome.

## Deliverables

- A harness that records the pinned Electric Ax/Streams artifacts and exercises applicable E9-T03 collection and dispatch cases.
- A provider matrix with contract/runtime versions, tested capabilities, support verdicts, and fail-closed behavior.
- `make verify-E9-T06` plus committed call traces, parity digests, and refusal fixtures.

## Acceptance criteria

- [ ] `evidence/electric-ax-provider-matrix.json` pins each package version and integrity, cited public contract, tested runtime/capabilities, and one explicit `supported` or `unsupported` result per combination.
- [ ] The matrix contains at least one pinned Electric Ax/Streams package/runtime combination and a nonempty result for every exercised capability; an all-`unsupported` result is valid only with fixture evidence that each exercised capability is refused before startup or state mutation.
- [ ] Every supported row passes the applicable reducer replay and authenticated-dispatch conformance cases; unsupported rows are refused before startup or state mutation. Results and digests are in `evidence/electric-ax-conformance.json`.
- [ ] The transport trace attributes stream I/O to the published Durable Streams client and contains no second transport or alternate write door; `evidence/electric-ax-transport-trace.json` records the observed calls and zero forbidden paths.
- [ ] Manifest validation rejects every unsupported matrix row; `make verify-E9-T06` exits 0 with exact refusal outcomes in `evidence/unsupported-manifest.json`.

## Adversarial verification

1. Select an unsupported combination and attempt reads and writes. Any startup that advertises support or accepted state mutation refutes fail-closed behavior.
2. Plant a second transport client or direct writer in a fixture. If the boundary audit remains green, it does not detect forbidden paths and is refuted.
3. Replay accepted events through the registered reducer and compare the adapter digest. Any divergence refutes the supported conformance result.
4. Change the pinned package artifact or public-contract version while keeping the old matrix. If the validator still treats it as supported, the qualification is stale.

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
