---
id: E3-T10
epic: 3
title: "Capstone: the reading room on official Durable Streams"
priority: 310
status: in-progress
depends_on: [E3-T04, E3-T08, E3-T09]
estimate: L
capstone: true
---

## Goal

From a cold clone, start the pinned Auth0 emulator, platform gateway, web app, and
Electric's published local Durable Streams server. In one Replay Chromium session,
browse organization to repository to tree to file, switch branches, inspect history,
then observe a second authenticated session's StreamFS edit arrive live.

## Deliverables

- `make verify-E3-T10` / `verify-E3-capstone` cold-start scenario.
- One Replay recording and matching verified MP4 for the walkthrough.
- Seeded official-stream event logs and independent digest report for every visible
  projection.
- Zero-console-error and network-boundary assertions.

## Acceptance criteria

- [ ] Every Epic 3 route is reached through real pointer/keyboard interactions.
- [ ] The second session's edit appears without reload and advances the displayed
      application checkpoint/digest to independent replay parity.
- [ ] Private cross-tenant repository data never appears in network or DOM state.
- [ ] Branch switch, live tree, file content, and history remain mutually consistent.
- [ ] The browser talks only to the platform origin; the platform uses the official
      client/server boundary and can select Electric Cloud by configuration.
- [ ] Replay point links, MP4, stream offsets, and digest evidence are recorded.

## Adversarial verification

1. Interrogate the Replay timeline for console errors, failed requests, hidden reloads,
   and source coverage.
2. Compare each DOM digest with the committed official-stream dump.
3. Force one reconnect during the live edit and verify exact convergence.
4. Run the same scenario from a pristine clone with empty service state.

## Verification log

(appended by builder and critic)
