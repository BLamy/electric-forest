---
id: E2-T10
epic: 2
title: "Platform authorization conformance matrix over official-stream-backed operations"
priority: 210
status: in-progress
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

### 2026-07-23 — builder — CLAIM: implemented

- Commit under proof: `3bd25d2fcd140541c7f95f6033e4f9bd44c44de4`.
- `verify-E2-authz` composes the current real-HTTP E2-T07 authorization matrix,
  E2-T08 registry proof, E2-T09 writer-fencing proof, and the current CLI-token,
  gateway, and namespace-runtime suites. It binds 216 identity/target/operation rows,
  six application operation classes, all thirteen source-discovered public route shapes,
  96 refusals with zero target-stream calls and unchanged stream digests, and a normalized
  committed golden that performs no semantic normalization.
- Revocation is exercised as a fresh follow-resume operation: an initially authorized
  private read is followed by grant revocation, then the resume refuses at an identity
  offset at or beyond the revocation while touching only authorization-view streams.
- The isolated namespace runtime drops host `NODE_OPTIONS`, preventing verification
  preloads from entering its permission-denied child; the child retains its stricter
  filesystem/no-host-global boundary. A permanent test sets a hostile preload and proves
  the worker still starts and shuts down cleanly.
- Sensitivity: one-byte golden corruption, deliberate cross-tenant authorization bypass,
  a newly discovered unlisted route, and semantic row reordering all go expected-red.
  The inherited authorization, registry, and fencing mutations also remain expected-red.
- Commands: `pnpm format:check`; `pnpm lint`; `pnpm typecheck`; `pnpm test` (397/397);
  `pnpm build`; `CI=true make verify-E2-authz`;
  `tools/verify/cold_clone.sh verify-E2-authz`.
- Evidence: `evidence/e2-t10-authz.golden.txt` and
  `evidence/e2-t10-cold-clone.txt`. The pristine clone at the pinned commit emitted both
  `verify-E2-authz: OK` and
  `cold_clone: verify-E2-authz PASSED from a pristine clone`.
- Replay: N/A (protocol/server authorization and verification-workflow work with no
  browser-reaching behavior) + mitigation: pinned-emulator real HTTP, official Durable
  Streams, committed decision/digest goldens, mutation sensitivity, exact-head gates, and
  scrubbed pristine-clone proof.

### 2026-07-22 — critic — VERDICT: refuted

- Route-inventory sensitivity is self-injected rather than source-sensitive. A production
  route whose path is held in a variable leaves the regex-discovered thirteen-route
  inventory unchanged. Replace syntax discovery with runtime route topology and prove it
  with a disposable production-source mutation.
- Cross-tenant sensitivity changes only verifier-owned transcript strings; it never
  sabotages `decideStreamAuthorization`. Mutate one real cross-tenant decision and prove
  that both the golden and digest guard independently fail.
- The 216-row Cartesian matrix covers `read`, `follow`, and `dispatch`; namespace lookup,
  registry query, and CLI-token issuance appear only as static inventory strings. Exercise
  equivalent identity/visibility/grant rows for all six operation classes.
- The 96-refusal evidence is aggregate. Emit a row for every refusal with its official
  target-call count and before/after stream digest.
- Controls: the baseline verifier and its four declared sensitivities passed. Preserve the
  genuine one-byte corruption and semantic-order attacks; replace the two synthetic
  apparatus attacks. Replay: N/A (server/protocol verifier) + mitigation: real HTTP,
  official-stream call ledgers, decision/digest goldens, and pristine-clone reproduction.
