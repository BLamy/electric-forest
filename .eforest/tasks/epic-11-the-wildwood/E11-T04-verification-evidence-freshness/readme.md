---
id: E11-T04
epic: 11
title: Invalidate application verification evidence when its inputs change
priority: 1104
status: pending
depends_on: [E10]
estimate: M
capstone: false
---

## Goal

The Electric Forest verification gate fingerprints the exact application code artifact,
build epoch, schema, runtime, and declared capabilities covered by a verdict. It preserves
eligibility when those inputs are unchanged and refuses stale evidence when any bound
input changes, so a PR or deployment cannot reuse a verdict earned by different bytes or
runtime assumptions.

## Context

The whitepaper treats acceptance runs and independent verdicts as evidence tied to a
specific application state. E10 provides the acceptance/verdict lifecycle; this task
defines freshness across the inputs that can change application behavior. Freshness is a
stream-backed gate decision, not a mutable boolean supplied by a builder. Every decision
must be reconstructable from the recorded fingerprints and verdict reference.

The fingerprint contract is versioned here. It covers declared execution inputs and does
not claim that an unrecorded dependency is safe; discovering such an input requires
adding it to the contract before relying on the gate.

## Deliverables

- A canonical, versioned verification fingerprint for code/build/schema/runtime/
  capability inputs and verdict references.
- A freshness evaluator used by the normal PR eligibility gate.
- A committed change matrix covering unchanged inputs and one-at-a-time mutations.
- A renewal path that requires the normal E10 acceptance run and a fresh independent
  verdict for a changed fingerprint before eligibility can be restored.
- `make verify-E11-T04` with decision, fingerprint, and sensitivity artifacts under
  `evidence/`.

## Acceptance criteria

- [ ] `make verify-E11-T04` exits 0 from a cold clone and writes
      `evidence/e11-t04-freshness-matrix.json` with the baseline and every mutation
      outcome; the unchanged-input case remains eligible and points to the same verdict.
- [ ] Changing each of code artifact digest, build epoch, schema version, runtime version,
      or declared capability set independently causes the normal PR gate to refuse stale
      evidence; the resulting decision event cites the changed fingerprint field.
- [ ] Restoring an input byte-for-byte to its verified value restores eligibility only
      when all other inputs and verdict references still match; a changed field hidden by
      a reused fingerprint cannot remain eligible.
- [ ] After a candidate input changes, the old verdict remains ineligible; only a
      successful new E10 acceptance record and passing independent verdict bound to the
      new fingerprint restore eligibility. `evidence/e11-t04-renewal.json` links old
      fingerprint/verdict, new fingerprint, new acceptance, new verdict, and gate decision.
- [ ] An altered verdict reference, missing fingerprint field, and unknown fingerprint
      version fail closed with distinct typed reasons; `evidence/e11-t04-invalid.json`
      records unchanged heads for refused attempts that must be log-neutral.
- [ ] A planted one-byte change in each fingerprint source is detected by the named
      sensitivity leg; `evidence/e11-t04-sensitivity.json` records each mutation and the
      expected refusal.
- [ ] The final evidence reports exact source event offsets and recomputed fingerprint
      digests, and states `Replay: N/A (verification freshness is a platform gate) + gate
      event log, change matrix, and fingerprint digests` unless browser behavior is changed.

## Adversarial verification

1. Change each fingerprint input in a separate cold run, including changes that preserve
   the application output. Any stale verdict remaining eligible refutes the gate.
2. Reorder capability declarations, add an unknown capability, and remove one field.
   If canonicalization or version handling produces a false match, freshness is refuted.
3. Reuse a valid verdict id with a different artifact or altered verdict stream offset.
   Any eligibility result that does not resolve the original verdict event refutes
   provenance binding.
4. Mutate the fingerprint after gate evaluation but before PR eligibility is read. If the
   PR consumes the old result without checking its bound fingerprint, the gate is stale.
5. Change an input and try to restore eligibility with the old acceptance or verdict.
   Any green decision before a new E10 acceptance and fresh independent verdict for the
   new fingerprint refutes renewal enforcement.
6. Independently recompute fingerprints from the raw inputs and compare them to the gate
   event. Any mismatch or untracked declared input refutes the evidence.
7. Disable the mutation detector in a scratch copy and run the planted byte-change case.
   If the suite remains green, the sensitivity apparatus is refuted.

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
