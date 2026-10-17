---
id: E11-T02
epic: 11
title: Isolate sibling application forks across streams, browser storage, and declared effects
priority: 1102
status: pending
depends_on: [E10]
estimate: M
capstone: false
---

## Goal

The E10 fork workflow creates two isolated sibling application forks from one pinned
base. Each fork has independent branch-stream writes, browser storage, and declared
effect records; dispatches in either sibling cannot mutate the parent or its peer, and
external effects remain behind the platform's declared effect boundary.

## Context

Fork comparisons and repair experiments are meaningful only when a fork cannot leak
state into another fork or production. This task adds isolation to the existing platform
fork model without changing the authority boundary: application mutations still append
through the normal authenticated dispatch door to platform streams. Browser storage is a
fork-scoped input/state surface, not an alternate authoritative event log. Network and
service effects are intercepted or sandboxed according to the fork's declared
capabilities; undeclared access fails closed.

The sibling identity and base boundary are taken from the E10 fork contract. The task
does not introduce a new transport, shared mutable browser profile, or implicit live
service credentials.

## Deliverables

- Fork-scoped identities and isolation rules for stream writes, browser storage, and
  declared effects.
- A deterministic two-sibling scenario that starts from one manifest and records each
  fork's event log, effect ledger, and state digests.
- A sabotage fixture that mutates one sibling while measuring the parent and peer.
- `make verify-E11-T02` plus isolation and sensitivity evidence under `evidence/`.

## Acceptance criteria

- [ ] `make verify-E11-T02` exits 0 from a cold clone; `evidence/e11-t02-forks.jsonl`
      records both fork identities and their common base boundary, and
      `evidence/e11-t02-digests.json` records independent stream/storage/effect digests.
- [ ] After distinct writes to both siblings, each fork's event log contains only its
      own dispatched writes, while the parent's and peer's base-prefix digests remain
      byte-equal to their pre-sabotage values in `evidence/e11-t02-isolation.json`.
- [ ] Browser storage seeded with the same key in each sibling can be changed or removed
      in one fork without changing the other fork's value; the exact key/value hashes are
      recorded in the evidence, not inferred from screenshots.
- [ ] A declared sandbox effect appears only in the invoking fork's effect ledger; an
      undeclared effect is refused before execution and leaves all stream and effect
      heads unchanged.
- [ ] The test harness plants a cross-sibling write and an undeclared-effect call; both
      sabotage cases make the named assertions fail, as recorded in
      `evidence/e11-t02-sensitivity.json`.
- [ ] `make verify-E11-T02` emits no Replay run because the tested contract is platform
      isolation; the Verification log states `Replay: N/A (no browser interaction is
      changed) + fork event logs, storage hashes, effect ledgers, and digests`.

## Adversarial verification

1. Start three forks from the same base and interleave writes with distinct payloads.
   A write appearing in a sibling or parent log refutes stream isolation.
2. Reuse a browser-storage key, cookie, cache entry, and service-worker registration
   across siblings. Any peer-visible mutation or shared profile path refutes storage
   isolation.
3. Replace one sibling's effect adapter with a callback that attempts a real network or
   filesystem write. If it executes without a declared capability or is absent from the
   evidence ledger, the effect boundary is refuted.
4. Kill and restart one sibling after writes. If it resumes from the peer's or parent's
   head, or changes their digest, fork identity and persistence are refuted.
5. Mutate the committed isolation fixture so that it aliases a sibling identifier.
   A green suite refutes sabotage sensitivity.
6. Independently replay every fork log and recompute base-prefix digests. Any mismatch
   with the reported isolation result refutes the measurement.

## Roadmap alignment — 2026-10-16

E12 delivers Forest hosting now; this epic is later provenance-aware operation of hosted
applications. Deployment, restoration, comparison, incident and repair records pin the E14
source changeset and complete file-version/content-manifest hash in addition to tested build
and authoritative state offsets. Stale source/content identity invalidates evidence even when
a branch name or artifact label is unchanged. Derived diffs remain in memory; textual patches
persist only in redacted agent tool logs.

Browser claims use named Replay QA journeys in `proj-electric-forest-ms8w0nv1` through the
configured managed tunnel; an epic capstone also requires the integrated exploration. Earlier
recording references mean recordings attached to those runs, never a direct local browser
recording substituted as final proof. Cite project/journey/test-run/exploration IDs and paired
stream/object digests. Any fallback follows AGENTS.md and cannot waive a stricter task
requirement.

Generated comparison scenes follow E14-T05's recording masks; do not persist derived
patch text in QA or Playwright evidence outside agent logs.

## Verification log

