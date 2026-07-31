---
id: E3-T04
epic: 3
title: "Live repository and organization browse from the registry event stream"
priority: 304
status: in-progress
depends_on: [E3-T03]
estimate: M
capstone: false
---

## Goal

The authenticated web app renders the current user's repository list and organization
browse by reducing the E2-T08 registry stream through `useStreamReducer`. New
repositories appear through live application events. Private repositories never enter a
cross-tenant browser payload.

## Deliverables

- Repository-list and organization routes in `apps/web`.
- One shared registry reducer imported by projector, CLI replay, and browser.
- Stable sorting, empty/loading/refusal states, and DOM checkpoint/digest attributes.
- Two-browser live-add and private-visibility tests.

## Acceptance criteria

- [ ] Initial rows and digest equal independent replay of the authorized registry range.
- [ ] A newly created repository appears without navigation or reload.
- [ ] Anonymous/non-member payloads contain no private repository identifiers or counts.
- [ ] DOM checkpoint and digest advance to the event observed in the Replay recording.
- [ ] No database, side cache, or browser-local persistence feeds either list.

## Adversarial verification

1. Create public and private repos concurrently in two organizations.
2. Inspect response bodies and browser state for private-name leakage.
3. Drop/reconnect the live feed and compare rows to independent replay.
4. Mutate the registry reducer in a scratch worktree; the digest/browser gate must fail.

## Verification log

(appended by builder and critic)
