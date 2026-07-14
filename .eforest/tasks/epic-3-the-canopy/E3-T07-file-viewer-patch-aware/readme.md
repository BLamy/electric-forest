---
id: E3-T07
epic: 3
title: "Live patch-aware file viewer over canonical StreamFS events"
priority: 307
status: pending
depends_on: [E3-T06]
estimate: L
capstone: false
---

## Goal

The blob route resolves a path through StreamFS metadata and folds its per-file content
stream through the canonical content reducer. Full writes and text patches appear live
through `useStreamReducer`; patch base/result digests are enforced by shared
application code.

## Deliverables

- File-viewer route with metadata and content projections.
- Shared patch application and content digest implementation.
- Binary/oversize/error states that never silently coerce bytes.
- Two-session live patch and full-write fallback scenarios.

## Acceptance criteria

- [ ] Rendered bytes and digest equal independent replay at the displayed checkpoint.
- [ ] Valid patches and fallback writes update without reload.
- [ ] Wrong-base, wrong-result, truncated, or reordered patches fail visibly and do not
      corrupt rendered state.
- [ ] Rename keeps the same file identity; delete removes the open file deterministically.
- [ ] The browser contains no second patcher, hasher, or stream transport.

## Adversarial verification

1. Race a patch with rename and delete operations.
2. Corrupt each patch digest independently.
3. Force reconnect before and after the patch frame.
4. Compare browser bytes, CLI materialization, and replay digest exactly.

## Verification log

(appended by builder and critic)
