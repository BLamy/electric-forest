---
id: E3-T09
epic: 3
title: "Commit-less history from canonical application events"
priority: 309
status: pending
depends_on: [E3-T05]
estimate: M
capstone: false
---

## Goal

The history route renders every canonical branch application event, newest first, using
one total `humanizeRecord` function. Each row cites its application offset, actor, kind,
and source stream; unknown versioned events render as explicit raw rows rather than
disappearing.

## Deliverables

- History route backed by `useStreamReducer`.
- Shared, total event humanizer and deterministic row ordering.
- Live append, reconnect, and unknown-event scenarios.
- Point-link-ready DOM attributes for stream id and application offset.

## Acceptance criteria

- [ ] Row count equals record count for the authorized replay range.
- [ ] Ordering is by canonical application offset only and remains stable across reloads.
- [ ] New events prepend live without resetting history.
- [ ] Unknown kinds remain visible and byte-citable.
- [ ] Actor values come from platform-stamped envelopes, never client payload fields.

## Adversarial verification

1. Append same-time events from several writers and verify offset-only order.
2. Inject an unknown higher-version event.
3. Reconnect with an event landing at the boundary.
4. Match random rendered rows back to exact dump bytes and offsets.

## Verification log

(appended by builder and critic)
