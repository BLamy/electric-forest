# E12-T10 frozen pre-critic report

Status: **FROZEN BEFORE PRODUCT IMPLEMENTATION**. This is a finite threat model and
verification plan, not a verification verdict or a claim that the proposed behavior
already works. The report was prepared by fresh read-only pre-critic
`/root/real_auth_precritic`. No product, canonical task/status, tenant, lifecycle control,
or real credential was modified; only this task's ignored pre-critic workshop was written.

- Canonical planning commit: `75faffee26b9f8e791fea38cf30ef41120df457e`.
- Direct parent: `b8ec0961aed4aa1882491c678530a387e95d3b3c`.
- Canonical specification: `.eforest/tasks/epic-12-first-light/E12-T10-real-auth0-private-railway/readme.md`.
- Exact committed specification SHA-256: `4e269bb9d4a94072a777bc3ef739736888578b9c99d83697911b1a3604ac4dc9`.
- Re-read task state: pending, priority 521, dependency E12-T00; committed queue names
  only E12-T10 next. This observation does not replace the required independent reader pair.
- Product source is byte-unchanged from inspected baseline
  `a7e861d023651925a16e9103c0f50fce9c368a4e`; `report.json` binds 30 source/build files
  and seven old verified task readmes by their full committed SHA-256 values.
- Canonical AC5 explicitly distinguishes actual real-operator minimal restart proof
  from isolated dedicated-fixture byte-exact stream replay. No production fixture login
  seam is permitted. AC2 now explicitly names the protected cookie values.

## Skill provenance and bounded application

My developer-provided skills catalog explicitly lists `auth0:auth0` at
`/Users/blamy/.codex/plugins/cache/openai-curated-remote/auth0/2.1.1/skills/auth0/SKILL.md`.
I read that file, plus its `references/pattern-security/index.md` and
`references/pattern-token-handling/index.md`, using the guidance intent for this review.
The metadata identifies Auth0, version 2.1.1. This is not a repository lifecycle control.
The guidance calls for public-client S256 PKCE, no SPA client secret, exact allowed URLs,
and a distinction between ID-token identity validation and API bearer validation.
The audit intent's per-command confirmation rule is not part of this guidance workflow.
No approval requirement is inferred. Existing user authority covers implementation and
Railway deployment; any concrete browser action policy remains a separate boundary.

Official documentation inspected on 2026-10-16 supports direct Authentication API
integration, an exact registered callback, and code exchange with `client_id` and
`code_verifier`. It also calls for client-side correlation of authorization state and
associating the intended local return URL with that transaction:

- https://auth0.com/docs/get-started/authentication-and-authorization-flow/authorization-code-flow-with-pkce/add-login-using-the-authorization-code-flow-with-pkce
- https://auth0.com/docs/secure/attack-protection/state-parameters
- https://auth0.com/docs/manage-users/user-accounts/verify-emails

No new browser SDK migration is implied. Preserve the existing server OIDC to opaque,
stream-backed session contract. The ID token is validated only while creating that
session; it is not a new API credential. First CLI access uses existing opaque hashed
web-minted grants. A native device/API audience rollout is outside this task.

## Finite trust boundary

The attacker can send arbitrary public HTTP targets, methods, headers, bodies and
cookies; initiate a legitimate login for their own dedicated fixture identity; replay
or splice known callback values; hold a valid second tenant's session/grant; and race
bounded request/restart operations in a disposable fixture store. Startup attacks may
alter fixture configuration, assets, marker and secret files. Tests do not assume a
compromised Auth0 signing key, Railway administrator, trusted image, container OS or
TLS stack. The private provider boundary is container loopback within one platform
replica. It does not prove a future multi-container credential topology or full public
launch capacity/backup qualification.

## Source seams and finite implementation predictions

1. `packages/platform/src/server.ts:20-34` builds `http://Host` before the handler and
   emits headers with `forEach`. A new hosted adapter must construct requests from the
   pinned HTTPS origin, validate request targets, and write each `Set-Cookie` separately
   over actual Node HTTP. Checking only a synthetic Response does not exercise the wire.
   `server.ts:6-10` buffers an unbounded body; numeric limits need a socket-level check.
2. `auth/routes.ts:308-345` uses request URL origin for the callback, a free-standing
   `ef_next` cookie, and an in-memory global transaction without browser binding.
   Callback validation must reject a valid attacker transaction delivered in a different
   browser before any identity append. A return path belongs to its login transaction.
3. `auth/oidc.ts:32-57` bounds the transaction count but has no expiry or browser
   correlation. `oidc.ts:187-192` ignores `email_verified`. Keep legacy local fixture
   contracts available while requiring verified email at the hosted trust boundary.
4. `auth/session.ts:16-22` currently omits Secure. Hosted session, login binding, return
   and clearing cookies all need the intended Secure/HttpOnly/SameSite/Path behavior.
   Session cookies necessarily carry the app's opaque credential: interpret the canonical task as forbidding provider tokens, signing secrets, passwords and PKCE verifiers, while retaining the established opaque app session.
5. `auth/routes.ts:180-240,354-480,483-493,534-645` contains several cookie mutation
   doors, including dispatch, invitations, mint/revoke and logout. A centralized hosted
   origin policy must cover all of them. Adding Authorization cannot convert an endpoint
   requiring a web session into a permitted bearer mutation.
6. `production.ts:201-203,262` wires one web-client-audience verifier into both ID and
   device credential paths. `auth/routes.ts:568-618` can register device grants. Hosted
   `/api/device-grants` must refuse until API/native audiences are separately qualified;
   the valid opaque web-mint path must continue through the grant-aware gateway. The
   parent explicitly requires a hosted composition policy that also rejects otherwise
   valid Auth0 ID/access JWTs at the gateway. Disabling only device registration does not
   prove that boundary. Existing legacy local bearer APIs remain unchanged.
7. `Dockerfile:15-20` bakes preview mode, preview fixture auth, preview data location and
   preview entrypoint into its final stage. A separate real-auth image/entrypoint must
   demonstrably avoid inheriting them. Reusing a function is not permission to copy the
   public preview store, subjects, sessions, private key or marker.
8. `preview.ts:100-132,326-389` is a useful composition reference, not a production
   bootstrap contract. Hosted storage needs explicit empty-volume initialization and
   restart refusal for missing/corrupt required secret/state. A new random secret over
   accepted data would invalidate sessions silently. Test interrupted initialization
   separately from corrupt previously-ready state, without a new reset escape hatch.
9. `apps/web/src/routes.tsx:44-65` suppresses the local proof fetch only in preview.
   Hosted real auth must not produce a deliberate 404 console/network fault for the local
   proof route, and existing local proof behavior must remain intact.
   `MembersPage.tsx:13` uses preview as its capability check; agents-off hosted state
   needs explicit server-stamped truth and server-side refusal before any event/effect.
10. `spa.ts:18-20` redirects private routes to plain `/auth/login`; a production deep
    link must retain its safe local target through the full browser round-trip. Existing
    account menu and CLI token route already exist; verify reachability instead of
    inventing a second token UI.

## Frozen acceptance/evidence matrix

| Criterion | Falsifiable outcome and cheapest check | Required final evidence |
| --- | --- | --- |
| AC1 packaging/config/bounds | From scrubbed inputs, bad config/asset/revision/marker/key exits without listening; valid runtime binds assigned PORT. Body limit rejects a declared and chunked over-limit upload; bounded stalled request terminates. Readiness <=60 s, shutdown <=15 s. | Fresh ordered root audit, exact-source cold-clone `make -- verify-E12-T10`, runtime versions/lock hash, raw socket receipts, time receipts, actual Linux image/source identity. |
| AC2 origin/cookies/CSRF | Host/proxy headers never change callback/invite/redirect host. Each legitimate cookie arrives separately with required flags. Missing/wrong/null Origin on cookie mutations and logout refuses without append; permitted opaque bearer dispatch has its distinct policy. | HTTP wire assertions plus an actual browser login/logout journey and exact before/after fixture stream heads. |
| AC3 auth/session | Valid S256 round-trip appends the expected user/session records. Wrong browser/cookie/state/nonce/verifier/signature/audience/expiry/email verification or reused callback has no identity append. Restart preserves active session and ended/revoked state; pending transaction fails closed. | Dedicated fixture event dumps, independently recomputed replay digests/offsets, browser timeline, log/token canary scan, stable-secret metadata without secret bytes. |
| AC4 private app/capabilities | New users start without seeded org/repo, each can create an org; private read/write/follow across tenants and anonymously returns the declared neutral refusal with no content/event. Raw/admin/fixture/device and agent/integration routes refuse before effect. | Two independent browser fixture profiles, HTTP denied request table, fixture event offsets, disabled UI capability state, CLI settings navigation and synthetic mint/revoke outcome. |
| AC5 live deploy/restart | The actual new service uses fresh volume, one replica, no overlap, exact source/image/config, real HTTPS health/assets/login redirect. Real operator session and one synthetic acceptance mutation persist through restart; local same-runtime fixture log prefix replays exactly. | Railway metadata + exact-source actual image health/assets receipt; minimal redacted operator UI/build/digest receipt before/after restart; separate byte-exact dedicated fixture dump/replay. No real identity dump. |
| AC6 real Auth0 | Actual discovery/JWKS identifiers and registered callback/logout/origin match pinned config; the operator finishes actual Auth0 callback and reaches signed-in app at that revision. A fixture login cannot satisfy this. | Public configuration receipt, minimal real-login UI receipt, exact tested source identity. Missing registration or human credential step remains a named blocker. |
| AC7 browser proof | Every changed browser behavior executes through named focused journey; zero console/page errors and DOM offsets/digests match independent fixture replay. | Configured Replay QA project + journey/run URLs, or current concrete unavailability receipt and literal `Replay: N/A (<reason>) + mitigation`, with complete fallback Playwright console/network/timeline/video fixture proof. No real operator credentials in remote QA. |
| AC8 lifecycle | Committed before-builder and post-write reader outputs are byte-identical; exact task/ledger/queue/control transition matches the asserted commit, prior history preserved. | Both independent raw snapshot outputs and hashes, full source/base/trusted attester OIDs, task ledger comparison and fresh role identities. |

## Fixed attack matrix and sensors

- Attack 1: table-driven host/proxy/return target cases and wrong/missing/null Origin on
  dispatch, invite, mint/revoke and logout. Assert typed status and event neutrality.
  Mutate HTTPS reconstruction and separately strip Secure in a scratch candidate: the
  corresponding wire/browser checks must fail and pass again after restoration.
- Attack 2: two independent browsers with valid transactions; transplant one callback to
  the other, then wrong/no binding cookie, unknown/wrong state, expired/reused code,
  wrong verifier/nonce/signature/audience/issuer/expiry, missing/false email_verified.
  Check identity bytes unchanged for each refusal, not just status text. Unknown
  in-flight state after process restart refuses; a new login succeeds normally.
- Attack 3: empty-new versus partially initialized versus previously-ready store;
  preview marker or known preview identity; lost/corrupt signing file; malformed public
  origin/PORT/body deadline/build revision; missing/altered bundle; inherited model,
  harness, email or preview settings. Assert no public readiness and no overwrite of
  accepted store/secret. Config validation must not echo injected secret values.
- Attack 4: exact and encoded/raw/admin/fixture/device endpoints, valid other-tenant and
  anonymous repository read/write/follow, direct agent events and outbound integration
  configuration. Send an otherwise correctly signed, unexpired web-client-audience ID
  JWT to the hosted gateway as Bearer and require refusal/no event even though that JWT
  is valid for the OIDC callback. Assert no private response, accepted event, subprocess
  or outbound fixture request. Hidden UI alone is insufficient.
- Attack 5: accepted synthetic write plus active session, shutdown/SIGKILL and restart;
  compare raw fixture event prefix and independent reduced state, read with the same
  browser cookie, end a session/revoke a grant and restart again to prove refusal.
  Stable-secret evidence should be file metadata/hash equality without its bytes.
- Attack 6: mutate one retained evidence byte without changing the expected digest;
  remove browser binding or a key auth refusal in scratch. Required sensor exits red,
  restores green. Judge interrogates submitted evidence, not a fresh browser rerun.

Additional bounded critic attack: send both a valid session cookie and an invalid or
other-user bearer on each relevant route. It must follow the declared explicit
credential precedence; a bad Authorization header must not fall back to a privileged
cookie, and adding Authorization must not bypass web-session-only token mint/revoke.
This tests the distinction AC2/AC4 already require without inventing a new auth feature.

## Coverage risks to resolve before the claim

- Positive browser login, callback refusal, stale in-flight transaction, safe deep-link,
  org creation, CLI mint/revoke, logout and disabled-agent UI all change reachable
  behavior. A login-only recording cannot cover them.
- Local positive fixtures must use the real gateway/provider and hosted auth policy,
  with only issuer/clock/random seams declared. Direct `identity.login` does not prove
  OIDC. An Auth0-shaped emulator is still not actual Auth0 proof.
- Actual operator proof is a separate minimal redacted receipt. Record only chosen
  synthetic content/build/digest/auth-state; never put browser storage, full callback URL,
  Auth0 user/email, production stream dump or provider tokens in artifact captures.
- Test existing local HTTP emulators and preview independently after shared server/auth
  changes. Hosted enforcement must not silently change prior test semantics, bypass
  frozen local proof, or replace an old deterministic golden.
- Startup/request bounds are checked over the public listener, not by calling an internal
  function. SSE/follow policy must name when a deadline applies so a successful long
  follow is not misrepresented as an unbounded handler.
- The exact task Make target must build the dependency closure from a fresh checkout;
  no pre-existing dist, root build before the target, or warm node_modules symlink.
- Retain every artifact cited by the index and verify it exists in Git; ignored `.log`
  files are a known retention trap. Index/replay sensitivity is a required apparatus
  assertion, not a cosmetic checksum.


## Frozen initial runtime profile

The parent confirmed these concrete defaults before this report was frozen. They
instantiate AC1 for the first usable deployment; they do not establish E12-T01's full
conformance/capacity profile, E12-T06 load qualification or E12-T07 backup/restore.

| Limit | Frozen default or hard task bound | Falsification sensor |
| --- | --- | --- |
| Maximum buffered request body | 8 MiB = 8,388,608 bytes | A known complete request at the supported boundary is admitted to schema/auth handling; a declared and a chunked body one byte above the bound cannot reach mutation handling, append or grow an unbounded buffer. |
| Body/request to response headers | 30,000 ms maximum by default | A stalled body or stalled finite response produces the declared bounded refusal/close; the effective configured value is visible in nonsecret startup evidence. An ordinary successful request still completes. |
| Startup/readiness | <=60,000 ms | Start the actual artifact over assigned PORT; timed public readiness is successful within the bound, or startup exits without claiming readiness. |
| Shutdown/drain | <=15,000 ms | Signal with one pending follow and a finite request; readiness becomes unavailable, process/store close within bound, no false successful mutation acknowledgement. |
| Login transaction TTL | 600,000 ms = 10 minutes | Boundary clock probes just before and at expiry; expired transaction with an otherwise valid code refuses without identity append. Cookie lifetime must not exceed the intended transaction validity. |
| Established session TTL | 86,400 seconds = 24 hours default | Replayed session envelope timestamp controls validity before and at TTL, independently of cookie presence or Auth0 token lifetime; restart does not extend it. |
| Mutation-serving platform replicas | Exactly one, zero overlapping revisions | Railway config plus actual deployment/restart identity, same dedicated persistent volume, no two concurrent mutation listeners. |
| Private provider interface | Container loopback only | Inspect bound address in dedicated local runtime and public route refusal; no public provider hostname/port or raw proxy route. |

Validated tighter configurable bounds are allowed only when the recorded effective values
are positive, finite and tested. Test clocks and reduced deadlines belong to declared
isolated fixture construction, not an environment switch that opens public fixture auth.

Established SSE/follow behavior is explicit: the 30-second body/response-header deadline
must not indiscriminately kill a legitimate stream after response headers. The hosted
policy must name stream cancellation/drain behavior; existing bounded long-poll waitMs
semantics remain available. A timeout wrapper alone is insufficient evidence if it lets
the request keep accepting body bytes indefinitely. Timing evidence does not claim a
new global exactly-once timeout guarantee; writes retain existing dispatch/fencing rules.

## Immutable local contracts and hosted policy

- Preserve E2-T03's configured-issuer/audience RS256 verifier, reason taxonomy, JWKS
  refresh and refusal-before-stream-access contract in existing local composition.
  A new hosted admission policy is explicit rather than silently weakening or changing
  the old verifier. Hosted gateway bearer auth admits only validated existing `ef_cli_`
  opaque web-mint grants at this milestone. Otherwise correctly signed, unexpired
  Auth0 ID/access JWTs addressed to the web client must be refused with no target event.
  Denying `/api/device-grants` alone does not prove gateway bearer policy.
- Preserve E2-T04's frozen identity event payloads, exactly one first-user record per
  sub, one session-start per accepted login, stream-reduced revocation/TTL/session truth,
  HMAC opaque session cookie, and idempotent/concurrent provisioning. Keep typed local
  auth refusal mapping: bad-state/bad-verifier/reused-code/bad-nonce ->400;
  bad-token/expired-token ->401. Hosted missing/unverified email can use a documented
  compatible typed refusal but cannot append a partial user before refusing.
- Preserve E2-T05's legacy local device API and opaque web-mint semantics. Do not claim
  the existing web-client audience qualifies an Auth0 API or native device flow. Hosted
  device registration fails closed while local frozen tests remain meaningful.
- Preserve E2-T12's explicitly local-only emulator/public reference-server proof, with
  no rewrite of its live-cloud refutation, scope decision, ledger or run ceiling.
- Preserve E3-T02a's whoami-from-replayed-view, safe SPA/API/auth route separation,
  complete `data-ef-stream`/`data-ef-offset`/`data-ef-digest` triples and independent
  offset-truncated replay. Hosted mode skips local-only proof fetching; local proof
  remains available without a global bypass or changed golden.
- Preserve E3-T02b's full-wire scanner and single clean publication boundary. A new
  login binding cookie carries no PKCE verifier/session ID and earns no broad scanner
  exemption. Do not copy real tokens into evidence before trying to redact them.
- Preserve verified E12-T00's explicit preview entrypoint, fixture label, shared
  disposable store boundaries and startup refusals. Its Railway service and volume
  remain unchanged. A real-auth deployment has a separate entrypoint and fresh private
  volume and cannot inherit the preview stage's baked environment by accident.

The required root audit runs format/lint, then typecheck, then tests, then build once
for the immutable candidate. If shared auth/server/web code changes, focused historical
local regression checks must execute those preserved paths. Do not recursively rerun
already passing root gates via historical make targets during evidence collection;
use their focused internal regression commands where the repository workflow permits.
The lead critic performs exactly one late pristine cold clone after cheap attacks pass.

## Concrete independent evidence plan

1. Publish one source-bound HTTP/config/refusal fixture transcript with named cases,
   effective limits, exact status and before/after identity/target offsets, counts and
   digests. Where refusal precedes provider lookup, instrumented call counts should
   independently prove no adapter create/read/append/follow. Use a socket-level body
   and header test for actual Node behavior, not only an in-process Request.
2. Retain dedicated-fixture identity, namespace and accepted synthetic application dumps
   at declared offsets. Independently reduce them, compare to CLI replay and DOM triples,
   and compare the raw before-log byte prefix after restart. Include actual ended-session
   and revoked-grant refusals after restart, plus an interrupted transaction case.
   Expected state must not be a golden calculated only by the same reducer under test.
3. Record focused fixture browser actions: anonymous private deep link -> Auth0-shaped
   dedicated issuer -> canonical callback -> same local target -> create own org ->
   separate second org/denied tenant views -> CLI settings -> fixture mint/revoke ->
   logout/refusal -> active-session restart/relogin paths -> disabled agents. Capture
   zero console/page errors and classify intentional denial responses explicitly.
4. Bind the actual new Railway service's project/environment/service/deployment/full
   source OID/image digest/config/volume identity, actual HTTPS health/readiness/assets,
   visible build/capability truth, and public Auth0 redirect parameters. Preserve starter
   services and the already verified preview. A Railway SUCCESS flag is not app proof.
5. Obtain actual Auth0 provider evidence without a credential dump: discovery/JWKS,
   application public client ID, exact allowed callback/logout/origin, and one operator
   login at the real origin. Record only a minimal selected redacted UI/build/auth-state
   receipt, chosen synthetic acceptance mutation and DOM digest before/after controlled
   restart. No email, sub, session cookie, full callback code/state, token storage, identity
   dump or private project enters committed or remote QA evidence. A private session used
   to operate the app is never serialized as proof. A human credential/consent step or
   registration mismatch remains an explicit blocker to the actual-auth criterion.
6. Test sensitivity at the lowest cost: retain control/red/restored-green receipts for
   HTTPS/cookie flags, browser binding or auth refusal, and one-byte evidence corruption.
   Report the mutation and sensor exit codes without persisting generated textual diffs.
   A fresh critic interrogates the submitted browser evidence and replay dumps rather
   than re-driving a different browser session as a substitute.

Replay QA project is `proj-electric-forest-ms8w0nv1`; named focused journey is
`E12-T10 Auth0 login and private workspace`. No epic-wide exploration is required at
this intermediate task. If the managed service remains unavailable, perform a current
availability diagnostic and use literal `Replay: N/A (<reason>) + mitigation` paired
with complete dedicated-fixture Playwright console/network/timeline/video and independent
stream evidence. An old authentication failure is context, not the new diagnostic.
Never put a real operator Auth0 session into external QA to satisfy fixture proof.

## Readiness of this pre-critic boundary

The canonical task has a finite implementable contract. No contradictory requirement
was found after the explicit operator/fixture evidence split, protected-cookie wording,
initial numeric profile and hosted opaque-only bearer policy were clarified. This is
not a green claim or authority to skip lifecycle readers, independent audit, actual
Auth0 login, or fresh verification. Public multi-user launch remains pending behind
E12-T01 through T09; T11 owns actual local CLI installation and selected-project import;
E14 owns the complete content-addressed changeset model. No broader proof is implied.
