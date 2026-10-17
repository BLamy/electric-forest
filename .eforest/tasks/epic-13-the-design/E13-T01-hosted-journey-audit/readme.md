---
id: E13-T01
epic: 13
title: "Audit the public hosted journeys before changing the product shell"
priority: 533
status: pending
depends_on: [E12]
estimate: M
capstone: false
---

## Goal

Produce a screenshot-backed audit of the launched Electric Forest public workflows.
Rank concrete navigation, comprehension, responsive and accessibility problems from
observed states, and map each finding to a real route, actor and reproducible journey.

## Context

The human's 2026-10-16 priority is public hosting first, then design. E12 supplies the
actual hosted product; E5-T15's UI system remains the starting point. This task audits
the product before another shell redesign. It proposes changes without implementing
source-model or provider migrations. Use the repository's Product Design audit skill
when performing the audit, and retain the existing Replay QA proof protocol.

## Deliverables

- `docs/design/hosted-journeys.md`: actor/route inventory, screenshots and ranked findings.
- Task-local `evidence/journey-manifest.json`: candidate/build/origin, named Replay QA
  journeys/test runs, screenshot paths and source-stream offsets/digests where visible.
- Coverage matrix for signup, org/repo creation, invitation, browse, changes/history,
  review, evidence, logout and forbidden access, at desktop and a 390 px viewport.
- `make verify-E13-T01` checking every route/state/finding citation resolves.

## Acceptance criteria

- [ ] The verify target exits 0 from a cold clone with no missing screenshots, route
      entries or evidence citations. Every mandatory journey has an observed outcome.
- [ ] Each finding states actor, route, action, observed problem, screenshot/run point,
      impact and proposed remedy. A preference without observed evidence is classified
      as an idea rather than a defect.
- [ ] The matrix includes anonymous visitor, signed-in owner, invited member and outsider;
      it covers loading/empty/error/forbidden/reconnect states and keyboard navigation.
- [ ] Named Replay QA journeys in `proj-electric-forest-ms8w0nv1` exercise the audited
      routes through its managed tunnel; deployed-origin screenshots bind to the same
      candidate. Evidence includes console/network findings without hiding failures.
- [ ] No private prompts, credentials or unrelated customer data enter screenshots or
      published evidence. Dedicated multi-tenant fixtures supply the actors.
- [ ] The claim separates design observations from state claims; any offset/digest claim
      cites an independently replayable stream dump. Pure design observations declare
      stream execution evidence N/A rather than inventing state proof.

## Adversarial verification

1. Open every cited screenshot/run point and compare actor, route and described state.
   One invented or mismatched observation refutes the finding.
2. Remove one required route or narrow-screen capture in a scratch copy. The verify
   target must fail coverage; a green result refutes the audit apparatus.
3. Try the documented keyboard route from a clean session and inspect the recorded
   proof. A mouse-only action described as keyboard-accessible refutes the claim.
4. Search evidence for seeded secret canaries and private tenant data outside the
   actor's scope. Any leak refutes the evidence boundary.

## Verification log
