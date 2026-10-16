---
id: E11-T03
epic: 11
title: Compare a pinned application journey across forks and build epochs
priority: 1103
status: pending
depends_on: [E11-T01, E11-T02]
estimate: M
capstone: false
---

## Goal

Electric Forest compares one versioned acceptance journey executed against isolated
application forks and build epochs. The comparison reports exact equality or an
explicitly expected divergence and localizes any unexpected difference to its first
authoritative event offset and resulting state digest; screenshots alone cannot decide
whether application state matches.

## Context

The whitepaper proposes comparing sibling experiments and code/build variants to
understand behavior changes. T01 supplies cold-restorable application boundaries and T02
supplies isolated forks. This task promotes comparison into a repeatable platform
measurement with frozen fixtures, rather than a visual or post-hoc judgment.

Comparison inputs include the journey version, resolved E10 acceptance-run evidence
references for both sides, fork manifest ids, code artifact/build epoch identities,
runtime/schema/capability versions, event-log boundaries, and expected divergence
declarations. Each referenced run must prove the same pinned journey digest and resolve
to its exact fork, build, and stream evidence. Platform streams remain authoritative;
browser recordings may help explain an observation but do not override event or state
digests.

## Deliverables

- A versioned comparison input/result format for journey runs across forks/build epochs.
- A source resolver that verifies each comparison side against its E10 acceptance-run
  evidence and pinned journey digest.
- A deterministic comparator that identifies matching prefixes and the first divergent
  event/state digest, with a typed result for declared intentional differences.
- Frozen fixtures that include exact offsets and expected digests for equal and
  intentionally divergent runs.
- `make verify-E11-T03` and committed comparison reports under `evidence/`.

## Acceptance criteria

- [ ] `make verify-E11-T03` exits 0 from a cold clone and writes
      `evidence/e11-t03-equal-report.json`; independent replay of both fixture logs yields
      byte-equal canonical state digests at every declared common offset.
- [ ] For a fixture with one altered application event, the report names the first
      differing authoritative offset and both recomputed digests; the comparator result
      matches the frozen expected offset in `evidence/e11-t03-divergence-report.json`.
- [ ] A divergence explicitly declared by the journey contract is reported as expected
      only at its declared event/state path; an earlier or different divergence fails
      `make verify-E11-T03` and is listed as unexpected in the report.
- [ ] Comparison output binds both results to the exact journey version, manifest ids,
      artifact/build epochs, runtime/schema/capabilities, and stream boundaries in
      `evidence/e11-t03-inputs.json`; changing any binding changes the comparison input
      digest.
- [ ] Each side names an E10 acceptance run and evidence reference that resolves to the
      same pinned journey digest and that side's exact fork, build, and stream evidence;
      a missing run reference or a substituted run with unrelated evidence is refused
      with a typed reason in `evidence/e11-t03-source-resolution.json`.
- [ ] The one-byte event mutation sensitivity check fails the comparison with the
      expected first offset; `evidence/e11-t03-sensitivity.json` records the changed byte,
      predicted result, and observed result.
- [ ] The Verification log declares browser proof as Replay evidence when the journey
      changes browser behavior; for a stream-only comparator run it records
      `Replay: N/A (no browser behavior changed) + event logs, offsets, and digest reports`.

## Adversarial verification

1. Supply two logs with equal final digests but a divergent and later reconvergent
   intermediate state. If the report omits the first divergence, prefix comparison is
   refuted.
2. Change the event order while preserving the final reduced value. If the comparator
   declares full-run equality without reporting the changed event sequence, its claim is
   too weak.
3. Substitute an artifact, runtime, schema, or capability identity while retaining the
   original result file. Any accepted stale binding refutes provenance checking.
4. Add an undeclared divergence before the expected intentional divergence. A report
   that labels the run expected refutes declared-difference handling.
5. Recompute fixture digests independently and mutate the event stream after report
   creation. Any green comparison or wrong localized offset refutes the apparatus.
6. Run a journey with non-deterministic timestamps or unordered JSON fields. If equivalent
   canonical records compare unequal, or materially different records compare equal,
   the canonicalization contract is refuted.
7. Replace one run-evidence reference with an unrelated run carrying the same journey
   label, then remove the other source reference. If either comparison is accepted
   without resolved evidence for the same pinned journey and exact input boundary,
   provenance binding is refuted.

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
