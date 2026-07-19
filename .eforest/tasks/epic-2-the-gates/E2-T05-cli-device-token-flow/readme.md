---
id: E2-T05
epic: 2
title: "CLI credentials: ef login device flow and mint-from-web-session, both recorded as revocable grant events on the identity stream"
priority: 205
status: in-progress
depends_on: [E2-T03, E2-T04]
estimate: M
capstone: false
---

## Goal

The `ef` binary (`packages/cli`) holds real, revocable credentials, obtained two ways,
and both ways are events. (1) **`ef login`** runs the OIDC device-authorization flow
(RFC 8628) against the E2-T02 emulator: `POST /oauth/device/code` returns
`{device_code, user_code, verification_uri, interval}`, the CLI prints the code and
polls `POST /oauth/token` with
`grant_type=urn:ietf:params:oauth:grant-type:device_code` (honoring
`authorization_pending` and `slow_down`) while the user approves at the emulator's
verification page; on success the access token is written to
`$EF_HOME/credentials.json` (default `~/.eforest/`, file mode `0600`, `EF_HOME`
overridable for tests). (2) **Mint from a web session**: an E2-T04-authenticated
session calls `POST /api/cli-tokens {name, scopes}` and receives a scoped bearer token
exactly once in the response body. Both paths append a `grant/cli-token-issued` event
to the subject's identity stream — carrying `{grantId, sub, tokenKind:
'device'|'web-mint', tokenHash /* SHA-256 of the bearer secret — for device tokens
the bearer secret is the emulator access-token JWT itself; never the secret */,
scopes, name?, issuedAt}` per the E2-T01 grant-event envelope (these two event types
are frozen here as versioned extensions of E2-T01's grant family, alongside
`grant/cli-token-revoked {grantId, revokedAt}`). E2-T03's bearer check at every
mutating door is extended (additively, behind the same verifier) to consult the E2-T01
reduced authorization view: a presented CLI credential must map — by verified `sub` +
`tokenHash` (the SHA-256 of the presented bearer secret, for both token kinds) — to
an **active** grant.
`DELETE /api/cli-tokens/:grantId` (web-session-authed) dispatches
`grant/cli-token-revoked`; from that event onward the identical append is refused with
the typed status `error.class: 'token-revoked'` → **401**, pinned here as an additive
row in E2-T03's frozen refusal taxonomy, log-neutral like every E2-T03 refusal. A
minimal **CLI tokens page** in the E2-T04 web app (list active tokens from the reduced
view, mint, revoke) makes the mint interaction real and recordable. `make
verify-E2-T05` replays a committed golden identity-stream event log — device-flow
grant, web-mint grant, revocation — to a committed digest and runs the end-to-end
transcript from a cold clone.

## Context

Epic 2's bet is that identity is just more events on streams — no database (ROADMAP.md
bet 4, "Epic 2 — the-gates"). E2-T01 froze the identity event model and the reduced
authorization view; E2-T02 gave us a deterministic local Auth0 stand-in (seeded
randomness, pinnable clock) so auth flows are provable from a cold clone; E2-T03 put a
bearer check at every mutating door with typed 401s; E2-T04 gave the web app real
logins and sessions-as-events. This task is where the **CLI** joins the identity
system, and where credentials become *first-class, revocable platform records* rather
than opaque strings: because both issuance paths are grant events, the authorization
view is the single source of truth for "which credentials exist right now", revocation
is one more event (no token blacklist table — there is no table), and
`replay(identity stream)` reconstructs the entire credential history. That property is
load-bearing for E2-T07 (per-stream authorization reads the same view), E2-T10 (the
conformance matrix sweeps identities minted this way), the E2-T12 capstone
(the-locked-gate mints a CLI token mid-recording), and Epic 4 (every `ef` sync command
authenticates with these credentials).

Contracts frozen here, versioned from this task forward: the
`grant/cli-token-issued` / `grant/cli-token-revoked` event shapes (fields above,
following E2-T01's envelope — if E2-T01 already defines equivalents, extend, never
fork); the rule that **the raw bearer secret never appears in any event** (only its
SHA-256 `tokenHash` — for device tokens, the hash of the access-token JWT); the `token-revoked` → 401
refusal row and its error-body shape (E2-T03's `{error: {class, ...}}` format); the
`POST /api/cli-tokens` / `GET /api/cli-tokens` / `DELETE /api/cli-tokens/:grantId`
endpoints and the mint response's show-the-secret-exactly-once semantics;
`$EF_HOME/credentials.json` as the CLI credential store location and shape; and the
**CLI exit-code table**, frozen here and mirrored in the CLI package README next to
E2-T03's refusal table:

| exit code | meaning |
|---|---|
| `0` | success |
| `10` | no credentials (`credentials.json` absent — refused locally, no request made) |
| `11` | device flow: `expired_token` (device code expired before approval) |
| `12` | device flow: `access_denied` (user denied at the verification page) |
| `13` | server refused the presented credential (typed 401, e.g. `token-revoked`) |

Every criterion below that mentions an exit code means the literal code from this
table; these codes are pairwise distinct by construction, and each is asserted
literally in the committed tests and transcript.

Non-goals: scope *enforcement* per stream/branch/visibility (scopes are recorded in
the grant event and surfaced in the door's auth context, but per-stream decisions are
E2-T07); token refresh/expiry policy beyond what the emulator's access tokens already
carry (revocation is the kill switch this task proves); `ef logout` beyond deleting
the local credentials file; rate-limiting the device poll (E2-T11); any new append
path — issuance and revocation events go through the one dispatch door like everything
else.

## Deliverables

- `packages/cli/src/commands/login.ts` — `ef login`: device-code request, user-code
  display, compliant polling (`interval`, `authorization_pending`, `slow_down`
  handled; `expired_token` exits `11`, `access_denied` exits `12` — the frozen CLI
  exit-code table in Contracts — each with its own message),
  credential write to `$EF_HOME/credentials.json` (0600). `--no-browser` prints the
  verification URI instead of opening it, so the flow is fully scriptable against the
  emulator's approval endpoint.
- `packages/cli/src/credentials.ts` — load/store/clear for the credentials file, plus
  the bearer-header injection used by every authenticated `ef` command; `ef logout`
  deletes the file.
- Server side (the E2-T03/E2-T04 platform surface, same packages those tasks
  established): `POST /api/cli-tokens` (web session required — a CLI bearer token
  presented here is refused **401** `error.class: 'web-session-required'`, frozen
  here; CLI tokens never mint further CLI tokens; generates the secret,
  dispatches `grant/cli-token-issued` with its hash, returns the secret once),
  `GET /api/cli-tokens` (active grants from the reduced view — never the secrets),
  `DELETE /api/cli-tokens/:grantId` (dispatches `grant/cli-token-revoked`;
  idempotent-safe with frozen refusals: revoking an already-revoked grant is
  **409** `error.class: 'grant-already-revoked'` and revoking an unknown grant is
  **404** `error.class: 'grant-not-found'`, both log-neutral — the identity
  stream's head offset and digest unchanged). Device-flow completion likewise
  dispatches
  `grant/cli-token-issued` (`tokenKind: 'device'`, `tokenHash` = SHA-256 of the
  issued access-token JWT).
- The E2-T03 verifier extension: after signature/session verification, resolve the
  credential against the E2-T01 authorization view; inactive/revoked ⇒
  `{error: {class: 'token-revoked'}}`, 401, nothing appended. The refusal-class table
  in the package README gains the `token-revoked` (401), `grant-already-revoked`
  (409), `grant-not-found` (404), and `web-session-required` (401) rows next to
  E2-T03's existing rows, and the CLI package README reproduces the frozen CLI
  exit-code table from Contracts next to that refusal table.
- Web app: `/settings/cli-tokens` page — list (name, kind, scopes, issuedAt), mint
  form, one-time secret display, revoke button — each action visibly driving the
  dispatch door (the page exposes the identity stream head offset in the DOM, per the
  AGENTS.md browser-gate doctrine).
- Tests (committed, green under `pnpm test`):
  - `packages/cli/test/login.device-flow.test.ts` — full device flow against the
    seeded emulator: pending→approved happy path, `slow_down` compliance per
    RFC 8628 §3.5 (the next poll interval MUST be >= previous interval + 5
    seconds, asserted deterministically with fake timers), expiry (exit `11`),
    denial (exit `12`), credentials-file mode 0600.
  - `packages/platform/test/cli-tokens.test.ts` — server integration tests: mint
    requires a live session (no/expired session ⇒
    E2-T04's typed refusal, **no grant event appended** — before/after head offset +
    digest identical); mint appends exactly one event; revoke appends exactly one
    event; a revoked credential's append attempt returns 401 `token-revoked` with the
    target stream's log untouched by digest; the same credential *before* revocation
    passes the door (exit 0 / 2xx).
  - Secret-hygiene test: after the full happy path, dump every touched stream and
    assert the raw bearer secrets (both kinds) appear in **zero** events.
- `Makefile`: `verify-E2-T05` per E0-T02's per-task contract — replays
  `evidence/e2-t05-identity-golden.jsonl` via `ef replay --digest` and compares
  against the committed digest, then runs the end-to-end transcript script
  (`evidence/e2-t05-transcript.sh`): cold-start servers (seeded emulator, pinned
  clock), scripted device flow, web-session mint via HTTP, authorized append exits 0,
  revocation, identical append refused 401 `token-revoked` (CLI exit `13`),
  `ef logout` (credentials file gone, authenticated command then exits `10` with the
  no-credentials message, and the same command repeated with the platform server
  unreachable — stopped, or `EF_SERVER_URL` at a closed port — exits `10` with the
  identical no-credentials message, proving the refusal is local), secret-hygiene
  grep. Nonzero exit on any step.
- `evidence/` — `e2-t05-identity-golden.jsonl` + `e2-t05-identity-golden.digest`
  (the golden identity-stream log and its replay digest), `e2-t05-transcript.txt`
  (the captured end-to-end run: commands, statuses, offsets, before/after digests),
  `e2-t05-sensitivity.md` (sabotage transcript, see acceptance), and the Replay
  recording URL of the mint-token web interaction cited in the Verification log.

## Acceptance criteria

- [ ] `make verify-E2-T05` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      with scrubbed env — seeded emulator, pinned clock, no warm state.
- [ ] Golden replay: `ef replay evidence/e2-t05-identity-golden.jsonl --digest` prints
      exactly the digest committed in `evidence/e2-t05-identity-golden.digest`, and
      that log contains, in order, a `grant/cli-token-issued` (`tokenKind: 'device'`),
      a `grant/cli-token-issued` (`tokenKind: 'web-mint'`), and a
      `grant/cli-token-revoked` referencing the web-mint `grantId`.
- [ ] Device flow end-to-end: from the transcript, `ef login --no-browser` against
      the emulator completes with exit 0 after scripted approval,
      `$EF_HOME/credentials.json` exists with mode 0600, and an authenticated append
      through an E2-T03 door using that credential exits 0 — with the corresponding
      `grant/cli-token-issued` event present at a named offset in the dumped identity
      stream.
- [ ] Logout: after `ef logout`, `$EF_HOME/credentials.json` does not exist, and a
      subsequent authenticated `ef` command exits with the frozen no-credentials
      code `10` (Contracts table) and the no-credentials message. To prove the
      refusal is local (not a reworded server 401), the transcript includes a step
      that runs that same authenticated command with the platform server unreachable
      (server stopped, or `EF_SERVER_URL` pointed at a closed port) and asserts
      exit code `10` and the identical no-credentials message — no request needed to
      refuse. All of these checks are steps in `evidence/e2-t05-transcript.sh` and
      their output, including the literal exit codes, appears in
      `evidence/e2-t05-transcript.txt`.
- [ ] Poll compliance: the device-flow test proves `authorization_pending` polling at
      the server-stated `interval`, and after `slow_down` the next poll interval is
      **>= the previous interval + 5 seconds** (RFC 8628 §3.5), with before/after
      interval values asserted in the committed
      `packages/cli/test/login.device-flow.test.ts` under fake timers
      (deterministic, no wall-clock sleeps) — that test is the sole evidence for
      `slow_down` compliance; the wall-clock transcript is not required to trigger
      it. Expiry exits with the frozen code `11` and denial with the frozen code
      `12` (Contracts table), each asserted literally in the committed
      `packages/cli/test/login.device-flow.test.ts`, and neither path writes
      credentials.
- [ ] Web mint: `POST /api/cli-tokens` under a valid E2-T04 session returns the
      secret exactly once and appends exactly one `grant/cli-token-issued` event
      (head advances by one offset); `GET /api/cli-tokens` lists the grant without
      the secret; the same POST without a session is refused with E2-T04's typed
      status and the identity stream's head offset and digest are byte-identical
      before and after. Each of these checks is asserted in the committed
      `packages/platform/test/cli-tokens.test.ts`, AND the same checks appear as
      transcript steps with before/after head offsets and digests in
      `evidence/e2-t05-transcript.txt`.
- [ ] Revocation flips the door: an append that succeeded with the minted token
      (exit 0, evidence offset recorded) is repeated byte-identically after
      `DELETE /api/cli-tokens/:grantId` and refused with status **401** and
      `error.class: 'token-revoked'`; the target stream's head offset and
      `ef replay --digest` digest are identical before and after the refused attempt.
      Both attempts, offsets, and digests appear in `evidence/e2-t05-transcript.txt`.
- [ ] Revocation refusals frozen: repeating the identical
      `DELETE /api/cli-tokens/:grantId` after a successful revoke returns **409**
      with `error.class: 'grant-already-revoked'`, and a DELETE for a `grantId`
      that never existed returns **404** with `error.class: 'grant-not-found'`;
      for both, the identity stream's head offset and `ef replay --digest` digest
      are byte-identical before and after the refused call. Both refusals and their
      log-neutrality are asserted in the committed
      `packages/platform/test/cli-tokens.test.ts`, AND the same checks appear as
      transcript steps with before/after head offsets and digests in
      `evidence/e2-t05-transcript.txt`.
- [ ] Secret hygiene: the committed test (and the transcript's grep step) dumps every
      stream touched by the run and finds the raw bearer secrets in zero events; the
      golden log contains `tokenHash` only, never a raw secret.
- [ ] Sensitivity proof: in a scratch worktree, no-op the revocation check in the
      verifier (treat every grant as active) and run the suite — the revoked-token
      tests MUST go red; separately flip one byte of
      `e2-t05-identity-golden.jsonl` and `make verify-E2-T05` MUST go red at the
      digest step. Both red transcripts committed as `evidence/e2-t05-sensitivity.md`.
- [ ] No regression: `make verify-E2-T03` and `make verify-E2-T04` re-run green with
      the verifier extension and new endpoints in place.
- [ ] Replay (browser layer): a Replay recording of the `/settings/cli-tokens`
      interaction — mint (one-time secret shown), list, revoke — cited by URL in the
      Verification log, with zero console errors and the DOM-exposed identity-stream
      head offset advancing across mint and revoke; recorded via
      `tools/replay/record-run.sh -o e2-t05-final` (or the loud
      `Replay: N/A (<reason>) + mitigation` fallback per AGENTS.md).
- [ ] All root gates pass: `pnpm format:check && pnpm lint && pnpm typecheck &&
      pnpm test && pnpm build` exit 0.

## Adversarial verification

The claim under attack: "every CLI credential that opens a door corresponds to an
active grant event, revocation is total and immediate at the door, and no secret ever
touches the log." Use your own tokens, seeds, and streams throughout; invent at least
one angle not listed.

1. **Revocation race and totality.** Mint your own token, use it successfully, revoke
   it, then hammer the door: the identical append, a different stream's append, a
   dispatch, concurrent parallel requests fired the instant the revoke event lands.
   Every one must be 401 `token-revoked` and log-neutral by before/after digest of the
   *target* stream. Any single post-revocation mutation that lands — or any refusal
   that appends so much as a marker event — refutes the task. Then restart the server
   and try again: if revocation only lived in process memory rather than the reduced
   view, the resurrected token refutes "no database, the stream is the truth".
2. **Secret hunt.** Run the full happy path with your own inputs, dump every stream
   (identity, session, registry, target), and grep for both raw secrets, their
   base64/hex variants, and the credentials-file contents. Also read the Replay
   recording's network and console at the mint moment: the secret may appear exactly
   once, in the mint response body — anywhere else (an event payload, a console log, a
   GET /api/cli-tokens response, a URL query string) refutes secret hygiene. Check
   `credentials.json` mode is 0600; a world-readable file refutes the storage claim.
3. **Forgery differential.** Construct near-miss credentials and demand the pinned
   refusal for each: a self-signed JWT with correct claims but a key outside the
   emulator's JWKS (must fail E2-T03's signature check, not reach the grant lookup); a
   valid-signature device token whose `tokenHash` has no `grant/cli-token-issued`
   event (fabricate by deleting the grant in a scratch replay — must refuse); a web-mint
   bearer string differing from the granted one by one byte (hash mismatch ⇒ refuse);
   a token whose grant belongs to a *different* `sub`. Any acceptance, or any refusal
   with the wrong `error.class`/status, refutes the frozen taxonomy row.
4. **Device-flow protocol abuse.** Ignore the builder's tests; drive the emulator
   yourself: poll before approval (must be `authorization_pending`, and the CLI must
   not exit 0), poll with a fabricated `device_code`, reuse a `device_code` after
   successful redemption (must be refused — a second credential from one approval
   refutes single-use), let the code expire, deny at the approval page. Then check
   the ledger: exactly one `grant/cli-token-issued` per *successful* redemption, zero
   grant events for any failed path — before/after identity-stream digests around
   each failure must be identical.
5. **Mint-door authentication.** Attack `POST /api/cli-tokens` and
   `DELETE /api/cli-tokens/:grantId` with no session, an expired/revoked E2-T04
   session, another user's session revoking your grant, and a raw CLI bearer token.
   The rule is frozen by this spec, not delegated to the builder: these endpoints
   are web-session-only, so a CLI bearer presented to either must be refused with
   **401** `error.class: 'web-session-required'` — a CLI token never mints or
   revokes CLI tokens; any acceptance, or a refusal with a different
   status/`error.class`, refutes the frozen taxonomy row. Also double-revoke:
   DELETE the same grant twice (expect the second to be 409
   `grant-already-revoked`) and DELETE a fabricated `grantId` (expect 404
   `grant-not-found`). Every refusal typed, every refusal log-neutral by digest.
6. **Sabotage, your mutations not theirs.** Beyond re-running the committed
   sensitivity proof: (a) make the verifier skip the grant lookup for
   `tokenKind: 'web-mint'` only, (b) make `DELETE` return 200 without dispatching the
   revoke event, (c) store the raw secret instead of its hash in the issued event.
   Run `make verify-E2-T05` and the test suite after each; any mutation that stays
   green refutes the measuring apparatus for that path.
7. **Cold-clone + golden replay yourself.** Run everything through
   `tools/verify/cold_clone.sh`. Replay the golden log independently and compare the
   digest; digest-bisect any divergence to its offset. Regenerate the transcript with
   a *different* emulator seed: event payload randomness (grantIds, tokenHashes) may
   differ,
   but the same event sequence and the same door behavior must hold — a transcript
   that only passes under the builder's exact seed refutes determinism-by-design.
   Interrogate the cited Replay recording: the mint click, the dispatch on the
   network, the DOM head offset advancing — a recording that doesn't contain the
   claimed interaction fails the claim immediately.

Refutation currency: an offset where a post-revocation mutation landed, an HTTP
transcript with the wrong status/class, a grep hit of a raw secret in a dump, or a
digest pair that should match and doesn't. "The poll felt slow" is a note, not a
finding.

## Verification log

### 2026-07-18 — builder — verification run 1 claim

- Sealed implementation/evidence head: `f9bbdd7447331044e06e8093cb75cddc214807cd`
  (pinned `vendor/emulate` gitlink `82eb835947c97fcf6e0596a4377acbb01ca13ede`).
- Exact gate: `CI=true make verify-E2-T05` — PASS from the top after the proof-spine
  fixes, with format/lint/typecheck/build clean, 22 root test files / 278 tests, the
  focused E2-T05 suite (3 files / 7 tests), `E2_T05_TRANSCRIPT_OK`,
  `E2_T05_BROWSER_OK`, `E2_T05_MP4_VERIFIED`, `E2_T05_EVIDENCE_OK`, inherited
  `verify-E2-T03: OK`, inherited `verify-E2-T04: OK`, and final
  `verify-E2-T05: OK`. The composed run exposed and fixed E2-T04's ordering-sensitive
  network evidence by freezing its observed endpoint/status set; two focused browser
  runs and the composed gate then reproduced the same committed evidence.
- Cold clone: `tools/verify/cold_clone.sh --keep verify-E2-T05` — PASS from exact head
  `f9bbdd7447331044e06e8093cb75cddc214807cd` at
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.9YXdwnfTM7`, with scrubbed
  environment, offline lockfile hydration, pinned submodule checkout, and the registered
  success marker. An earlier exact-head attempt failed before tests because E2-T05 was
  absent from `tools/verify/cold_clone_targets.txt`; the target was registered, the full
  local gauntlet was restarted, and the pristine-clone proof was re-earned.
- Stream evidence: `evidence/e2-t05-identity-golden.jsonl` independently reduces to
  `eef1711cbba22711fa04d242597fd8fd0c95caa1311a59d1d24dd5ba897dbfa7`;
  `evidence/e2-t05-transcript.txt` records device approval, web mint, active use,
  revocation, immediate typed/log-neutral refusal, double/unknown revoke refusal,
  secret hygiene, credentials mode, and local no-credential refusal. Golden SHA-256 is
  `ece632d11b34f8cccd241c146c9292af966bf0ec57a3187f5535d400a4c7adaa`;
  transcript SHA-256 is
  `3d0a72cdf575b1d206a4bd01a5163931f74b32b06916844901970d66c57cd22f`.
- Sensitivity: `evidence/e2-t05-sensitivity.md` records a verifier mutation that made the
  revoked append return 202 instead of 401, and a one-byte golden mutation whose digest
  became `4b8f1deaf8fbc2e95876c944aad801d6f259a7130a6f7233618aa9b446fc3f19`;
  both measuring paths went red as required.
- Browser evidence: the final `/settings/cli-tokens` walkthrough advanced the DOM identity
  head from offset `...0375` to `...0771` on mint and `...0961` on revoke, exposed the
  secret once, listed no secret, and recorded zero console errors/warnings/exceptions.
  The same session produced `recordings/e2-t05-final.mp4` (2.000 s, SHA-256
  `5fdb7aa63c4d6d1712451868be37a5754a37d0dd2e64e5e51f700a17ccd02207`)
  and `evidence/e2-t05-playwright-trace.zip` (SHA-256
  `c2a6de48bf1e946999ac4beffd10289b7be59d04930bb8b95baf80b66a1c378e`),
  bound by `evidence/e2-t05-browser-artifacts.json` with `capturedTogether: true`.
- Replay: N/A (tenant policy denied external Replay upload) + mitigation: the committed
  same-session Playwright trace, locally verified MP4, deterministic stream log/digest,
  exact HTTP transcript, OS loopback network guard, and exact-head cold-clone run cover
  the browser and stream claims without claiming an unavailable Replay URL.
- Claim: every accepted device or web-mint CLI bearer resolves to an active identity-stream
  grant; revocation is immediately enforced at the shared gateway door and remains true
  on replay; refused mutations are typed and log-neutral; raw credentials never enter an
  event; and the web session can mint/list/revoke without exposing stored secrets.

### 2026-07-18 — critics — VERDICT: refuted

- P1 revocation race/totality — FAILED. Predicted that once the revoke event committed,
  an already-started dispatch could not append afterward. A barrier-controlled request
  stalled its body after `GrantAwareVerifier` observed the active grant; the critic then
  committed revocation and released the body. Observed revoke offset `...0674`, grant
  status `revoked`, followed by HTTP 202 and one target event by `race-user`.
  `packages/platform/src/gateway.ts:69-100` authorizes once and appends later without an
  atomic recheck. Demand: serialize revocation against authorization-plus-append or make
  the grant check atomic at the mutation commit boundary; add a deterministic concurrent
  regression test and a restart-after-revoke proof.
- P1 forgery differential — FAILED. Predicted an unknown/self-signed JWT-shaped bearer
  would fail E2-T03 signature verification before grant lookup. Observed
  `TokenRevokedError`, `token-revoked`, and zero bearer-verifier calls because
  `packages/platform/src/auth/grants.ts:38-47` hashes and resolves the grant before
  signature verification. Demand: verify JWT-shaped device credentials first, bind the
  verified subject to its active grant, preserve opaque web-mint handling, and freeze the
  exact taxonomy in a permanent test.
- P1 frozen CLI exit 13 — INSUFFICIENT. `runAuthenticatedDispatch` contains the return
  path, but no committed test asserts literal exit 13 and the transcript performs the
  post-revoke attempt with raw `fetch`. Demand: perform the accepted and identical
  revoked attempts through `ef dispatch`, assert exits 0 and 13, and freeze them in the
  deterministic transcript.
- Coverage needing evidence: the concurrent and restart revocation paths, forged/unknown
  device-JWT taxonomy, default browser-opening `ef login`, and production runtime
  composition. The sequential identity/grant lifecycle, web endpoints and page, device
  polling, credentials mode, local exit 10, stream replay, secret hygiene, and inherited
  regressions remain exercised. The committed verifier sensitivity proves only the
  sequential path and does not cover the authorization-to-append interval.
- Artifact integrity — PASSED but does not cure the refutations. Both critics independently
  reproduced digest
  `eef1711cbba22711fa04d242597fd8fd0c95caa1311a59d1d24dd5ba897dbfa7`;
  the golden/transcript/trace/MP4 hashes match; the trace contains the web-mint secret only
  in the POST response and nowhere in GET bodies, URLs, or console; the retained exact-head
  cold clone is clean and pins the claimed submodule; Replay N/A wording is correct.
- Commands: focused committed suite — 3 files / 7 tests PASS; independent `ef replay`
  digest — PASS; barrier race probe — FAILED with post-revoke 202/append; forgery-order
  probe — FAILED with `bearerCalls: 0`. SUITE: retain existing artifacts and tests, add
  the three demanded regressions, re-record, and resubmit from the top.

### 2026-07-18 — builder — verification run 2 rework claim

- Sealed rework/evidence head: `2ab8b45b6cd325e24c413ebee8a3e1af6c908a37`
  (`faae737` closes the authorization-to-append race and restores signature-first JWT
  classification; `afdf6b2` records independent sensitivity; `2ab8b45` seals the
  regenerated transcript, trace, and artifact manifest).
- Exact sealed-head gate: `CI=true make verify-E2-T05` — PASS from the top with clean
  format/lint/typecheck/build, 22 root test files / 284 tests, the focused E2-T05 suite
  (3 files / 13 tests), emulator suites (61 + 6 tests), `E2_T05_TRANSCRIPT_OK`,
  `E2_T05_BROWSER_OK`, `E2_T05_MP4_VERIFIED`, `E2_T05_EVIDENCE_OK`, inherited
  `verify-E2-T03: OK`, inherited `verify-E2-T04: OK`, and final `verify-E2-T05: OK`.
- Cold clone: `tools/verify/cold_clone.sh --keep verify-E2-T05` — PASS from exact head
  `2ab8b45b6cd325e24c413ebee8a3e1af6c908a37` at
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.zrDKIt0dTc`, with scrubbed
  environment, lockfile/store-only hydration, pinned submodule checkout, and the
  registered success marker.
- Refutation closure: the gateway performs its preliminary E2-T03 authentication before
  body parsing, then rechecks the grant and holds the identity-store grant serialization
  boundary through append. A deterministic stalled-body test now commits revocation while
  the request body is blocked, releases it, and proves HTTP 401 with no append; a second
  barrier test proves an append already inside the boundary orders before revocation and
  that a restarted identity view refuses afterward. JWT-shaped device bearers now run
  signature verification before grant lookup, with exact `invalid_signature` and
  `malformed_token` taxonomy and zero identity events for forgeries; opaque web-mint
  tokens retain hash-based grant resolution.
- CLI/browser coverage: the deterministic transcript executes the real `ef dispatch`
  path before and after revocation and freezes exits `0` and `13`; committed tests also
  exercise the default `verification_uri_complete` browser-open path and production
  runtime verifier composition. The browser walkthrough still proves mint/list/revoke,
  one-time secret exposure, DOM offsets/digests, and zero console errors, warnings, or
  uncaught exceptions.
- Stream evidence: the golden independently reduces to
  `eef1711cbba22711fa04d242597fd8fd0c95caa1311a59d1d24dd5ba897dbfa7`.
  SHA-256: golden
  `ece632d11b34f8cccd241c146c9292af966bf0ec57a3187f5535d400a4c7adaa`;
  transcript `7468d45ef24268458be486ff495188fe3fcbd8761ee277d618e327a75fd269f6`;
  sensitivity `903603c63738fd21fe36dd4cb28d939022a2cc080fac722aac3bf3b1c21e3a3f`.
- Sensitivity: bypassing the post-body serialized authorization boundary makes the
  stalled-body regression fail with 202 instead of 401; moving grant lookup before JWT
  verification makes both forged-token taxonomy checks fail. The one-byte golden
  corruption remains a red digest proof.
- Browser artifacts: `evidence/e2-t05-playwright-trace.zip` SHA-256
  `f4616290f2740ea272bb77c422600a7ffe04a0f2baa6f8b6a898edb9e205280e` and the
  same-session `recordings/e2-t05-final.mp4` (1.800 s, 30,291 bytes) SHA-256
  `c3fd46cb97d58235e63cde0c24865a1034dfdeeda468e172417ff9b79b34bf5d`, bound by
  `evidence/e2-t05-browser-artifacts.json` with `capturedTogether: true`.
- Replay: N/A (tenant policy denied external Replay upload) + mitigation: the committed
  same-session Playwright trace, locally verified MP4, deterministic stream log/digest,
  exact CLI/HTTP transcript, OS loopback network guard, race/forgery sensitivity proofs,
  and exact-head cold-clone run cover the browser and stream claims without claiming an
  unavailable Replay URL.
- Claim: every accepted CLI bearer is both cryptographically classified and backed by an
  active identity-stream grant at the mutation commit boundary; after revocation commits,
  no later mutation can land with that grant, including an already-started stalled-body
  request; restart preserves refusal; forged JWTs cannot exploit grant-state oracles; and
  the documented CLI, stream, and browser evidence exercises every refuted path.

### 2026-07-18 — critics — VERDICT: refuted (verification run 2)

- P1 cross-runtime revocation totality — FAILED. Predicted that after the shared identity
  stream committed `critic-grant` as revoked, no later mutation could land with that grant.
  A barrier probe used two independent `IdentityStore` instances over one durable identity
  stream: runtime A entered an authorized append, runtime B committed revocation, then A
  was released. Observed revoke offset `...0856`, reduced status `revoked`, HTTP 202, and
  one target event by `critic-user` after the revoke. The lock in
  `packages/platform/src/auth/provision.ts` is instance-local, so the serialization in
  `packages/platform/src/auth/grants.ts` does not cross runtime boundaries. Demand: order
  authorization-plus-append against revocation at a shared durable commit boundary and
  promote this two-runtime interleaving as a permanent deterministic regression and
  sensitivity proof.
- Revoke-side sensitivity — INSUFFICIENT. Removing `withGrantSerialization` from
  `revokeCliGrant` in scratch still left the committed in-flight ordering test green
  because its one-microtask yield did not prove the revoke had attempted entry. A critic
  scheduler delay made the mutation red and the restored implementation green, showing
  that the apparatus needs an explicit revoke-entered barrier/hook. Demand: make the
  ordering test deterministic and commit the lock-removal red transcript.
- Prior refutation closure — PASSED but does not cure the cross-runtime failure. The exact
  single-runtime stalled-body interleaving returns 401 with no append; an append already
  inside that instance's boundary orders before revoke; restart refuses; JWT-shaped
  forgeries are signature-first with exact taxonomy; opaque web-mint still resolves;
  production composition and default browser opening execute; the transcript records
  real `ef dispatch` exits 0 then 13.
- Artifact integrity — PASSED. Independent replay reproduced
  `eef1711cbba22711fa04d242597fd8fd0c95caa1311a59d1d24dd5ba897dbfa7`;
  transcript, trace, MP4, manifest, and sensitivity hashes match; the trace exposes the
  minted token only in the mint response/visible DOM and not in GET bodies, URLs, or
  console; the retained exact-head cold clone is clean; Replay N/A wording is exact.
- Commands: focused suite — 3 files / 13 tests PASS; independent replay digest — PASS;
  two-runtime shared-stream barrier — FAILED with post-revoke 202/append; revoke-lock
  scratch sabotage — committed test stayed green until strengthened. SUITE: retain the
  run-2 artifacts and prior regression tests, add shared-boundary ordering, deterministic
  revoke-entry coordination, and corresponding sensitivity before resubmission.

### 2026-07-18 — builder — verification run 3 cross-runtime rework claim

- Sealed rework/evidence head: `c4b6e5a5a1be623cbe2de320d3695d697c8d63e9`
  (`5787b19` introduces the shared durable operation boundary, `535bef2` removes the
  obsolete process-local correctness lock and strengthens the race sensor, and `c4b6e5a`
  seals regenerated evidence).
- Durable ordering: an accepted mutation commits
  `identity.grant.operation.started { operationId, grantId }` on the identity stream
  before target append and commits the matching `identity.grant.operation.completed`
  afterward. The reducer refuses `identity.grant.revoked` while a matching operation is
  active; the revoker retries from the new head. Stream-Seq therefore gives operation
  start versus revoke one shared winner across independent runtimes: start-first forces
  target append and completion before revoke can commit, while revoke-first makes start
  fail as revoked. No process-local mutex participates in correctness.
- Exact sealed-head gate: `CI=true make verify-E2-T05` — PASS from the top with clean
  format/lint/typecheck/build, 22 root files / 284 tests, focused E2-T05 3 files / 13
  tests, emulator suites 61 + 6, deterministic transcript, browser trace/MP4 validation,
  inherited `verify-E2-T03: OK`, inherited `verify-E2-T04: OK`, and final
  `verify-E2-T05: OK`.
- Cold clone: `tools/verify/cold_clone.sh --keep verify-E2-T05` — PASS from exact head
  `c4b6e5a5a1be623cbe2de320d3695d697c8d63e9` at
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.FEuFe3YGMV`, with scrubbed
  environment, lockfile/store-only hydration, pinned submodule, registered marker, and
  zero skips.
- Cross-runtime proof: the permanent test uses two `IdentityStore` instances on one
  durable identity stream. Runtime A durably starts an operation and stalls target append;
  runtime B attempts revoke. An explicit hook races against successful revoke completion
  and must report `blocked`; reduced state proves one active operation. Releasing A yields
  the exact identity order started → completed → revoked, one target event, and restart
  refusal. The stalled-body revoke-first path still returns 401 with no target event.
- Sensitivity: deleting only the reducer's active-operation revoke guard in detached
  scratch makes the race report `committed` instead of `blocked` in 159 ms; restored code
  passes the identical probe. This supersedes the run-2 timer-sensitive local-lock sensor.
  The prior post-body, forgery-order, sequential-revocation, and one-byte golden mutations
  remain recorded. Sensitivity SHA-256:
  `9410421808f450126de3248ad21fca80be12209003ac0900717a8853e624e9a5`.
- Stream/CLI evidence: the legacy golden remains byte-compatible and independently reduces
  to `eef1711cbba22711fa04d242597fd8fd0c95caa1311a59d1d24dd5ba897dbfa7`
  (golden SHA-256
  `ece632d11b34f8cccd241c146c9292af966bf0ec57a3187f5535d400a4c7adaa`).
  The regenerated deterministic transcript includes durable operation events, real
  `ef dispatch` exits 0 then 13, log-neutral typed refusal, and secret hygiene; SHA-256
  `e3dc915ae3604c861fc8dac29a40caa2d16bcf87074e3edd1f9756ca463ca6a4`.
- Browser artifacts: `evidence/e2-t05-playwright-trace.zip` SHA-256
  `f2f30c759c143773376f1621a6933cf9b167995ab41fe2f30efa7b374fe0dba8` and the
  same-session `recordings/e2-t05-final.mp4` (2.120 s, 30,619 bytes) SHA-256
  `5f7a3bf73cf5815c46c5f5a76a284daceeaf7770f020702e4b7569258c1bcada`, bound by
  `evidence/e2-t05-browser-artifacts.json` with `capturedTogether: true`; zero console
  errors/warnings/exceptions and all 52 observed network requests loopback-only.
- Replay: N/A (tenant policy denied external Replay upload) + mitigation: the committed
  same-session Playwright trace, locally verified MP4, deterministic stream log/digest,
  exact CLI/HTTP transcript, OS loopback network guard, explicit two-runtime durable race
  and sensitivity proofs, and exact-head cold clone cover the claims without asserting an
  unavailable Replay URL.
- Claim: the identical CLI bearer cannot append after its revoke event in one runtime or
  across independent runtimes sharing the stream; the ordering is replayable identity
  state, not memory. Signature-first forgery taxonomy, opaque-token handling, restart,
  CLI exits, secret hygiene, and browser mint/list/revoke remain covered end to end.

### 2026-07-18 — critics — VERDICT: refuted (verification run 3)

- P1 orphaned durable operation — FAILED. Predicted a restarted runtime could still
  revoke after its predecessor died between `identity.grant.operation.started` and
  `.completed`. A fresh probe durably started `orphaned-operation`, discarded that
  runtime, and attempted revoke from a new `IdentityStore`; the explicit blocked hook
  fired and the revoke could never commit. The only completion path is the old process's
  `finally`; reducer state has no abort/recovery/lease, and the revoker retries forever.
  Demand: make pending operations crash-recoverable without permitting a paused/fenced
  writer to append after revoke, then commit an orphan-restart regression and sensitivity
  proof.
- P1 simultaneous revokes — FAILED. Two DELETE-equivalent requests observed the same
  active grant, blocked behind one durable operation, then raced after completion.
  Observed one success and one rejected handler promise carrying
  `IdentityDispatchRefusedError: identity/grant-revoked`, rather than frozen responses
  `[200, 409 grant-already-revoked]`. Demand: map the dispatch-time losing race to the
  existing typed 409 response and promote a deterministic two-request regression proving
  exactly one revoke event and no rejected promise.
- Shared ordering — PASSED for live runtimes. Independent probes proved start-first
  yields started → completed → revoked, revoke-first rejects operation start, two active
  operations keep revoke blocked until both complete, failed target append closes its
  operation and permits revoke, restart refuses the revoked bearer, and opaque/JWT
  classification remains correct. Guard-removal sensitivity went red in 254 ms with
  `committed` instead of `blocked`; restored code passed.
- Artifacts/gates — PASSED. Root 22 files / 284 tests and focused 3 files / 13 tests pass;
  golden/transcript/sensitivity/trace/MP4 hashes match; transcript proves real CLI exits
  0/13 and log neutrality; trace secret handling, loopback-only network, and zero console
  faults pass; retained exact-head cold clone is clean; Replay N/A wording is exact.
- Coverage demand: add crash recovery/fencing and concurrent HTTP revoke coverage; add
  focused malformed-schema checks for the new operation event validators while promoting
  the permanent suite. This is failed verification run 3, so `.eforest/loop.md` requires
  a fresh three-run progress audit before any fourth builder run.

### 2026-07-18 — progress critic — RUNS 1-3: progressing

- Rationale: Findings genuinely narrowed from single-runtime authorization ordering and
  taxonomy gaps, through cross-runtime ordering, to deeper crash-recovery and
  simultaneous-revoke composition. Earlier surviving behavior remained green, while
  permanent regression and sensitivity coverage compounded without weakened gates.
- Run 1: `f9bbdd7` established the end-to-end CLI/web/stream proof; critics isolated
  single-runtime TOCTOU, signature ordering, and missing literal exit-13 coverage. Run 2's
  13 focused tests and `evidence/e2-t05-sensitivity.md` closed each finding.
- Run 2: `2ab8b45` preserved run-1 behavior and fixed stalled-body, restart, forgery
  taxonomy, and real CLI exits 0/13; critics advanced to an independent-runtime
  counterexample and exposed a timer-sensitive revoke sensor.
- Run 3: `c4b6e5a` promoted shared-stream ordering plus deterministic guard-removal
  sensitivity; critics confirmed live-runtime start-first/revoke-first,
  multiple-active-operation, failed-append cleanup, restart refusal, and prior taxonomy
  behavior. Remaining failures are narrower: orphan recovery/fencing and concurrent-revoke
  response mapping.
- Next focus: make durable operations crash-recoverable with fencing, map the losing
  simultaneous revoke to typed 409 without a rejected promise, and add orphan-restart,
  concurrent HTTP revoke, and malformed operation-event schema regressions.
- Assessment: progressing

### 2026-07-18 — builder — verification run 4 claim

- Sealed implementation/evidence head: `fd9c1ec84347c8ed8148632485ec32c914f003b7`
  (`32a35b0` implements crash recovery and typed concurrent-revoke composition;
  `fd9c1ec` seals the new sensitivity proof).
- Crash-recoverable boundary: `identity.grant.operation.started` now freezes the target
  stream and fully actor-stamped event. Both the original runtime and a revoker recovering
  an orphan append through the official Durable Streams producer tuple
  `(operationId, epoch 0, sequence 0)`. The revoker completes every recovered operation
  before retrying revoke. A runtime crash before target append, after target append, or a
  late original-runtime resume therefore produces exactly one target event and cannot
  leave the grant permanently in use.
- Permanent attacks: `packages/platform/test/cli-tokens.test.ts` uses the official server
  to cover both crash points in one run, then replays the original producer tuple after
  recovery and observes no duplicate. The cross-runtime live-operation test routes recovery
  through the same target adapter. Two simultaneous HTTP DELETEs resolve—not reject—as one
  200 and one frozen `409 grant-already-revoked`, with exactly one revoke event. Four
  malformed recovery-plan shapes are rejected by the identity schema suite.
- Sensitivity: in a disposable worktree at `32a35b0`, changing only the revoker's recovered
  `Producer-Seq` from `0` to `1` makes the orphan test fail against the official server with
  `409 Producer sequence gap`; the identical untouched probe passes. Evidence SHA-256:
  `83af7784e096f121ae0475231d53e08f4b4788e7c120fbcf3f7dab7183fab0af`.
- Exact gate: `CI=true make verify-E2-T05` — PASS from the top after every implementation
  change: format/lint/typecheck/build, 22 root files / 287 tests, focused E2-T05 3 files /
  15 tests, deterministic transcript, browser/MP4 evidence, inherited `verify-E2-T03: OK`,
  isolated inherited `verify-E2-T04: OK`, and final `verify-E2-T05: OK`.
- Cold clone: `tools/verify/cold_clone.sh --keep verify-E2-T05` — PASS from exact head
  `fd9c1ec84347c8ed8148632485ec32c914f003b7` at
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.zRbrDh5Xcs`, with scrubbed
  environment, lockfile/store-only hydration, pinned submodule, registered marker, and
  zero skips.
- Stream/CLI evidence: golden replay remains byte-compatible at digest
  `eef1711cbba22711fa04d242597fd8fd0c95caa1311a59d1d24dd5ba897dbfa7`
  (golden SHA-256 `ece632d11b34f8cccd241c146c9292af966bf0ec57a3187f5535d400a4c7adaa`).
  The refreshed deterministic transcript includes the frozen recovery plans, real CLI
  exits 0/13, log-neutral refusal, and secret hygiene; SHA-256
  `fd0de2d2c76f756600951580da7130c4a678a2032756b4edc686f54b19d4a0a8`.
- Inherited evidence isolation: `_v-e2-t04-browser` now resets its process-network sensor
  immediately before the recorded browser proof, so its committed guard contains only the
  run under claim rather than unrelated preceding root-suite traffic. The isolated guard
  is independently stable at SHA-256
  `6d0500a495105a955ad13ffc816c8cbbba0b5458c3f74d624ee79161c811ebf3`.
- Browser artifacts: the browser-reaching UI behavior is unchanged and was re-earned by
  the exact gate. The committed Playwright trace SHA-256 remains
  `f2f30c759c143773376f1621a6933cf9b167995ab41fe2f30efa7b374fe0dba8`;
  same-session `recordings/e2-t05-final.mp4` is 2.120 seconds / 30,619 bytes at SHA-256
  `5f7a3bf73cf5815c46c5f5a76a284daceeaf7770f020702e4b7569258c1bcada`.
- Replay: N/A (tenant policy denied external Replay upload) + mitigation: the committed
  same-session Playwright trace, locally verified MP4, deterministic stream log/digest,
  exact CLI/HTTP transcript, OS loopback network guard, official-server crash/recovery and
  concurrent-revoke tests, sensitivity proof, and exact-head cold clone cover the claims
  without asserting an unavailable Replay URL.
- Claim: every authorized target mutation is now a recoverable exactly-once plan on the
  identity stream. Revocation remains total across independent runtimes and both process
  crash windows, late resumption cannot duplicate the target event, and simultaneous web
  revokes preserve the frozen typed response contract without an unhandled rejection.

### 2026-07-18 — critic — VERDICT: refuted

- P1 unavailable recovery target — FAILED. Predicted a process crash before the target
  append could not leave a grant permanently active. An independent probe durably wrote a
  valid `identity.grant.operation.started` plan for a nonexistent stream, restarted the
  identity store, and attempted revocation. Recovery returned official-server `404 Stream
  not found`; the grant and operation both remained `active`, with the identity log ending
  at `identity.grant.operation.started`. `revokeCliGrant` awaits every recovery before it
  can retry, while `recoverGrantOperation` completes only after a successful append
  (`packages/platform/src/auth/provision.ts`).
- Coverage — INSUFFICIENT. The submitted orphan regression pre-creates both target streams
  (`packages/platform/test/cli-tokens.test.ts`), so it proves producer idempotency before
  and after an append but cannot falsify a missing/deleted target. Add a permanent official
  server regression for that terminal failure, proving revocation completes and a late
  original runtime remains fenced from appending.
- Surviving evidence — PASSED. Independent focused execution passed 23/23 identity,
  platform, and CLI tests. The retained exact-head cold clone is clean at `fd9c1ec`; the
  producer-sequence and concurrent-409 sabotages go red; golden digest
  `eef1711cbba22711fa04d242597fd8fd0c95caa1311a59d1d24dd5ba897dbfa7`,
  transcript, trace, network guard, and MP4 hashes match the claim. These results preserve
  run 4's idempotent happy-path recovery, schema validation, and typed concurrent-revoke
  gains but do not cure the unavailable-target counterexample.
- Demand: define a durable terminal abort/failure outcome for a frozen plan whose target
  cannot accept it, close that operation without allowing it to commit later, revoke the
  grant, and prove the behavior plus sensitivity from the official server. This is failed
  verification run 4; the runs 1-3 progress audit authorizes run 5.

### 2026-07-18 — builder — verification run 5 claim

- Sealed implementation/evidence head: `a373322bda11ff13382ae05f0047224232e0a2e0`
  (`19f94f3` implements the terminal abort and late-runtime fence; `a373322` seals the
  sensitivity proof).
- Durable terminal outcome: an official target 404 now commits
  `identity.grant.operation.aborted` with frozen reason `target-unavailable`. The reducer
  closes that operation without treating the target event as successful, after which the
  same revoker commits `identity.grant.revoked`. Non-404 transport failures remain active
  and retryable rather than being discarded.
- Late-runtime fence: the original authorized runtime receives an operation-status fence
  which the gateway checks immediately before the target append. An aborted operation maps
  to the frozen `401 token-revoked` path; idempotent terminal handling prevents its finalizer
  from overwriting the abort. A target deleted during the operation may be recreated after
  revocation without admitting the late original event.
- Permanent official-server attacks: `packages/platform/test/cli-tokens.test.ts` proves a
  never-created target produces `started -> aborted -> revoked`, and separately deletes a
  real target after an original runtime enters its mutation, revokes from a restarted
  identity store, recreates the target, releases the late runtime, and observes an empty
  target. The prior before/after-append orphan recovery remains exact-once. Identity schema
  and reducer tests freeze the abort payload, terminal state, reason, and refusal to complete
  an aborted operation.
- Sensitivity: in a disposable worktree at `19f94f3`, replacing only the unavailable-target
  abort with a completed outcome makes both new official-server tests red at their exact
  `completed` versus `aborted` assertions; the identical sealed control passes 2/2. Evidence
  SHA-256: `58aa20e389e38004f9f64ae784386677e7ab7bcb0ea230bf01c1a4f41438a109`.
- Exact gate: `CI=true make verify-E2-T05` — PASS from the top after every implementation
  change: format/lint/typecheck/build, 22 root files / 290 tests, focused E2-T05 3 files /
  17 tests, deterministic transcript, browser/MP4 evidence, inherited `verify-E2-T03: OK`,
  inherited `verify-E2-T04: OK`, and final `verify-E2-T05: OK`.
- Cold clone: `tools/verify/cold_clone.sh --keep verify-E2-T05` — PASS from exact head
  `a373322bda11ff13382ae05f0047224232e0a2e0` at
  `/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/tmp.aPzrUbReqo`, with scrubbed
  environment, lockfile/store-only hydration, pinned submodule, registered marker, and zero
  skips.
- Stream/CLI evidence: golden replay remains byte-compatible at digest
  `eef1711cbba22711fa04d242597fd8fd0c95caa1311a59d1d24dd5ba897dbfa7`
  (golden SHA-256 `ece632d11b34f8cccd241c146c9292af966bf0ec57a3187f5535d400a4c7adaa`).
  The deterministic transcript still proves CLI exits 0/13, log-neutral refusal, and secret
  hygiene; SHA-256 `fd0de2d2c76f756600951580da7130c4a678a2032756b4edc686f54b19d4a0a8`.
- Browser artifacts: the browser-reaching UI behavior is unchanged and was re-earned by the
  exact gate. The committed Playwright trace SHA-256 remains
  `f2f30c759c143773376f1621a6933cf9b167995ab41fe2f30efa7b374fe0dba8`;
  same-session `recordings/e2-t05-final.mp4` is 2.120 seconds / 30,619 bytes at SHA-256
  `5f7a3bf73cf5815c46c5f5a76a284daceeaf7770f020702e4b7569258c1bcada`.
- Replay: N/A (tenant policy denied external Replay upload) + mitigation: the committed
  same-session Playwright trace, locally verified MP4, deterministic stream log/digest,
  exact CLI/HTTP transcript, OS loopback network guard, official-server missing/deleted
  target tests, exact-once recovery tests, sensitivity proof, and exact-head cold clone
  cover the claims without asserting an unavailable Replay URL.
- Claim: an unavailable frozen target can no longer pin a credential active forever. Its
  operation ends in an explicit auditable abort, revocation completes across a restart, and
  the already-authorized original runtime remains fenced even if the deleted target name is
  later recreated, while successful target recovery preserves exact-once semantics.

### 2026-07-18 — critic — VERDICT: refuted (verification run 5)

- P1 late-writer TOCTOU — FAILED. Predicted an aborted and revoked operation could not
  append to a recreated target. A deterministic official-server probe paused the original
  runtime after `assertActive()` passed but before target append; recovery then observed
  404, committed `identity.grant.operation.aborted` followed by
  `identity.grant.revoked`, recreated the target, and released the original writer. The
  append succeeded after revocation. `packages/platform/src/auth/grants.ts:93-100` and
  `packages/platform/src/gateway.ts:110-111` separate the snapshot-only active check from
  the target commit. The committed regression pauses before the check at
  `packages/platform/test/cli-tokens.test.ts:593-597`, so it does not cover this window.
- P1 live-target 404 ledger — FAILED. A live target append's 404 is converted to a 502
  response by `packages/platform/src/gateway.ts:106-116`; the verifier's `finally` then
  records `identity.grant.operation.completed`. Only revoker recovery classifies 404 as
  aborted in `packages/platform/src/auth/provision.ts:321-337`. The identity ledger can
  therefore claim completion even though no target event landed.
- Surviving evidence — PASSED but insufficient. The run-5 exact gate, exact-head cold
  clone, terminal-abort schema/reducer tests, official missing-target recovery, artifact
  hashes, and 2/2 completed-versus-aborted sensitivity result remain valid. The fresh
  critic's disposable probe passed 1/1 with 11 skipped because its assertions reproduced
  the unsafe post-revocation append; the worktree was removed and the builder tip remained
  untouched.
- Demand: make the abort/revoke fence atomic with the target append commit boundary (or an
  equivalent durable epoch/conditional-write protocol), classify live target-unavailable
  failures consistently, and promote a permanent regression that pauses after the active
  check plus fence-removal sensitivity. This is failed verification run 5; the runs 1-3
  progress audit authorizes run 6.
