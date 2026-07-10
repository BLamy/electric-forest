---
id: E2-T03
epic: 2
title: Bearer-token verification at every mutating door — unauthenticated and forged stream ops refused with typed 401s, log untouched
priority: 203
status: pending
depends_on: [E2-T02]
estimate: M
capstone: false
---

## Goal

When `packages/stream-server` is started with auth enabled (`EF_AUTH_ISSUER` +
`EF_AUTH_AUDIENCE` set — start-time configuration, never mutable at runtime), every
mutating door — `PUT /streams/:id` (create), `POST /streams/:id` (raw append), and
`POST /streams/:id/dispatch` — requires an `Authorization: Bearer <jwt>` header whose
token verifies against the E2-T02 OIDC emulator's published JWKS
(`/.well-known/jwks.json`, discovered via `/.well-known/openid-configuration`) and
resolves to a non-empty Auth0 subject (`sub` claim). A request that fails any check is
refused with HTTP **401**, a `WWW-Authenticate: Bearer` response header, and the typed
error body `{ error: { class: 'unauthorized', reason } }` — the `unauthorized` class is
the one E0-T11's frozen taxonomy explicitly reserved a seat for ("Epic 2 will add an
`unauthorized` class beside them, not restructure them"), and it maps to exactly one
status code, 401, in the package README's class→code table. The `reason` values are a
refusal table **frozen here**: `missing-token`, `malformed-token`, `bad-algorithm`,
`bad-signature`, `token-expired`, `wrong-issuer`, `wrong-audience`, `unknown-key`,
`missing-subject` — one reason per failure mode, enumerated in the Deliverables. Every
refusal is log-neutral in E0-T05/E0-T11's sense: head offset, event count, and
`ef replay --digest` digest are byte-identical before and after, and no live tailer
(E0-T06 long-poll/SSE) observes any frame. The auth check runs **before** every other
stage at each door — a tokenless request with a garbage body is 401, never 400/422 —
and a verified request carries its resolved subject into the request context
(`{ sub: string }`), reaching E0-T11's `ActionValidator` context as an additive
optional `auth` field so E2-T07/E2-T09 can consume it without re-verifying. Read doors
(`GET /streams/:id`, `/events`, `/state`, long-poll, SSE) remain ungated in this task —
per-stream read authorization is E2-T07's job, and that boundary is pinned in the
README so its absence here is a documented decision, not a hole. With auth **disabled**
(the env vars unset), the server behaves exactly as E0/E1 froze it — every prior verify
target and golden transcript stays green unmodified.

## Context

Epic 2 is the-gates, and this task is the gate mechanism itself: the first moment an
electric-forest server refuses a mutation because of *who is asking* (or rather, who
failed to prove they're asking). E2-T02 delivered a deterministic local Auth0 stand-in
that can mint real RS256 JWTs and publish the JWKS to verify them; this task makes the
stream server's three mutating doors demand one. Everything downstream leans on it:
E2-T04's web sessions and E2-T05's CLI tokens are only meaningful if a missing token is
actually refused; E2-T07's per-stream authorization assumes a verified subject is
already sitting in the request context; E2-T09 scopes `Stream-Seq` fencing per writer
identity — the identity this task resolves; and the E2-T12 capstone's headline shot is
literally this task's behavior ("the same append without the token is refused with the
right status").

Builds on: E2-T02 (the emulator is the sole issuer and JWKS source; verification runs
against its cold-started instance. Negative-path tokens use concrete mechanisms —
E2-T02 froze no claim-control surface, its only knobs are `--now`/`--seed` — namely:
**expired** via a second emulator instance started with `--now` far enough in the past
that its minted tokens' `exp` has already elapsed; **wrong-issuer** via a second
emulator instance on a different port (same committed keypair and `kid`, therefore a
different issuer URL); **wrong-audience** via a server configured with a mismatched
`EF_AUTH_AUDIENCE`, or by signing directly with the committed private JWK
`packages/oidc-emulator/fixtures/test-keypair.private.jwk.json`; **missing-subject**
only via that direct-signing route, since every emulator-minted token carries `sub`.
The golden transcript uses the direct-signing route for wrong-audience and
missing-subject and the second-instance routes for expired and wrong-issuer, with
fixed `--now`/`--seed` values and fixed ports, so it stays deterministic),
E0-T11 (the class→code table this task extends with `unauthorized` → 401; the
log-neutral-refusal doctrine inherited wholesale; the `ActionValidator` context this
task additively extends), E0-T05 (the raw doors and their frozen error semantics —
untouched except for the new 401 layer in front), E0-T09 (the conformance suite is the
regression instrument: it must stay green with auth off, and its mutating operations
must *all* go 401 with auth on — that differential is this task's proof of coverage),
E0-T04 (`ef replay --digest` is the neutrality instrument).

Contract frozen here: the refusal table — the nine `reason` strings above, the
`unauthorized` class name, the 401 status, the `WWW-Authenticate: Bearer` header, and
the body shape `{ error: { class: 'unauthorized', reason } }` (no other keys required;
additive optional `detail` permitted, never load-bearing). Also frozen: the ordering
rule (auth precedes body parsing and every E0-T11 stage at all three doors), the
intra-auth stage order — header presence → scheme match → JWT shape/decode → `alg`
→ `kid`/key resolution → signature → `exp`/`nbf`/`iat` → `iss` → `aud` → `sub` —
with the rule that **the first failing stage's reason wins**, so a multi-fault token
(e.g. simultaneously expired and wrong-issuer, or bad-signature and missing-subject)
has exactly one determined reason and the reason table stays binary-checkable even
for adversarially constructed inputs, the
verification policy (allowed algorithm list is exactly `RS256`; `alg: none`, HS*, and
any other algorithm refuse as `bad-algorithm`; issuer and audience must equal the
configured values exactly; clock leeway is **0 seconds**, documented, and the boundary is frozen too: a token is
expired iff `exp` ≤ current time, per RFC 7519 §4.1.4 (`exp` names the instant on or
after which the token MUST be rejected); the
authorization scheme match is **exact case-sensitive `Bearer`** — any other casing,
including `bearer` or `BEARER`, refuses `missing-token` even when the credentials are
an otherwise-valid token; this is a deliberate, documented departure from RFC 7235's
case-insensitive schemes, chosen so the fuzz criterion below is binary; a token whose
header carries **no `kid` at all** refuses `unknown-key`, with **no** refetch
performed — key lookup requires a `kid`, and its absence is pinned to this reason so
implementations cannot diverge), the
unreachable-JWKS behavior (when the issuer's JWKS cannot be fetched — emulator down or
refetch failing — a token needing a key lookup refuses `unknown-key` after the single
failed refetch attempt, responding 401 within **5 seconds**, never a 5xx, never
fail-open, never hanging), the startup-discovery failure behavior (with auth enabled,
if OIDC discovery against the configured issuer fails at startup, the server exits
nonzero with a named error — fail-closed; it never starts open, never starts with an
empty keyset, and never defers discovery to first request), and the start-time-only
nature of the auth toggle. Epic 3's UI and Epic 4's CLI will render
these bodies; E2-T10's conformance matrix sweeps this table; renaming a reason later
invalidates their goldens.

Non-goals: per-stream/per-branch authorization and public/private visibility (E2-T07),
token *issuance* and login flows (E2-T04/E2-T05 — this task only verifies), grant
revocation checks against identity streams (E2-T05/E2-T07 — a cryptographically valid
token is sufficient here), rate limiting (E2-T11), recording the subject into event
envelopes (E0-T03's envelope is frozen; how identity lands in events is decided where
it's needed, E2-T06/E2-T09), and gating read doors (E2-T07).

## Deliverables

- `packages/stream-server/src/auth.ts` — `verifyBearer(header, config)` returning
  `{ sub }` or a typed refusal from the frozen table, plus the `requireAuth` middleware
  wired in front of exactly the three mutating routes. JWKS handling: discovery via the
  issuer's `/.well-known/openid-configuration` at startup, key lookup by `kid`, and on
  an unknown `kid` exactly **one** JWKS refetch before refusing `unknown-key` (refetch
  count observable for tests). Verification via a standard JOSE library pinned to the
  `RS256` allowlist; `jku`/`jwk`/`x5u` header parameters are never honored.
- The frozen refusal table, implemented and documented in the package README beside
  E0-T11's class→code table:
  - `missing-token` — no `Authorization` header, or scheme is not exactly the
    case-sensitive string `Bearer` (per the frozen verification policy — `bearer`
    refuses even with valid credentials), or empty credentials.
  - `malformed-token` — credentials are not a three-segment decodable JWT.
  - `bad-algorithm` — `alg` outside the `RS256` allowlist (including `none` and HS*).
  - `bad-signature` — signature does not verify against the resolved JWKS key.
  - `token-expired` — `exp` ≤ current time (leeway 0; the ≤ boundary is frozen per
    RFC 7519 §4.1.4); also covers `nbf`/`iat` in the
    future, documented in the README as part of this reason's definition.
  - `wrong-issuer` — `iss` ≠ configured issuer (exact string match).
  - `wrong-audience` — `aud` does not contain the configured audience.
  - `unknown-key` — `kid` absent from JWKS after the single refetch; also covers a
    token whose header carries **no `kid`** at all, refused `unknown-key` with **no**
    refetch performed (there is no key to look up); also the
    unreachable-JWKS case: when the JWKS cannot be fetched at all (emulator down,
    refetch fails), the request refuses `unknown-key` after the single failed refetch
    attempt, responding 401 within 5 seconds — never 5xx, never fail-open, never a
    hang. Documented in the package README beside the refusal table.
  - `missing-subject` — valid token whose `sub` is absent, empty, or not a string.
- Config surface: `EF_AUTH_ISSUER`, `EF_AUTH_AUDIENCE` (both required to enable auth;
  partial configuration is a startup error, not silent-open; likewise, if discovery
  against the issuer's `/.well-known/openid-configuration` fails at startup, the
  server exits nonzero with a named error — fail-closed, per the frozen contract —
  never starts open, with an empty keyset, or with discovery deferred to first
  request), read once at startup. Documented in the package README with the
  startup fail-closed behavior, the auth-off compatibility guarantee, and the
  reads-stay-open boundary (E2-T07 pointer).
- Additive `ActionValidator` context extension: the dispatch context gains optional
  `auth?: { sub: string }`, populated when auth is on; E0-T11's frozen interface is
  untouched (extension by additive optional field, verified by re-running its suite).
- `packages/stream-server/test/auth.test.ts` — integration over real HTTP against a
  cold-started E2-T02 emulator and an auth-enabled server:
  - Authorized path: a token minted by the emulator succeeds at all three doors —
    create (201), raw append (per E0-T05's frozen success shape), dispatch (per
    E0-T11's) — appending exactly the expected events; a test-registered validator
    asserts `context.auth.sub` equals the subject the emulator minted.
  - Per refusal reason (all nine), at **each** of the three doors: capture head offset,
    event count, and `ef replay --digest` digest; send the refused request; assert
    exactly 401, `WWW-Authenticate: Bearer` present, the literal
    `error.class`/`error.reason`; re-capture and assert all three neutrality values
    byte-identical. Negative tokens come from three sanctioned sources: the emulator
    (expired via a `--now`-in-the-past instance; wrong-issuer via a second instance on
    a different port), local construction with a foreign keypair (bad-signature,
    bad-algorithm, unknown-key, malformed), and — for claim-shape negatives that must
    carry a *valid* signature so the later stage is the one that fires
    (missing-subject at minimum; wrong-audience may use this route too) — direct
    signing with E2-T02's committed
    `packages/oidc-emulator/fixtures/test-keypair.private.jwk.json` under the real
    `kid` `eforest-test-2026`. That last route is explicitly sanctioned here: the
    emulator's minting surface always includes `sub`, so a signature-valid,
    subject-less token can only be produced by signing with the committed private JWK
    directly.
  - Ordering: tokenless request with an unparseable body → 401 `missing-token`, not
    400; tokenless dispatch of an unknown action type → 401, not 404.
  - Multi-fault determinism: a token that is simultaneously expired **and**
    wrong-issuer (directly signed with the committed private JWK, `exp` in the past,
    `iss` mismatched) refuses `token-expired` — the earlier stage in the frozen
    intra-auth order wins — a committed assertion, and the case appears as a line in
    the golden transcript `evidence/e2-t03-doors.txt` so the stage order is
    regression-guarded.
  - Reads stay open: `GET /events`, `/state`, and a live long-poll succeed tokenless
    with auth on.
  - Unknown-kid refetch: a token with a fabricated `kid` triggers exactly one JWKS
    refetch (asserted via the observable count) then `unknown-key`.
  - Unreachable JWKS: with the emulator stopped (or its JWKS endpoint unreachable), a
    valid-shaped token needing a key lookup refuses 401 `unknown-key` after exactly
    one failed refetch attempt, with the response arriving within 5 seconds — never
    5xx, never fail-open, never a hang.
  - SSE silence: a tailer attached across a batch of refusals receives zero frames.
- `packages/stream-server/test/auth.fuzz.test.ts` — seeded fuzzer (seed committed):
  bit-flips in each JWT segment, segment deletions/duplications, oversized tokens
  (bounded to **8 KB** total header size — safely below Node's ~16 KB default
  `maxHeaderSize`, so the request always reaches the auth middleware rather than
  tripping a transport-layer 431), unicode and whitespace injection in the header —
  with the injection alphabet bounded the same way the size is: header-injection
  inputs are restricted to bytes lawful in an RFC 7230 field-value (VCHAR, SP, HTAB;
  obs-text excluded), because field-value-illegal bytes never reach the code under
  test — a standards-following client refuses to send them, and via raw socket Node's
  llhttp parser answers 400 at the transport layer before the auth middleware runs.
  Non-field-value byte sequences (raw control characters, bare CR/LF, non-ASCII) may
  additionally be exercised as raw-socket probes, but those are pinned separately: a
  transport-layer 400 is the permitted answer for them, and the digest must still be
  unchanged — they are excluded from the 401-exactly criterion below. Also:
  scheme-case variants (refused `missing-token` per the frozen case-sensitive-`Bearer`
  policy), `alg: none`, HS256-signed-with-public-key confusion tokens, embedded
  `jwk`/`jku` headers. Every field-value-lawful input yields 401 with a taxonomy
  reason — never 2xx, never 5xx — and a final digest equal to the pre-fuzz digest.
- `Makefile`: `verify-E2-T03` — cold-starts the E2-T02 emulator and an auth-enabled
  server, runs both suites, writes/verifies the golden door transcript, runs the
  **differential conformance sweep** (E0-T09's mutating operations replayed against
  the auth-on server must all return 401/`unauthorized`; the same suite against an
  auth-off server must pass green unmodified), and replays the neutrality golden.
  Nonzero exit on any failure; joins `verify-all`.
- `evidence/` — `e2-t03-doors.txt` (the golden transcript: every authorized and
  refused request's door, token condition, status, and full error body, in a fixed
  order; authorized-dispatch lines carry the resolved `sub`; the transcript also
  includes the three ordering probes, the three tokenless-read probes, the
  multi-fault expired-and-wrong-issuer case, and the `nbf`-in-the-future refusal as
  lines), `e2-t03-refusal-neutrality.txt` (before/after offset + count + digest per
  refusal reason per door), `e2-t03-fuzz-seed.txt`, `e2-t03-sensitivity.md` (sabotage
  transcript, below).

## Acceptance criteria

- [ ] `make verify-E2-T03` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      with scrubbed env, cold-starting the E2-T02 emulator itself (no warm emulator,
      no cached JWKS on disk).
- [ ] Golden door transcript: `evidence/e2-t03-doors.txt` is regenerated by
      `verify-E2-T03` and compared exact — one authorized success per door (dispatch
      carrying the resolved `sub`), all nine refusal reasons per door, the ordering
      probes, the tokenless-read probes, the multi-fault expired-and-wrong-issuer
      case, and the `nbf`-in-the-future refusal, each line carrying the literal
      status and error body. Any drift in status, class, reason, resolved `sub`, or
      the `WWW-Authenticate` header fails the diff.
- [ ] Refusal neutrality, exhaustive: for every (reason × door) refusal in the
      transcript, head offset, event count, and `ef replay --digest` digest captured
      immediately before and after are byte-identical, committed to
      `evidence/e2-t03-refusal-neutrality.txt`; a **tokenless** SSE tailer attached
      across the refusal batch connects successfully with auth on (2xx, stream open)
      and its liveness is proven — it receives exactly the frames for interleaved
      authorized appends and zero frames for the refusal batch. A tailer whose
      connection was refused (and therefore trivially saw nothing) does not satisfy
      this criterion. An append-then-compensate implementation fails by count and
      digest.
- [ ] Subject resolution proven (stream layer): the authorized dispatch run asserts,
      inside a registered `ActionValidator`, that `context.auth.sub` equals the exact
      subject the emulator minted the token for — not merely that the request
      succeeded — and the authorized-dispatch line in the golden transcript
      `evidence/e2-t03-doors.txt` carries the resolved `sub`, so subject resolution
      is golden-diffed by the critic, not vouched for only by the builder's own test.
      An implementation populating `auth.sub` from a constant is caught by sabotage
      (d) below.
- [ ] Ordering pinned (stream layer): tokenless + garbage body → 401 `missing-token`
      (not 400); tokenless + unknown action type → 401 (not 404); valid token +
      garbage body → E0-T11's 400 `malformed-body` — proving auth precedes, and only
      precedes, the existing stages. All three are committed test assertions **and**
      appear as lines in the golden transcript `evidence/e2-t03-doors.txt` (they are
      door requests with statuses and bodies — the transcript already fits), so the
      ordering is critic-diffable, not only builder-tested. The intra-auth stage
      order is additionally guarded by the committed multi-fault assertion: an
      expired-and-wrong-issuer token → `token-expired` (first failing stage wins),
      also a transcript line. Likewise `nbf`/`iat`-in-the-future → `token-expired`
      (the frozen mapping in the refusal table) is a committed assertion and a
      transcript line — the contract text alone is not its proof.
- [ ] Verification policy edges: `alg: none` and an HS256 token signed with the JWKS
      public key as HMAC secret both refuse `bad-algorithm`; a structurally valid
      token signed by a foreign RS256 keypair under the emulator's `kid` refuses
      `bad-signature`; a token with `exp` one second in the past refuses
      `token-expired` (leeway 0, per the frozen policy); `iss` differing by a single
      trailing slash refuses `wrong-issuer`; a signature-valid token whose header
      carries no `kid` refuses `unknown-key` with zero refetches performed (asserted
      via the observable refetch count, per the frozen policy). All six edges are
      committed assertions
      in `packages/stream-server/test/auth.test.ts` and appear as lines in the golden
      transcript `evidence/e2-t03-doors.txt` (stream layer).
- [ ] Unreachable JWKS pinned: with the emulator down, a valid-shaped token needing a
      key lookup refuses 401 `unknown-key` after the single failed refetch attempt,
      the response arrives within 5 seconds, and no 5xx or fail-open occurs — a
      committed test assertion in `packages/stream-server/test/auth.test.ts` running
      inside `verify-E2-T03`, and the behavior is documented in the package README
      beside the refusal table.
- [ ] Differential conformance: E0-T09's conformance suite passes green against an
      auth-off server on this task's tree (zero drift), and its mutating operations
      all return 401 `unauthorized` against an auth-on server — both runs inside
      `verify-E2-T03`. A mutating conformance op that succeeds tokenless with auth on
      fails this criterion outright.
- [ ] Reads stay open (stream layer): with auth on, tokenless `GET /events`,
      `GET /state`, and a long-poll live read succeed — committed assertions, the
      three tokenless-read probes appear as lines (door, token condition, status) in
      the golden transcript `evidence/e2-t03-doors.txt` so the boundary is
      critic-diffable, and the README documents the E2-T07 boundary.
- [ ] Fuzz: the seeded token fuzzer (seed committed in `evidence/e2-t03-fuzz-seed.txt`)
      completes with every response exactly 401, `error.class` = `unauthorized`,
      `error.reason` a member of the frozen nine-entry table, and a post-run digest
      equal to the pre-run digest — a non-table reason, a bare 400/403, or any
      2xx/5xx fails this criterion. This criterion applies to the bounded alphabet
      only: every header-injection input is drawn from bytes lawful in an RFC 7230
      field-value (VCHAR, SP, HTAB), so every input provably reaches the auth
      middleware rather than a client refusal or llhttp's transport-layer 400. Any
      raw-socket probes with field-value-illegal bytes are judged by their own frozen
      rule — transport-layer 400 permitted, digest still unchanged — and never count
      toward, or against, the 401-exactly requirement. A fuzzer that silently narrows
      its alphabet below the deliverable's mandated classes fails this criterion.
- [ ] Sabotage sensitivity: in a scratch worktree, each of (a) `verifyBearer` accepts
      everything, (b) signature checked but `exp` ignored, (c) issuer check removed,
      (d) `context.auth.sub` populated from a hardcoded constant instead of the
      verified token's `sub` claim — run `make verify-E2-T03` after each and it MUST
      go red ((d) via the subject-resolution assertion and the `sub`-carrying
      transcript line, proving that assertion is sensitive rather than decorative);
      transcripts committed as `evidence/e2-t03-sensitivity.md`. Any sabotage the
      target stays green on refutes the apparatus.
- [ ] No regression: `make verify-E0-T09`, `verify-E0-T11`, and every `verify-E1-*`
      recipe present in the root Makefile (the set is derived mechanically from the
      Makefile, e.g. `grep -E '^verify-E1-[^:]*:' Makefile` — no subset, no naming
      judgment) re-run green on this tree (auth off).
- [ ] All root gates pass: `pnpm format:check && pnpm lint && pnpm typecheck &&
      pnpm test && pnpm build` exit 0.
- [ ] Replay (browser layer): N/A — no browser-reaching surface; mitigation per
      AGENTS.md is the stream-layer transcript + digest evidence above, declared
      explicitly in the Verification log entry.

## Adversarial verification

The claim under attack: "with auth on, no mutation lands without a token the emulator's
JWKS actually vouches for, no refusal leaves a trace, and the refusal table is the
whole truth." Mint your own tokens and keypairs throughout — never reuse the builder's
fixtures — and invent at least one angle beyond these.

1. **Forge factory.** Generate your own RS256 keypair; mint tokens with the correct
   `iss`/`aud`/`sub`/`exp` and the emulator's real `kid`, signed with your key. Every
   one must be 401 `bad-signature`, log-neutral by byte-diff of the raw dump. A single
   acceptance refutes the task. Then the classics: `alg: none` with a valid-looking
   payload, HS256 with the emulator's public key (fetched from its JWKS yourself) as
   the HMAC secret, a token carrying an embedded `jwk` header holding your public key,
   a `jku` pointing at a JWKS you serve locally. Any of these accepted — or answered
   5xx — refutes the verification policy.
2. **Bypass hunt at the router.** Enumerate every route in `packages/stream-server`
   that can reach a store write (read the router source, don't trust the README).
   Probe tokenless: method-override headers (`X-HTTP-Method-Override`), `HEAD`/
   `OPTIONS` on mutating paths, path case variants and trailing slashes, URL-encoded
   path segments, chunked/duplicated `Authorization` headers, `Authorization` header
   smuggled twice (one valid, one empty). After the whole barrage, byte-diff the store
   dump against pre-barrage. Any mutation, or any door reachable tokenless that the
   three-door claim doesn't cover, refutes coverage.
3. **Neutrality under observation.** Attach an SSE tailer and a long-poll reader,
   then drive ≥ 100 refusals of your own construction (mixed reasons, mixed doors,
   interleaved with a few authorized appends). The tailers must observe exactly the
   authorized events and nothing else, in order; the final digest must equal a replay
   of only the authorized appends. Any extra frame — even a metadata or error event —
   refutes log-neutrality.
4. **Clock and claim edges.** Tokens with `exp` at or before the request time
   (construct via direct signing with your own keypair or the committed private JWK —
   the frozen boundary is `exp` ≤ current time ⇒ `token-expired`, so any such token
   must refuse; the binary-checkable committed assertion is the `exp`-one-second-past
   case), `exp` = now − 1s, `nbf` one
   hour in the future, `iat` in the future, `aud` as an array containing the right
   audience among wrong ones, `aud` as the right string with trailing whitespace,
   `sub` as `""`, `sub` as an array, missing `kid`. Behavior must match the frozen
   policy and reason table exactly (leeway 0; array-`aud` containing the audience is
   the RFC-defined accept); for tokens carrying several faults at once, the frozen
   intra-auth stage order determines the single correct reason — first failing stage
   wins — so there is exactly one right answer to check; any response outside
   401-with-a-table-reason or the
   documented accept refutes the frozen contract. Check `Object.prototype` is clean
   after the run.
5. **The toggle is not a hole.** Confirm auth cannot be disabled without a restart:
   flip the env vars in the running process's environment (if reachable), send
   SIGHUP, probe again — still 401. Start a server with only one of the two env vars
   set — it must refuse to start, not start open. Then run the auth-on differential
   conformance sweep *yourself* from the raw E0-T09 suite, not the builder's wrapper:
   every mutating op 401, every read op unchanged.
6. **JWKS lifecycle attacks.** Serve your own OIDC discovery + JWKS stub and configure
   it as the server's issuer (E2-T02's frozen contract has no rotation — the critic
   supplies the lifecycle). Mint a token under a fresh `kid` you publish in your stub
   mid-run: the server must refetch and verify it with no server restart. Then remove
   that key from your JWKS and send another token under the same `kid`: it must refuse
   `unknown-key` after exactly one refetch (count the hits your stub receives). More
   or fewer refetches, a stale-cache acceptance, or a hang refutes the lifecycle
   claim. Kill the emulator entirely and send a valid-shaped token with an
   unknown `kid`: the server must refuse 401 (never hang, never 5xx, never fail open)
   — pin the observed reason against the README's documented behavior for an
   unreachable JWKS; an undocumented answer is a contract hole.
7. **Sabotage beyond the builder's.** In a scratch worktree: (a) swap the audience
   check to `startsWith`, (b) make `requireAuth` run *after* body parsing, (c) make
   refusals append a "denied" audit event then return 401. `make verify-E2-T03` must
   go red for each — (b) via the ordering criteria, (c) via neutrality. Any survivor
   refutes the measuring apparatus for that property.
8. **Cold-clone + golden re-derivation.** Run everything through
   `tools/verify/cold_clone.sh` with scrubbed env. Regenerate `e2-t03-doors.txt`
   yourself against your own cold-started emulator and diff against the committed
   golden — nondeterminism in the transcript (timestamps, random ports, token bodies
   leaking in) refutes the golden's fitness as a regression instrument. Re-run
   `verify-E0-T09` and the E1 targets on this tree; any drift refutes "additive".

Refutation currency: an HTTP transcript of a tokenless or forged-token mutation that
landed (with the dump + offset of the appended event), a refusal with the wrong
status/class/reason against the frozen table, a digest pair that should match and
doesn't, an SSE frame emitted during a refusal, or a sabotage run that stayed green.
"The 401 body could say more" is a note, not a finding.

## Verification log
