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

- [ ] Scanner observes raw request target, URL, method/status, every header name/value
      including duplicates, and request/response bodies; malformed or ambiguous protected
      representations fail closed without losing raw provenance.
- [ ] JWTs, PKCE verifiers, and session IDs occur nowhere outside the exact structurally
      valid HttpOnly `ef_session` value; `document.cookie` cannot expose it.
- [ ] Every inherited credential counterexample is a named expected-red with a benign
      control and one-byte sensitivity mutation.
- [ ] Publication follows `OPEN -> SEALING -> CLOSED -> DECIDED_CLEAN -> PUBLISHING`.
      Producers are closed and callbacks drained before the decision. Missing, malformed,
      inconsistent, stale, or unknown-version terminal telemetry is red.
- [ ] Console error, page error, and request failure delivered during walkthrough, after
      serialization, after any final sample, and while close begins all yield nonzero and
      publication count zero. Clean control publishes exactly once.
- [ ] Crash/kill at each lifecycle edge cannot create a success receipt; retry cannot
      double-publish; uploader failure remains failure.
- [ ] MP4 must be nonempty, correctly encoded, and same-session. Standing authorization
      means upload is always attempted; tenant denial is reported and never converted to
      success.
- [ ] Production source identity and coverage checks prove sensitivities execute the real
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
