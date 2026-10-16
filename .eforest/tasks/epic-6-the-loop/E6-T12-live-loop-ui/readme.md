---
id: E6-T12
epic: 6
title: "Live loop UI: launch and watch builder/critic runs, status flips, findings, and evidence"
priority: 612
status: pending
deferred_from: in-progress
human_deferred_on: 2026-10-16
depends_on: [E6-T06, E6-T11]
estimate: L
capstone: false
---

## Goal

The project page and task detail UI can start an authorized loop session and watch its
entire replay-derived timeline live: queue selection, builder branch/run/gates/claim,
critic predictions/attacks/verdict, rework, project stop/completion, findings, and every
evidence attachment. Independent browsers converge without reload, and every rendered
task, run, queue, and project state exposes its exact source offset and digest.

## Context

E6-T06 renders static/live task entities; E6-T11 makes the loop runnable. This task joins
them at the product surface. It must not stream private prompts, secrets, or unrestricted
tool output: the UI reads redacted run-stream projections and content-addressed evidence
through existing authorization. The launch button is a dispatch to the controller, not
an in-browser job runner.

All intermediate states matter. A UI that jumps from pending to verified conceals the
proof loop and fails the roadmap even if final state is correct. A refutation shows the
critic's prediction, observed value, finding fingerprint, and resolvable citation before
the rework starts.

## Deliverables

- `packages/webapp/src/routes/LoopSession.tsx` and project/task integration for launch,
  stop, resume, and live session navigation.
- `packages/webapp/src/loop/RunTimeline.tsx`, `GateResults.tsx`, `Finding.tsx`,
  `RunEvidence.tsx`, and live hooks for loop/run streams.
- Redacted run projection in `packages/loop` with stable DOM offset/digest contracts and
  secret-canary tests.
- Two-browser Playwright scenarios covering verify-first, refute/rework/verify, pause,
  invalid_loop, evidence removal, authorization refusal, and reconnect.
- `Makefile` target `verify-E6-T12` and Replay recording `e6-t12-final`.

## Acceptance criteria

- [ ] `make verify-E6-T12` exits 0 cold with zero skips and zero browser console errors;
      the Verification log cites an uploaded Replay recording containing both browsers.
- [ ] Browser A launches a refute-once fixture while browser B remains on the project /
      task pages; B observes in order pending, in-progress, implemented, refuted,
      in-progress, implemented, verified plus all builder/critic run boundaries without
      reload or document navigation, each within the committed liveness bound.
- [ ] B renders the first finding's prediction, observed value, fingerprint, and citation
      before the second builder run begins; the cited attachment/offset/Replay link
      resolves to bytes/state matching the rendered hash/value.
- [ ] At every captured transition, DOM task/run/queue/project offsets are at least the
      causative event offsets and their digests byte-equal independent server replay at
      those exact offsets; final quiescent DOM composite equals the session transcript.
- [ ] Builder gate results and both agents' evidence attachments appear live; attachment
      removal hides only the reference and never changes the shared content hash or other
      owner, proved in both browsers.
- [ ] Unauthorized launch, launch while paused/invalid/complete, and a second concurrent
      launch show frozen refusal states while every source head and DOM digest remains
      unchanged.
- [ ] No secret canary from agent environment, capability, raw prompt, or private tool
      output appears in HTML, browser network payloads, console, run projection, or Replay
      recording; redaction is asserted before rendering.
- [ ] Keyboard-only use can launch, follow the timeline, open findings/evidence, stop,
      and resume, with zero serious/critical accessibility findings.

## Adversarial verification

1. Inspect the Replay timeline around every status flip and network response. Missing
   intermediate states, reloads, console errors, or DOM offsets unrelated to source
   events refute live observability.
2. Delay/reorder run, task, queue, and project tails independently. Rendering a verdict
   before its claim/finding, or exposing a digest for mixed offsets, refutes consistency.
3. Plant unique secrets in every agent input channel and search recording/network/DOM
   artifacts. One leaked canary refutes the redaction boundary.
4. Race two launch clicks and pause during builder/critic boundaries. More than one
   session or one post-pause status mutation refutes control fencing.
5. Freeze the client task digest while allowing statuses to update. Playwright must fail
   the exact replay parity check; green refutes the browser evidence apparatus.

## Verification log

### 2026-09-01 — independent critic — VERDICT: needs-evidence

- P1/COVERAGE projection replay parity - INSUFFICIENT. Predicted each captured DOM
  transition would be independently reproducible from a committed server/event-log
  replay; observed only the browser transcript/DOM/network artifacts, with
  `e6_t12_evidence.mjs` checking the final DOM against `offsetForOrdinal(7)` and
  digest shape, not replaying any event log (`tools/verify/e6_t12_evidence.mjs:24-72`).
  The browser oracle itself manufactures `projectionAt()` and computes its digests in
  the same test process (`apps/web/test/loop-session.pw.ts:90-215`), so the asserted
  `a07da20b...`/`aaaa...`/`bbbb...` values are circular rather than independent
  server evidence. Add a committed projection/event-log dump and an independent
  replay comparison for every transition, or provide equivalent deterministic
  stream-layer evidence.
- P1/ERROR zero browser console errors - FAILED. Predicted the verify target would
  finish with zero browser console errors; observed the candidate test explicitly
  requires `actorConsoleErrors.length === 2` and `unauthorizedConsoleErrors.length ===
  2`, while accepting those messages only because they mention expected 409/403/404
  responses (`apps/web/test/loop-session.pw.ts:473-500`). This contradicts the stated
  acceptance criterion and the transcript verifier only searches the transcript text,
  not the captured console stream (`tools/verify/e6_t12_evidence.mjs:38-46`). Remove
  the console errors from the browser path or capture and prove a genuinely zero-error
  run under the literal criterion.
- P2/COVERAGE keyboard journey - INSUFFICIENT. Predicted keyboard-only actions would
  activate launch, timeline/finding/evidence navigation, stop, and resume; observed
  only a 45-Tab name scan and a presence check for `loop-stop`/`loop-resume`, followed
  by mouse clicks for launch, stop, and resume (`apps/web/test/loop-session.pw.ts:412-418`).
  No keyboard activation, finding/evidence opening, or serious/critical accessibility
  result is recorded. Add executable keyboard assertions and an accessibility result
  covering the complete criterion.
- P3/COVERAGE sensitivity attack - INSUFFICIENT. Predicted freezing the task digest
  while statuses advance would make the Playwright parity check fail; observed the
  sensitivity script merely replaces the literal DOM attribute name in source text
  and checks that the marker disappears (`tools/verify/e6_t12_sensitivity.mjs:51-59`).
  It never mutates a runtime projection or runs the browser oracle against a frozen
  digest, so it cannot validate the required measuring-apparatus sensitivity. Add a
  runtime negative test with a one-byte digest mutation that must fail.

### 2026-10-16 — human-directed hosting reprioritization

The human explicitly authorized updating the lifecycle to begin Railway hosting and
stubbed first deployments. Administratively defer this task to pending; its existing
implementation, claims, findings, evidence and verification-run history remain intact.
This is not a verification verdict, a finding closure, or a reset of any run/checkpoint.
E12-T00 executes the separate disposable preview scope first. All unearned acceptance
criteria still require their original independent proof before this task can verify.
