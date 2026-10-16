---
id: E13-T02
epic: 13
title: "Design navigation, changeset terminology and complete interface states"
priority: 532
status: pending
depends_on: [E13-T01]
estimate: M
capstone: false
---

## Goal

Freeze a small product design contract for organization/project/repository navigation,
branch/file browsing, changesets, reviews, tasks, runs and evidence. It specifies the
actual hosted shell and clearly marks future E14 changeset screens as proposals.

## Context

Use E13-T01's observed problems to select improvements. A changeset identifies an
immutable source revision; a review discusses it; an agent run explains its production;
evidence binds the tested revision to a verdict. Computed review comparisons remain
available without treating a stored patch as source authority. Use the existing UI
primitives and tokens, and preserve every current reachable capability.

## Deliverables

- `docs/design/navigation-and-states.md` with route/actor/state matrix, entity glossary,
  task flow diagrams and desktop/narrow-screen wireframes.
- Traceability from every selected audit finding to a proposed state or documented
  deferral; no unrelated platform-builder scope.
- Explicit maps for loading, empty, forbidden, expired session, missing file/version,
  reconnect, stale branch head, conflict, binary comparison and evidence removal.
- `make verify-E13-T02` validating route coverage and finding-to-design references.
- A frozen accessibility test contract naming the scanner and exact version, ruleset,
  severity mapping, route/actor/state/viewport matrix and keyboard scenarios for T03;
  criteria cannot be reduced after observing failures.

## Acceptance criteria

- [ ] The verify target exits 0; every existing route/capability in E13-T01 maps to a
      reachable proposed action, and every selected finding maps to a design decision.
- [ ] Wireframes include desktop and 390 px width, keyboard focus order and accessible
      names, plus every named error/reconnect state. States requiring future APIs are
      labeled with the owning E14 ticket rather than shown as current behavior.
- [ ] The glossary distinguishes branch head, changeset, file version/content address,
      review, agent run, task and evidence; each link identifies its authorization scope.
- [ ] The source model shows complete immutable versions linked to changesets. Diff
      views are derived from endpoints; no design requires persisted textual patches
      outside redacted agent logs.
- [ ] `Replay: N/A (design specification; no browser implementation changed) + mitigation`
      names the screenshot-backed E13-T01 run and route/state coverage checks. Stream
      execution evidence for proposed screens is explicitly absent.

## Adversarial verification

1. Pick a current capability at random and follow the proposed routes using only the
   labeled actions. An unreachable feature refutes route coverage.
2. Trace removed access, a deleted file, a missing blob and a stale review through the
   state matrix. A happy-path-only design refutes completeness.
3. Delete a mandatory state or finding reference in a scratch copy. The verify target
   must fail; a green result refutes sensitivity.
4. Ask how a file can be reconstructed with every agent log removed. A design requiring
   patch text instead of complete object references refutes the source model.

## Verification log
