---
id: E2-T11
epic: 2
title: "Rate limits and tenant isolation: typed 429s with deterministic windows, cross-tenant probes refused side-effect-free"
priority: 211
status: pending
depends_on: [E2-T10]
estimate: M
capstone: false
---

## Goal

`packages/stream-server` enforces per-identity rate limits on its three mutating doors —
`PUT /streams/:id` (create), `POST /streams/:id` (raw append), and
`POST /streams/:id/dispatch` — and the platform's tenant boundary survives an
adversarial probe corpus with zero side effects. Rate limiting: a **fixed-window
counter keyed by `(sub, door-class, floor(now / windowMs))`** where `sub` is the
subject E2-T03 resolved from the bearer token, configured at startup by
`EF_RATE_LIMIT_MAX` (requests per window) and `EF_RATE_LIMIT_WINDOW_MS` — both required
to enable limiting, partial configuration is a startup error, both unset means limits
off and every prior verify target green unmodified. The limit stage runs **after**
E2-T03 auth and **before** everything else (body parsing, E0-T11 validation, E2-T07
authorization): request number `MAX` in a window succeeds, request `MAX + 1` is refused
with HTTP **429**, a `Retry-After: <seconds>` header (integer seconds until the current
window ends, computed from the injectable clock, never a guess), and the typed body
`{ error: { class: 'rate-limited', reason: 'rate-limit-exceeded' } }` — `rate-limited`
is a new class added beside E0-T11's frozen taxonomy (additive, mapping to exactly one
status, 429, in the package README's class→code table). The clock is **injectable**
(`createServer({ clock })`, default `Date.now`): every window-rollover behavior is
asserted by stepping a manual clock in-process, never by sleeping. Rate-limit refusals
are log-neutral in E0-T05/E0-T11's sense — head offset, event count, and
`ef replay --digest` byte-identical across a refused burst, no live tailer observes a
frame — and counters are pure in-memory request-accounting state, derived from nothing
and persisting nothing (bet 4 untouched: a restart forgets them, documented).
Tenant isolation: an adversarial corpus of crafted stream ids and cross-tenant
operations — path traversal (`..`, `%2e%2e`, encoded `/` `%2f` and `:` `%3a`, null
bytes, unicode homoglyphs of `-` and `/`), namespace prefix collisions (`org` vs
`org-evil` vs `orgx` under the frozen `fs:<org>/<repo>` prefix from E2-T06),
cross-tenant stream-id probes (identity B reading, writing, dispatching to,
live-tailing, and listing via the E2-T08 registry/index doors `fs:orgA/...` and `id:`
streams it holds no grant on — a registry listing must not disclose the existence of
another tenant's private repos), and cross-org grant
escalation (dispatching E2-T01 grant/membership events targeting another org's identity
stream) — is refused from **every** door including long-poll and SSE live-tail, each
refusal carrying the already-frozen status for its cause (E2-T03 401, E2-T07 403/404,
E2-T06 409/422 — this task freezes **no new isolation statuses**, it proves the
existing ones are airtight) and each provably side-effect-free by byte-identical store
dumps. The E2-T10 conformance matrix gains rate-limit and isolation rows, and its
sabotage sensitivity is re-proven over the extended matrix, all under
`make verify-E2-T11`.

## Context

This is the last hardening task before the E2-T12 capstone: the gates exist (E2-T03
auth, E2-T07 per-stream authorization, E2-T06 namespaces, E2-T09 per-writer fencing)
and E2-T10 built the standing matrix that sweeps them — but nothing yet bounds how hard
an authenticated identity can hammer a door, and nobody has *attacked* the tenant
boundary with hostile inputs rather than well-formed wrong-identity requests. ROADMAP.md
names "rate limits and tenant isolation" as Epic 2 scope explicitly. The isolation half
deliberately mints no new mechanism: E2-T06 froze the name grammar and `fs:<org>/<repo>`
prefix, E2-T07 froze per-stream refusals — this task is the adversarial proof that
those contracts compose without seams (a probe that slips between "invalid name" and
"not your stream" and lands anywhere refutes the composition, whichever task's contract
it technically violates). The rate-limit half adds the one genuinely new mechanism, kept
minimal: fixed-window, per-subject, mutating doors only.

Builds on: E2-T10 (the matrix harness this task extends — new rows ride its golden
decision-transcript format and its sensitivity apparatus; extending rather than
forking it is the point), E2-T03 (the resolved `sub` is the rate-limit key; the stage
ordering slots the limit stage directly behind auth and inherits the log-neutral
refusal doctrine and the class→code table this task adds `rate-limited` to), E2-T07 (the
per-stream 403/404 refusals every cross-tenant probe must land on; this task adds no new
authorization logic, it stress-tests T07's), E2-T06 (the name grammar
`^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`, the reserved-name set, and the
`fs:<org>/<repo>` stream-id prefix the isolation corpus attacks; malformed ids die at
T06's `ns/invalid-name` 422 or T07's 404, never in between), E2-T01 (the identity
streams — `id:*` — and the grant/membership events a cross-org escalation probe tries to
forge onto another tenant's stream), E2-T09 (per-writer `Stream-Seq` fencing — a probe
must not be able to fence a stream it can't write), E0-T11 (the taxonomy this task
extends additively with `rate-limited`, and the `validator-rejected`/log-neutral
doctrine every refusal obeys), E0-T06 (long-poll + SSE live modes — the live-tail door
that must refuse cross-tenant reads exactly as the pull doors do), E0-T04
(`ef replay --digest`, the neutrality instrument), E0-T09 (the conformance suite whose
mutating ops must all still refuse correctly with limits on).

Contract frozen here, versioned from this task forward:

- **Rate-limit config surface**: `EF_RATE_LIMIT_MAX` (positive integer, requests per
  window) and `EF_RATE_LIMIT_WINDOW_MS` (positive integer, window length in ms), both
  read once at startup, both required to enable — exactly one set is a startup error
  (fail closed on misconfiguration, never silent-open, never silent-off), both unset =
  limits disabled. Not mutable at runtime. The startup error is frozen as: nonzero
  process exit and the exact stderr line
  `EF_RATE_LIMIT_MAX and EF_RATE_LIMIT_WINDOW_MS must be set together (got one without the other)`
  — tests assert this line verbatim. The same shape (nonzero exit + this frozen line)
  applies when either variable is set but not a positive integer, with the line
  `EF_RATE_LIMIT_MAX must be a positive integer` /
  `EF_RATE_LIMIT_WINDOW_MS must be a positive integer` respectively.
- **Rate-limit key + algorithm**: fixed window, key
  `(sub, door-class, floor(clock() / windowMs))`. `door-class` is one of
  `create` | `append` | `dispatch` (the three mutating doors, counted independently).
  The `MAX`-th request in a window is the last accepted; `MAX + 1` is the first refused.
- **Rate-limit refusal shape**: HTTP `429`, class `rate-limited`, reason
  `rate-limit-exceeded`, header `Retry-After: <integer seconds>` = ceil of
  `(windowEnd - clock()) / 1000` where `windowEnd = (floor(clock()/windowMs)+1)*windowMs`.
  Body `{ error: { class: 'rate-limited', reason: 'rate-limit-exceeded' } }` (additive
  optional `detail` permitted, never load-bearing). `rate-limited` → `429` is added to
  the package README class→code table beside `unauthorized` → 401.
- **Stage ordering**: at every mutating door the pipeline is
  `auth (E2-T03) → rate-limit → body-parse → validate (E0-T11) → authorize (E2-T07) →
  fence (E2-T09) → append`. A tokenless burst is 401, never 429 (limit needs a `sub`); a
  rate-limited request never reaches body parsing, validation, or authorization; a
  request that *passes* the limit but fails authorization is 403/404, not 429.
- **Isolation statuses are inherited, not new**: crafted-name and cross-tenant probes
  resolve to exactly one of the already-frozen refusals — E2-T03 `401 unauthorized`,
  E2-T06 `422 schema-violation` / `409 validator-rejected` (`ns/invalid-name`,
  `ns/reserved-name`, `ns/name-taken`, `ns/org-not-found`, `ns/project-not-found`),
  E2-T07 `403`/`404` per-stream refusals. This task freezes no new isolation reason
  code; it freezes the *corpus* (committed seeds) and the *claim* that every seed lands
  on exactly one inherited refusal, side-effect-free.

Non-goals: sliding-window / token-bucket / distributed rate limiting (fixed-window
in-memory per-process is the frozen choice; distributed limiting is a later-epic
concern), rate-limiting read doors (mutating doors only — reads stay open per the
E2-T07 boundary), per-org or per-IP limits (per-`sub` only), CAPTCHA / ban-lists /
anomaly detection, and any new authorization mechanism for the isolation half (it
stress-tests E2-T06/T07/T01, it does not extend them).

## Deliverables

- `packages/stream-server/src/rate-limit.ts` — `createRateLimiter({ max, windowMs,
  clock })` returning a `check(sub, doorClass): { allowed: boolean; retryAfterSec:
  number }` and the `rateLimit` middleware wired in front of exactly the three mutating
  routes, positioned between `requireAuth` and body parsing. Counter state is a plain
  in-memory `Map` keyed by the frozen tuple, pruned lazily (entries for elapsed windows
  dropped on access); no timers, no disk, no store writes. Disabled path (env unset) is
  a pass-through with zero overhead and no `429` reachable.
- Class→code table extension: `rate-limited` → `429` added to the E0-T11 taxonomy and
  documented in the package README beside `unauthorized`, including the `Retry-After`
  computation and the injectable-clock contract.
- Config surface: `EF_RATE_LIMIT_MAX`, `EF_RATE_LIMIT_WINDOW_MS` parsing + validation at
  startup (both-or-neither, positive integers), documented in the package README with
  the limits-off compatibility guarantee and the in-memory/non-persistent note.
- `packages/stream-server/src/server.ts` (or existing factory) — `createServer` accepts
  an optional `clock: () => number` (default `Date.now`) threaded into the rate limiter
  so tests step time deterministically.
- `packages/platform` (or wherever E2-T06's resolver lives) — no new logic; this task
  imports the frozen resolver + name validator and proves the composition. If a probe
  reveals a genuine gap (e.g. a decode step that runs before name validation), the fix
  lands in the owning package with a pointer back here, not a bypass here.
- `packages/stream-server/test/rate-limit.test.ts` — integration over real HTTP with an
  auth-enabled, limit-enabled server and a stepped manual clock:
  - Burst boundary: `MAX` requests in one window all succeed (create/append/dispatch,
    each door tested independently), request `MAX + 1` returns exactly `429` with the
    literal body and a `Retry-After` equal to the computed remaining seconds. The exact
    request that tips `200`→`429` is captured to the transcript.
  - Window rollover: step the clock past `windowEnd`; the counter resets and the next
    request succeeds. Step to exactly `windowEnd` (boundary) and assert the frozen
    `floor` semantics (the boundary request belongs to the new window).
  - Per-key independence: two subjects hammering the same door don't share a counter;
    one subject hammering `create` doesn't consume its `dispatch` budget.
  - Log-neutrality: capture head offset + event count + `ef replay --digest` before a
    `≥ 50`-request over-limit burst and after; assert byte-identical; an SSE tailer
    attached across the burst receives zero frames.
  - Ordering: tokenless over-limit burst → `401` (not `429`); over-limit request with a
    garbage body → `429` (not `400`, limit precedes parse); an under-limit request to an
    unauthorized stream → `403`/`404` (not `429`).
  - Restart amnesia: build a fresh limiter (simulating restart) and assert prior counts
    are gone — documenting bet-4 non-persistence.
- `packages/stream-server/test/isolation.test.ts` — the adversarial isolation corpus as
  a committed, seeded table (`evidence/e2-t11-isolation-corpus.jsonl`): each row is
  `{ probe, door, expectedStatus, expectedClass, expectedReason }`. Covers, at each of
  create/append/dispatch **and** GET/`/events`/`/state`/long-poll/SSE **and** the E2-T08
  registry doors `GET /registry/public`, `GET /registry/org/:org`, and
  `GET /registry/me`:
  - Path traversal / encoding: `fs:orgA/../orgB/repo`, `%2e%2e`, `%2f`, `%3a`, embedded
    null byte, mixed/double encoding, unicode homoglyph of `-` (e.g. `U+2010`) and `/`.
  - Prefix collisions: identity B (member of `org-evil`) probing `fs:org/...` vs
    `fs:org-evil/...` vs `fs:orgx/...` — no prefix bleed grants access across the
    hyphen/boundary.
  - Cross-tenant stream-id probes: B reads/writes/dispatches/live-tails `fs:orgA/...`
    and `id:<A-subject>` streams B holds no grant on; B's registry/index listings
    (E2-T08 doors) contain no byte disclosing orgA's private repos' existence.
  - Cross-org grant escalation: B dispatches E2-T01 `grant`/`membership` events targeting
    orgA's `id:*` stream to promote itself.
  Every row asserts the exact inherited status/class/reason AND byte-identical store
  dump before/after (side-effect-free), including the live-tail doors emitting zero
  frames to the probing identity.
- `packages/stream-server/test/isolation.fuzz.test.ts` — seeded fuzzer (seed committed
  in `evidence/e2-t11-fuzz-seed.txt`) generating crafted stream ids by mutating valid
  `fs:<org>/<repo>[:branch:...]` ids: byte-flips, separator injection, encoding layers,
  length extension, reserved-name splicing. The fuzzed door set is frozen and
  enumerated here — `create`, `append`, `dispatch`, `GET` (pull read), `/events`,
  `/state`, long-poll, SSE, `GET /registry/public`, `GET /registry/org/:org`, and
  `GET /registry/me` — and at least 1,000 generated ids are fired at **each** of these
  named doors per run; the count for each named door is printed to the transcript and
  individually asserted `≥ 1000` by `verify-E2-T11` (a run missing any door, or
  under-sized at any door, fails mechanically). Every input at every door yields a
  refusal from the frozen inherited set (never `2xx`, never `5xx`) and a post-run store
  digest equal to pre-run.
- E2-T10 matrix extension: the conformance matrix gains a **rate-limit axis** (under/at/
  over limit) and **isolation rows** (the corpus), regenerating the golden decision
  transcript; the matrix's sensitivity apparatus is re-run over the extended set.
- `Makefile`: `verify-E2-T11` — cold-starts the E2-T02 emulator + an auth-on,
  limit-on server; runs all three suites; regenerates and exact-diffs the golden
  transcripts; re-runs the E2-T10 matrix with the new rows; runs the sabotage
  sensitivity sweep; asserts the limits-off differential (server with limits unset
  passes every prior verify target unmodified and never returns `429`). Nonzero exit on
  any failure; joins `verify-all`.
- `evidence/` — `e2-t11-burst-transcript.txt` (the ordered burst: every request's door,
  sub, in-window index, status, and body, with the exact `MAX`→`MAX+1` tip line, the
  clock step past `windowEnd`, the post-rollover accepted line, and the target stream's
  `ef replay --digest` printed unchanged before the burst and after the refused span),
  `e2-t11-isolation-corpus.jsonl` (the committed probe corpus + expected refusals),
  `e2-t11-isolation-neutrality.txt` (before/after store dump digest per probe),
  `e2-t11-fuzz-seed.txt`, `e2-t11-matrix.txt` (the extended golden decision transcript),
  `e2-t11-sensitivity.md` (sabotage transcripts).

## Acceptance criteria

- [ ] `make verify-E2-T11` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      with scrubbed env, cold-starting the E2-T02 emulator and both an auth-on/limit-on
      and a limits-off server.
- [ ] Burst tip proven: `evidence/e2-t11-burst-transcript.txt` is regenerated by
      `verify-E2-T11` and exact-diffed — it contains, for each mutating door, `MAX`
      consecutive `200`/`201` lines then a `429` line carrying the literal
      `{ error: { class: 'rate-limited', reason: 'rate-limit-exceeded' } }` body and the
      computed `Retry-After` integer, then a recorded clock step past `windowEnd` and one
      more accepted (`200`/`201`) line proving the budget resets — the full boundary walk
      (allowed × MAX, refused, allowed again) in one fixed-clock golden; the target
      stream's `ef replay --digest` printed immediately before the burst and after the
      refused span is byte-identical. Any drift in status, class, reason, `Retry-After`,
      the tip index, or the post-rollover acceptance fails the diff.
- [ ] Deterministic windows: every window-rollover assertion is driven by a stepped
      manual clock, not `sleep` — `grep -rnE 'setTimeout|setInterval|\bsleep\b'` over
      the fixed glob `packages/stream-server/test/**/*.ts` (the whole test tree, so no
      transitive-import enumeration is needed) exits nonzero (zero occurrences, no
      judgment calls). `verify-E2-T11` prints the exact file list the grep scanned to
      the transcript so the critic can diff it against the tree; any unavoidable
      exception must appear in a committed allowlist file
      (`packages/stream-server/test/no-sleep-allowlist.txt`) that `verify-E2-T11`
      exact-diffs the grep output against — enforced with exit-code semantics; the
      boundary request at exactly `windowEnd` obeys the frozen `floor` semantics
      (committed assertion).
- [ ] Rate-limit neutrality: for a `≥ 50`-request over-limit burst, head offset, event
      count, and `ef replay --digest` before and after are byte-identical (committed to
      the transcript); an SSE tailer attached across the burst receives zero frames. An
      append-then-reject implementation fails by count and digest.
- [ ] Ordering pinned: tokenless over-limit burst → `401` (not `429`); over-limit +
      garbage body → `429` (not `400`); under-limit + unauthorized stream → `403`/`404`
      (not `429`). All three are committed test assertions proving the frozen stage
      order.
- [ ] Isolation corpus airtight: every row of `evidence/e2-t11-isolation-corpus.jsonl`
      lands on exactly its declared inherited status/class/reason at every listed door
      (including long-poll and SSE), and its before/after store dump digest in
      `e2-t11-isolation-neutrality.txt` is byte-identical. A probe that returns `2xx`,
      returns `5xx`, returns a status outside the inherited set, or mutates the store
      fails this criterion.
- [ ] Live-tail parity: for each cross-tenant read/live-tail probe, the probing identity
      receives the same refusal on long-poll and SSE as on the pull `GET`, and observes
      zero frames of the target stream's data — committed assertions, not eyeballed.
- [ ] Cross-org escalation refused: B's dispatch of a forged `grant`/`membership` event
      onto orgA's `id:*` stream is refused (E2-T07 `403`/`404`), log-neutral, and the
      authorization view reduced from orgA's identity stream is byte-identical before and
      after (the escalation left no residue in the reduced grant set).
- [ ] Fuzz: the seeded isolation fuzzer (seed in `evidence/e2-t11-fuzz-seed.txt`)
      generates **at least 1,000 crafted ids per run for each door in the frozen fuzz
      door list** — `create`, `append`, `dispatch`, `GET`, `/events`, `/state`,
      long-poll, SSE, `GET /registry/public`, `GET /registry/org/:org`,
      `GET /registry/me` — with the count for each named door printed to the transcript
      and individually asserted `≥ 1000` by `verify-E2-T11`, so a run that skips a door
      or is under-sized at any door fails mechanically — and completes with zero `2xx`,
      zero `5xx`, and a post-run store digest equal to the pre-run digest.
- [ ] Matrix extended with sensitivity re-proven: the E2-T10 golden decision transcript
      is regenerated with the rate-limit axis and isolation rows
      (`evidence/e2-t11-matrix.txt`) and exact-diffed; the matrix's sabotage sensitivity
      sweep is re-run over the extended set and every sabotage goes red.
- [ ] Sabotage sensitivity (this task's own): in a scratch worktree, each of
      (a) rate limiter always allows, (b) `Retry-After` hardcoded to `0`, (c) limit
      stage moved *after* authorization, (d) name validation skips URL-decoding so
      `%2e%2e` reaches the store resolver, (e) prefix check uses `startsWith` so
      `fs:org` matches `fs:org-evil` — run `make verify-E2-T11` after each and it MUST go
      red; transcripts committed as `evidence/e2-t11-sensitivity.md`. Any sabotage the
      target stays green on refutes the apparatus.
- [ ] Limits-off compatibility: a server started with both env vars unset passes
      `verify-E2-T03`, `verify-E2-T07`, `verify-E2-T10`, `verify-E0-T09`, and the E1
      targets unmodified; additionally, the differential leg of `verify-E2-T11` fires a
      burst of at least `3 × MAX` requests (where `MAX` is the limit-on configuration
      used elsewhere in the target) at each of the three mutating doors of the
      limits-off server, prints the burst size per door to the transcript, and asserts
      zero `429` responses across the entire burst.
- [ ] Startup fail-closed: a server started with exactly one of the two rate-limit env
      vars refuses to start — nonzero exit AND the frozen stderr line
      `EF_RATE_LIMIT_MAX and EF_RATE_LIMIT_WINDOW_MS must be set together (got one without the other)`
      asserted verbatim by the test (per the Contract's frozen startup-error shape) —
      not start open or silently unlimited — committed assertion.
- [ ] All root gates pass: `pnpm format:check && pnpm lint && pnpm typecheck &&
      pnpm test && pnpm build` exit 0.
- [ ] Replay (browser layer): N/A — no browser-reaching surface (rate limits and tenant
      isolation are server-door behavior); mitigation per AGENTS.md is the stream-layer
      transcript + digest evidence above, declared explicitly in the Verification log.

## Adversarial verification

The claim under attack: "no authenticated identity can exceed its per-window budget on a
mutating door without a typed `429`; no crafted name or cross-tenant operation reaches
another tenant's stream from any door including live-tail; and every refusal — limit or
isolation — leaves the log byte-identical." Construct your own probes and mint your own
tokens throughout; never reuse the builder's corpus verbatim, and invent at least one
angle beyond these.

1. **Race the window boundary.** With the injectable clock, drive `MAX` accepted
   requests, then interleave the `MAX+1`-th refusal with a clock step to exactly
   `windowEnd`: confirm the frozen `floor` rule decides which window the boundary
   request belongs to and that `Retry-After` is never negative, never zero-while-refused,
   never fractional. Fire `MAX+1` requests concurrently (not serially) at a single
   subject/door and count the `429`s — exactly one request may be accepted as the
   `MAX`-th; a counter race that admits `MAX+1` or more refutes the limit. Then confirm a
   different `door-class` and a different `sub` each get their own fresh budget (no
   shared counter).
2. **Slip between the contracts.** Take every isolation probe class — traversal,
   encoding layers (single, double, mixed-case `%2E`), null byte, homoglyphs, prefix
   collision (`fs:org` vs `fs:org-evil` vs `fs:orgx`) — and fire each at **every** door,
   pull and live-tail. The refutation is any probe that returns `2xx`, `5xx`, or a status
   outside the inherited frozen set, OR that lands in a decode/resolve step *before* name
   validation (read the router + resolver source; don't trust the corpus). Byte-diff the
   whole store dump after the barrage against before — a single appended byte anywhere
   refutes side-effect-freedom.
3. **Cross-tenant live-tail.** As identity B, open a long-poll and an SSE tail on
   `fs:orgA/...` and on `id:<A-subject>` — streams B holds no grant on. B must receive
   the same refusal it gets on the pull `GET`, and must observe **zero** frames even as A
   actively appends. Any leaked frame — data, metadata, or error carrying stream content
   — refutes read isolation. Repeat with a subscription opened *before* B loses a grant
   (if T07 supports revocation) and confirm the frame flow stops. Then pull B's
   registry/index listings (every E2-T08 door) and grep them for any byte naming orgA's
   private repos — an existence leak in a listing refutes isolation even though no
   stream content moved.
4. **Grant escalation forgery.** As B, dispatch E2-T01 `grant`/`membership` events
   targeting orgA's identity stream to promote yourself; try the same via raw append and
   via a crafted stream id that resolves to orgA's `id:*`. Every attempt must refuse
   (`403`/`404`), and orgA's *reduced authorization view* must be byte-identical before
   and after — not merely "the append was rejected," but "the reduced grant set contains
   no trace of B." A residue in the view refutes isolation even if the HTTP status looked
   right.
5. **Order-of-operations probes.** Confirm the limit stage sits exactly where frozen:
   tokenless over-limit burst → `401` not `429`; over-limit + unparseable body → `429`
   not `400`; valid token, under limit, unauthorized stream → `403`/`404` not `429`;
   valid token, over limit, unauthorized stream → `429` (limit precedes authz). Any
   inversion refutes the stage order and, with it, the neutrality guarantee (a request
   that reaches parsing/authz before the limit could have side effects the limit was
   supposed to prevent).
6. **Persistence and toggle.** Confirm counters are pure in-memory: restart the server
   mid-window and confirm the budget resets (documented amnesia) — but also confirm
   nothing counter-related was written to the store or any side file (`git status` /
   store dump clean). Start a server with exactly one rate-limit env var and confirm it
   refuses to boot. Attempt to mutate `EF_RATE_LIMIT_MAX` in the running process env /
   SIGHUP and confirm the limit is unchanged (start-time only).
7. **Sabotage beyond the builder's.** In a scratch worktree: (a) make the limiter key on
   `sub` only (dropping `door-class`) so one door starves another — the per-key
   independence test must go red; (b) make `Retry-After` a constant — the transcript diff
   must go red; (c) change the prefix guard to `startsWith` — the `org`/`org-evil` probe
   must go red; (d) decode the path *after* resolving the store id — a traversal probe
   must reach the store and neutrality must go red. Any survivor refutes the measuring
   apparatus for that property.
8. **Cold-clone + golden re-derivation.** Run everything through
   `tools/verify/cold_clone.sh` with scrubbed env. Regenerate `e2-t11-burst-transcript.txt`
   and `e2-t11-matrix.txt` yourself against your own cold-started emulator and diff
   against the committed goldens — any nondeterminism (leaked timestamps, random ports,
   token bodies, clock drift) refutes their fitness as regression instruments. Re-run
   `verify-E2-T03`, `verify-E2-T07`, `verify-E2-T10`, `verify-E0-T09`, and the E1 targets
   on a limits-off server; any drift refutes "additive."

Refutation currency: an HTTP transcript of an over-budget mutation that landed without a
`429` (with the appended event's offset), a cross-tenant probe that returned `2xx` or
reached another tenant's stream (with the store-dump diff), a leaked live-tail frame of a
tenant's data, a residue in a reduced authorization view after a refused escalation, a
`Retry-After` that lies about the window, a digest pair that should match and doesn't, or
a sabotage run that stayed green. "The limit could be higher/lower" or "the 429 body could
say more" is a note, not a finding.

## Verification log
