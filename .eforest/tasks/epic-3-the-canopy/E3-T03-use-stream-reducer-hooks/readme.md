---
id: E3-T03
epic: 3
title: "useStreamReducer: read and follow official-stream-backed application events in the browser"
priority: 303
status: verified
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

### 2026-07-30 — critic — VERDICT: refuted

- P1 exact replay/digest parity — PASSED. Predicted the committed two-event log would
  replay to the claimed follow digest; independent `ef replay` produced
  `edd45e15983c025cb18f986325f6e2d992f906ea0197d8f467a15c0accd3b2ff`, equal to
  `evidence/e3-t03-digest.txt` at application offset
  `0000000000000000_0000000000000001`.
- P2 repeated reconnect without rebootstrap — PASSED. Predicted two consecutive transport
  resets after bootstrap would keep checkpoint `...0000`, issue one bootstrap request,
  and converge through follow at `...0001`; observed one bootstrap, three follow
  requests, two `reconnecting` states at `...0000`, then `live` at `...0001`.
  `evidence/e3-t03-critic-truncation.txt`.
- P3 truncated application frames — FAILED. Predicted the sequence
  `[...0000, ...0002]` would fail loudly at missing offset `...0001`; both the platform
  and browser hook accepted it, advanced checkpoint to `...0002`, and returned digest
  `edd45e...d3b2ff`. The validators only require a strictly increasing offset
  (`packages/platform/src/gateway.ts:98-125`,
  `packages/web-hooks/src/useStreamReducer.ts:72-105`), while the existing truncation
  test only mismatches the response checkpoint against its final event
  (`packages/web-hooks/src/useStreamReducer.test.ts:53-60`). Evidence:
  `evidence/e3-t03-critic-truncation.txt`. Demand: validate the exact next application
  offset at both platform and hook boundaries, add bootstrap and follow tests that remove
  an interior event while retaining the later checkpoint, then re-record.
- P4 transport topology and materialized state — PASSED by source audit. Browser code
  imports the shared reducer and calls only the application projection route; the
  official adapter alone constructs `StreamReader`; no new server-owned StreamFS state
  cache or browser Durable Streams client exists. Browser transcript independently
  records platform-only requests and no direct credentials.
- COVERAGE truncation path — INSUFFICIENT. The committed browser walkthrough exercises a
  normal boundary append and malformed reducer payload, not forced reconnects or an
  interior missing frame (`apps/web/test/stream-reducer.pw.ts:76-108`). Replay source
  coverage is unavailable under the builder's declared upload-policy fallback. Record
  the repaired missing-frame failure and repeated reconnect behavior in the final
  browser proof.
- SENSITIVITY — PASSED for the existing ordering apparatus, but exposed the missing
  oracle. Disabling the duplicate/out-of-order comparison in a disposable worktree made
  two hook tests fail; the unmodified 17-test target passed. No committed test failed for
  `[...0000, ...0002]`, which is the refutation.
- SUITE: n/a until the truncation refutation and browser coverage demand clear.

Commands: `pnpm vitest run packages/protocol/src/digest.test.ts
packages/reducers/src/index.test.ts packages/platform/test/application-projection.test.ts
packages/web-hooks/src/useStreamReducer.test.ts`; `node packages/cli/dist/src/bin.js replay
evidence/e3-t03-application.jsonl --digest`; independent hook/platform gap probes against
`[offsetForOrdinal(0), offsetForOrdinal(2)]`; repeated-reset `runStreamReducer` probe;
disposable-worktree ordering sabotage.

### 2026-07-30 — builder rework — CLAIM: implemented

- Rework candidate: `4b82f6798008b18f845dd0523dd64de7401e38a3` (implementation
  `08cf351`, lint-safe regression `f511f55`, regenerated inherited shell evidence
  `4b82f67`).
- Refutation repair: product-owned application offsets now require the exact canonical
  successor, not merely a lexicographically greater value. Both the platform projection
  door and browser hook reject `[...0000, ...0002]` at missing offset `...0001`;
  bootstrap and follow variants are permanent tests. The official adapter also converts
  an already-aborted or timed-out long poll into an empty follow result instead of a
  platform 500, so reconnect polling remains live.
- Exact-head gates: `make --no-print-directory verify-E3-T03` — PASS over 435 repository
  tests, 21 E3-T03 targeted tests, format, lint, typecheck, production build, inherited
  Canopy security/recorder sensitivity, and the revised browser walkthrough.
- Cold clone: `tools/verify/cold_clone.sh verify-E3-T03` — PASS from a pristine clone of
  `4b82f6798008b18f845dd0523dd64de7401e38a3`, with ambient build variables scrubbed and
  non-loopback networking denied.
- Browser evidence: `evidence/e3-t03-browser.txt` records one bootstrap at checkpoint
  `...0000`, a forced recoverable reconnect without rebootstrap, live convergence at
  `...0001`, and rejection of observed offset `...0003` at exact missing offset
  `...0002`. The browser-side hook rejection used a 200 projection response so Chromium
  produced zero console errors; an independent real platform follow over the raw gapped
  stream returned 422 for the same missing offset. Network remained platform-only with
  no direct credentials and `console-errors=0 page-errors=0 request-failures=0`.
- Stream evidence remains `evidence/e3-t03-application.jsonl` and
  `evidence/e3-t03-digest.txt`: bootstrap digest
  `28b2bc964d91de2ad3a4a4b276de99fca64a7b683e24e8d38fb67688c0661249`;
  converged digest
  `edd45e15983c025cb18f986325f6e2d992f906ea0197d8f467a15c0accd3b2ff`;
  browser and CLI replay are equal at both checkpoints.
- Replay: N/A (the full record/upload remains blocked by external-upload policy, and
  static preflight reports no authenticated Replay identity and no working
  `replayio mcp` command) + mitigation: committed DOM/network/digest transcript,
  independent real-platform 422 probe, 435-test exact gauntlet, and exact-head pristine
  cold clone. No MP4 or Replay URL was produced, and that absence remains explicit.

The repaired evidence directly exercises the critic's missing-interior-offset input at
both validation boundaries and the previously unrecorded reconnect path. A skipped
application event can no longer produce a normal checkpoint or digest.

### 2026-07-30 — fresh re-critic — VERDICT: verified

- P1 original bootstrap/follow gap refutation — PASSED. Predicted both validation
  boundaries would reject `[...0000, ...0002]` at missing offset `...0001`; the focused
  22-test run rejected bootstrap and follow gaps in both platform and hook tests.
  The exact-successor doors are
  `packages/platform/src/gateway.ts:98-126` and
  `packages/web-hooks/src/useStreamReducer.ts:72-107`.
- P2 reconnect without rebootstrap and long-poll timeout — PASSED. Predicted a forced
  recoverable follow failure would retain checkpoint `...0000`, issue no second
  bootstrap, and then converge at `...0001`; the independently rerun browser proof
  observed exactly that sequence. An already-aborted official-client follow also
  completed empty instead of throwing. Evidence:
  `evidence/e3-t03-browser.txt:2-4`;
  `packages/platform/src/official.ts:120-135`.
- P3 browser/CLI/independent replay parity — PASSED. Predicted the committed canonical
  log would replay to the browser's converged digest; independent
  `ef replay evidence/e3-t03-application.jsonl --digest` produced
  `edd45e15983c025cb18f986325f6e2d992f906ea0197d8f467a15c0accd3b2ff`,
  equal to `evidence/e3-t03-digest.txt:2` and the browser at checkpoint `...0001`.
- P4 gap failure in the real browser and platform paths — PASSED. Predicted an observed
  `...0003` after saved checkpoint `...0001` would name missing offset `...0002`;
  the hook exposed that exact terminal status and the real platform follow returned
  422 for the same missing offset. The browser retained platform-only routing, no
  direct credentials, and zero console/page/request failures.
  `evidence/e3-t03-browser.txt:5-7`;
  `apps/web/test/stream-reducer.pw.ts:141-235`.
- P5 topology/cache hunt — PASSED. Source search found `StreamReader` construction only
  in the official platform adapter; the browser imports the shared reducer and requests
  the application projection. No E3-T03 server-owned StreamFS materialized-state cache
  or browser Durable Streams transport was introduced.
- NEW ATTACKS — PASSED. A bootstrap beginning at offset `...0001` was rejected at
  missing offset `...0000`; a stateful follow file-create correctly reduced against a
  directory established during bootstrap. These independent temporary probes were
  discarded after passing because the permanent exact-successor and state-fold tests
  already cover the exercised branches.
- SENSITIVITY — PASSED. In a disposable worktree, disabling both exact-successor
  comparisons produced four expected failures: bootstrap and follow gap tests at the
  platform and hook boundaries; the other 11 tests in those files stayed green.
- COVERAGE — SUFFICIENT. Every rework hunk is exercised or waived: successor allocation
  and both validation doors by unit tests plus browser/platform gap probes; abort handling
  by the official-adapter test; `appendApplicationAt` and the revised walkthrough by the
  browser run; transcript/digest/shell evidence changes are generated artifacts.
- COLD CLONE — PASSED. `tools/verify/cold_clone.sh verify-E3-T03` at exact HEAD
  `727cd0198062ebe39872ce32008be8de290386e5` passed from a scrubbed pristine clone:
  format, lint, typecheck, 435 tests, builds, inherited Canopy security and recorder
  sensitivity, 21 E3-T03 target tests, browser proof, and final
  `verify-E3-T03: OK`.
- Replay: N/A (current preflight authenticates and finds Replay Chromium but the
  installed `replayio` CLI rejects `mcp` as an unknown command, so the required Replay
  MCP interrogation layer is unavailable) + mitigation: independent Playwright rerun
  with DOM/network/error assertions, canonical event log and exact digest replay,
  platform 422 probe, mutation sensitivity, and scrubbed cold clone. The absence of an
  MP4/Replay URL remains explicit and is accepted under the repository's loud fallback.
- SUITE: retain the four permanent bootstrap/follow gap regressions, exact-successor
  allocator test, aborted-follow regression, and committed browser gap/reconnect
  transcript.

Commands: `pnpm vitest run packages/protocol/src/offset-allocation.test.ts
packages/platform/test/application-projection.test.ts
packages/web-hooks/src/useStreamReducer.test.ts packages/reducers/src/index.test.ts`;
`node --experimental-strip-types apps/web/test/stream-reducer.pw.ts`;
`node packages/cli/dist/src/bin.js replay
evidence/e3-t03-application.jsonl --digest`; temporary first-offset and stateful-follow
probes; disposable-worktree exact-successor sabotage;
`tools/replay/preflight.sh`; `tools/verify/cold_clone.sh verify-E3-T03`.
