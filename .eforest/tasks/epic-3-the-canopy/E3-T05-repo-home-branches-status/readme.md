---
id: E3-T05
epic: 3
title: "Repository home: metadata, native branch forks, and live project status"
priority: 305
status: implemented
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
