---
id: E3-T09
epic: 3
title: "Commit-less history from canonical application events"
priority: 309
status: in-progress
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

### 2026-08-02 — critic — VERDICT: verified

- Falsification: predicted every rendered row would map to one contiguous logical
  application offset, preserve its source stream and platform actor, and retain unknown
  payload bytes; observed exact row-count/order/source/raw matches in
  `evidence/e3-t09-browser.txt` and the canonical dumps in `evidence/e3-t09-events.json`.
  Same-timestamp appends prepend in offset order, reconnect preserves the boundary event,
  and inherited/fork/local feature history is isolated and complete.
- Sufficiency: `node tools/verify/e3_t09_evidence.mjs` independently replays both histories,
  matches their state digests, checks the higher-version unknown event and actor provenance,
  and turns red after a one-byte payload mutation. Focused platform/hook tests and the full
  `make verify-E3-T09` chain passed, including 43 test files / 463 tests and the browser
  journey with zero console/page errors.
- Coverage: the gateway recursive history resolver, history reducer, metadata-preserving
  hook, total humanizer, History route/branch selector, live/reconnect paths, styles, and
  verifier wiring are exercised by the focused tests, browser journey, build, and verify
  target. Replay MCP remains unavailable (`npx -y replayio mcp` reports `unknown command
  'mcp'`); per the repository fallback contract this is explicitly recorded as
  `Replay: N/A (...) + mitigation` in `evidence/e3-t09-replay.txt`, with Playwright
  console/network checks and independent stream replay as the mitigation. No code or
  evidence contradiction was found.
- Suite: promoted the deterministic browser journey and `verify-E3-T09` target as the
  standing regression artifacts. Implementation commit: `1abdd67`.
- Commands: `git diff --check`; `node tools/verify/e3_t09_evidence.mjs`;
  `make --no-print-directory _v-meta`; `make --no-print-directory verify-E3-T09`.
