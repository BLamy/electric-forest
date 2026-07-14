---
id: E3-T05
epic: 3
title: "Repository home: metadata, native branch forks, and live project status"
priority: 305
status: pending
depends_on: [E3-T03]
estimate: L
capstone: false
---

## Goal

The repository home combines three authorized `useStreamReducer` projections: namespace
metadata, branch metadata, and project status. It shows Electric native-fork ancestry and
application fork checkpoints without inventing server-side branch state.

## Deliverables

- Repository-home route with metadata, branch list, and project-status regions.
- Pure reducers/selectors for each region.
- DOM stream/checkpoint/digest/reducer-version attributes.
- Live branch-created and project-status transition scenarios.

## Acceptance criteria

- [ ] Every region matches independent replay at its displayed checkpoint.
- [ ] A native head fork appears live with parent id and application fork checkpoint.
- [ ] Status renders only `building`, `complete`, `paused`, or `invalid_loop`.
- [ ] Cross-tenant users receive the same nonexistence behavior as an unknown private
      repository.
- [ ] The browser never reads Electric directly or a materialized server-state cache.

## Adversarial verification

1. Append between the three regions' bootstraps and verify the page converges.
2. Supply malformed/cyclic branch metadata and require a typed visible refusal.
3. Force reconnect while status and branch streams both advance.
4. Compare every displayed digest with independently replayed dumps.

## Verification log

(appended by builder and critic)
