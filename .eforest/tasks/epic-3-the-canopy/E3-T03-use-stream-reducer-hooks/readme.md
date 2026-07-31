---
id: E3-T03
epic: 3
title: "useStreamReducer: read and follow official-stream-backed application events in the browser"
priority: 303
status: implemented
depends_on: [E3-T01, E3-T02b]
estimate: L
capstone: false
---

## Goal

`@eforest/web-hooks` exports `useStreamReducer`, the browser data path for every
stream-backed view. The hook requests an authorized application-event bootstrap from
`@eforest/platform`, folds those canonical events with the same reducer used by
`ef replay`, and follows later events from the returned application checkpoint.

The platform uses `@durable-streams/client` to read/follow Electric Durable Streams;
the browser API is an authenticated application projection, not an implementation or
proxy clone of the Durable Streams HTTP protocol. There is no server-materialized
reducer state endpoint and no second reducer.

## Deliverables

- `packages/web-hooks/src/useStreamReducer.ts` returning
  `{ state, checkpoint, digest, status }`.
- Platform application-event bootstrap/follow handlers backed by the official client.
- Reducer registry shared by CLI, platform validation, and browser bundles.
- Reconnect, hydration-boundary, duplicate, truncation, and malformed-event tests.
- A stream-inspector route exposing stream id, application checkpoint, digest, and
  reducer version in the DOM.

## Acceptance criteria

- [x] Initial state equals `ef replay` over exactly the returned canonical event range.
- [x] Events landing between bootstrap and follow are neither skipped nor duplicated.
- [x] Disconnect resumes from the last application checkpoint without a full reset.
- [x] Browser, CLI, and independent replay produce identical canonical state digests at
      the same checkpoint.
- [x] The network trace contains only platform application APIs; it does not expose
      retired custom state/event endpoints or direct browser credentials for Electric.
- [x] A malformed event fails loudly with the offending application offset.
- [x] Playwright evidence shows live convergence with zero console errors. Replay is
      unavailable under the explicitly recorded fallback below.

## Adversarial verification

1. Append at the bootstrap/follow boundary under repeated forced reconnects.
2. Duplicate, truncate, and reorder frames; silent digest convergence is a refutation.
3. Block further bootstrap requests after first load; recoverable reconnects must still
   converge from the saved checkpoint.
4. Compare source coverage against the browser recording and the independent replay log.
5. Search for a server-owned materialized reducer cache or a second transport client.

## Verification log

(appended by builder and critic)

### 2026-07-30 — builder — CLAIM: implemented

- Candidate commit: `202b6a14cc7f05390b1a78851afbc2a3241afc54`.
- Exact-head gate: `make --no-print-directory verify-E3-T03` — PASS. This ran
  format, lint, typecheck, all 430 repository tests, production build, inherited Canopy
  security and recorder sensitivity, 17 E3-T03 reducer/platform/hook tests, and the
  browser projection walkthrough.
- Cold clone: `tools/verify/cold_clone.sh verify-E3-T03` — PASS from a pristine clone
  of the candidate commit with the ambient environment scrubbed and non-loopback
  networking denied.
- Stream evidence:
  `evidence/e3-t03-application.jsonl`,
  `evidence/e3-t03-digest.txt`, and
  `evidence/e3-t03-browser.txt`. Bootstrap application checkpoint
  `0000000000000000_0000000000000000` produced digest
  `28b2bc964d91de2ad3a4a4b276de99fca64a7b683e24e8d38fb67688c0661249`;
  follow checkpoint `0000000000000000_0000000000000001` produced digest
  `edd45e15983c025cb18f986325f6e2d992f906ea0197d8f467a15c0accd3b2ff`.
  Browser and CLI replay were exactly equal at both checkpoints.
- Browser evidence: the final Playwright run crossed the bootstrap/follow boundary,
  retained its checkpoint through reconnects without a second bootstrap, used only
  authenticated platform application APIs, exposed no direct Electric credentials,
  and reported `console-errors=0 page-errors=0 request-failures=0`. A malformed event
  failed loudly at exact application offset
  `0000000000000000_0000000000000002`.
- Replay: N/A (the required full record/upload was blocked before execution by the
  external-upload policy; static preflight also reported no authenticated Replay
  identity and no working `replayio mcp` command) + mitigation: the committed
  Playwright transcript records DOM checkpoints/digests, CLI parity, platform-only
  network routing, exact malformed-event failure, and zero console/page/request errors;
  the exact verifier and pristine cold clone independently reproduced it. No MP4 or
  Replay URL was produced, and that absence is explicit.

The recorded stream artifacts and deterministic browser transcript demonstrate that the
browser hydrates and follows canonical application events through the platform, folds
them with the shared StreamFS reducer, resumes from its product-owned checkpoint, and
matches independent CLI replay without a server materialized-state cache or browser-side
Durable Streams transport.
