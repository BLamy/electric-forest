---
id: E11-T07
epic: 11
title: Restore an incident fork and reproduce its captured failure at the same stream boundary
priority: 1107
status: pending
depends_on: [E11-T01, E11-T06]
estimate: M
capstone: false
---

## Goal

Given a valid T06 incident and its T05 deployment, the platform restores an isolated
application fork using T01, replays the captured safe inputs, and reproduces the same
failure signature at the same authoritative stream offset and state digest. A changed
input is detected as a distinct run and cannot inherit the incident's reproduction claim.

## Context

Incident repair is only useful when a fresh environment can reproduce the reported
failure from recorded inputs and the exact deployed application identity. This task
composes cold restore with authorized incident intake. The failure signature, offset, and
digest come from platform-stream evidence; browser rrweb data may explain the user-visible
sequence but is not used to fabricate or replace authoritative application state.

Replay runs use the isolated effect boundary established by the fork workflow. They do
not issue live production side effects. An unavailable input or missing retained offset
must fail explicitly instead of being patched from current state.

## Deliverables

- An incident replay runner binding the T06 incident, T05 deployment, T01 restore
  manifest, and captured-input digest.
- A stable failure signature and exact offset/digest comparison report.
- Frozen same-input and different-input fixtures, including an unavailable-input case.
- `make verify-E11-T07` and full restore/replay evidence under `evidence/`.

## Acceptance criteria

- [ ] `make verify-E11-T07` exits 0 from a cold clone and writes
      `evidence/e11-t07-replay-chain.jsonl`; replay resolves incident → deployment →
      manifest → captured inputs with all identities and offsets equal to their source
      events.
- [ ] Replaying the captured input in two independent empty roots produces the same
      declared failure signature at the same authoritative offset and byte-equal state
      digest; `evidence/e11-t07-reproduction.json` includes both cold-run results.
- [ ] Changing one captured input produces a distinct input digest and either a distinct
      failure result or an explicit non-reproduction result; it cannot be reported as the
      original incident reproduced. The exact changed input and result appear in
      `evidence/e11-t07-input-sensitivity.json`.
- [ ] Removing the required historical offset or one required input exits nonzero with a
      typed missing-evidence result and creates no successful replay receipt.
- [ ] Effect traces show no writes to the deployed application or live external service;
      the planted live-effect attempt is refused and recorded in
      `evidence/e11-t07-effects.json`.
- [ ] The Verification log includes stream logs and digest comparison and states
      `Replay: N/A (incident replay is executed in an isolated platform runner) + cold
      restore and event-log evidence`, unless this task changes a browser interaction, in
      which case it cites the named Replay QA journey.

## Adversarial verification

1. Replay a different deployment's incident with the same apparent failure text. If the
   runner accepts it as the linked incident, deployment identity checking is refuted.
2. Alter a captured input while retaining the old input digest. Any same-incident success
   refutes input binding and sensitivity.
3. Delete or reorder an event near the expected failure offset. If the runner reports the
   same offset/digest, or does not fail closed, replay integrity is refuted.
4. Make the failure occur at a neighboring offset with the same message. A text-only
   match refutes the signature contract.
5. Enable a real effect adapter or stale environment cache. Any production write or
   warm-only reproduction refutes isolation and cold replay.
6. Independently restore and replay the cited evidence, predicting the expected offset
   and digest before reading the result. Any mismatch refutes the builder's claim.

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

