---
id: E2-T11
epic: 2
title: "Platform rate limits and tenant isolation before official-stream access"
priority: 211
status: in-progress
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

- [ ] Request `MAX` succeeds and `MAX + 1` returns typed 429 with deterministic
      retry metadata; advancing the injected clock opens the next window.
- [ ] Anonymous/public and authenticated operation classes use the documented keys
      without sharing counters across tenants.
- [ ] Refused and over-limit requests perform zero official-client calls.
- [ ] Cross-tenant private probes are indistinguishable from nonexistent resources and
      leave every involved stream unchanged.
- [ ] No wall-clock sleeps are used in deterministic tests.
- [ ] `make verify-E2-T11` passes against the Auth0 emulator and published server.

## Adversarial verification

1. Fire concurrent requests at the window boundary; totals must never exceed the limit.
2. Probe encoded stream ids and namespace aliases across tenants.
3. Reuse one token across public and private operation classes and verify counters match
   the documented key.
4. Search for limiter or tenant logic in `@eforest/server` or any copied transport.

## Verification log

(appended by builder and critic)
