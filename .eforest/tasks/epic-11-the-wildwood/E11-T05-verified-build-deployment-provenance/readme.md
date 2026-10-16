---
id: E11-T05
epic: 11
title: Record deployments only for fresh verified application builds
priority: 1105
status: pending
depends_on: [E11-T04]
estimate: M
capstone: false
---

## Goal

The platform records a deployment only when the candidate's current code/build/schema/
runtime/capability fingerprint has fresh E10 verification evidence. A durable deployment
provenance record binds the exact artifact, application manifest and stream offsets,
verdict, and freshness decision; stale, missing, or tampered references are refused.

## Context

Deployments are the bridge between verified candidate behavior and later production
incidents. Without a durable link to the exact verified artifact and application-state
boundary, incident replay can reconstruct the wrong system. T04 supplies freshness
decisions; this task adds the deployment transition and its provenance record. The
platform's stream records the decision and identity. A deployment record does not make
rrweb/browser observations authoritative or bypass the normal authenticated dispatch
door.

The task covers a disposable production-shaped deployment target for verification. It
does not authorize a real production rollout or introduce a second source of deployment
truth.

## Deliverables

- A versioned deployment provenance event/record binding the artifact, application
  manifest and offsets, fresh verdict, and freshness fingerprint.
- A deploy eligibility check integrated with the normal platform deployment path.
- Valid, stale, missing-reference, and tampered-reference fixtures.
- `make verify-E11-T05` and a replayable provenance chain under `evidence/`.

## Acceptance criteria

- [ ] `make verify-E11-T05` exits 0 from a cold clone and records
      `evidence/e11-t05-deployment-chain.jsonl`; replay resolves the deployment to one
      exact artifact digest, app manifest id/offsets, verdict event, and T04 fingerprint.
- [ ] A current verified candidate deploys in the disposable target and the deployment
      result's artifact/app-manifest/verdict references byte-match the corresponding
      source events in `evidence/e11-t05-deployment-summary.json`.
- [ ] Mutating the candidate after verification, changing its runtime/schema/capability
      fingerprint, or substituting a stale verdict causes deploy refusal before any
      deployment event or target mutation; `evidence/e11-t05-stale-attempts.json` records
      unchanged target and stream heads.
- [ ] Altering or removing the manifest, offset, artifact, or verdict reference makes
      independent provenance replay fail with the exact unresolved field; the corrupted
      chain fixtures and results are stored under `evidence/e11-t05-tamper/`.
- [ ] Replaying the valid deployment chain twice from separate cold roots yields identical
      canonical provenance digests; changing one linked event changes the result and
      makes the sensitivity check fail.
- [ ] The Verification log cites stream-layer evidence and declares `Replay: N/A
      (deployment provenance is exercised through the platform server/CLI) + deployment
      event chain and independent replay`; if browser deployment controls change, it must
      include the task's named Replay QA journey instead.

## Adversarial verification

1. Race an artifact change between freshness evaluation and deployment dispatch. If a
   deployment is recorded for bytes other than the evaluated fingerprint, provenance is
   refuted.
2. Supply a valid verdict for another artifact, a verdict from an earlier build epoch,
   and a valid manifest with a wrong stream offset. Any accepted deployment refutes
   reference binding.
3. Interrupt dispatch after target preparation and retry. A duplicate deployment, an
   unrecorded target mutation, or an ambiguous result refutes atomic lifecycle behavior.
4. Change one byte in each linked artifact/event and independently replay the chain. Any
   corruption that retains the original digest refutes integrity.
5. Attempt deployment with a builder-issued eligibility flag but no fresh platform
   verdict. If the deploy door trusts the flag or writes before refusing, the authorization
   and freshness boundary is refuted.
6. Verify the evidence uses platform stream offsets, not a local database or browser
   recording as the source of deployment identity. Any alternate authority refutes the
   architecture contract.

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

