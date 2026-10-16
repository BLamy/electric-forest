---
id: E9-T05
epic: 9
title: Qualify TanStack Electric collections for apps using PostgreSQL
priority: 905
status: pending
depends_on: [E9-T03, E15-T03]
estimate: M
capstone: false
---

## Goal

Electric Forest records a pinned qualification result for `@tanstack/electric-db-collection` as an optional collection provider for apps that choose PostgreSQL. The adapter can be selected only for tested combinations, and all mutations affecting Electric Forest state still pass through the app's validated server path and authenticated dispatch.

## Context

Some hosted apps may intentionally use an external PostgreSQL source while Electric Forest's own platform state remains stream-authoritative. The published TanStack Electric collection contract is qualified separately from the first-party reducer adapter. A qualification must not imply that PostgreSQL or its write path replaces Electric Forest events.

## Deliverables

- A pinned-version qualification harness for `@tanstack/electric-db-collection` and the public app/server API boundary.
- A provider/request matrix with supported or explicit unsupported outcomes and evidence for each tested path.
- `make verify-E9-T05` with collection parity, request tracing, and fail-closed selection checks.

## Acceptance criteria

- [ ] `evidence/electricsql-provider-matrix.json` records package version/integrity, tested runtime and Postgres shape, each read/write case, and a pinned `supported` or `unsupported` result with rationale.
- [ ] The matrix contains at least one pinned runtime/Postgres shape and explicit outcomes for at least one collection read and one attempted write; unsupported outcomes include a refusal fixture, and no outcome implies PostgreSQL replaces Electric Forest stream authority.
- [ ] For a supported row, collection reads match the declared source and every mutation request for Electric Forest state reaches the validated app server path then authenticated dispatch; request ids, event offset, and resulting digest are committed in `evidence/electricsql-request-trace.json`.
- [ ] Unauthorized or malformed writes produce no accepted event and leave the stream offset/digest unchanged; direct adapter writes to Electric Forest state are refused. Before/after values and refusal responses are in `evidence/electricsql-refusals.json`.
- [ ] Unsupported rows are rejected by `AppManifestV1` validation before app startup; `make verify-E9-T05` exits 0 and records the rejected fixture in `evidence/unsupported-manifest.json`.

## Adversarial verification

1. Configure the adapter to write directly to a PostgreSQL-backed collection for an Electric Forest-owned entity. Any state mutation that bypasses validated server dispatch refutes the boundary.
2. Race a permitted write with permission revocation and replay the resulting events. Acceptance after revocation or a client digest not backed by an accepted event refutes authorization/convergence.
3. Remove or change the pinned collection version. A green qualification without matching package integrity refutes the provider matrix.
4. Mark a deliberately failing case as supported. If the matrix validator accepts the result without passing its recorded evidence, the qualification is not trustworthy.

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
