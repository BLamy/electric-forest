---
id: E12-T05
epic: 12
title: Complete public onboarding and tenant boundaries
priority: 525
status: pending
depends_on: [E12-T04]
estimate: L
capstone: false
---

## Goal

An unaffiliated visitor can join through the real identity provider and reach the existing
account/org/repository experience, while public/private visibility and membership rules
remain exact across browser routes, APIs, live subscriptions and caches. Public signup
does not grant another tenant's private data or mutation capabilities.

## Context

T04 establishes a hosted candidate. A public multi-user launch additionally needs a
tested onboarding/invitation path and an explicit permission matrix, not a shared
preauthenticated demo. Reuse existing identity, namespace and gateway contracts rather
than adding a second membership store. Public/private access means the app's documented
visibility rules; it does not authorize anonymous mutation or bypass of the existing
session gate for routes that are not public.

Use dedicated fixture identities and two tenant namespaces. Keep private-response
caching separate from immutable public assets; a newly signed-in user must not receive
the preceding user's private response through any app/proxy/cache path.

## Deliverables

- Public-provider signup/onboarding and existing organization/invitation/deep-link flows
  wired to the hosted app, including expired/used/wrong-user invitation refusals.
- A frozen access matrix for anonymous visitor, tenant member, unrelated user, removed
  member and owner across public/private repository, file, issue, PR and follow surfaces.
- Explicit private-response cache policy and current authorization enforcement at read,
  follow and mutation doors; no alternate authority for membership.
- `make verify-E12-T05`, access/refusal fixtures and named local-QA/deployed smoke journeys.

## Acceptance criteria

- [ ] `make verify-E12-T05` exits 0 and emits `evidence/e12-t05-access-matrix.json` with
      concrete route/operation, actor, visibility, expected status and observed status
      for every declared matrix cell. All statuses and returned identifiers match the
      frozen matrix; missing cells fail verification.
- [ ] Fresh dedicated users complete public real-provider signup, return to the app,
      enter the existing account flow, create an allowed org/repo, and accept an owner
      invitation through a deep link. Expired, consumed and wrong-user invites are
      refused without membership mutation. Actual deployed-origin results are in
      `evidence/e12-t05-onboarding-smoke.json`.
- [ ] Unrelated users and anonymous clients cannot read or follow private fixture
      repository/file/issue/PR state or mutate another tenant's data. An already-open
      private follow stops delivering newly private events after its membership is
      revoked under the frozen authorization contract. Refusal transcripts record
      unchanged heads/digests; `evidence/e12-t05-streams.jsonl` and
      `evidence/e12-t05-digests.json` replay to the exact expected membership and app state.
- [ ] Reusing browser storage, HTTP connections and the deployed cache path across
      logout/login and public/private responses never returns another user's private
      bytes, identifiers or live events. Private responses have the explicit non-shared
      cache policy; immutable asset caching remains usable. Exact header/body hashes and
      session-switch cases are in `evidence/e12-t05-cache-boundary.json`.
- [ ] Named journeys `E12-T05 public onboarding` and `E12-T05 tenant boundary and removal`
      run through the configured managed tunnel in Replay QA project
      `proj-electric-forest-ms8w0nv1`. The claim cites actual journey/test-run IDs,
      outcome/bug/console/network evidence and attached recording URLs when present.
      Deployed-origin smoke independently exercises the real-provider public/private
      paths. Playwright asserts zero console errors and DOM digests match stream replay;
      unavailable QA uses explicit `Replay: N/A` with the doctrine's mitigation.
- [ ] Before a builder call, two fresh readers attest the same committed lifecycle
      snapshot and legal task/run eligibility. A fresh pre-critic freezes the threat
      model; a separate fresh critic alone may verify the task. Full verdict history,
      run ceilings, checkpoints, ordered gates and project stops remain intact. Any
      failed requirement is a blocker, never a gate waiver or ledger reset.

## Adversarial verification

1. Swap tenant/repository identifiers on every declared private read, follow and mutation
   route using an unrelated account. Any foreign private payload or head movement refutes
   isolation; enumerate the missing matrix cell if the harness never sends the request.
2. Keep a follow connected while removing membership, then append an independently
   identifiable private event. Delivery after the revocation boundary refutes enforcement.
3. Log user A out and B in through the same browser/cache path, replay conditional cache
   headers and compare response hashes. Any A-private bytes delivered to B refute caching.
4. Accept one invite twice, with another identity and after expiry. A membership append
   on a refused attempt refutes invite admission/idempotency.
5. Sabotage the tenant guard and private cache header separately in scratch candidates.
   The corresponding matrix/cache tests must fail; otherwise their coverage is refuted.
6. Interrogate the QA runs for omitted denial/removal paths and compare the deployed
   smoke's real-provider identities against the fixture stream events. Preloaded shared
   accounts do not prove public signup.

## Verification log

