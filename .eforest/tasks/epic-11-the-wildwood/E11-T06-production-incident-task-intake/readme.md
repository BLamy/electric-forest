---
id: E11-T06
epic: 11
title: Turn a deployed application regression into an authorized evidence-linked task
priority: 1106
status: pending
depends_on: [E11-T05]
estimate: M
capstone: false
---

## Goal

An authorized incident intake records the deployed application identity, observed
authoritative stream offsets, captured safe inputs, and evidence references, then creates
a normal Electric Forest task through the existing authenticated dispatch workflow. A
versioned detector observes a seeded regression in a disposable production-shaped
deployment and, after its declared threshold is crossed, produces exactly one task whose
event chain resolves back to that deployment and incident observation.

## Context

The whitepaper connects real application behavior to repair work by turning a production
failure into a reproducible fork and task. T05 establishes the immutable deployment
identity. This task records enough provenance for a later restore without copying
secrets, private user content, or mutable UI state as authoritative history. Incident
intake is a normal authorized task dispatch; it cannot write task files or statuses
directly, bypass validation, or grant a verdict.

The regression is seeded in an isolated production-shaped target with dedicated fixture
data. No live customer incident or production credential is required to verify this
task.

## Deliverables

- A versioned incident observation record linking a deployment id to app stream offsets,
  safe captured inputs, and evidence references.
- A deterministic health-signal detector with a declared consecutive-failure threshold,
  a scoped monitor identity, and a below-threshold control fixture.
- An authenticated intake path that creates a task through the normal dispatch door and
  records its resolving event offset.
- A seeded regression fixture and unauthorized/malformed intake cases.
- `make verify-E11-T06` and a replayable deployment-to-task chain under `evidence/`.

## Acceptance criteria

- [ ] `make verify-E11-T06` exits 0 from a cold clone and writes
      `evidence/e11-t06-incident-chain.jsonl`; replay links the seeded observation to the
      exact T05 deployment, app offsets, captured-input digest, evidence refs, and created
      task event offset.
- [ ] The seeded regression creates exactly one task through the normal dispatch path;
      the task's recorded deployment id and observed offsets match the deployment and
      application event log in `evidence/e11-t06-incident-summary.json`.
- [ ] Two consecutive failed health checks cross the declared detector threshold and
      produce one authorized monitor signal that creates exactly one task through normal
      dispatch; the signal, authorization, threshold decision, and task event are linked
      in `evidence/e11-t06-detection-chain.jsonl`.
- [ ] A control with one failed health check followed by a healthy check stays below
      threshold and creates no signal, incident, or task; `evidence/e11-t06-threshold.json`
      records both cases and unchanged stream heads for the control.
- [ ] An unauthorized caller, malformed observation, unresolved deployment reference,
      or stale app offset is refused with a typed reason and no task/deployment/app stream
      head change; `evidence/e11-t06-refusals.json` records before/after heads.
- [ ] Captured inputs are sufficient to identify the failing scenario and contain no
      seeded secret canary or undeclared personal field; the redaction scanner reports
      zero leaks and its planted-secret self-test fails in `evidence/e11-t06-redaction.json`.
- [ ] Duplicate retry after an acknowledged intake resolves to the original incident/task
      identity and emits no second task event; the retry and event counts are recorded in
      the chain.
- [ ] If intake is exposed through a browser surface, the named Replay QA journey proves
      authorized creation and refused unauthorized intake; otherwise the Verification log
      states `Replay: N/A (server dispatch only) + incident/task event chain and stream
      digests`.

## Adversarial verification

1. Substitute a different deployment id or move the observation offset one event
   earlier/later. Any task created with a non-resolving or mismatched reference refutes
   provenance validation.
2. Replay an intake event twice, including a retry after a simulated lost response. More
   than one task or a second incident identity refutes idempotency.
3. Attempt intake as an unrelated user, with expired authorization, and with a revoked
   grant. Any append or leaked private reference refutes the authorization boundary.
4. Plant canary secrets in each captured-input location and evidence metadata. A scanner
   miss, a secret in the task event, or a secret-bearing error message refutes redaction.
5. Change the normal dispatch validator in a scratch copy so it accepts a malformed
   task. If the sensitivity case remains green, the test apparatus is refuted.
6. Drop one health check or inject a healthy check between failures. Any signal or task
   below the declared threshold, or no task after the threshold is crossed, refutes
   detection-to-intake behavior.
7. Independently replay the deployment, app, incident, and task streams. Any broken
   reference, wrong offset, or task created outside normal dispatch refutes the chain.

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
