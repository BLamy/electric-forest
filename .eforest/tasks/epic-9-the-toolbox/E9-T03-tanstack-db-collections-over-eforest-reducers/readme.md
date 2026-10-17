---
id: E9-T03
epic: 9
title: TanStack DB collections materialize Electric Forest reducers while dispatch stays authoritative
priority: 903
status: pending
depends_on: [E9-T01]
estimate: M
capstone: false
---

## Goal

`@eforest/tanstack-db` materializes registered `@eforest/reducers` state as TanStack DB collections and live queries for app clients. Client writes use the authenticated Electric Forest dispatch path; TanStack DB remains a client query/materialization layer and never becomes the authority for accepted app state.

## Context

Apps should share TanStack DB's collection and live-query model while preserving Electric Forest's event log, reducer, and one-mutation-door contracts. This task freezes the first-party adapter boundary that provider-qualification tasks can compare against. It does not replace reducers with a client cache or add another stream transport.

## Deliverables

- `@eforest/tanstack-db` collection adapter over registered reducer state and accepted event updates.
- A two-client fixture with a read/query path and a mutation routed through authenticated dispatch.
- `make verify-E9-T03` plus committed event logs, query snapshots, state digests, and refusal evidence.

## Acceptance criteria

- [ ] Two independently initialized clients consume the same accepted event log; their canonical collection/query result and digest equal a fresh replay through the registered `@eforest/reducers` implementation. Values and offsets are pinned in `evidence/two-client-parity.json` and the event log is in `evidence/accepted-events.jsonl`.
- [ ] A permitted client mutation is accepted only through authenticated dispatch and appears once in the stream; request trace and resulting offset/digest are recorded in `evidence/client-mutation-path.json`.
- [ ] An unauthorized mutation and an attempted direct collection write leave the stream offset, reducer digest, and other client's collection unchanged; `evidence/refused-writes.json` contains before/after values and refusal codes.
- [ ] Replaying the same accepted log in two fresh processes yields identical reducer and collection digests; `make verify-E9-T03` exits 0 with the compared digests in `evidence/replay-digests.txt`.

## Adversarial verification

1. Attempt a direct client collection write, bypassing dispatch. Any visible state treated as accepted, stream append, or offset advance refutes the authority boundary.
2. Deliver duplicate, delayed, and out-of-order event notifications to the two clients. A collection that diverges from replay or silently advances past a missing event refutes materialization correctness.
3. Revoke a client's permission between query and write. If the write changes the stream or either client's authoritative digest, dispatch authorization is refuted.
4. Mutate one event byte and replay. If the reducer/collection digest stays green, the evidence path is insensitive.

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
