---
id: E2-T02
epic: 2
title: "OIDC emulator: deterministic local Auth0 stand-in — authorize+PKCE, device-code, token, JWKS — drivable in a browser from a cold clone"
priority: 202
status: pending
depends_on: [E1]
estimate: M
capstone: false
---

## Goal

`packages/oidc-emulator` (`@eforest/oidc-emulator`) is a local, deterministic,
Auth0-compatible OIDC provider serving the exact surfaces Epic 2 consumes, with **zero
external network** — startable from a cold clone and drivable in a real browser. Started
via `pnpm --filter @eforest/oidc-emulator start -- --port <p> --subjects <file>
--now <iso8601> --seed <int>` (or the exported `startEmulator(options)` for tests), it
serves on `http://127.0.0.1:<port>`:

- `GET /.well-known/openid-configuration` — issuer metadata whose `issuer`,
  `authorization_endpoint`, `token_endpoint`, `device_authorization_endpoint`, and
  `jwks_uri` all point back at the emulator's own origin.
- `GET /authorize` — authorization-code flow with **mandatory PKCE `S256`**, rendering a
  dependency-free HTML login page (inline CSS only, zero external resources) that
  Playwright can drive: a subject picker populated from the subjects fixture
  (`data-testid="login-subject"`), a submit button (`data-testid="login-submit"`), then a
  302 to `redirect_uri` carrying `code` and the byte-identically echoed `state`.
- `POST /oauth/device/code` — device-authorization flow: `device_code`, `user_code`,
  `verification_uri`, `verification_uri_complete`, `expires_in`, `interval`.
- `GET/POST /activate` — the device-approval page for a `user_code`, equally
  Playwright-driveable (`data-testid="device-user-code"`, `"device-confirm"`,
  `"device-deny"`).
- `POST /oauth/token` — grants `authorization_code` + PKCE and
  `urn:ietf:params:oauth:grant-type:device_code`, minting RS256 `access_token` +
  `id_token` (`token_type: Bearer`, `expires_in`) from a **committed** signing key, with
  OAuth-standard error bodies (`invalid_grant`, `authorization_pending`, `expired_token`,
  `access_denied`, `unsupported_grant_type`) at their RFC-pinned statuses.
- `GET /.well-known/jwks.json` — the public half of the committed RS256 test keypair
  (`fixtures/test-keypair.private.jwk.json` / `fixtures/test-keypair.public.jwk.json`,
  fixed `kid: eforest-test-2026`, TEST ONLY banners).

The emulator is deterministic under an injectable clock and a subjects fixture
(`fixtures/subjects.json`: array of `{ sub, email, name }`, Auth0-shaped `sub` like
`auth0|ef-test-user-1`): given the same `--now`, `--seed`, and request inputs, issued
JWTs are **byte-identical across runs** (RS256/PKCS#1 v1.5 is deterministic; `iat`/`exp`
derive from the injected clock, never wall time), so full HTTP transcripts of both grant
flows are golden-able. `make verify-E2-T02` runs from a cold clone with scrubbed env and
replays both grant flows against **committed golden transcripts** byte-exactly
(port-normalized), verifies issued JWTs against the served JWKS with an independent
verifier, and proves the apparatus by rejecting a tampered-signature token.

## Context

This is verification infrastructure, added explicitly. Epic 2's bet (ROADMAP.md,
"the-gates") is that Auth0 is the sole identity provider and the only external service —
which makes every auth claim in E2-T03..T12 unprovable under the cold-clone rule
(AGENTS.md) unless a deterministic local stand-in exists first. The capstone demo itself
says "Playwright drives an emulated Auth0 login end-to-end" (ROADMAP.md, the-locked-gate);
this task builds the thing being emulated. Without it, every later evidence run would
either hit the real Auth0 (network dependency, nondeterministic tokens, unverifiable from
a clone) or mock at the wrong layer (stubbing our own client code, which proves nothing
about our verification of real RS256 tokens). With it, E2-T03's bearer-token
verification, E2-T04's web login, E2-T05's device flow, E2-T10's conformance matrix, and
E2-T12's capstone all record against the same fixture, and their golden transcripts stay
replayable forever.

Depends on `E1` (the epic gate: this rides the verify spine, workspace gates, and
evidence conventions frozen in Epic 0/1; it needs nothing from E2-T01's identity event
model — the emulator is upstream of the platform, deliberately ignorant of streams).
Unblocks: E2-T03 (tokens to verify), E2-T04 (a login page to drive), E2-T05 (a device
flow to poll), E2-T10 (identities for the conformance matrix), E2-T12 (the capstone's
emulated login).

Contracts frozen here (later changes invalidate every downstream E2 golden transcript
and standing verification recorded against the emulator):

- **Endpoint paths and issuer-metadata shape** — the endpoints above at exactly those
  Auth0-compatible paths, discovery document field names per OIDC Discovery. The form
  submissions are frozen too, because downstream golden transcripts byte-pin them:
  the login form submits `POST /authorize` (same path as the GET that rendered it) and
  the device-approval form submits `POST /activate` — changing either form's method or
  action later is a contract change that invalidates every downstream E2 golden, not a
  refactor.
- **The test keypair and its `kid`** (`eforest-test-2026`) — E2-T03's verifier and every
  downstream golden token verify against this exact JWKS; rotating the committed key is
  a contract change, not a refresh.
- **`fixtures/subjects.json` format** and the shipped default subjects — E2-T10's
  identity × operation matrix enumerates these subjects by `sub`.
- **Token claim sets** — ID token: `iss`, `sub`, `aud`, `iat`, `exp`, `nonce` (when
  sent), `email`, `name`. Access token: also an RS256 JWT signed with the same
  `kid: eforest-test-2026`, pinned minimal claim set `iss`, `sub`, `aud`, `iat`, `exp`
  (E2-T03's bearer verification and its golden transcripts verify against exactly this
  shape).
- **Error taxonomy, pinned for every negative path the spec names** — token endpoint:
  400 for `invalid_grant`/`authorization_pending`/`expired_token`/
  `unsupported_grant_type`, 403 for `access_denied`; a device poll with a fabricated
  `device_code` and a token request with a mismatched `redirect_uri` are each
  `invalid_grant` 400. `/authorize` PKCE refusals (`code_challenge_method=plain`,
  missing `code_challenge`): direct `400` with `error=invalid_request` in the body and
  **no redirect** to `redirect_uri` — never a 302.
- **Determinism knobs** — `--now <iso8601>` (injected clock; all `iat`/`exp`/expiry
  arithmetic derives from it) and `--seed <int>` (deterministic
  `device_code`/`user_code`/authorization-code generation for transcript-golden runs;
  without `--seed`, codes are random but token bytes are still clock-and-input
  determined).
- **`data-testid` hooks** — `login-subject`, `login-submit`, `device-user-code`,
  `device-confirm`, `device-deny`; E2-T04/T05/T12's Playwright specs select by these.

Security semantics are real even though the identities are fake: PKCE is mandatory
(`code_challenge_method` must be `S256`; `plain` and absent challenges are refused at
`/authorize` with the pinned 400, no redirect), authorization codes and device codes are
single-use and expire, a token request whose `code_verifier` does not hash to the stored
challenge is refused `invalid_grant` 400 with **no token issued**, and `state` is echoed
untouched. Downstream tasks must demonstrate their negative paths (E2-T03's 401s,
E2-T12's refused append) against honest refusals, not a pushover.

Non-goals: refresh tokens, `/userinfo`, RP-initiated logout, opaque access tokens with
introspection, multi-tenant issuers, clock-skew simulation, TLS — all deferrable; the
frozen contract is additive-extensible. The emulator never touches durable streams,
never persists across restarts (in-memory only, by design — restart = clean slate), and
is a dev/test dependency: nothing in any production `src/` outside this package may
import it.

## Deliverables

- `packages/oidc-emulator/src/server.ts` — the HTTP server and endpoint handlers;
  `startEmulator(options): Promise<{ url, close }>` exported for tests.
- `packages/oidc-emulator/src/cli.ts` — the `--port/--subjects/--now/--seed` entry
  (`pnpm --filter @eforest/oidc-emulator start`).
- `packages/oidc-emulator/src/tokens.ts` — RS256 signing over the committed private JWK
  (Node `crypto`/`jose`, no network), claim construction from the injected clock only.
- `packages/oidc-emulator/src/pages.ts` — the `/authorize` login page and `/activate`
  device-approval page: inline HTML/CSS, zero external resources, the five frozen
  `data-testid` hooks.
- `packages/oidc-emulator/fixtures/` — `test-keypair.private.jwk.json`,
  `test-keypair.public.jwk.json` (TEST ONLY banners), `subjects.json` (≥ 3 subjects,
  one earmarked in a comment field for E2-T10's "other tenant" role).
- `packages/oidc-emulator/README.md` — the frozen contract verbatim: endpoint table,
  claim sets, error taxonomy with statuses, keypair/`kid`, subjects format, determinism
  knobs, `data-testid` hooks, and the doctrine line "every E2 evidence run records
  against this emulator".
- `packages/oidc-emulator/test/conformance.test.ts` — over real HTTP against
  `startEmulator({ now, seed })`: discovery document field-by-field; full
  authorization-code+PKCE round trip (authorize → drive the login form → capture
  `code`+`state` from the 302 → token exchange → **verify the RS256 signature of both
  tokens against `/.well-known/jwks.json` using an independent verifier, not the signing
  code** → assert every frozen claim); full device flow (device/code → poll →
  `authorization_pending` → approve at `/activate` → poll → tokens → signature-verify);
  every error-taxonomy entry provoked and asserted at its literal pinned status and
  `error` code — never "some 4xx".
- **Golden transcripts (the headline evidence):**
  `evidence/golden-authcode-transcript.jsonl` and
  `evidence/golden-device-transcript.jsonl` — the full ordered request/response
  transcript (method, path, query, status, headers subset, body; ephemeral port
  normalized to a placeholder) of each grant flow under a pinned `{ now, seed }`.
  The header subset is pinned, not implementation-chosen: at minimum `location`
  (port-normalized; the authorization `code` is seed-deterministic so the value is
  byte-stable) and `content-type`, explicitly excluding wall-clock headers like
  `date`. Produced once and committed. `make verify-E2-T02` re-runs both flows with
  the same
  pins and **diffs the fresh transcript against the committed golden — byte-exact
  equality required**; the target never regenerates the golden it checks against.
- `packages/oidc-emulator/test/security.test.ts` — the negative paths at their pinned
  statuses: PKCE `plain` → 400 `invalid_request` at `/authorize`, no redirect; missing
  challenge → same; wrong `code_verifier` → `invalid_grant` 400, no token;
  authorization-code reuse → second exchange `invalid_grant` 400; expired code (clock
  advanced via `now`) → `expired_token` 400; device poll with fabricated `device_code`
  → `invalid_grant` 400; denied device grant → `access_denied` 403; mismatched
  `redirect_uri` → `invalid_grant` 400; `state` echoed byte-identical including
  URL-hostile characters. Exchanges appended to
  `evidence/e2-t02-security-transcript.jsonl`.
- `packages/oidc-emulator/test/determinism.test.ts` — two full runs with identical
  `{ now, seed }` produce byte-identical ID tokens, byte-identical access tokens, and
  byte-identical (port-normalized) transcripts.
- Playwright spec `packages/oidc-emulator/test/login.pw.ts` — a real browser drives
  `/authorize` login and `/activate` approval through pointer/keyboard events via the
  frozen `data-testid` hooks, asserts zero console errors and zero non-loopback network
  requests, and completes both token exchanges; trace committed to
  `evidence/e2-t02-playwright-trace.zip`. The same walkthrough recorded with
  `tools/replay/record-run.sh -o e2-t02-final` (browser-impacting task: Replay evidence
  is mandatory per AGENTS.md, with the loud `Replay: N/A (<preflight reason>) +
  mitigation` fallback only if `tools/replay/preflight.sh` fails).
- `evidence/` — the two golden transcripts, `e2-t02-security-transcript.jsonl`,
  `e2-t02-jwt-verification.txt` (independent-verifier output: green on issued tokens,
  red on the tampered token), `e2-t02-determinism.txt` (empty-diff proof),
  `e2-t02-network-guard.txt` (network-deny trip count), `e2-t02-fs-audit.txt`
  (filesystem-write audit: count of writes outside the allowlist pinned in acceptance
  criterion 9 — `os.tmpdir()`, this task folder's `work/`, and the two enumerated
  evidence exceptions — asserted `0`; the conformance/security/determinism suites run
  under it, the Playwright spec does not),
  `e2-t02-sensitivity.md`, `e2-t02-playwright-trace.zip`.
- `Makefile`: `verify-E2-T02` per the frozen per-task target contract — composed from
  the `_v-*` recipes plus the three test suites, the golden-transcript replay diff, the
  JWT verify/tamper step, and the Playwright spec; joined to `verify-all`; ends with
  exactly `@echo "verify-E2-T02: OK"`.

## Acceptance criteria

- [ ] `make verify-E2-T02` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      with scrubbed env (`NODE_OPTIONS`, `NODE_ENV`, `npm_config_*` unset) and zero
      `SKIPPED:` lines — evidence: `make verify-E2-T02 2>&1 | grep -c '^SKIPPED:'`
      prints `0`.
- [ ] **Golden transcript replay, exact:** the verify target re-runs the
      authorization-code+PKCE flow and the device-code flow under the pinned
      `{ now, seed }` and `diff`s each fresh port-normalized transcript against
      `evidence/golden-authcode-transcript.jsonl` /
      `evidence/golden-device-transcript.jsonl` — both diffs empty, asserted by exit
      code, not eyeballs. Deleting a committed golden makes the target fail red, never
      regenerate-and-pass. Together the two goldens cover every frozen endpoint
      (discovery, authorize, login form POST, device/code, activate, both token grants,
      jwks) with literal statuses, and the authcode golden's 302 line contains the
      `Location` header carrying `code` and the byte-identically echoed `state` — a
      golden whose 302 lacks that Location payload fails the criterion.
- [ ] Signature + tamper sensitivity (the apparatus proof):
      `evidence/e2-t02-jwt-verification.txt` shows an ID token and an access token from
      the golden flows verified RS256-valid against the **served** `/.well-known/jwks.json`
      (matched by `kid: eforest-test-2026`, key equal to the committed
      `fixtures/test-keypair.public.jwk.json`) using a verifier independent of
      `src/tokens.ts` — independence asserted mechanically, not by reading: a grep over
      the verifier's resolved import graph for `packages/oidc-emulator/src` returns no
      output and exits 1 (the same exit-code style as criterion 9), with that grep's
      command and exit code captured in `e2-t02-jwt-verification.txt`; a "verifier"
      that imports the signing helper or any module under the emulator's `src/` fails
      this criterion regardless of its green/red output — and shows the same verifier
      go red on the same token with one signature byte flipped. A verifier that stays green on the tampered token refutes
      the measuring apparatus, not the emulator.
- [ ] Determinism: two runs with identical `--now` and `--seed` produce byte-identical
      ID tokens, access tokens, and (port-normalized) transcripts; empty-diff proof
      committed as `evidence/e2-t02-determinism.txt`. Back-to-back runs can share a
      wall-clock second, so the byte diff alone does not trap a wall-clock leak: the
      determinism test additionally decodes the issued tokens and asserts `iat`/`exp`
      equal the injected `--now` arithmetic exactly (the golden replay of criterion 2,
      with its pinned past `--now`, is the byte-diff trap for wall-clock leaks).
- [ ] Zero external network, enforced in-process: the conformance + security +
      determinism suites run under a network-deny bootstrap that patches
      `net.Socket.connect` and undici's connector to **throw** on any connection to a
      non-loopback host, counts trips, asserts zero, and writes the count to
      `evidence/e2-t02-network-guard.txt`; the Playwright spec asserts every observed
      request URL is loopback. Belt-and-braces, the whole run also executes with
      proxies blackholed (`HTTP_PROXY=http://127.0.0.1:1 HTTPS_PROXY=http://127.0.0.1:1
      NO_PROXY=127.0.0.1,localhost`). A single trip or non-loopback request fails the
      run.
- [ ] PKCE and single-use are real: the security suite demonstrates — with exact
      statuses — wrong `code_verifier` → `invalid_grant` 400 and no token; code reuse →
      `invalid_grant` 400 on the second exchange; `code_challenge_method=plain` and
      missing challenge → 400 `invalid_request` at `/authorize` with no redirect;
      pre-approval device poll → `authorization_pending` 400; denied device grant →
      `access_denied` 403; expired code → `expired_token` 400 — evidence: each
      provocation and its literal status/error body appended to
      `evidence/e2-t02-security-transcript.jsonl`; the criterion is checked against
      that transcript, not test output.
- [ ] Browser proof: the Playwright spec completes login and device approval through
      real pointer/keyboard events on the frozen `data-testid` hooks with zero console
      errors; trace committed as `evidence/e2-t02-playwright-trace.zip`; a Replay
      recording of the same browser-driven walkthrough (`tools/replay/record-run.sh -o
      e2-t02-final`) is cited by URL in the Verification log — or the claim carries
      `Replay: N/A (<preflight reason>)` with the trace named as mitigation, per
      AGENTS.md. Silence is a refutation.
- [ ] Sabotage sensitivity: in a scratch worktree, (a) corrupt one byte of the committed
      private JWK's `d` parameter and (b) skip the `code_verifier` check in the token
      handler — after each, `make verify-E2-T02` MUST go red (JWT verification and the
      security suite respectively); transcripts committed as
      `evidence/e2-t02-sensitivity.md`. Green under either sabotage refutes the suite.
- [ ] Isolation holds, mechanically: `git grep -l 'oidc-emulator' -- 'packages/*/src'
      'apps/*/src' ':!packages/oidc-emulator/**'` returns **no output and exits 1** — a
      literal empty-output/exit-code assertion over production `src/` only
      (`package.json` devDependencies are outside the searched pathspec by construction,
      not by judgment; any hit, whatever the builder calls it, fails). Clean-slate is
      proven behaviorally, not by documentation: `conformance.test.ts` includes a
      restart test — mint a `device_code`, `close()` the emulator, re-run
      `startEmulator` with identical options, poll the same `device_code` →
      `invalid_grant` 400 (nothing survived the restart) — and the same three suites as
      criterion 5 (conformance + security + determinism; the Playwright spec is
      explicitly **excluded** from the audit — its trace zip lands in `evidence/` by
      design) run under a filesystem-write audit that hooks `fs` writes in-process and
      counts every write to any path outside the mechanical allowlist
      `{ os.tmpdir(), this task folder's work/, evidence/e2-t02-security-transcript.jsonl,
      evidence/e2-t02-fs-audit.txt }` — the last two are the enumerated exceptions:
      the security suite appends its transcript and the audit writes its own count file
      during the audited run, and no other path outside tmp/`work/` is allowed. The
      audit writes the count to `evidence/e2-t02-fs-audit.txt` and asserts it is `0`
      (the same evidence pattern as criteria 4 and 5); the allowlist is the literal set
      above, not a judgment call — "the whole repo" is not an allowlist. The package README states both
      properties, but the README is documentation, not evidence — the grep exit code,
      the restart test, and the fs-audit count are the checks.
- [ ] All root gates pass: `pnpm format:check && pnpm lint && pnpm typecheck &&
      pnpm test && pnpm build` exit 0; `verify-all` (every E0/E1 target) still green.

## Adversarial verification

The claim under attack: "this stand-in is deterministic, offline, cryptographically
honest, and strict enough that evidence recorded against it means something." Use your
own inputs and seeds throughout — never the builder's — and invent at least one angle
this list omits.

1. **Network cage, your bars.** Do not trust the builder's proxy env. Run the full
   verify target under your own containment: blackholed proxies of your own choosing,
   plus live monitoring (`lsof -i -P` or a packet capture during the run). Any
   connection attempt to a non-loopback address — a lazy `npx` fetch, a telemetry ping,
   `jose` reaching for a remote JWKS — refutes the zero-external-network claim outright,
   even if the tests pass.
2. **Golden transcript, your replay.** Replay both grant flows yourself with the pinned
   `{ now, seed }` from a cold clone and byte-diff against the committed goldens. Then
   delete a golden and run the verify target — it must fail red, not regenerate. Inspect
   the recipe and test code for any path that writes a golden at check time; a
   self-blessing golden refutes the entire evidence scheme downstream E2 tasks inherit.
   Finally, diff the goldens against the frozen contract: every endpoint, every pinned
   status, present with its literal value — a golden that never exercises an endpoint
   the contract freezes is a coverage hole; name it. Check the headers too: the
   authcode golden's 302 line must include a `Location` header carrying `code` and the
   echoed `state` — a degenerate or Location-less header subset that never witnesses
   the frozen redirect payload is the same coverage hole; refute it.
3. **Crypto differential, independent stack.** Take tokens from your own live run (not
   the committed transcript) and verify them with a stack the repo does not use (raw
   `node:crypto` `verify()` if the suite used `jose`, or vice versa). Then attack: flip
   one signature byte (must go red), swap the header `kid` to a nonexistent one (a
   verifier that falls back to "any key" refutes), rewrite the header to `alg: none`
   and strip the signature (must be rejected), and re-sign the payload HS256 using the
   *public* key bytes as the HMAC secret — the classic confusion attack; any green
   refutes the verification apparatus this emulator exists to feed. Confirm `iat`/`exp`
   equal the injected `--now` exactly, not wall time.
4. **Determinism, your seed and your diff.** Run the flows twice with your own
   `{ now, seed }` and byte-diff tokens and transcripts yourself. Then run once with
   `--now` and once without, and confirm the *documented* boundary: seeded runs
   identical; unseeded runs differ only in the code/nonce material the contract says is
   random. Any undocumented nondeterminism (object key order drift, locale-dependent
   formatting, port leaking into a claim) refutes the determinism contract.
5. **PKCE and single-use, adversarial sequencing.** With your own client: exchange a
   code with a verifier that is a *prefix* of the correct one; the correct value but
   base64 (not base64url) encoded; the challenge itself replayed as the verifier. All
   must refuse `invalid_grant` 400 with no token. Fire the same authorization code at
   `/oauth/token` twice **concurrently** — if both racing exchanges return tokens, the
   single-use claim is refuted at the race, not just the happy path. Repeat the race on
   a device-code poll straddling the approval moment. Cross the streams: mint a code
   via the login flow, then exchange it alongside device-flow parameters; any
   grant-type parameter bleed that yields a token refutes.
6. **Fuzz the doors.** Malformed traffic at every endpoint with your own generator:
   truncated bodies, wrong content types, `__proto__` keys, array-valued parameters,
   10 MB `state` values, null bytes in `user_code`, duplicate query keys. N ≥ 300. Any
   5xx, crash, hang, or — worse — any 200 bearing a signed token for malformed input
   refutes robustness. Check `Object.prototype` for pollution after the run.
7. **Drive the pages yourself, then interrogate the recording.** Your own Playwright
   session, your own subject choice, headed and headless: complete both flows through
   real events on the frozen `data-testid` hooks, assert zero console errors and
   loopback-only network. Then open the builder's cited Replay recording via the Replay
   MCP: confirm the login form submission, the 302 carrying `code`+`state`, and the
   token exchange actually occur *in the recording* — a recording that never shows the
   exchange is insufficient evidence; demand a re-record. If `Replay: N/A` was
   declared, reproduce the stated preflight reason on this machine; a false N/A is
   fabricated evidence.
8. **Sabotage beyond the builder's.** In a scratch worktree: (a) make `/oauth/token`
   accept any `code_verifier`, (b) serve a JWKS whose modulus differs from the signing
   key, (c) make expired codes exchangeable, (d) return `state` re-encoded instead of
   byte-identical, (e) change one pinned error status (e.g. `access_denied` 403 → 400).
   `make verify-E2-T02` must go red under every one. Any sabotage it survives green is
   a hole every downstream E2 task inherits — refute loudly and name the missing
   assertion.
9. **Fixture-lock audit.** Diff the package README's frozen contract against the
   shipped code both directions: endpoint paths, claim sets, error statuses, `kid`,
   subjects format, `data-testid` hooks, determinism knobs. Fingerprint the served
   JWKS `n` against `fixtures/test-keypair.public.jwk.json` and confirm no second
   signing key exists anywhere in the tree. Then check isolation yourself: any
   production `src/` import of the emulator outside its package, or any durable-stream
   write from the emulator process, refutes. A contract the code silently deviates
   from poisons every later golden recorded against this emulator — that is the
   finding that matters most here.

Refutation currency: an HTTP transcript showing a wrong status/claim/token, a byte diff
where the contract pins identity, a packet-capture line to a non-loopback host, a Replay
point link showing the recording contradicts the claim, or a green run under a sabotage
that was contracted red — each cited by file, request, or diff line. "Auth0 also
supports X and this doesn't" is out of scope unless a later E2 task's spec requires X;
the contract here is the frozen subset, not Auth0 parity.

## Verification log

(appended over time by builders and critics)
