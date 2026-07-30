---
id: E3-T02b
epic: 3
title: "Browser evidence hardening: full-wire credential scanner and atomic Replay publication"
priority: 302.1
status: in-progress
depends_on: [E3-T02a]
estimate: S
capstone: false
split_from: E3-T02
inherited_invalid_loop_commit: 1d22b95
---

## Goal

Independently prove the evidence-facing half of E3-T02: captured browser traffic cannot
hide protected credentials, and no Replay/MP4 claim can be published after any
browser/transport failure. This task consumes verified E3-T02a as its clean walkthrough
fixture and does not change shell, whoami, routing, identity reducer, or DOM-triple
semantics.

## Lineage and scope

This child inherits every scanner counterexample from parent runs 1-14 and both round-16
open findings: the final-snapshot-to-close race and malformed/inconsistent terminal
telemetry. Those findings are not waived or reset. Run 16's MP4 is a refuted-apparatus
fixture only.

Owned paths: browser-verify credential observation/scanner modules and corpus;
Replay lifecycle, terminal telemetry, MP4 validation, and sole publication edge;
B-specific verification scripts and evidence. Shared Makefile wiring is assigned only
for the B/composite targets.

## Deliverables

- Typed full-wire scanner with bounded canonicalization and permanent historical corpus.
- One production recorder lifecycle owning telemetry collection, closure, schema
  validation, MP4 verification, and the sole upload invocation.
- Publication state-machine transcript and expected-red race/crash/schema matrix.
- Fresh clean same-session MP4, upload receipt or loud tenant denial, source coverage,
  and `make verify-E3-T02b`.

## Acceptance criteria

- [x] Scanner observes raw request target, URL, method/status, every header name/value
      including duplicates, and request/response bodies; malformed or ambiguous protected
      representations fail closed without losing raw provenance.
- [x] JWTs, PKCE verifiers, and session IDs occur nowhere outside the exact structurally
      valid HttpOnly `ef_session` value; `document.cookie` cannot expose it.
- [x] Every inherited credential counterexample is a named expected-red with a benign
      control and one-byte sensitivity mutation.
- [x] Publication follows `OPEN -> SEALING -> CLOSED -> DECIDED_CLEAN -> PUBLISHING`.
      Producers are closed and callbacks drained before the decision. Missing, malformed,
      inconsistent, stale, or unknown-version terminal telemetry is red.
- [x] Console error, page error, and request failure delivered during walkthrough, after
      serialization, after any final sample, and while close begins all yield nonzero and
      publication count zero. Clean control publishes exactly once.
- [x] Crash/kill at each lifecycle edge cannot create a success receipt; retry cannot
      double-publish; uploader failure remains failure.
- [x] MP4 must be nonempty, correctly encoded, and same-session. Standing authorization
      means upload is always attempted; tenant denial is reported and never converted to
      success.
- [x] Production source identity and coverage checks prove sensitivities execute the real
      scanner/recorder; root gates, E3-T02a, E2-T04, E2-T12, exact-head B, and cold-clone
      B all pass.

## Adversarial verification

Replay all historical scanner seeds plus mixed-case, folding, raw-authority, bounded
decode, malformed, and oversize cases. Inject failures at every publication transition;
attack missing keys, wrong types, unknown versions, contradictory counters, TOCTOU,
delayed callbacks, signals, truncated/zero/wrong-codec MP4s, duplicate calls, retries,
wrong session IDs, and upload failure. Every verdict cites corpus case, transition,
publication count, and production hunk.

## Verification log

### 2026-07-29 — split validation — BLOCKED ON E3-T02a

- Parent coverage assigned here: credential scanner/encoding policy, observation receipt,
  terminal telemetry, browser close, MP4 verification, and the sole publication edge.
- Inherited open findings: round-16 P1 post-final-snapshot failures published and P2
  malformed counters failed open; all earlier scanner counterexamples remain regression
  requirements.
- Fresh proof required: complete wire corpus, lifecycle race/crash/schema matrix,
  exact-head gate, cold clone, and clean final recording. No run 1-16 builder claim is
  positive evidence for this child.

### 2026-07-29 — inherited-baseline validation — EXPECTED RED

- Command: `node /private/tmp/e3t02-run16-final-boundary-attack.mjs` against split commit
  `084037f8439e42a69d573a9ff13d1055d609679b`.
- Late page error: `guard-exit=0 publish-count=1 live-failures=1 snapshot-failures=0`.
- Late request failure: `guard-exit=0 publish-count=1 live-failures=1
  snapshot-failures=0`.
- Inconsistent terminal schema: `activity=7 stableSamples=0 failures=0 guard-exit=0
  publish-count=1`.
- Verdict: the inherited B apparatus is conclusively red before implementation. These
  three attacks are the minimum regression seeds; B cannot claim implemented until each
  yields nonzero with publication count zero and the clean control publishes exactly
  once.

### 2026-07-30 — builder — IMPLEMENTED

- Candidate implementation: `7cf4091bb180e0a9e7f61e4ff931c25e390d60d3`.
- Exact-head command: `make verify-E3-T02b` — PASS. Root format, lint, typecheck,
  34 test files / 413 tests, build, Auth0 emulator, production shell browser proof,
  task architecture audit, queue self-check, and E3-T02 contract/topology checks passed.
- Wire evidence:
  `evidence/e3-t02b-wire-sensitivity.txt` — `E3_T02_WIRE_SENSITIVITY_OK
  mutations=161`; production platform-wire observations preserve duplicate raw headers,
  request targets, request/response bodies, and raw provenance, with body-read ambiguity
  failing closed.
- Recorder evidence:
  `evidence/e3-t02b-recorder-sensitivity.txt` —
  `E3_T02_RECORDER_SENSITIVITY_OK cases=25 timing=12 schema=8 crash=3 retry=1
  mp4=1 clean-publish=1`. The clean path records
  `OPEN>SEALING>CLOSED>DECIDED_CLEAN>PUBLISHING` and publishes once; every timing,
  malformed-journal, close/video/upload, retry, and codec attack is expected-red with no
  false success receipt or duplicate publication.
- Pristine reproduction: `tools/verify/cold_clone.sh verify-E3-T02b` — PASS at exact
  commit `7cf4091bb180e0a9e7f61e4ff931c25e390d60d3`, including the production browser proof
  and both sensitivity matrices.
- Replay: N/A (external-upload policy rejected export before Replay Chromium launched)
  + mitigation: exact-head and pristine-clone production browser proofs, 161-case
  full-wire sensitivity corpus, and 25-case atomic lifecycle/crash/schema/MP4 matrix.
  No browser data left the machine; the denial was not converted to success.
- Claim: the production scanner now observes the full raw HTTP surface and fails closed
  on ambiguous evidence, while a single durable recorder lifecycle owns browser closure,
  terminal-journal validation, H.264 MP4 validation, and the sole upload edge. Therefore
  no post-snapshot browser/transport failure or malformed telemetry can publish a claim.

### 2026-07-30 — critic — VERDICT: refuted

- P1 same-session publication — FAILED. Predicted that a recording ID not proven to
  belong to the named Playwright session would be rejected before upload; observed
  `WRONG_RECORDING_ACCEPTED session=actual-browser-session
  uploaded=deadbeef-dead-4bad-8bad-deadbeefdead publicationCount=1`. The ID selector
  accepts whichever single new global Replay recording appears without checking its
  session or target (`tools/replay/e3_t02_recording_id.mjs:13-32`), and the lifecycle
  uploads and receipts that unbound ID (`tools/replay/e3_t02_recorder_lifecycle.mjs:
  267-283`). Demand: bind the Replay recording to the browser-open session with
  fail-closed identity evidence, and promote the wrong-recording-ID attack so an
  unrelated concurrent recording can never become this session's claim.
- P2 inherited timing and telemetry attacks — SURVIVED. Predicted all 12 timing
  combinations and eight schema mutations would remain red with no false receipt;
  observed `E3_T02_RECORDER_SENSITIVITY_OK cases=25 timing=12 schema=8 crash=3 retry=1
  mp4=1 clean-publish=1` from `node tools/verify/e3_t02_recorder_sensitivity.mjs`.
  Citation: `evidence/e3-t02b-recorder-sensitivity.txt`.
- P3 full-wire corpus — SURVIVED. Predicted the permanent credential corpus would reject
  all inherited mutations; observed `E3_T02_WIRE_SENSITIVITY_OK mutations=161` from
  `node tools/verify/e3_t02_wire_sensitivity.mjs`. Citation:
  `evidence/e3-t02b-wire-sensitivity.txt`.
- Replay N/A — WAIVED only for tenant denial. The loud external-export denial is an
  acceptable environmental fallback, but it cannot waive the task's local
  same-session identity invariant or its explicit wrong-session-ID attack.
- COVERAGE — INSUFFICIENT. The sensitivity suite's `wrong-session` mutation changes only
  the telemetry journal session (`tools/verify/e3_t02_recorder_sensitivity.mjs:238-243`);
  no test supplies an unrelated recording ID to the production publication edge.
- SUITE: n/a until the refutation clears. Independent attack:
  `node /private/tmp/e3t02b-wrong-recording-id-attack.mjs`.
