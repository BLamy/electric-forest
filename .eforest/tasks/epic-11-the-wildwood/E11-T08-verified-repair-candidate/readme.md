---
id: E11-T08
epic: 11
title: Verify a repair on an isolated sibling and bind its candidate to the originating incident
priority: 1108
status: pending
depends_on: [E11-T02, E11-T07]
estimate: L
capstone: false
---

## Goal

The normal E10 acceptance, independent verdict, and PR flow can verify a repair on a
fresh isolated sibling fork of a reproduced incident. Its resulting candidate carries
fresh verification evidence and immutable links to the original deployment, incident,
replay, and sibling fork, while the incident environment and its failure digests remain
unchanged.

## Context

The whitepaper's repair loop compares a proposed fix against an isolated reproduction,
then promotes only a candidate with current evidence. T02 protects the incident and peer
forks; T07 supplies a reproducible failure. This task connects those primitives to the
existing E10 workflow rather than inventing a second acceptance or verdict mechanism.
Only a fresh independent critic can issue the normal verdict. The builder cannot mark the
candidate verified or update the incident's original state to make the repair appear to
pass.

## Deliverables

- A repair-candidate lifecycle that forks from the incident reproduction and routes
  acceptance, verdict, and PR eligibility through E10.
- Provenance links for deployment, incident, reproduction, sibling fork, artifact,
  freshness fingerprint, acceptance evidence, verdict, and PR candidate.
- A seeded repair fixture with a passing candidate and a deliberately stale/failed
  candidate.
- `make verify-E11-T08` and candidate/incident comparison evidence under `evidence/`.

## Acceptance criteria

- [ ] `make verify-E11-T08` exits 0 from a cold clone; the event chain in
      `evidence/e11-t08-candidate-chain.jsonl` resolves the repair candidate through
      sibling fork, T07 reproduction, T06 incident, T05 deployment, fresh T04
      fingerprint, E10 acceptance, independent verdict, and PR eligibility.
- [ ] The seeded repair passes the same acceptance journey that reproduced the incident;
      its new candidate digest differs from the failing incident build as expected, and
      its passing state digest and fresh verdict are recorded in
      `evidence/e11-t08-candidate-summary.json`.
- [ ] After candidate verification, the original incident fork's event log, failure
      offset, and state digest remain byte-equal to their pre-repair values in
      `evidence/e11-t08-incident-unchanged.json`.
- [ ] A candidate with a stale fingerprint, failed acceptance, or missing independent
      verdict cannot become PR-eligible; refusal cites the exact missing or stale evidence
      and leaves the PR/deployment heads unchanged.
- [ ] Replaying the provenance chain twice from clean roots yields identical candidate
      and incident digests; changing a linked event or artifact byte makes the chain
      verification fail.
- [ ] The Verification log cites the independent critic verdict and all stream evidence;
      it includes Replay QA journey evidence for any browser-impacting change, or an
      explicit `Replay: N/A (...) + stream-layer evidence` statement for server/CLI-only
      repair orchestration.

## Adversarial verification

1. Modify the repair sibling while checking the original incident and a second sibling.
   Any changed incident/peer digest refutes isolation.
2. Try to reuse the incident's old acceptance or verdict after changing the code artifact,
   runtime, schema, or capabilities. Any PR eligibility refutes freshness enforcement.
3. Present a builder-issued verdict or reuse the builder session as critic. If either can
   mark the candidate verified, role separation is refuted.
4. Break the repair so the original incident still reproduces, then tamper with its
   displayed result. Any passing verdict or unchanged evidence digest refutes acceptance
   and measurement integrity.
5. Remove one provenance edge or substitute a different incident with a similar failure
   signature. Any candidate still claiming this incident as its origin refutes link
   validation.
6. Recompute both incident and candidate streams independently and compare before/after
   digests. Any unrecorded write, stale proof, or candidate chain mismatch refutes the
   completion claim.

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

