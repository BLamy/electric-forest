---
id: E2-T11
epic: 2
title: "Platform rate limits and tenant isolation before official-stream access"
priority: 211
status: implemented
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
