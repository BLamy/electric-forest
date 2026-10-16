---
id: E12-T03
epic: 12
title: Make public HTTPS authentication and sessions production-correct
priority: 523
status: pending
depends_on: [E12-T02]
estimate: M
capstone: false
---

## Goal

The production platform uses one configured HTTPS origin for OIDC callbacks, invitations
and redirects, emits secure cookies, and preserves the stream-backed session contract
across restart. Production identity-provider configuration is prepared and checked;
T04 completes the real-provider browser round-trip at the actual Railway origin.

## Context

The Node adapter currently reconstructs `http://Host` and auth routes derive callbacks
and invite links from that value. Session and return-path cookies lack `Secure`.
Pending OIDC transactions and per-run capabilities are process-local, while established
session validity is derived from the identity stream. T01's single mutation-serving
replica and no-overlap deployment boundary remains mandatory; this task must specify
safe interrupted-login behavior rather than pretending in-memory transactions survive.

The existing Auth0 emulation is deterministic proof infrastructure. It does not establish
that the real provider has registered the future Railway HTTPS callback or that the
deployed flow works. Keep those claims separate and bind T04's live check to this code.

## Deliverables

- Validated canonical public-origin configuration and an explicit proxy/host trust policy
  for the production adapter; local fixture mode remains explicit.
- Production cookie handling for session and return-path state; safe local redirects,
  stream-backed expiry/logout and documented restart/rotation behavior.
- A redacted real-provider integration configuration identifying issuer, public client,
  registered HTTPS callback/logout origins and signup policy, without client secrets.
- `make verify-E12-T03`, auth refusal/restart fixtures and named Replay QA auth journeys.

## Acceptance criteria

- [ ] `make verify-E12-T03` exits 0 from a cold clone and writes
      `evidence/e12-t03-origin-cases.json`, `evidence/e12-t03-cookie-cases.json`,
      `evidence/e12-t03-identity.jsonl` and `evidence/e12-t03-digests.json`. Replay twice
      reproduces exact identity/session digests and auth refusals append no identity event.
- [ ] Login, token exchange redirect URI and invitation links use the configured HTTPS
      origin. Untrusted `Host`, `Forwarded` and `X-Forwarded-*`, protocol-relative URLs,
      encoded external return paths and mixed-origin callback requests cannot replace
      it. Invalid production origin configuration fails startup. Exact locations and
      refusals are captured in the origin cases.
- [ ] Production cookies for the opaque session and return path are `Secure`, `HttpOnly`,
      appropriately `SameSite` and path-scoped, contain no token/claim/credential, and
      clear consistently. Cross-site mutation/logout attempts follow an explicit
      same-origin/CSRF policy; bypass attempts neither mutate private state nor end a
      session. Cookie/refusal transcripts cite the unchanged stream heads.
- [ ] Dedicated users complete authorization-code+PKCE login, local deep-link return,
      expiry, idempotent logout and session replay after app restart with the same secret.
      Bad state/verifier/nonce, reused code, invalid signature/audience and expired token
      produce the frozen typed refusals. An interrupted in-flight login fails closed and
      can restart from login; secret rotation has an explicit tested invalidation policy.
- [ ] `evidence/e12-t03-provider-config.json` records live issuer discovery/JWKS validation
      and the registered planned callback/origin configuration for the real provider,
      redacted to public fields. A missing provider registration is a blocker. This task
      does not claim the Railway browser round-trip; T04 must execute it on the deployed
      immutable artifact before that deployment can pass.
- [ ] Journey `E12-T03 HTTPS authentication and session restart` runs in Replay QA project
      `proj-electric-forest-ms8w0nv1` through its managed tunnel with dedicated fixture
      identities. The Verification log cites actual journey/test-run IDs, outcome, bugs,
      console/network findings and attached recordings when present, matching the
      identity-stream dump. Playwright asserts zero console errors. If unavailable,
      use explicit `Replay: N/A (<reason>) + mitigation` under the existing doctrine.
- [ ] Before a builder call, two fresh readers attest the same committed lifecycle
      snapshot and legal task/run eligibility. A fresh pre-critic freezes the threat
      model; a separate fresh critic alone may verify the task. Full verdict history,
      run ceilings, checkpoints, ordered gates and project stops remain intact. Any
      failed requirement is a blocker, never a gate waiver or ledger reset.

## Adversarial verification

1. Inject hostile host/proxy headers and return paths into login, callback and invite
   requests. A redirect/token exchange/invite sent to the injected origin refutes trust.
2. Strip `Secure`, restore the original HTTP origin reconstruction, and bypass the
   cross-site guard in separate scratch mutations. Each corresponding verifier must fail.
3. Restart after session creation and separately between OIDC authorization and callback.
   A lost established session, accepted unknown transaction or unusable retry refutes
   the declared restart contract.
4. Reuse a consumed callback, alter nonce/verifier/audience and log out twice. An extra
   identity append, untyped refusal or accepted forged login refutes authentication.
5. Interrogate the named QA run and compare its visible session/refusal states against
   independent identity replay. An emulator recording presented as live Railway-provider
   evidence refutes claim scope.
6. Change the provider registration or canonical origin after config capture. Stale
   evidence accepted for the new configuration refutes artifact/configuration binding.

## Verification log

