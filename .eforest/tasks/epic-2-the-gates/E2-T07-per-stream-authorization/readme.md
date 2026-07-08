---
id: E2-T07
epic: 2
title: "Per-stream authorization at every door: read/write per branch, public/private repos, typed refusals that never touch the log"
priority: 207
status: pending
depends_on: [E2-T05, E2-T06]
estimate: L
capstone: false
---

## Goal

Every server door that touches a repo-namespaced stream — reads (`GET /streams/<id>`,
`/state`, `/events`, range/offset reads, snapshot bootstrap), appends
(`POST /streams/<id>`), dispatch (`POST /dispatch`), and live tail (long-poll **and**
SSE) — passes through one pure decision function,
`authorize(view, subject, streamId, op) → { allow: true } | { allow: false, refusal }`
in `@eforest/platform` (`packages/platform/src/authz/decide.ts`), evaluated against the
E2-T01 authorization view (memberships + grants reduced from identity streams) joined
with the E2-T06 namespace view (`visibility`, `owner`, `repoStreamPrefix`). The policy
is frozen: **public** repos (`visibility: "public"`) are readable and tailable by
anyone, including tokenless requests; writes (append + dispatch) to any repo stream
require a write grant **scoped to that branch's stream prefix**
(`fs:<org>/<repo>:<branch>`) — a grant on `main` confers nothing on any other branch;
the repo owner (E2-T06's `owner`) holds an implicit read+write grant on every branch of
that repo; **private** repos are *invisible* to non-members — every operation, read or
write, by a subject without a read grant answers with the typed 404 whose status, body,
and `error.reason` are **byte-identical** to the response for a repo that does not
exist (no 403, no existence leak). Authenticated subjects visible to a resource but
lacking the needed grant get 403 `authz/forbidden`; unauthenticated writes still die at
E2-T03's 401 before this task's logic runs. All refusal statuses and reason codes are
frozen in one typed refusal table, every refusal is log-neutral (head offset and
`ef replay --digest` dump digest byte-identical before and after), and authorization is
decided **per delivery, not per connection**: a `grant.revoke` event appended to the
identity stream observably flips a subject from allowed to refused mid-session — the
next poll refuses, an open SSE tail stops delivering and closes at the next delivery
attempt or heartbeat tick, whichever comes first (heartbeat interval frozen at 15
seconds, so an idle revoked connection closes within 15 seconds even if no event is
ever appended). Evidence: a scripted
allowed/refused suite under `make verify-E2-T07` where every allowed operation lands at
a cited offset, every refusal shows digest-before equals digest-after, and the
revocation flip is captured in a single transcript.

## Context

This is the task the epic is named for: the-gates. E2-T01 froze *who may do what* as a
reduced view; E2-T03 proved *someone* is at the door; E2-T06 built the namespace tree
with `visibility` and `owner` materialized truthfully. None of it is enforced yet — as
of E2-T06 any authenticated subject can read and write any stream. This task closes
that gap at every door at once, because an authorization layer with one uncovered
endpoint is not a partial success, it is a bypass. Downstream: E2-T09 scopes
`Stream-Seq` fencing per the writer identities this task admits, E2-T10 sweeps the full
identity × operation × visibility matrix against golden decision transcripts (this
task's scripted suite is the seed of that matrix, not a replacement for it), E2-T11
adds rate limits behind these gates, the E2-T12 capstone's "tokenless append refused
with the right status" is this task's contract performed on camera, and E3's browser
reads public repos through exactly the anonymous-read path frozen here.

Builds on: E2-T01 (grant/membership events and the authorization view — this task adds
**no new identity event types** except `grant.revoke` if E2-T01 did not already freeze
one; if it did, that shape governs and this task only consumes it, documenting the
reuse in the package README), E2-T03 (bearer verification — authentication precedes
authorization; a garbage token never reaches `authorize`), E2-T05 (CLI-minted tokens
are just subjects here; revoking a *grant* must flip a subject even while its *token*
remains valid — decisions read the view at decision time, never token claims),
E2-T06 (`resolvePath` and the `fs:<org>/<repo>` prefix — the one resolver, no
lookalike parsing of stream ids in the authz layer), E0-T11 (the door architecture the
middleware mounts on), E0-T04 (`ef replay --digest` as the neutrality instrument),
E1-T05/E1-T07 (the tail and snapshot-bootstrap read paths that must be covered — the
doors most likely to be forgotten).

Contract frozen here, versioned from this task forward:

- **Operations**: `read` (any non-mutating fetch of stream data: full read, range read,
  `/state`, `/events`, snapshot bootstrap), `tail` (long-poll and SSE live delivery —
  authorized per delivery cycle), `append` (raw protocol append), `dispatch` (the
  E0-T11 door). `append` and `dispatch` share one `write` decision; `read` and `tail`
  share one `read` decision. Exactly four door classes, two decisions.
- **Grant scope**: a write grant names a branch stream prefix
  `fs:<org>/<repo>:<branch>` and covers **all** streams under that exact prefix
  (`:meta`, per-file content streams) and nothing else. Scope matching is by exact
  frozen segmentation (org, repo, branch parsed via E2-T06's resolver), never by raw
  string-prefix comparison — `fs:o/r:main` must not match `fs:o/r:main2:meta`. A read
  grant names a repo (`fs:<org>/<repo>`) and covers all its branches. The repo owner
  holds an implicit read+write grant on every branch of the repo.
- **Decision table** (subject × visibility × grant → outcome), frozen. Grant
  implication rule, stated once and applied before every row: **a branch write grant
  on any branch of a repo implies a read grant on that repo** (ownership already
  implies both) — so "without read grant" below means the subject holds neither an
  explicit read grant, nor any branch write grant on the repo, nor ownership. There
  is no reachable "write grant but no read grant" state; the implied-read rows are
  still listed explicitly so they can be literal-asserted. Rows:
  public + read/tail → allow, for everyone including tokenless; public + write without
  grant → 401 `auth/unauthenticated` (E2-T03's exact frozen body) if tokenless, else
  403 `authz/forbidden`; public + write with branch grant or ownership → allow;
  private + any op without read grant (per the implication rule above) → 404
  `authz/not-found` (writes included — a non-member never learns the repo exists by
  writing to it); private + write, tokenless → 401 `auth/unauthenticated`
  (authentication precedes authorization; no existence leak because a tokenless write
  to a nonexistent repo yields the byte-identical 401); private + read grant or
  ownership + read/tail → allow; private + read grant but no write grant on the
  target branch + write → 403 `authz/forbidden`; private + branch write grant only
  (no explicit read grant) + read/tail → allow, via the implied read grant; private +
  branch write grant only + write on the granted branch → allow; private + branch
  write grant only + write on any other branch → 403 `authz/forbidden` (the implied
  read grant makes the repo visible, so the refusal is 403, never 404); private +
  branch write grant or ownership + write on the granted branch → allow. Unknown
  repo → the same 404 `authz/not-found`, same body bytes.
- **Refusal table** (extends E0-T11's class→code table and E2-T03's 401 contract,
  documented beside them in the package README): 401 `auth/unauthenticated` (E2-T03,
  unchanged), 403 `{ error: { class: "authz-denied", reason: "authz/forbidden" } }`,
  404 `{ error: { class: "authz-denied", reason: "authz/not-found" } }`. The 404 body
  for a private-invisible refusal and for a genuinely nonexistent stream is one
  constant — same producer function, byte-identical serialization. Changing any of
  these shapes later invalidates the golden transcripts committed here.
- **Revocation semantics**: `authorize` reads the identity + namespace views at head
  at decision time. For `tail`, the decision is re-evaluated before every delivered
  frame **and** on every SSE heartbeat tick (heartbeat interval frozen at 15
  seconds); after a revocation event is durable at identity-stream offset R, no
  event frame is delivered to the revoked subject on any covered stream, and an open
  SSE connection is closed with a terminal typed frame carrying the refusal at the
  next delivery attempt or heartbeat tick, whichever comes first — an idle stream
  with no subsequent appends still closes the revoked connection within one
  heartbeat interval (no silent hang, and no dependence on traffic). Long-poll
  requests after R get the refusal status directly.
- **Layer ordering**, frozen: authentication (E2-T03, 401) → authorization (this
  task, 403/404) → validation (E0-T11/E2-T06, 409/422). A schema-garbage dispatch to
  a private repo by a non-member is 404, never 422 — validators must not run for
  unauthorized subjects.
- **Out-of-scope streams**: identity streams (`E2-T01`) and namespace streams
  (`ns:root`, `ns:org:*`, E2-T06) keep the access rules those tasks froze; this task
  governs repo streams (everything under a resolved `fs:<org>/<repo>` prefix) and
  must not weaken the others — asserted, not assumed.

Non-goals: the standing conformance matrix and golden decision-transcript corpus
(E2-T10 — this task ships a scripted suite, T10 industrializes it), per-writer
`Stream-Seq` fencing (E2-T09), rate limiting and cross-tenant quotas (E2-T11), the
`__registry__` index and its own visibility filtering (E2-T08), grant-management UI or
any web surface (E3), org-role hierarchies beyond what E2-T01 froze, and timing-channel
hardening for the 404 path (the byte-equality guarantee is frozen here; constant-time
response is noted as future work, not claimed). Per AGENTS.md 3a this task has no
browser-reaching surface: Replay browser evidence is declared N/A with stream-layer
transcripts and digests as the mitigation.

## Deliverables

- `packages/platform/src/authz/decide.ts` — the pure decision function over
  `(identityView, nsView, subject | null, streamId, op)`, returning the frozen
  allow/refusal shapes; zero I/O, zero clock, property: same views + same inputs →
  same decision, unit-tested as a pure function against the full frozen decision
  table (every row literal-asserted).
- `packages/platform/src/authz/scope.ts` — grant-scope matching built on E2-T06's
  resolver segmentation (exported and reused; no second stream-id parser), with the
  `main` vs `main2` prefix-collision cases as committed unit tests.
- Server wiring: one authorization middleware mounted on **every** repo-stream door —
  read, range read, `/state`, `/events`, snapshot bootstrap, long-poll, SSE tail,
  raw append, `/dispatch` — plus a committed route inventory
  (`packages/platform/src/authz/doors.ts`) that enumerates the server's routes **from
  the router at runtime** and asserts each is classified (covered by the middleware,
  or explicitly exempt with a one-line reason: health checks, auth endpoints,
  identity/ns doors governed by prior tasks). A route the inventory cannot classify
  fails the build's tests — new doors cannot ship unguarded silently.
- `grant.revoke` consumption (or the E2-T01 shape, reused): tail delivery loop
  re-evaluates `authorize` per frame; SSE terminal refusal frame shape frozen and
  documented.
- The typed refusal table in the package README beside E0-T11's and E2-T03's tables,
  with the single 404-body producer function exported and used by both the
  private-invisible and true-not-found paths.
- `packages/platform/test/authz.test.ts` — over real HTTP with E2-T03 tokens: the
  full decision table exercised door-by-door (every op class × public/private ×
  owner/granted/member-read-only/non-member/tokenless), literal status + class +
  reason assertions, allowed ops asserting the landed offset, refused ops asserting
  head offset and dump digest byte-identical before/after; the byte-equality
  assertion between private-invisible 404 and true-not-found 404 (full body bytes,
  not parsed fields); layer ordering (garbage payload + no grant + private repo →
  404, never 422; tokenless write to public → 401, never 403).
- `packages/platform/test/authz.revoke.test.ts` — grant a subject, open both a
  long-poll loop and an SSE tail, append events (delivered, offsets asserted),
  append the revocation, append more events: assert zero post-revocation frames
  delivered, the SSE terminal refusal frame received, the next long-poll refused
  with the frozen status; then re-grant and assert the flip back to allowed.
- `packages/platform/test/authz.fuzz.test.ts` — seeded (seeds committed): random
  subjects/streams/ops/visibilities with random grant and revoke interleavings
  across ≥ 5 seeds, decisions checked against an independent in-process model (a
  plain-object oracle applying the frozen decision table — differential, not the
  decider checking itself); zero 5xx, every refusal log-neutral by digest.
- `packages/platform/fixtures/authz/` — golden identity + namespace logs (two
  subjects, one public and one private repo, branch-scoped grants, one revocation)
  with `*.expected.json` decision tuples for the scripted suite.
- `evidence/` — the allowed/refused suite transcript with offsets and digest pairs
  (`e2-t07-decision-suite.txt`), the 404 byte-equality proof
  (`e2-t07-invisibility.txt`), the revocation flip transcript with the identity-log
  offset R and the tail timeline (`e2-t07-revocation.txt`), the route-inventory
  classification (`e2-t07-doors.txt`), fuzz seeds + digests (`e2-t07-fuzz.txt`),
  sensitivity transcripts (`e2-t07-sensitivity.md`).
- `Makefile`: `verify-E2-T07` per the E0-T02 target contract — decision suite, both
  test files, the fuzz run, the door inventory, the sensitivity proofs, plus re-runs
  of `verify-E2-T03` and `verify-E2-T06` proving the gates are additive; nonzero
  exit on any failure.

## Acceptance criteria

- [ ] `make verify-E2-T07` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      with scrubbed env, output containing zero `SKIPPED:` lines.
- [ ] Decision-table completeness: every row of the frozen table is exercised over
      real HTTP against every door class it applies to (read doors individually:
      full read, range read, `/state`, `/events`, snapshot bootstrap, long-poll,
      SSE; write doors individually: raw append, `/dispatch`), with literal
      status/class/reason assertions; allowed operations assert the exact landed
      offset; transcript committed to `evidence/e2-t07-decision-suite.txt`.
- [ ] Refusal neutrality, universally: for **every** refused operation in the suite
      (403s, 404s, and the 401s inherited from E2-T03) whose target stream exists,
      head offset and `ef replay --digest` dump digest of the target stream are
      recorded immediately before and after and asserted byte-identical; for every
      refusal whose target does not exist (true-not-found 404s, tokenless 401s
      against nonexistent repos), the assertion is instead that the target remains
      absent — a read of the target immediately after the refusal still returns the
      frozen 404 with byte-identical body — and that the server-wide stream
      inventory (the runtime enumeration of existing streams, plus each existing
      stream's digest) is unchanged before and after, so the check is executable for
      every refusal class; an SSE tail held open on an existing target stream during
      a batch of refusals delivers zero frames.
- [ ] No existence leak: as a non-member, every operation against a private repo and
      the same operation against a nonexistent repo produce responses with identical
      status and **byte-identical bodies** (asserted on raw bytes), across every
      door class; likewise the tokenless pair: a tokenless write to the private
      repo and to a nonexistent repo produce byte-identical 401 bodies; proof
      committed to `evidence/e2-t07-invisibility.txt`. Any differing byte fails
      this criterion.
- [ ] Branch scoping is exact: a subject granted write on `fs:o/r:main` succeeds on
      `main`'s meta and content streams (offsets cited) and is refused with 403 on a
      sibling branch of the same repo, on `fs:o/r:main2:*` (prefix-collision case),
      and on the same branch name in a different repo — all log-neutral by digest;
      transcript rows committed to `evidence/e2-t07-decision-suite.txt`, citing at
      the stream layer the landed offset for every allow and the
      digest-before/digest-after pair for every refusal.
- [ ] Revocation flips mid-session: with a long-poll loop and an SSE tail both live
      for a granted subject, appending the revocation at identity offset R results
      in zero event frames delivered after R, an SSE terminal refusal frame, and the
      next long-poll refused with the frozen status — while the subject's bearer
      token remains valid and a *different* granted subject's tail on the same
      stream keeps receiving frames throughout; additionally the idle case: an SSE
      tail on a stream that receives **no** appends after the revocation is closed
      with the terminal refusal frame within one frozen heartbeat interval (15
      seconds), timestamped in the timeline; timeline committed to
      `evidence/e2-t07-revocation.txt`. A re-grant restores delivery.
- [ ] Layer ordering holds: a schema-invalid dispatch by a non-member against a
      private repo is 404 `authz/not-found` (never 422); a tokenless write to a
      public repo is E2-T03's exact 401 (never 403); an authorized subject's
      schema-invalid dispatch still gets E0-T11's 422 — all three literal-asserted,
      with the literal status/class/reason lines for each probe committed to
      `evidence/e2-t07-decision-suite.txt`.
- [ ] Door inventory is total: the runtime route enumeration classifies every route
      as guarded or exempt-with-reason, the classification is committed to
      `evidence/e2-t07-doors.txt`, and the test fails if any route is unclassified.
- [ ] Fuzz survival + differential oracle: all committed seeds complete with zero
      5xx and zero crashes, every server decision equal to the independent model's,
      every refusal log-neutral; seeds + digests in `evidence/e2-t07-fuzz.txt`.
- [ ] Sensitivity proof runs inside `make verify-E2-T07`: in a scratch worktree,
      (a) make `authorize` allow-all, (b) return 403 instead of 404 on the
      private-invisible path, (c) remove the per-frame re-check so tails decide only
      at connection open, and (d) unguard one read door (e.g. snapshot bootstrap) —
      each sabotage independently turns the target red; transcripts committed as
      `evidence/e2-t07-sensitivity.md`. Any sabotage the target stays green on
      fails this criterion.
- [ ] No regression: `verify-E2-T03` and `verify-E2-T06` re-run green against this
      tree (identity/ns doors unweakened), and all root gates pass
      (`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build`).
- [ ] Replay (browser layer): N/A — no browser-reaching surface; declared explicitly
      per AGENTS.md, with the decision-suite transcript, the byte-equality
      invisibility proof, and the revocation timeline as the stream-layer evidence
      currency.

## Adversarial verification

The claim under attack: "every door decides from one pure function over the reduced
views; public means readable by the world and writable by grant; private means
invisible, not merely forbidden; grants are branch-exact; refusals never move a byte
of any log; and revoking a grant flips a live session now, not at the next login."
Use your own subjects, streams, and seeds throughout; invent at least one more angle.

1. **Find the forgotten door.** Do not trust the builder's route inventory — derive
   your own from the server source and from runtime probing (walk the router, diff
   against `evidence/e2-t07-doors.txt`, then brute-force method × path variants:
   `HEAD` where only `GET` was tested, trailing slashes, percent-encoded stream ids,
   `POST` with method-override headers, the E1-T07 snapshot-bootstrap path, any
   internal/debug endpoint). As a non-member with a valid token, hit every route
   naming a private repo's streams: **any** response that returns stream data, a 403
   where the table says 404, or any status other than the frozen refusal for that
   layer refutes door completeness. One leaky door refutes the task title.
2. **Existence-leak differential, wider than bytes.** Beyond replaying the builder's
   byte-equality check with your own repos: compare the private-invisible 404 and
   the true-not-found 404 on headers (modulo `Date`), on behavior under `HEAD`, on
   SSE/long-poll connection behavior (does a tail on a private stream hang like a
   nonexistent one, or error differently?), and on error shape when combined with
   malformed offsets or a stale `Stream-Seq`. Then the oracle attack: as a
   non-member, attempt to *create* a repo whose name collides with an existing
   private repo — E2-T06 answers `ns/name-taken`, which is a legitimate,
   already-frozen disclosure channel; verify the task documents this boundary
   honestly rather than claiming invisibility it cannot have. Any *undocumented*
   channel that distinguishes private-existing from nonexistent (status, byte,
   header, or connection behavior) is a refutation.
3. **Grant-scope confusion, hand-crafted.** Mint grants and streams designed to
   break segmentation: repo `a` with branch `b:meta`-lookalike names if the grammar
   allows, repo pairs (`ab`/`a`), branch pairs (`main`/`main2`, `dev`/`dev-x`),
   grants written with raw string prefixes if any door accepts them. A write
   accepted on any stream outside the grant's exact branch prefix — cite the landed
   offset — refutes branch scoping. Also attack via `/dispatch` actions whose
   *effects* touch a second stream (E2-T06's org-stream mint pattern): confirm the
   decision covers every stream the dispatch writes, not just the addressed one.
4. **Revocation liveness, your own clock.** Re-run the flip with your own timing:
   open N concurrent tails as the granted subject, append the revocation, then
   immediately flood the stream with appends from an authorized writer. Count
   frames delivered to the revoked subject after identity offset R across all N
   connections: any post-R event frame refutes per-delivery authorization. Then the
   stale-view attack: restart the server between grant and revoke, and revoke while
   a tail is mid-long-poll; a decision cached at connection open (test sabotage (c)
   should have caught this — if the builder's sensitivity proof passed but your
   live probe leaks a frame, both the gate and its apparatus are refuted). Verify
   the token-vs-grant split: the revoked subject's token still authenticates (gets
   403/404, not 401) — a 401 here means the builder conflated revocation with
   token invalidation and the E2-T05 contract is broken.
5. **Neutrality under concurrency.** Interleave, from three clients: authorized
   appends, refused writes (403 and 404 classes), and refused reads, hundreds of
   rounds, while one SSE tail per stream watches live. After each round, dump and
   replay: final digest must equal the digest of the accepted subsequence alone
   (build it from your own transcript), and the tails must have delivered exactly
   the accepted events in order. Any refusal that shifted an offset, emitted a
   frame, or appears in any dump refutes log-neutrality; cite the offset.
6. **Differential oracle from scratch.** Write your own decider that never imports
   `@eforest/platform`: parse the golden identity + namespace dumps, implement the
   frozen decision table from this readme alone, and sweep it against the live
   server across the full subject × op × door × visibility product plus 200 fuzzed
   cases. Any disagreement refutes either the implementation or the frozen table —
   bisect which, and if the *readme's* table is the ambiguous party, that
   ambiguity is itself a finding against the task spec.
7. **Apparatus sabotage, your own.** Beyond re-running the builder's committed
   proofs: (e) make the 404-body producer return a fresh object per call with key
   order permuted — the byte-equality check must go red (a check comparing parsed
   JSON instead of bytes is a refuted apparatus); (f) drop one door from the route
   inventory's classified list — the inventory test must fail loudly, not pass on
   the shorter list; (g) point one `expected.json` decision at the wrong outcome
   and confirm red. Any green run under sabotage refutes the measuring apparatus
   and every transcript this task cites.
8. **Cold-clone, hostile-first.** Run everything through
   `tools/verify/cold_clone.sh` with scrubbed env. Before any grant exists, probe
   every door tokenless, with malformed tokens, and with a valid token holding zero
   grants: the world must be exactly "public readable, everything else refused per
   the table" from the first request — any warm-state dependence (a grant surviving
   from the builder's dev data dir, an allow-by-default window before the views
   first reduce) is a refutation.

Refutation currency: an HTTP transcript with the wrong status/class/reason at a named
door, a landed offset for a write the table forbids, a byte index where the two 404
bodies differ, a frame delivered after revocation offset R, or a digest pair that
should match and doesn't. "Private repos should also hide from timing analysis" is
the documented non-goal, not a finding. No refutation → promote your from-scratch
decider sweep and your nastiest scope-confusion case into the committed corpus; they
are the seed E2-T10 grows from.

## Verification log
