---
id: E3-T06
epic: 3
title: "Live StreamFS tree browser with deterministic digest"
priority: 306
status: pending
depends_on: [E3-T05]
estimate: M
capstone: false
---

## Goal

The tree route reduces a branch's StreamFS metadata events through
`useStreamReducer` and the canonical `@eforest/streamfs` reducer. Directory
navigation, renames, deletes, and recreates update live while the DOM exposes the exact
application checkpoint and tree digest.

## Deliverables

- Branch/path tree route and deterministic row selector.
- Shared StreamFS reducer; no browser-specific filesystem implementation.
- Keyboard/pointer navigation and accessible loading/error states.
- Live rename/delete/recreate browser scenario.

## Acceptance criteria

- [ ] Rows are segment-wise deterministic and match `StreamFs.listTree` over the same
      replay range.
- [ ] Tombstoned paths are absent; rename and recreate semantics match CLI replay.
- [ ] Live mutations render without document navigation or full projection reset.
- [ ] DOM tree digest equals independent StreamFS replay at the displayed checkpoint.
- [ ] No direct Electric credentials or retired custom endpoints appear in the browser.

## Adversarial verification

1. Rename a populated directory while the route points inside it.
2. Delete/recreate a path and verify stale file ids never reappear.
3. Reconnect around each mutation and compare final canonical trees.
4. Break one reducer operation in a scratch worktree; the digest gate must fail.

## Verification log

(appended by builder and critic)
