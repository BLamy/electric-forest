---
id: E13-T03
epic: 13
title: "Capstone: a legible, accessible shell over the real hosted workflows"
priority: 533
status: pending
depends_on: [E13-T02]
estimate: L
capstone: true
---

## Goal

Implement E13-T02's selected shell/navigation changes in `apps/web`, using existing
real stream hooks, routes and UI tokens. Public multi-user workflows remain reachable
and replay-derived; the product works with keyboard navigation and narrow screens.

## Context

This is a focused improvement to the hosted product, not another component-library
rewrite. Future changeset screens are implemented with their real backend in E14-T05;
do not add placeholder actions or claim those capabilities here. All E12 public access,
tenant isolation and recovery guarantees remain required regressions.

## Deliverables

- Shell/navigation/state components in `apps/web`, linked to the selected audit findings.
- Playwright scenarios for desktop, 390 px width, keyboard flows, reconnect, session
  change, branch change, forbidden access and loading/error states.
- `make verify-E13-T03`, committed DOM captures and independently replayable stream dumps.
- Focused Replay QA journeys and one integrated E13 epic-closing exploration.

## Acceptance criteria

- [ ] The immutable candidate passes the ordered root gates and the verify target cold
      with no skips, zero console errors and no serious/critical accessibility findings
      under E13-T02's frozen engine/version/rules and route/state/viewport matrix.
- [ ] Real pointer/keyboard interactions complete E12 signup/onboarding, browse, review
      and evidence flows. Desktop and narrow-screen captures demonstrate the approved
      changes without obscuring existing actions or tenant context.
- [ ] Switching branch/account, revoking access or reconnecting never shows another
      tenant's content or a mixed offset/digest pair. Every captured stream triple
      equals independent replay of the cited dump at that exact offset.
- [ ] Focused journeys in `proj-electric-forest-ms8w0nv1` and the E13 full exploration
      cite test-run/bug/recording IDs, candidate build identity and matching stream
      evidence. Actual deployed-origin smoke verifies the same shell release.
- [ ] A fresh critic reviews the diff, journey evidence and source-state parity before
      setting verified. Any unavailable Replay capability is declared with the literal
      N/A reason and mitigation required by AGENTS.md.

## Adversarial verification

1. Interrogate the recorded keyboard and narrow-screen journeys. Missing activation,
   hidden controls or an inaccessible selected flow refute the design contract.
2. Race branch/account change with delayed live responses and revocation. Any stale
   unauthorized content or wrong stream triple refutes isolation and provenance.
3. Freeze a DOM digest while statuses/content update in a scratch worktree. The verify
   target must fail against independent replay, not against a self-computed value.
4. Compare the complete E12 route matrix with the new shell. One removed public
   launch capability without explicit scope authorization refutes regression coverage.

## Verification log
