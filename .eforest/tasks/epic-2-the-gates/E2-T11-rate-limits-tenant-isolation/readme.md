---
id: E2-T11
epic: 2
title: "Platform rate limits and tenant isolation before official-stream access"
priority: 211
status: verified
depends_on: [E2-T10]
estimate: M
capstone: false
---

## Goal

`@eforest/platform` applies deterministic per-subject rate limits and tenant isolation
to application API operations before invoking the official Durable Streams client.
Electric's server remains unchanged. Fixed-window accounting is keyed by verified Auth0
subject plus operation class and uses an injected clock for deterministic evidence.

Cross-tenant probes are refused without revealing stream existence, touching a private
log, or consuming another tenant's quota.

## Deliverables

- Pure fixed-window limiter with injected clock and typed 429 responses.
- Platform middleware ordered after authentication and before namespace resolution,
  authorization, reducer validation, or official-stream calls.
- Cross-tenant probe corpus covering reads, follows, dispatches, registry queries, and
  token issuance.
- Golden rate-limit and isolation transcripts with stream-digest guards.

## Acceptance criteria

- [x] Request `MAX` succeeds and `MAX + 1` returns typed 429 with deterministic
      retry metadata; advancing the injected clock opens the next window.
- [x] Anonymous/public and authenticated operation classes use the documented keys
      without sharing counters across tenants.
- [x] Refused and over-limit requests perform zero official-client calls.
- [x] Cross-tenant private probes are indistinguishable from nonexistent resources and
      leave every involved stream unchanged.
- [x] No wall-clock sleeps are used in deterministic tests.
- [x] `make verify-E2-T11` passes against the Auth0 emulator and published server.

## Adversarial verification

1. Fire concurrent requests at the window boundary; totals must never exceed the limit.
2. Probe encoded stream ids and namespace aliases across tenants.
3. Reuse one token across public and private operation classes and verify counters match
   the documented key.
4. Search for limiter or tenant logic in `@eforest/server` or any copied transport.

## Verification log

(appended by builder and critic)

### 2026-07-24 — builder — implemented

- Proof commit: `73a276a21ebef1ce781d8f740189c0314a70b477`.
- Commands:
  - `CI=true make verify-E2-T11` — PASS: formatting, lint, typecheck, 31 root
    test files / 406 tests, build, 3 focused files / 45 tests, E2-T11 evidence
    and sensitivity, pinned Auth0 emulator, inherited E2-T07/E2-T08/E2-T09/E2-T10
    proofs, meta self-check, and target inventory; terminal
    `verify-E2-T11: OK`.
  - `tools/verify/cold_clone.sh verify-E2-T11` — PASS from a pristine clone of
    the exact proof commit with scrubbed environment and pinned emulator
    submodule; terminal
    `cold_clone: verify-E2-T11 PASSED from a pristine clone`.
  - `node tools/verify/e2_t11_evidence.mjs` — PASS twice, byte-identical:
    `rows=15`, SHA-256
    `5c8c1dfeea1b368edc5ca6954de78d08f75d1e33a3ac38a461a41dc49938e7d9`.
  - `node tools/verify/e2_t11_sensitivity.mjs` — PASS: one-byte golden
    corruption and all three production-source mutations went expected-red
    (`attacks=4 source-mutations=3`).
- Stream evidence:
  `evidence/e2-t11-rate-tenant.golden.txt`. The real-TCP run uses
  `createDurableStreamTestServer` plus `OfficialStreamAdapter`, proves exact
  MAX/MAX+1/reset behavior, encoded cross-tenant probes over read/follow/
  dispatch/registry/token paths, anonymous/authenticated counter separation,
  revoked-credential ordering, zero private/target calls on every refusal, and
  exact before/after all-stream digest equality.
- Replay: N/A (server/protocol-only middleware and verifier work; no browser
  surface changed) + mitigation: deterministic real-TCP official-server
  transcript, all-stream SHA-256 guards, concurrent boundary unit proof,
  source-mutation sensitivity, full inherited authorization matrix, and
  exact-head pristine cold clone.
- Claim: the platform now performs fixed-window accounting by
  tenant/verified-subject/operation after authentication, refuses tenant-bound
  cross-tenant probes before private namespace or target access without
  consuming the target tenant's quota, preserves anonymous and tenantless
  public behavior, and leaves the published Durable Streams transport and
  `@eforest/server` unchanged.

### 2026-07-24 — critic — VERDICT: verified

- P1 authentication and gate ordering — PASSED. Predicted malformed/revoked
  credentials would fail before rate accounting or private-stream access;
  the focused suite passed 45/45, the revoked transcript row returned 401
  with `private-calls=0` and identical digest
  `1cf854600a46c4ed5265f13f0aa7c0baf8d6736b93cc85088462de93598b6041`,
  and the credential-order source mutant went expected-red.
- P2 fixed-window accounting — PASSED. Predicted exactly MAX admissions,
  typed MAX+1 refusal, reset at the injected boundary, and no over-admission
  under a 40-request concurrent burst. The unit suite observed 7 accepted /
  33 refused for its independent burst; the real-TCP golden recorded two
  accepted 200s, a 429 with exact retry metadata and zero private calls, then
  a 200 after the clock advanced. Limiter-bypass mutation went expected-red.
- P3 tenant isolation and existence neutrality — PASSED. Predicted foreign
  read/follow/dispatch/registry/token probes and encoded aliases would perform
  zero private/target calls, preserve the all-stream digest, consume no target
  quota, and match nonexistent-private responses. All cited refusal rows
  recorded `private-calls=0` and before/after digest
  `350513bf2e893cac32595e5d722d9df7fc099cd8891771dbb00172570a7ba57e`;
  foreign private read and nonexistent read bodies were byte-equal. The
  production tenant-bypass mutant went expected-red.
- P4 key separation and additional input — PASSED. Predicted anonymous and
  authenticated public reads would occupy distinct subject keys, and a subject
  actively bound to both `acme` and `beta` would be admitted to both but not
  `gamma`. The committed proof observed independent count 1 values; a detached
  exact-head critic test passed the multi-tenant case plus delimiter-shaped
  counter keys and one-clock-sample semantics. A first-tenant-only membership
  mutant failed the `beta` assertion as predicted. The scratch test was
  discarded because the committed pure isolation test plus production
  tenant-bypass sensitivity already cover the stable invariant.
- P5 scope, coverage, and compatibility — PASSED. Diff review found no
  `.skip`, `.todo`, disabled lint, deterministic-test sleeps, copied
  transport, limiter/tenant symbol in `packages/server`, or
  `packages/server` diff from verified base
  `3dbbb7696577b001870989ad5180219315beaec9`. The pristine target re-earned
  the promoted E2-T08 refusal/visibility/no-database evidence and E2-T10
  216-row authorization plus 37-row/18-refusal HTTP operations matrix.
- Evidence binding — proof head
  `73a276a21ebef1ce781d8f740189c0314a70b477`; submission
  `cda7e2eb90f3008fee4cf0d056c1eaba3065bb3a` changes only this task readme
  and generated queue over the proof head. `node
  tools/verify/e2_t11_evidence.mjs` passed twice byte-identically:
  `rows=15`, SHA-256
  `5c8c1dfeea1b368edc5ca6954de78d08f75d1e33a3ac38a461a41dc49938e7d9`.
  `node tools/verify/e2_t11_sensitivity.mjs` passed all four expected-red
  attacks. `tools/verify/cold_clone.sh verify-E2-T11` cloned exact head
  `73a276a21ebef1ce781d8f740189c0314a70b477`, completed 31 files / 406 root
  tests, 3 files / 45 focused tests, every inherited proof, and terminated
  with `verify-E2-T11: OK` and
  `cold_clone: verify-E2-T11 PASSED from a pristine clone`.
- Replay: N/A (server/protocol-only middleware and verifier work; no browser
  surface changed) + mitigation: independently reproduced real-TCP transcript,
  exact all-stream digest guards, source and golden mutation sensitivity,
  critic-authored boundary input, full composed target, and exact-head
  pristine cold clone.
