---
id: E2-T10
epic: 2
title: "Platform authorization conformance matrix over official-stream-backed operations"
priority: 210
status: pending
depends_on: [E2-T05, E2-T07, E2-T08, E2-T09]
estimate: M
capstone: false
---

## Goal

`make verify-E2-authz` permanently sweeps the platform's authorization contract over
real HTTP while the platform uses the official Durable Streams client and the pinned
Auth0 emulator. The golden matrix covers identity, repo visibility, grant state, and
application operation. It verifies decisions and also proves that refusals never reach
the stream substrate.

The matrix tests platform operations—not a fork or proxy implementation of the Durable
Streams protocol: namespace lookup, application-state read, live application follow,
dispatch, registry query, and CLI-token issuance.

## Deliverables

- A table-driven conformance harness with independently seeded identities and streams.
- A committed normalized golden decision transcript.
- Per-refusal official-client call counts and before/after stream digests.
- `verify-E2-authz`, included in the standing verification sweep.

## Acceptance criteria

- [ ] The cartesian matrix covers anonymous, token holder, member, non-member, admin,
      revoked grant, public/private repo, and every platform operation class.
- [ ] Fresh output byte-matches the committed golden; regeneration requires an explicit
      command and cannot happen in the verification target.
- [ ] Every refusal records zero official-client calls and unchanged stream digests.
- [ ] Public reads/follows and authorized private operations are exercised over real
      official streams, not mocks.
- [ ] One-byte decision-golden corruption and one deliberate `authorize` bypass each
      make the target fail.
- [ ] No matrix row targets retired application projection bootstrap, official live follow, custom dispatch, or custom
      server endpoints.

## Adversarial verification

1. Add an unlisted platform route and prove the route inventory check fails.
2. Shuffle matrix order and normalize ports/times only; semantic normalization is a
   refutation.
3. Revoke a grant between initial read and follow resume and verify the next operation
   uses the new authorization-view offset.
4. Sabotage the decision function to allow one cross-tenant row; the golden and digest
   guards must both fail.

## Verification log

(appended by builder and critic)
