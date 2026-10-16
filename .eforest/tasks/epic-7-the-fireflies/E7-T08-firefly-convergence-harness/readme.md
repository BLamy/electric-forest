---
id: E7-T08
epic: 7
title: "Firefly convergence harness: two viewers, live agent edits, exact prefix and latency proof"
priority: 708
status: pending
depends_on: [E7-T04, E7-T05, E7-T07]
estimate: M
capstone: false
---

## Goal

`make verify-E7-fireflies` runs a reusable two-viewer scenario against a fresh server:
a real hosted agent session performs incremental edits, tool calls, and task activity
while two isolated browsers watch the same branch feed and file. For each source event,
the host harness records the dispatch acknowledgement time and the first monotonic host
time each browser exposes the matching source offset. Both browsers must render the
event within two seconds of dispatch and within one second of each other, then converge
to identical DOM activity/content offsets and digests. The harness also scrubs both
browsers to sampled historical offsets and compares them to offline replay.

## Context

This is Epic 7's promoted measuring apparatus, not its capstone choreography. Browser
`performance.now()` clocks are not compared across contexts; the Playwright host stamps
both observations with one monotonic clock. Bounds are committed constants and cannot
be derived from the observed run. The scenario emits enough events to expose batching,
resume, and last-write-only cheats, and promotes its logs as a permanent golden corpus.

## Deliverables

- `apps/web/test/firefly-convergence.spec.ts` with two isolated contexts, host
  observation clock, zero-console/network assertions, disconnect/recovery, and scrub.
- `tools/scenarios/firefly_session.ts` driving the real E7-T02 recorder and producing
  source/activity dumps plus an expected event manifest.
- `tools/verify/firefly_convergence.sh`, `make verify-E7-fireflies`, and
  `make verify-E7-T08`, including sabotage legs and cold-clone support.
- Promoted golden session under `apps/web/fixtures/fireflies/` and task evidence:
  latency timeline, dumps, DOM captures, prefix/composite digests, and sensitivity log.

## Acceptance criteria

- [ ] `make verify-E7-T08` and `make verify-E7-fireflies` exit 0 from a pristine cold
      clone, fresh server/profile dirs, scrubbed environment, zero skips, all root gates
      green.
- [ ] Every expected source event is observed exactly once by both browsers; each host
      observation is at most 2000 ms after dispatch acknowledgement and the absolute
      difference between browser observations is at most 1000 ms, with all timestamps
      committed in `evidence/e7-t08-timeline.json`.
- [ ] Both browsers finish with activity and content offset/digest pairs equal to each
      other, server head, and independent replay of fresh dumps.
- [ ] One browser loses its tail during active writes and still satisfies exact event-set
      equality and final digest parity after resume, with no reload or application projection bootstrap refetch
      after hydration.
- [ ] At no fewer than five sampled activity offsets, both browsers' historical composite
      digest equals E7-T06 offline replay; at least one sample precedes file creation and
      one lies between incremental saved versions.
- [ ] Sabotages for dropped version, duplicate feed row, last-write-only rendering, frozen
      DOM digest, and reload-on-reconnect each make the named assertion fail before an
      `EXPECTED-FAIL OK` marker.
- [ ] The fixture and verify target join the permanent suite without weakening or
      forking E7-T02/T03/T06 checks; browser evidence is recorded under Replay and cited
      unless preflight fallback is declared per AGENTS.md.

## Adversarial verification

1. Replace the committed scenario with your own seeded interleaving and burst schedule.
   Recompute the expected manifest from source dumps, never UI output; any missing or
   duplicate observation refutes.
2. Independently recompute host latencies from raw timestamps and verify the committed
   constants predate the run. Clock mixing or a post-hoc bound refutes latency proof.
3. Sever each browser at different offsets and hold one offline through multiple edits.
   A reload, state refetch, or final event-set difference refutes recovery.
4. Scrub to your own random prefixes and compare both DOM composites against offline
   source replay. Any mismatch or browsers agreeing on the same wrong value refutes.
5. Run every committed sabotage and invent one more mutation. A sabotage that stays green
   refutes the apparatus, regardless of the happy run.
6. From a cold clone, verify profiles, server state, ports, and goldens are created or
   read as declared; hidden warm state, fixed dev ports, or generated-at-test goldens
   refute reproducibility.

## Roadmap alignment — 2026-10-16

This task runs after the hosted loop and E14 source transition. Accepted source changes are
complete immutable versions linked to changesets; fine-grained edit/patch text belongs only in
redacted agent logs. Activity and historical views reference actual changeset, version and
source-offset identities; transient highlights are computed from full versions. No new
branch/content/projection/evidence artifact may persist textual patch bodies. Legacy verified
streams/evidence remain unchanged.

Browser claims use named Replay QA journeys in `proj-electric-forest-ms8w0nv1` through the
configured managed tunnel; an epic capstone also requires the integrated exploration. Earlier
recording references mean recordings attached to those runs, never a direct local browser
recording substituted as final proof. Cite project/journey/test-run/exploration IDs and paired
stream/object digests. Any fallback follows AGENTS.md and cannot waive a stricter task
requirement.

Generated comparison scenes follow E14-T05's recording masks; do not persist derived
patch text in QA or Playwright evidence outside agent logs.

## Verification log
