---
id: E2-T04
epic: 2
title: "Web login and sessions: authorization-code+PKCE against the emulator, idempotent first-login provisioning as events, a real logged-in page"
priority: 204
status: pending
depends_on: [E2-T01, E2-T03]
estimate: L
capstone: false
---

## Goal

`packages/platform` (`@eforest/platform`) is the authenticated application gateway;
it reaches Electric through `@durable-streams/client` and owns real web login.
`GET /auth/login` starts an OIDC
**authorization-code + PKCE (S256)** flow against the issuer named by `EF_OIDC_ISSUER`
+ `EF_OIDC_CLIENT_ID` — the E2-T02 `@emulators/auth0` service from the pinned
`vendor/emulate` submodule by default, or a
real Auth0 tenant by changing only those env vars, with zero code differences between
the two. `GET /auth/callback` validates `state`, exchanges the code with the PKCE
`code_verifier` at the issuer's token endpoint, and verifies the resulting **RS256** ID
token against the issuer's JWKS — signature, `iss`, `aud`, `exp`, `nonce` all checked;
any failure is a typed refusal (`{ error: { class: 'auth-refused', reason } }`) that
appends **nothing** to any stream. On a verified first login for an Auth0 `sub`, the
callback dispatches **exactly one** `identity.user.created` event (E2-T01's frozen
`{ v: 1, sub, email }` payload) onto the identity stream through the dispatch door — a
second login by the same `sub` is idempotent and dispatches no second
`identity.user.created`, proven by grepping the raw dump, not the reduced view. Every
login dispatches one `identity.session.started` (`{ v: 1, sessionId, sub }`) and every
logout (`POST /auth/logout`) one `identity.session.ended` (`{ v: 1, sessionId }`); the
browser holds only an HttpOnly signed cookie naming the session id — **session
validity is reduced state, `replay(identity stream)` through E2-T01's registered
reducer, and nothing else** (bet 4: no database, no in-memory session table that
matters — a platform restart preserves live sessions because replay rebuilds them). A
minimal server-rendered page at `/` shows the logged-out state; after login it shows
the identity (`sub` + email from the reduced user record, not from the raw token) plus,
machine-readable in the DOM: `data-identity-offset` — the identity-stream offset the
render replayed to, equal to the server's head for that stream at render time — and
`data-identity-digest` — the authorization-view digest (`viewDigest ===
stateDigest(view)` from `@eforest/protocol`) of the state at that offset. The committed
two-login golden replays to that same digest with `ef replay --digest --reducer`.

## Context

This is the first task where a browser meets the gates. E2-T01 froze the identity
event model (eight `identity.*` types reduced to the canonical authorization view,
digest-pinned) and E2-T02 delivered the deterministic local Auth0 stand-in
(authorize+PKCE, token, JWKS, drivable in a browser from a cold clone) — this task
wires a real login flow through both and makes Epic 2's founding claim concrete:
**identity facts are events like everything else**. A user record is not a row created
by middleware; it is an `identity.user.created` event some login dispatched, and "is
this session valid" is a reducer question. Getting first-login provisioning idempotent
here — one `identity.user.created` per subject, ever, including under concurrent first
logins — is what makes E2-T01's authorization view trustworthy for every later
consumer: E2-T05 mints CLI grants from the web session frozen here, E2-T07 enforces
per-stream authorization against the view these events feed, and the E2-T12 capstone
(the-locked-gate) drives this exact login flow under Playwright + Replay.

Builds on: E2-T01 (the event shapes are E2-T01's frozen contract — this task adds
**no** new event types and no payload fields; note `identity.session.started` carries
no expiry, so session lifetime is `EF_SESSION_TTL` config measured from the
`session.started` event's envelope, documented in the package README; E2-T01's
dispatch validator already refuses a duplicate `sub` in `user.created` and a
`session.started` for an unknown `sub`, which pins provisioning order: `user.created`
must land before the first `session.started`). E2-T02 (the emulator this flow runs
against from a cold clone, including its deterministic test subjects and its `--now`
clock knob, which the expired-token evidence uses). E0-T11 (validated dispatch: the
callback's dispatches travel the same door as everything else and inherit its refusal
taxonomy). E0-T05/E1-T04 (the idempotence race resolves through the serialized append
path and E2-T01's duplicate-`sub` validator, not through a lock in the web tier).
Builds on E2-T03's authenticated platform gateway and official-client boundary.
Unblocks: E2-T05, E2-T07, E2-T12.

Contract frozen here: the cookie is `ef_session`, HttpOnly + SameSite=Lax, signed
(HMAC keyed by `EF_SESSION_SECRET`), carrying only the session id — never the JWT,
never claims; the endpoints `/auth/login`, `/auth/callback`, `/auth/logout`; the DOM
attributes `data-identity-offset` and `data-identity-digest` (E3's `useStreamReducer`
hydration-offset convention reads the same idea); the reason→status mapping —
`bad-state`, `bad-verifier`, `reused-code`, `bad-nonce` → **400**; `bad-token`,
`expired-token` → **401** — frozen here so the critic checks against this spec, not
against a table the builder authors (the package README restates this mapping, it does
not define it); and the rule that a failed
verification of any kind — bad state, bad verifier, reused code, bad signature, wrong
`iss`/`aud`, expired, bad `nonce` — is log-neutral: identity-stream head offset, event
count, and authorization-view digest byte-identical before and after.

Non-goals: CLI/device flow (E2-T05), per-stream authorization decisions (E2-T07 —
this task establishes *who you are*, not *what you may touch*), org/membership events
beyond what a bare user login needs (E2-T01/E2-T06), styling beyond a legible page,
refresh-token rotation (session lifetime is the session events' + TTL config's
business, not the token's).

## Deliverables

- `packages/platform/src/auth/oidc.ts` — discovery
  (`/.well-known/openid-configuration` from `EF_OIDC_ISSUER`), PKCE pair generation
  (S256), JWKS fetch + kid-keyed cache, full ID-token verification (RS256 only —
  `alg: none` and HS256 are hard refusals regardless of header claims), `state`/`nonce`
  issuance and single-use validation.
- `packages/platform/src/auth/routes.ts` — `/auth/login` (302 to the issuer's
  `/authorize` with `code_challenge`), `/auth/callback` (validate → exchange → verify →
  provision-if-first → `identity.session.started` dispatch → set `ef_session` → 302
  `/`), `/auth/logout` (`identity.session.ended` dispatch, cookie cleared). Every
  refusal is the typed body `{ error: { class: 'auth-refused', reason: <'bad-state' |
  'bad-verifier' | 'reused-code' | 'bad-token' | 'expired-token' | 'bad-nonce'> } }` at
  400/401 per the reason→status mapping frozen in this spec's Contract (restated in
  the package README) — never a 5xx, never an append.
- `packages/platform/src/auth/provision.ts` — first-login provisioning: reads the
  authorization view at head for `sub`; if absent, dispatches `identity.user.created`;
  a racing duplicate is refused by E2-T01's duplicate-`sub` dispatch validator and
  absorbed as success (the user exists — proceed to `session.started`), so two racing
  first logins cannot both land one and neither can land a `session.started` before
  the `user.created` it needs.
- `packages/platform/src/auth/session.ts` — `sessionIsValid(id)` answered from the
  reduced identity view (started, not ended, envelope-time + `EF_SESSION_TTL` not
  elapsed); no session map that survives as authority.
- `packages/platform/src/web/` — server-rendered `/`: logged-out state with a login
  link; logged-in state with `sub`, email, `data-identity-offset`,
  `data-identity-digest`, and a logout control.
- `packages/platform/README.md` — env table (`EF_OIDC_ISSUER`, `EF_OIDC_CLIENT_ID`,
  `EF_SESSION_SECRET`, `EF_SESSION_TTL`), the reason→status table, the cookie
  contract, the exact env changes a real Auth0 tenant needs (and that nothing else
  changes).
- `packages/platform/test/auth.test.ts` — integration over real HTTP against a spawned
  emulator: full happy path; second login idempotent (raw dump: exactly one
  `identity.user.created`); every refusal reason with before/after head-offset +
  event-count + view-digest triples asserted byte-identical; restart-survival (kill
  and restart the platform mid-session, `/` still logged-in with the same cookie);
  concurrent first-login race (≥ 20 trials, exactly one `identity.user.created` per
  trial's fresh sub, every trial's replay digest matching the single-provision
  expectation).
- `packages/platform/test/login.pw.ts` — Playwright, the full walkthrough in one run:
  logged-out → first login through the emulator's `/authorize` form → logged-in page;
  asserts zero console errors/warnings across the whole run; asserts
  `data-identity-offset` equals an out-of-band `GET` of the identity stream's head and
  `data-identity-digest` equals `ef replay --digest --reducer` over an out-of-band
  dump of the same stream — literal string equality both; then logout → logged-out;
  then a **second login by the same subject** — logged-in again, and the out-of-band
  dump still greps to exactly one `identity.user.created` (idempotency visible in the
  same run the recording captures); then a failed-verification attempt (expired ID
  token via the emulator's `--now` knob) refused log-neutrally.
- `Makefile`: `verify-E2-T04` — both test files plus replay of the committed
  two-login golden to its committed digest; joins `verify-all`.
- `evidence/` — `e2-t04-two-logins.events.jsonl` + `e2-t04-two-logins.digest` (the
  identity-stream dump of two full logins + one logout by one subject: exactly one
  `identity.user.created`, two `identity.session.started`, one
  `identity.session.ended`; digest produced once and committed),
  `e2-t04-refusal-neutrality.txt` (per-reason before/after triples),
  `e2-t04-playwright.txt` (the transcript incl. both DOM-equality assertions),
  `e2-t04-sensitivity.md` (sabotage transcript, angle 6). The Replay recording of the
  full walkthrough — first login, logout, second login, failed-verification refusal —
  (`tools/replay/record-run.sh -o e2-t04-final`) is cited by URL in the Verification
  log — never committed.

## Acceptance criteria

- [ ] `make verify-E2-T04` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      with scrubbed env — emulator only, loopback only. "No real Auth0 credentials or
      hosts reached" is observed, not assumed: the cold-clone run executes under a
      deny-all-but-loopback network guard wired into `tools/verify/cold_clone.sh`
      (`HTTP_PROXY`/`HTTPS_PROXY` pointed at a local refusing proxy, or an equivalent
      resolver/firewall shim) so that any connection attempt to a non-loopback host
      fails the run; the guard's log — every attempted connection, all loopback — is
      committed as `evidence/e2-t04-network-guard.txt`. The guard must prove its own
      sensitivity in the same run: the cold-clone run executes a deliberate canary
      connection attempt to a known non-loopback host (e.g. `auth0.com:443`) under the
      guard, which MUST be refused, with the refused attempt visible in the committed
      guard log — a canary that connects, or a guard log missing the refused canary,
      fails this criterion (an all-loopback log alone cannot distinguish a working
      guard from a dead one).
- [ ] One `identity.user.created`, ever: after two complete logins by the same
      emulator subject, a structural grep over the **raw dump** counts exactly one
      `identity.user.created`, two `identity.session.started`, and (after logout) one
      `identity.session.ended`; `ef replay evidence/e2-t04-two-logins.events.jsonl
      --digest --reducer <E2-T01's registered reducer>` reproduces
      `evidence/e2-t04-two-logins.digest` and exits 0.
- [ ] Concurrent first-login race: ≥ 20 trials of two simultaneous callbacks for the
      same fresh `sub` — every trial lands exactly one `identity.user.created`, no
      trial lands an `identity.session.started` that E2-T01's reducer refuses
      (unknown `sub` — i.e. no session-before-user ordering violation), and the
      post-trial replay digest matches a reference constructed per trial, not
      self-referentially: the test builds a reference log from the trial's observed
      events containing exactly one `identity.user.created` for the fresh `sub`
      followed by the trial's `identity.session.started` events, replays it through
      E2-T01's registered reducer, and asserts its digest equals the digest of the
      trial's actual dump — the reference construction itself must fail (and the
      trial with it) on any second `user.created` or any reducer-refused event.
- [ ] Token verification is real: a token signed by a wrong key, `alg: none`,
      HS256-with-the-public-key, expired `exp`, wrong `iss`, wrong `aud`, and wrong
      `nonce` are each refused with the documented `auth-refused` reason at the
      status frozen in this spec's Contract (`bad-state`/`bad-verifier`/`reused-code`/
      `bad-nonce` → 400; `bad-token`/`expired-token` → 401) — the critic checks the
      status against this spec, not against the builder's own README table — and for
      each the identity stream's head offset, event count,
      and view digest are byte-identical before and after — triples committed in
      `evidence/e2-t04-refusal-neutrality.txt`.
- [ ] PKCE and state are enforced: a callback with a mismatched or replayed `state`,
      an exchange with the wrong `code_verifier`, and a **reused authorization code**
      are each refused log-neutrally — for each of bad-state, bad-verifier, and
      reused-code, the before/after head-offset + event-count + view-digest triple is
      byte-identical and committed in `evidence/e2-t04-refusal-neutrality.txt`
      alongside the token-verification reasons' triples; the same `state` value
      cannot succeed twice.
- [ ] The DOM tells the truth twice: the Playwright run asserts
      `data-identity-offset` equals the identity stream's head fetched independently
      over HTTP, and `data-identity-digest` equals the digest `ef replay --digest`
      computes over an independent dump of that stream at that offset — literal
      string equality, transcript in `evidence/e2-t04-playwright.txt`.
- [ ] Zero console errors: the entire Playwright run (first login, logout, second
      login, failed-verification attempt) records no console errors and no uncaught
      exceptions.
- [ ] Sessions are events, provably: with a live logged-in session, the platform
      process is SIGKILLed and restarted while the published local Durable Streams
      service remains available; `/` with the
      same cookie renders logged-in with the same `data-identity-offset`; after
      `POST /auth/logout` + another restart it renders logged-out. The test snapshots
      the platform's runtime dirs **pre-login**, diffs them **post-SIGKILL**, and
      asserts no platform-local state files changed — any new or modified file (a
      `state.json`, `cache.dat`, LevelDB directory, or
      anything else, regardless of name) fails the test; a filename glob (`*.sqlite*`,
      `*.db`, `*sessions*`) may run as a cheap first-line check but is not sufficient
      on its own.
- [ ] Logout and expiry are distinct and correct: logout appends exactly one
      `identity.session.ended`; a TTL-expired session renders logged-out **without**
      appending anything — head offset identical before and after the expired
      revisit; a second logout on the same session appends nothing, and the platform
      never dispatches for it: the integration test runs the second logout with the
      Durable Streams service's request log (or a recording proxy in front of it) capturing
      traffic, and asserts zero dispatch POSTs to the identity stream for that
      request — distinguishing "never attempted" from "attempted and refused by
      E2-T01's reducer" — with the transcript committed in
      `evidence/e2-t04-refusal-neutrality.txt`.
- [ ] The cookie is inert: `ef_session` is HttpOnly + SameSite=Lax, carries no JWT
      and no claims (asserted by decoding it in the test); a forged cookie naming a
      never-started session id, a tampered signature, or an ended session's id
      renders logged-out, log-neutrally.
- [ ] Malformed input never crashes a door: a fuzz run of ≥ 200 randomized/malformed
      inputs across the three parsing surfaces — `/auth/callback` with garbage
      `code`/`state` (empty, oversized, non-UTF-8, URL-metacharacter payloads),
      truncated and non-base64 JWTs at token verification, and malformed `ef_session`
      cookie bytes (random bytes, wrong segment counts, oversized values) — yields
      for every input a documented 4xx `auth-refused` body, zero 5xx responses, and
      zero uncaught exceptions, and the identity stream's head-offset + event-count +
      view-digest triple is byte-identical before and after the whole run, shown by
      dump diff in the test.
- [ ] Real-tenant parity by env only, proven differentially: as a cheap first gate,
      `git grep -iE 'emulator' packages/platform/src/` produces zero matches —
      identifiers, imports, env checks, and comments included — and
      emulator code is reached only by the integration harness through the pinned
      `vendor/emulate` submodule (E2-T02's isolation rule). Because a grep is only a
      word-match proxy
      (an `if (issuer.startsWith('http://localhost'))` or port-conditional branch
      contains no "emulator" token), the test suite also runs the identical
      login/logout flow against a **second, independently configured emulator
      instance** — different port, different issuer URL, different subjects — changing
      only `EF_OIDC_ISSUER`/`EF_OIDC_CLIENT_ID`, and asserts the same event shapes and
      the same refusal behavior across the two configurations (each instance's raw
      dump replayed through E2-T01's registered reducer and digest-compared against
      its own reference construction); any behavioral difference between issuer
      configurations refutes parity-by-env.
- [ ] Replay (browser layer): a Replay recording of the full walkthrough —
      logged-out page, first login through the emulator form, logged-in identity +
      offset + digest, logout, second login by the same subject, and the
      failed-verification refusal — is cited by URL in the Verification log; if
      `tools/replay/preflight.sh` fails on the machine, the fallback is declared per
      AGENTS.md (`Replay: N/A (<reason>) + mitigation`) with the Playwright
      transcript + console/network interrogation standing in.
- [ ] All root gates pass: `pnpm format:check && pnpm lint && pnpm typecheck &&
      pnpm test && pnpm build` exit 0, and `make verify-E2-T01`, `verify-E2-T02`, and
      `verify-E0-T11` re-run green on this tree.

## Adversarial verification

The claim under attack: "only a cryptographically verified login mints identity
events, it mints exactly the right ones exactly once, the page's offset and digest are
the stream's truth, and no session state lives outside the log." Use your own emulator
instance, your own subjects, your own dumps. Invent at least one more angle.

1. **Forge the token.** Do not reuse the builder's bad-token fixtures — mint your own
   against E2-T02's committed keypair surface: `alg: none` with a valid-looking
   payload, HS256 signed with the *public* RSA key bytes (the classic confusion), a
   valid token whose `kid` is not in the JWKS, a token from a *second* emulator
   instance (wrong `iss`, right shape), a structurally perfect token with one
   signature bit flipped. Every one must land in the documented `auth-refused` reason
   with the identity stream untouched by digest, count, and head offset. Any
   acceptance, any 5xx, or any appended event — including a "failed-login" marker —
   refutes the door.
2. **Replay the callback.** Capture a real successful callback URL (code + state) and
   fire it again; fire the code with a different verifier; run two logins and swap
   their `state` values; start login A, complete login B, then finish A with B's
   artifacts. Single-use means single-use: a second acceptance of any code or state
   refutes it. Then diff the raw dump — the replayed attempts must have appended
   nothing.
3. **Race the provisioning yourself.** Fresh sub, ≥ 50 rounds of 2–3 concurrent
   first-login callbacks through your own harness, not the builder's test. Exactly one
   `identity.user.created` per round in the raw dump, every round, and never an
   `identity.session.started` refused for unknown `sub` that left the winner's login
   half-done. Then verify the mechanism lives at the dispatch door: find and disable
   any web-tier mutex/queue in `packages/platform` and re-run — if duplicates appear,
   the fence was in the wrong layer and the restart-survival claim is theater.
4. **Hunt the hidden database.** Log in, SIGKILL the platform (no graceful shutdown),
   and diff its runtime dirs against pre-login plus the expected stream appends: any
   sessions file, sqlite, LevelDB, or JSON state blob refutes bet 4. Restart and
   confirm the session validates purely off replay — then, in a scratch copy of the
   data dir, excise the session's `identity.session.started` event and confirm the
   session *stops* validating; a session surviving the deletion of its own event
   proves a shadow store.
5. **Lie in the cookie.** Decode `ef_session` — any JWT, email, sub, or role inside
   is a finding. Forge — all four forgeries constructed **without** knowledge of
   `EF_SESSION_SECRET`, so every forged cookie is signature-invalid: valid-*looking*
   HMAC + fabricated session id, real id + broken HMAC, an ended session's id,
   another user's session id. All must render logged-out and append nothing. (A
   validly-signed stolen cookie — another user's real session id with a genuine
   HMAC — rendering logged-in is bearer semantics, correct behavior, and out of
   scope here; cookie theft mitigation is a future CSRF/rotation task, not a
   refutation of this claim.) Check HttpOnly/SameSite on the wire against the frozen
   contract,
   and try the cookie against `/auth/logout` too — a forged cookie that lands an
   `identity.session.ended` refutes log-neutrality where it hurts.
6. **Interrogate the DOM pair.** At the logged-in point (live or via the Replay MCP),
   read `data-identity-offset` and `data-identity-digest`; independently fetch the
   stream head and compute `ef replay --digest` over your own dump — all four must
   agree. Dispatch an unrelated identity event, reload: both attributes must move to
   the new truth; a stale, hardcoded, or off-by-one value refutes the claim. Sabotage
   the apparatus: hardcode each attribute in a scratch worktree and run the Playwright
   suite — it must go red for each; a green run refutes the measuring apparatus
   (compare against `evidence/e2-t04-sensitivity.md`).
7. **Expiry vs logout, adversarially.** Elapse `EF_SESSION_TTL` (and separately use
   the emulator's `--now` knob for an expired ID token) — both must render/refuse
   logged-out with zero appends, shown by dump diff. Log out twice — the second must
   append no second `identity.session.ended` and must match the README's documented
   behavior; an undocumented answer is a contract hole. Confirm the cited Replay
   recording actually contains the scenes the builder claims — a recording missing a
   claimed scene fails sufficiency.
8. **Cold clone + parity honesty.** Run `make verify-E2-T04` through
   `tools/verify/cold_clone.sh` with env scrubbed and the network observed — any
   reach for a non-loopback host refutes the emulator-default claim. Re-derive the
   two-login golden digest yourself with `ef replay --digest --reducer` and grep the
   raw dump for the 1/2/1 event counts. Then read `packages/platform/src/` for
   emulator-conditional paths and check `package.json` dependency placement; a
   production import of `@emulators/auth0` or any `if (emulator)` branch
   refutes parity-by-env.
9. **Fuzz the doors.** With your own generator (not the builder's fuzz corpus), throw
   N randomized/malformed inputs at each parsing surface: `/auth/callback` with
   garbage `code`/`state` values, truncated and non-base64 JWTs presented at token
   verification, and mangled `ef_session` cookie bytes. Every input must land a
   documented 4xx `auth-refused` body — any 5xx, any uncaught exception in the
   platform's logs, or any change to the identity stream's head-offset/count/digest
   triple (diff the raw dump before and after the whole run) refutes the "never a
   5xx, never an append" contract at the exact place it is cheapest to fake.

Refutation currency: a dump + offset where an unverified login minted an event, a
second `identity.user.created` for one sub, a forged token or cookie that rendered
logged-in, a DOM offset or digest that disagrees with the stream, a session file on
disk, or a digest pair that should match and doesn't. "The login page is ugly" is a
note, not a finding.

## Verification log
