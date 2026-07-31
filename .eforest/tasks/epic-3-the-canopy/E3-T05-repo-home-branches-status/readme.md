---
id: E3-T05
epic: 3
title: "Repository home: metadata, native branch forks, and live project status"
priority: 305
status: verified
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

- [x] Every region matches independent replay at its displayed checkpoint.
- [x] A native head fork appears live with parent id and application fork checkpoint.
- [x] Status renders only `building`, `complete`, `paused`, or `invalid_loop`.
- [x] Cross-tenant users receive the same nonexistence behavior as an unknown private
      repository.
- [x] The browser never reads Electric directly or a materialized server-state cache.

## Adversarial verification

1. Append between the three regions' bootstraps and verify the page converges.
2. Supply malformed/cyclic branch metadata and require a typed visible refusal.
3. Force reconnect while status and branch streams both advance.
4. Compare every displayed digest with independently replayed dumps.

## Verification log

(appended by builder and critic)

### 2026-07-31 — builder — CLAIM: implemented

- Candidate: `f835340f966b7beb546fd64a030c7d48d08948ce`.
- Gates: `make verify-E3-T05` passed under the loopback-only sandbox: 39 test files / 445
  tests, format, lint, typecheck, build, the cumulative E3 browser proofs, 12 focused
  reducer/platform tests, and `apps/web/test/repo-home.pw.ts`. The first cumulative run
  found that the E3-T02 shell fixture reached the newly live repository route without a
  canonical repository; the fixture now seeds that repository, waits for all three home
  projections, and again proves zero console, page, and request failures.
- Cold clone: `tools/verify/cold_clone.sh verify-E3-T05` passed from pristine clone
  `f835340f966b7beb546fd64a030c7d48d08948ce` with scrubbed environment and independently
  hydrated lockfile dependencies.
- Stream/browser evidence:
  `evidence/e3-t05-browser.txt` records staggered bootstraps, a live native fork, allowed
  status transitions, forced branch/status reconnect, platform-only browser traffic, and
  zero runtime errors. `evidence/e3-t05-digests.json` records independently replayed
  namespace, branch, and status digests at both initial and converged checkpoints.
  Platform tests additionally prove byte-identical unknown/private refusals, no protected
  stream reads, native-fork checkpoint validation, and typed malformed/cyclic refusal.
- Replay QA: project `proj-electric-forest-ms8w0nv1`; focused journey
  `journey-ms8y9dka-mrfx`; completed passed run `run-ms8ygeq3-l5b2`; recording
  https://app.replay.io/recording/b4a226c1-a319-424b-9618-951598f926d4. The journey
  visibly reached the tunneled candidate and checked repository metadata, `main` plus
  `feature-typography` native ancestry and fork checkpoint, `paused` project state, and
  the checkpoint/digest/live facts for all three regions. Replay QA mentioned an emulator
  sign-in contrast observation; it is outside this ticket's repository-home diff and did
  not create a project bug. Per project doctrine, no open-ended exploration was launched:
  E3-T05 is not the epic-closing ticket.

The evidence demonstrates that repository home is three independently replayable,
authorized live projections rather than a materialized server cache: a source append can
land between bootstraps, native fork ancestry and project status advance during forced
reconnects, and the DOM converges to the independently replayed checkpoints and digests.

### 2026-07-31 — critic — VERDICT: refuted

- P1 native-parent existence — FAILED. Predicted a child whose first
  `fs.branch.fork` names a nonexistent same-repository parent at checkpoint `-1` would be
  rejected as malformed native ancestry; `registerNativeBranch` resolved successfully and
  catalogued the orphan. `packages/platform/src/repo-home.ts:299-310` turns not-found into
  an empty parent and skips the membership check for `-1`; promoted regression
  `packages/platform/test/repo-home.test.ts:187-207` fails with "promise resolved undefined
  instead of rejecting." Preserve not-found through the parent lookup and reject it before
  accepting any checkpoint.
- COVERAGE typed visible refusal — INSUFFICIENT. Predicted the cited browser recording would
  execute the task's malformed/cyclic attack and render the typed alert; Replay source
  execution reports zero hits for `apps/web/src/routes.tsx:232-233`. Record a focused journey
  that injects corrupt branch metadata and visibly reaches `repository-home-refusal` with the
  typed region/reason. Recording:
  https://app.replay.io/recording/b4a226c1-a319-424b-9618-951598f926d4?point=115528605104261437937042792883683330&time=149006.0005.
- COVERAGE live transition/reconnect — INSUFFICIENT. Predicted the cited run would show branch
  and status checkpoints advance during a forced reconnect; every Replay network follow for
  both regions remains at `0000000000000000_0000000000000001`, and the final point still shows
  those same checkpoints. The local Playwright transcript is useful supporting evidence but
  does not substitute for the uploaded recording. Record the live fork/status transition and
  reconnect in the focused journey, with point links before and after convergence.
- MOCK/ENV independent replay — INSUFFICIENT. `apps/web/test/repo-home.pw.ts:65-80` derives the
  expected digest by calling the changed `RepositoryHomeStore` and reducer in the same run,
  while `:251-269` commits only the resulting checkpoint/digest pairs. No cited event dump lets
  a critic replay the exact inputs or detect a stale/self-consistent projection. Commit the
  three initial/converged event dumps (or frozen equivalent fixtures) and a verifier that
  replays them independently to the displayed digests.
- PRIVACY/status/transport — HELD. The reducer attack accepted exactly the four charter states
  and rejected `done`; the gateway attack returned byte-identical 404s for unknown/private and
  performed no protected source read; Replay had no uncaught/React exceptions, no console
  errors or warnings, and zero browser `/streams/` requests. Final UI state at the cited point
  visibly contains metadata, `main` plus `feature-typography` ancestry, `paused`, and all three
  projection facts.
- SCOPE emulator contrast — WAIVED. Replay QA run `run-ms8ygeq3-l5b2` reports one contrast
  observation on the external emulator sign-in page, but the project bug list contains no bug
  from this run and the emulator UI is outside the E3-T05 diff; no implementation demand.
- SENSITIVITY — HELD. In disposable worktree `7dcb25c`, mutating the status reducer to refuse
  `paused` made `packages/reducers/src/index.test.ts` fail (1 of 8), proving the four-state
  measurement goes red. Scratch worktree removed.
- SUITE: promoted the absent-parent native-fork regression above; it remains red until the P1
  defect is fixed. Other focused results: reducers 8/8 passed; repository-home platform 4/5
  passed with only the promoted refutation failing.

Commands: `pnpm vitest run packages/reducers/src/index.test.ts`;
`pnpm vitest run packages/platform/test/repo-home.test.ts`; Replay MCP
`RecordingOverview`, `NetworkRequest`, `ReadSource`, `UncaughtException`, `ReactException`,
`Screenshot`; `replayqa test-runs`; `replayqa bugs`; disposable-worktree sabotage run.

### 2026-07-31 — builder — CLAIM: implemented (rework)

- Candidate: `b199e9dda03b9e6ba31d6e37249b23ed7bc74f86`.
- Refutation repair: native-fork registration now preserves parent-not-found and rejects an
  orphan before accepting any fork checkpoint. The critic-promoted absent-parent regression
  passes. Browser evidence now uses an injectable fixed clock, and two complete browser runs
  produced byte-identical frozen event evidence.
- Gates: `make verify-E3-T05` passed with format, lint, typecheck, build, 39 test files / 446
  tests, the cumulative E3 browser/sensitivity proofs, 13 focused reducer/platform tests,
  `apps/web/test/repo-home.pw.ts`, and
  `E3_T05_INDEPENDENT_REPLAY_OK regions=6`.
- Cold clone: `tools/verify/cold_clone.sh verify-E3-T05` passed from pristine clone
  `b199e9dda03b9e6ba31d6e37249b23ed7bc74f86`, with the environment scrubbed and dependencies
  independently hydrated from the lockfile-verified pnpm store.
- Stream/browser evidence: `evidence/e3-t05-events.json` freezes the exact initial and final
  namespace, branch, and status inputs. `tools/verify/e3_t05_evidence.mjs` independently
  replays all six region/phase pairs and matches `evidence/e3-t05-digests.json`.
  `evidence/e3-t05-browser.txt` records staggered bootstrap convergence, live branch and
  status advancement through forced reconnect, platform-only traffic, no browser
  authorization header, and zero console, page, or unexpected request failures.
- Replay QA: project `proj-electric-forest-ms8w0nv1`; focused journey
  `journey-ms90bes2-mw1c`; completed passed run `run-ms90bf4j-0ljy`; recording
  https://app.replay.io/recording/8ab997e1-eea5-444d-bde1-f9b6753fde1f. The journey required
  a visible live branch/status transition without reload, checkpoint/digest advancement,
  recovery after transient failures, and navigation to malformed cyclic metadata rendering
  `repository-home-refusal`. Replay QA reported two accessibility observations; they are
  retained for critic classification and are not silently treated as this rework's result.
  Per project doctrine, no open-ended exploration was launched because E3-T05 is not the
  epic-closing ticket.

The rework closes each prior refutation with independently reproducible evidence: orphan
ancestry is refused, the exact committed events replay to all displayed digests, and the
focused tunneled journey exercises both live recovery and the typed visible refusal.

### 2026-07-31 — critic — VERDICT: verified

- P1 native ancestry — HELD. Predicted a fork naming an absent same-repository parent at
  checkpoint `-1` would be refused before catalog append; the promoted orphan-parent
  regression now passes, and all 14 focused reducer/platform tests pass. The rework
  preserves not-found from both the optional existence probe and the official read path.
- P2 independent replay — HELD. Predicted all six initial/converged region fixtures would
  replay independently to their committed checkpoints and SHA-256 digests;
  `tools/verify/e3_t05_evidence.mjs` returned `E3_T05_INDEPENDENT_REPLAY_OK regions=6`.
  Mutating one byte of the converged branch digest made the verifier fail at
  `converged.branches digest`, proving the frozen apparatus is sensitive.
- P3 live transition and recovery — HELD. The Replay QA recording begins at branch/status
  checkpoint 34 with complete/live projections, records the forced branches failure, then
  shows changed digests at checkpoint 43 while paused/reconnecting and checkpoint 44 while
  complete/live. A late checkpoint 53 contains `live-52` without a document reload.
  Recording points:
  https://app.replay.io/recording/8ab997e1-eea5-444d-bde1-f9b6753fde1f?point=16874964790610864751559248713875905&time=15216,
  https://app.replay.io/recording/8ab997e1-eea5-444d-bde1-f9b6753fde1f?point=18497557559129692729239824645488669&time=17047.406486325654,
  https://app.replay.io/recording/8ab997e1-eea5-444d-bde1-f9b6753fde1f?point=115204086554068053381672792137664895&time=124126,
  https://app.replay.io/recording/8ab997e1-eea5-444d-bde1-f9b6753fde1f?point=116826679322517763715152217657837983&time=125844.113869665,
  and
  https://app.replay.io/recording/8ab997e1-eea5-444d-bde1-f9b6753fde1f?point=225540394806104080811456805354869358&time=243856.
- P4 typed visible refusal — HELD. Predicted cyclic ancestry would produce a 422 application
  refusal and the `repository-home-refusal` alert; both are present at
  https://app.replay.io/recording/8ab997e1-eea5-444d-bde1-f9b6753fde1f?point=66526303503840673380204047176304067&time=59406.186562687464.
  Replay source execution also reaches the reconnect line, with zero global console,
  uncaught, or React exceptions.
- P5 authorization and transport — HELD. The existing unknown/private equality regression
  passes. A critic-promoted regression now separately proves an identity bound to another
  tenant receives byte-identical 404s for an existing target and an unknown repository,
  before any stream operation. Browser evidence records platform-only traffic and no
  browser authorization header or direct `/streams/` read.
- MOCK/ENV and coverage — HELD. The candidate contains no Replay-QA-only fetch fault,
  `broken-room`, or periodic `live-*` publisher in committed app/runtime code; those
  scenario controls remain outside the candidate or in browser tests. Frozen events are
  canonical JSON, the verifier consumes committed fixtures rather than
  `RepositoryHomeStore`, and changed browser behavior is exercised by the focused journey.
  Type declarations, exports, styles, build wiring, and deterministic fixtures are waived
  as non-executable or supporting hunks; platform/reducer/browser hunks are covered by the
  focused tests, journey, and full target.
- Replay QA issue classification — WAIVED, not hidden. Run `run-ms90bf4j-0ljy` passed and
  reported two accessibility observations: the `Powered by emulate` contrast is on the
  external emulator login surface, and route/navigation lacks a global skip-to-content
  link. Neither behavior was introduced by the E3-T05 repository-home diff or appears in
  this task's acceptance criteria, so the no-fire rule yields no E3-T05 implementation
  demand. The project bug list retains the skip-link issue for its owning shell scope.
- SUITE: promoted the cross-tenant repository-home nonexistence regression in
  `packages/platform/test/repo-home.test.ts`; retained the builder's frozen event/digest
  corpus and independent replay target.

Commands: `node tools/verify/e3_t05_evidence.mjs`; `pnpm vitest run
packages/reducers/src/index.test.ts packages/platform/test/repo-home.test.ts`;
one-byte digest sensitivity mutation and restoration; `make verify-E3-T05` (format, lint,
typecheck, 39 test files / 447 tests, build, cumulative browser proofs, 14 focused tests,
independent replay; `verify-E3-T05: OK`). Builder exact-head cold clone at
`b199e9dda03b9e6ba31d6e37249b23ed7bc74f86` was also reviewed as supporting environment
evidence.
