---
id: E7-T07
epic: 7
title: "Time-travel scrubber: drag through branch history and render exact historical repo state"
priority: 707
status: pending
depends_on: [E7-T06]
estimate: L
capstone: false
---

## Goal

The branch page gains an accessible time-travel scrubber backed exclusively by
E7-T06 projections. Dragging, keyboard stepping, or opening `?at=<activityOffset>` pins
the app to that offset and reconstructs the file tree, open file, issue/PR/task panels,
session feed selection, and project status as they existed at that cursor. The UI shows
the activity offset and composite digest in the DOM, clearly labels historical mode,
disables every mutation control while pinned, and returns to the live tail only through
an explicit "Return to live" action.

## Context

The scrubber is a view over one activity offset, never a collection of independently
live widgets. All participating surfaces receive one immutable projection object so a
file from the past cannot be displayed beside a current task status. Drag previews may
cancel stale requests, but only the response matching the latest requested cursor may
commit. Historical URLs are reloadable and shareable subject to normal authorization.

## Deliverables

- `packages/webapp/src/time-travel/TimeTravelScrubber.tsx`, projection context, request
  cancellation, historical-mode banner, and live-return control.
- Integration of tree/file/issues/PRs/tasks/project status/activity panels with the
  immutable historical projection and disabled mutation controls.
- Playwright suite for pointer drag, keyboard navigation, deep-link reload, rapid race,
  live writes while pinned, auth errors, and return-to-live convergence.
- `make verify-E7-T07`, Replay recording, per-cursor DOM/composite captures, network and
  no-dispatch logs, and accessibility checks.

## Acceptance criteria

- [ ] `make verify-E7-T07` exits 0 from a cold clone with zero skips, all root gates and
      automated accessibility checks green.
- [ ] For every cursor in the committed fixture, the DOM activity offset/composite
      digest equals E7-T06 CLI replay, and named tree/file/issue/PR/task values equal the
      prefix goldens.
- [ ] Pointer drag and keyboard stepping visit at least five distinct offsets, including
      before/after a file create, task transition, and PR event, with one atomic
      projection per rendered state and zero console errors.
- [ ] While pinned, at least five live events land; every historical DOM value remains
      unchanged, all mutation controls are disabled, and server dumps prove the browser
      dispatched zero events.
- [ ] Rapid out-of-order HTTP responses never paint a stale cursor: the final DOM offset
      equals the last requested offset and its matching digest in 20 raced trials.
- [ ] Reloading a valid `?at=` URL restores the identical historical digest; invalid,
      pruned, and unauthorized cursors show explicit errors and never current state.
- [ ] Returning live converges to the independently fetched activity head and current
      composite digest without document reload; the cited Replay recording contains
      the complete scrub and return flow or fallback is declared per AGENTS.md.

## Adversarial verification

1. Drive your own pointer and keyboard cursor order and compare every DOM digest to
   offline CLI replay. Any mismatch or mixed-era widget refutes atomic projection.
2. Delay responses in reverse order while scrubbing rapidly. A stale response painting
   after the last request refutes race handling.
3. Keep a writer active while pinned and attempt every mutation control plus direct form
   submission. Any appended event or silently advancing widget refutes historical mode.
4. Deep-link to malformed, nonexistent, pruned, and unauthorized offsets. Falling back
   to head or leaking protected historical data refutes error isolation.
5. Sabotage one panel to retain its live hook and freeze the displayed composite digest.
   The verification target must detect both mutations.
6. Interrogate Replay at each named cursor, matching DOM tuples to committed evidence and
   checking network/console. Missing points or inconsistent values refute the recording.

## Verification log
