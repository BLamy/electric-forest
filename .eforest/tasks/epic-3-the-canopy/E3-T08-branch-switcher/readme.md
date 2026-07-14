---
id: E3-T08
epic: 3
title: "Branch switcher over Electric native forks with isolated projections"
priority: 308
status: pending
depends_on: [E3-T07]
estimate: M
capstone: false
---

## Goal

Tree and blob routes switch between repository branches by rebinding
`useStreamReducer` to the selected native-fork-backed StreamFS streams. The UI exposes
parent/fork application checkpoints and keeps branch histories isolated.

## Deliverables

- Accessible branch selector shared by tree and blob routes.
- Per-stream checkpoint retention for fast switch-back without from-zero replay.
- Diverged fixture and rapid-switch/reconnect browser tests.
- DOM branch, parent, fork-checkpoint, head-checkpoint, and digest attributes.

## Acceptance criteria

- [ ] Switching changes the route and both metadata/content projections atomically.
- [ ] Branch-specific edits never leak to another branch before a merge event.
- [ ] Switching back resumes from the saved application checkpoint and converges.
- [ ] Displayed ancestry and digests equal independent replay of each official stream.
- [ ] Rapid switches cannot apply a late frame from the previously selected branch.

## Adversarial verification

1. Alternate branches while both receive writes and network reconnects.
2. Delay frames from the old branch until after rebinding.
3. Navigate to a path that exists on only one branch.
4. Compare each settled DOM digest with its branch dump.

## Verification log

(appended by builder and critic)
