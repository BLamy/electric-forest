---
id: E3-T09
epic: 3
title: "Commit-less history from canonical application events"
priority: 309
status: implemented
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

- [x] Row count equals record count for the authorized replay range.
- [x] Ordering is by canonical application offset only and remains stable across reloads.
- [x] New events prepend live without resetting history.
- [x] Unknown kinds remain visible and byte-citable.
- [x] Actor values come from platform-stamped envelopes, never client payload fields.

## Adversarial verification

1. Append same-time events from several writers and verify offset-only order.
2. Inject an unknown higher-version event.
3. Reconnect with an event landing at the boundary.
4. Match random rendered rows back to exact dump bytes and offsets.

## Verification log

(appended by builder and critic)

### 2026-08-02 — builder — implemented

- The history reducer and gateway projection preserve every canonical application event,
  rebase inherited and branch-local records into one contiguous application-offset space,
  and attach the platform-stamped actor plus source stream. `humanizeRecord` is total and
  deterministic: known StreamFS kinds get summaries while unknown/versioned kinds retain
  canonical raw payload bytes. The History route exposes row-level point-link attributes,
  actor/source/kind metadata, branch switching, live follow, and reconnect state.
- Stream evidence: `evidence/e3-t09-events.json` contains canonical main and feature
  history dumps; `evidence/e3-t09-digests.json` records independent history-reducer state
  digests. `node tools/verify/e3_t09_evidence.mjs` replays both dumps, checks contiguous
  offsets, source/actor provenance, unknown `v99` retention, and rejects a one-byte payload
  mutation by digest mismatch.
- Browser evidence: `evidence/e3-t09-browser.txt` demonstrates row-count parity,
  newest-first reload stability, same-timestamp offset order, live prepend, reconnect-boundary
  preservation, inherited/fork/local branch history, exact random-row raw-byte matching, and
  zero console/page errors. `evidence/e3-t09-replay.txt` records the Replay MCP preflight
  limitation and the Playwright/stream-replay mitigation.
- Gates: `pnpm format:check`; `pnpm lint`; `pnpm typecheck`; `pnpm test` (43 files, 463
  tests); `pnpm build`; `make --no-print-directory _v-meta`; and
  `make --no-print-directory verify-E3-T09` all passed. The latter also re-earned the
  inherited E3-T03 through E3-T08 gates and finished `verify-E3-T09: OK`.
