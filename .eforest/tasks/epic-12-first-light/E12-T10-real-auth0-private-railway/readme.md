---
id: E12-T10
epic: 12
title: Deploy real Auth0 login with private persistent data on Railway
priority: 521
status: in-progress
depends_on: [E12-T00]
estimate: L
capstone: false
---

## Goal

The operator can sign into the real hosted application with the supplied Auth0 tenant.
A separate Railway service uses fresh private data on our pinned, patched, self-hosted
Durable Streams server. This is the first usable authenticated deployment; the complete
public multi-user release remains gated by E12-T01 through T09. No existing verified
behavior or public-launch criterion is waived by this early milestone.

## Context

The human explicitly chose our custom Durable Streams server on Railway and prioritized
real production login, local CLI setup, and mirroring their own selected projects before
further design or an ElectricSQL migration. The supplied Auth0 SPA is `eforest`, client
`H9LGwHMzwWHgamCot9KTAmOFJCmDIlOk`, issuer
`https://dev-8qqftel4x1s5wed3.us.auth0.com/`. These are public identifiers, not secrets.
Public authorization-code/S256 PKCE needs no client secret. Auth0 registration must name
the actual new service origin; the shared-fixture preview cannot become its datastore.

Use Railway project `e0864588-a320-4ba3-96df-95ad0a07ee81`, environment
`c1cbbfc7-b8f7-4e3e-a4ee-a6260bea7448`. Preserve the preview and all starter services/data.
Co-locate the published patched provider on container loopback with one mutation-serving
platform replica, persistent dedicated storage and non-overlapping deployments. This
selects the initial self-hosted implementation; T01 still earns its complete production
conformance/capacity profile and T07 earns backup/restore. Do not present those pending
qualifications as complete. Existing local emulator/test contracts remain available.

## Deliverables

- Separate real-auth runtime/image entrypoint, fresh private volume, canonical public
  origin, validated configuration and exact deployed source/image identity.
- Secure session/return/login-state cookie handling, browser-bound PKCE transaction,
  same-origin cookie mutations, safe redirects and verified email for invitation identity.
- Reachable app indication of actual auth/build/capabilities, organization creation and
  existing CLI-token settings; agents and outbound integrations remain off.
- Public-only Auth0 registration record, dedicated-fixture HTTP/browser/stream evidence,
  actual deployed-origin health/assets/login redirect, and real operator login receipt
  without production credentials or unrelated private data in committed evidence.
- `make verify-E12-T10` and concise operator login/CLI-token handoff instructions.

## Acceptance criteria

- [ ] Ordered immutable root gates and cold-clone `make verify-E12-T10` pass. Evidence
      names the full source revision, lockfile/runtime versions, image digest and numeric
      limits: startup/readiness <=60 s, shutdown <=15 s, positive bounded body size and
      request deadline. Invalid/missing config/assets and preview or inherited harness
      credentials fail before public listen; successful startup accepts assigned PORT.
- [ ] The public origin always determines callback, redirect and invite origins. Host,
      Forwarded and X-Forwarded-* injection, external/encoded return paths and wrong
      origins cannot replace it. Cookies are separately emitted, Secure/HttpOnly and
      SameSite/path scoped; they contain no provider token, password, signing secret or
      PKCE verifier. Cookie mutations/logout require the
      configured Origin; bearer CLI requests have their explicit separate policy.
- [ ] Dedicated fixture users complete real gateway-backed PKCE login and local deep-link
      return in browser evidence. Browser transaction binding, state, nonce, verifier,
      signature, audience, expiry and verified-email failures append no identity event.
      A stolen/other-browser transaction cannot log the victim into the attacker's account.
      Reused callbacks fail; established sessions survive restart with the stable private
      signing secret; an interrupted in-flight login safely restarts. Logout/revocation
      survives restart. Public cookies and logs never contain provider tokens or secrets.
- [ ] Two dedicated fixture identities create separate organizations. Private reads,
      writes and follow are refused across them and to an anonymous visitor. The hosted
      runtime exposes no raw stream/admin or fixture-login routes, starts without preview
      users/repos, and rejects agent execution/outbound integrations before their effect.
      The app surfaces Auth0/build state, disabled agents and reachable CLI-token settings;
      a newly signed-in user can create their own organization without seeded data.
- [ ] The actual Railway service has a dedicated fresh private volume, one replica and
      zero overlapping mutation-serving revisions. `/healthz`, `/readyz`, asset loading,
      visible source identity and `/auth/login` work at its HTTPS origin. The manifest
      binds exact source/image/config/service/deployment. A controlled restart preserves
      a real operator's synthetic acceptance mutation and established login, documented
      by a minimal redacted UI/build/digest receipt; production identity is not dumped.
      The same immutable runtime's isolated dedicated-fixture restart proof independently
      replays byte-identical event prefixes/state. No public-fixture data or credentials
      were copied into this volume; no fixture-login seam is exposed to earn live proof.
- [ ] Public provider evidence records actual issuer discovery/JWKS, web client ID and
      exact registered callback/logout/origin. The real operator can complete the deployed
      Auth0 login; capture a minimal redacted outcome bound to this revision, without a
      production token, password, private project, email or identity dump in evidence.
      Missing registration or a failed real callback remains an explicit blocker.
- [ ] Named journey `E12-T10 Auth0 login and private workspace` in configured project
      `proj-electric-forest-ms8w0nv1` covers changed browser paths with dedicated fixtures,
      zero console/page errors and DOM digests matching independently replayed dumps. Use
      the existing explicit `Replay: N/A (<reason>) + mitigation` fallback when unavailable.
      Real production credentials never enter an external QA recording.
- [ ] Two fresh committed readers agree before builder and after lifecycle writes; a
      fresh pre-critic freezes the finite threat model and a separate fresh critic alone
      verifies. Prior task ledgers, ceilings, controls and project stops are preserved.

## Adversarial verification

1. Inject hostile origin/proxy/return values and cross-site POST/logout requests; verify
   exact refusal and unchanged stream heads. Restore HTTP or strip Secure in scratch:
   its corresponding sensor must go red.
2. Attempt login-CSRF with another browser's valid transaction, wrong cookie/state,
   expired/reused code, nonce/audience/signature mismatch and unverified email. Unknown
   transactions after restart fail closed, while established sessions remain valid.
3. Start with a preview marker, missing/incomplete volume, wrong revision/assets or
   inherited developer keys; no public readiness or silently seeded user may appear.
4. Probe raw/admin/fixture routes and agent/integration admission from the public side;
   a bypass, secret or cross-tenant private response refutes the boundary.
5. Kill/restart after an accepted fixture write and login; independently replay before
   and after, compare exact event prefix/digests and check one stable secret boundary.
6. Alter one evidence byte and separately sabotage cookie state binding or auth refusal;
   each measuring apparatus must detect its mutation. Interrogate recorded browser
   evidence; do not represent emulator login as the real Auth0 round-trip.

## Verification log

### 2026-10-16 — human-directed activation

The human prioritized actual Auth0 login on Railway, then local CLI setup and selected
private-project mirroring on our patched self-hosted Durable Streams server. E12-T00
is independently verified at `b8ec0961aed4aa1882491c678530a387e95d3b3c`; its preview
service/data and all starter services remain separate. The planning commit is
`75faffee26b9f8e791fea38cf30ef41120df457e`. This task alone becomes in progress.

Two independent trusted-pre-write committed snapshots are byte-identical:
`evidence/lifecycle/planned-a.json` and `planned-b.json`, SHA-256
`e2296180e93da6d99432cc6aa7508d34964c4b1fc57f3b9c64da858c231e146e`. They show
project building, T10 pending/eligible, run 0 under ordinary ceiling 10, empty ledger,
and unchanged controls. All 153 prior verification logs and all 74 verified task
readmes remain byte-identical. This activation grants no verification or extra run.

Fresh read-only pre-critic `/root/real_auth_precritic` froze the finite threat model in
`evidence/precritic/report.md` and `report.json`, bound to the committed specification
SHA-256 `4e269bb9d4a94072a777bc3ef739736888578b9c99d83697911b1a3604ac4dc9`.
The initial profile is 8 MiB maximum body, 30 s to response headers with explicit
established-stream cancellation/drain policy, <=60 s readiness, <=15 s shutdown,
10-minute login transactions and default 24-hour sessions. These bounds do not satisfy
T01's full launch profile or T06/T07 capacity/recovery qualification.

Replay: N/A (lifecycle activation and pre-implementation threat model; no product
behavior changed) + mitigation: committed exact reader snapshots, immutable history
hashes, DAG/queue checks and the fresh frozen pre-critic report. Product stream/browser
execution evidence is explicitly absent until the builder records it.
