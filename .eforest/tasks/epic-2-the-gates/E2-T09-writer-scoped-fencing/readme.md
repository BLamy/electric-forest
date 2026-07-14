---
id: E2-T09
epic: 2
title: "Stream-Seq fencing scoped per writer identity: concurrent authenticated writers cannot fence each other out"
priority: 209
status: pending
depends_on: [E2-T07]
estimate: M
capstone: false
---

## Goal

The E0-T05 `Stream-Seq` writer fence becomes identity-scoped in
`packages/stream-server`: with auth enabled (E2-T03), the server tracks the
monotonically advancing sequence **per `(stream, writer identity)` lane**, where the
lane key is the verified token subject (`auth.sub`) that E2-T03 placed in the request
context — never anything the client names. Two authorized writers (per E2-T07's
per-stream write authorization) on one branch stream interleave fenced appends freely:
writer A at sequence `SA` and writer B at sequence `SB` each advance their own lane, and
neither's append ever produces a fencing conflict for the other. The failure semantics
are otherwise **byte-frozen from E0-T05**: an append bearing a stale `Stream-Seq` *from
the same identity* is refused with the exact E0-T05 conflict status (HTTP 409, response
`Stream-Seq` header naming that lane's current sequence, frozen error body), nothing
appended, head offset and `ef replay --digest` dump digest byte-identical before and
after. A forged-identity seq claim is refused outright: there is **no client-facing lane
selector** — any request carrying an explicit writer/lane designator (a
`Stream-Writer`-style header or an actor/lane field in the append body) is refused with
a typed 4xx before the fence is consulted, log-neutral, and an append authenticated as
identity B can never advance, reset, or observe-then-poison identity A's lane no matter
what `Stream-Seq` value it carries. With auth **disabled** (E2-T03's env vars unset),
behavior is bit-for-bit E0-T05: a single anonymous lane per stream, every E0-T09
conformance transcript and every prior `verify-E0-*`/`verify-E1-*` target green
unmodified. Lane state survives restart with the same durability contract E0-T05/E0-T07
froze for the per-stream sequence — a killed and restarted server refuses the same stale
sequences it refused before the kill. E1-T04's `stale-base` content fence is untouched:
it still rides the fenced append path underneath dispatch, now within the dispatching
identity's lane.

## Context

E0-T05's fence answers "did another write beat mine to this stream?" with one sequence
per stream — correct for the single-writer world of Epic 0, but a false-conflict
machine the moment Epic 2 makes multiple authenticated humans first-class: two teammates
with E2-T07 write grants on the same branch would perpetually fence each other out, and
the losing client's only move would be blind retry, turning the safety mechanism into a
liveness bug. The fix Epic 2's ROADMAP section names explicitly ("`Stream-Seq` fencing
scoped per writer identity") is to key the fence by the identity the platform now
actually has: E2-T03 verifies the bearer token and parks `{ sub }` in the request
context precisely so this task can consume it without re-verifying. Meanwhile the two
guarantees fencing exists for must not soften: a *single* client's stale retry (crashed
process resuming with an old sequence, duplicated request) is still refused exactly as
E0-T05 froze it, and no identity can interfere with another's lane — otherwise fencing
becomes an unauthenticated cross-tenant denial-of-service primitive, the opposite of a
gate.

Builds on: E2-T07 (per-stream write authorization — both writers in every scenario here
hold real grants; an unauthorized writer never reaches the fence, it dies at T07's
frozen refusal, and this ordering is asserted, not assumed), E2-T03 (the verified
`auth.sub` in the request context is the lane key; tokenless appends die at T03's 401
before fencing), E0-T05 (the fence mechanism, the 409 conflict shape, and the response
`Stream-Seq` header — frozen there, scoped here, never reshaped), E0-T07 (sequence-state
durability across restart), E0-T09 (the conformance suite is the no-regression
instrument for the auth-off path), E1-T04 (the orthogonal content fence that must keep
working through dispatch). Unblocks: E2-T10 sweeps identity × operation including fenced
appends; E2-T11's tenant-isolation probes assume no cross-identity interference channel
exists at the fence; E4's two-machine watchers are two writers on one branch — this task
is why they can both hold sequences without fighting.

Contract frozen here, versioned from this task forward:

- **Lane key**: with auth enabled, the fencing lane is `(streamId, auth.sub)` — the
  verified subject, exactly as E2-T03 resolved it. No header, query parameter, or body
  field selects a lane; the E0-T05 `Stream-Seq` request header keeps its exact name and
  monotonic-advance semantics, reinterpreted per lane.
- **Same-identity stale refusal**: byte-identical to E0-T05's conflict — HTTP 409, the
  response `Stream-Seq` header carrying the *lane's* current sequence, the same frozen
  error body, nothing appended. No new error class, no new reason string for this case.
- **Cross-identity independence**: an append's fencing verdict is a pure function of
  its own lane's state and its own `Stream-Seq` header. Another identity's appends,
  sequences, or conflicts never appear in it — including in the 409's response header,
  which must name the requester's lane sequence, never another writer's (leaking
  another lane's sequence is an information channel and a refutation).
- **Forged lane designator**: any mutating request carrying an explicit writer/lane
  designator — the reserved request header `Stream-Writer` (any casing) or an
  actor/writer/lane field in an append or dispatch body where the frozen schemas admit
  none — is refused before the fence runs: header form → HTTP 400 with E0-T05's frozen
  malformed-request shape; body form → 422 `schema-violation` per E0-T11. Both
  log-neutral. The exact statuses are pinned in the package README beside E0-T11's
  class→code table.
- **Auth-off equivalence**: with E2-T03's auth env unset, exactly one anonymous lane
  per stream exists and every observable (statuses, headers, offsets, digests) matches
  E0-T05/E0-T09 bit-for-bit.
- **Anonymous-lane seam**: the anonymous lane is a distinct lane keyed by a reserved
  sentinel that no E2-T02 token can mint as a verified `sub`; the sentinel value and
  the single enforcement point for its non-mintability (E2-T02 refusing to mint a
  token with that `sub`, or E2-T03 refusing to verify one, with the exact refusal
  status) are documented in the package README. Toggling E2-T03's auth
  env across a restart on the same `--data-dir` changes no fencing verdict in any
  lane, in either direction: authenticated identities never inherit, advance, or get
  fenced by the anonymous lane's history, and the anonymous lane never inherits any
  identity's sequence.
- **Durability**: lane sequence state has the same restart semantics as E0-T05's
  per-stream sequence under the E0-T07 file-backed store — kill and restart on the same
  `--data-dir` changes no fencing verdict.

Non-goals: rate limiting and abuse windows on repeated stale attempts (E2-T11), the
conformance matrix sweep of identity × operation (E2-T10), any change to E1-T04's
`stale-base` semantics or to the `Stream-Seq` wire names (frozen upstream), lane
garbage-collection policy for departed writers (additive later; unbounded-but-small is
acceptable at this scale and stated in the README), and any web UI. Per AGENTS.md 3a
this task has no browser-reaching surface: Replay browser evidence is declared N/A with
stream-layer transcripts and digests as the mitigation.

## Deliverables

- Identity-scoped lane keying in `packages/stream-server` — extending exactly the
  fencing module E0-T05 landed (that task's file naming governs; no parallel second
  fence), reading `auth.sub` from the E2-T03 request context, falling back to the
  single anonymous lane when auth is disabled.
- The forged-lane-designator guard: `Stream-Writer` header refusal (400, frozen
  malformed shape) at all three mutating doors, and schema refusal (422) for
  writer/lane fields smuggled into append/dispatch bodies — both before the fence is
  consulted, both log-neutral.
- Package README section: the lane-key contract, the two refusal rows added beside
  E0-T11's class→code table, the auth-off equivalence statement, the anonymous-lane
  seam contract (reserved non-mintable sentinel lane; auth toggle across restart on
  one `--data-dir` changes no verdict in any lane), the E2-T07-before-fence door
  ordering, and the stated lane-GC non-goal.
- `packages/stream-server/test/fencing-identity.test.ts` — over real HTTP with E2-T02
  emulator tokens for two subjects A and B, both granted write via E2-T07: a scripted
  interleaving (≥ 12 alternating fenced appends, sequences advancing independently)
  with zero 409s; A retrying a stale sequence → the frozen E0-T05 409 whose response
  `Stream-Seq` equals A's lane head (literal assertion) with before/after head offset
  and dump digest byte-equal; B sending A's exact current sequence value → accepted or
  refused purely by B's own lane state (both subcases exercised); the forged-designator
  refusals (header and body forms, exact status and body asserted, log-neutral), each
  form also sent carrying a `Stream-Seq` stale for the requester's lane and still
  drawing the guard's exact 400 / 422 — never the fence's 409 — proving the guard runs
  before the fence; an
  unauthorized third subject C dying at E2-T07's refusal without any lane being
  created for C — asserted by the pinned probe protocol, not internals: after C's
  E2-T07 refusal, grant C write via E2-T07, then (i) C's first append carrying the
  lane-initial `Stream-Seq` must be accepted, and (ii) a C append replaying the exact
  `Stream-Seq` value carried during the refused attempt must draw the identical
  verdict a never-before-seen identity draws on a fresh lane (both transcripts with
  literal status/header assertions); the E1-T04 dispatch-path
  subcase — identity A dispatches an edit with a stale base while identity B interleaves
  fenced appends on the same stream: E1-T04's frozen `stale-base` refusal fires exactly
  as frozen, B's lane sequence and next in-sequence append are unaffected, and the dump
  digest is byte-equal before and after the refused dispatch; auth-off mode asserting
  single-lane E0-T05 behavior on the same server binary.
- `packages/stream-server/test/fencing-identity.race.test.ts` — seeded (seed
  committed): two writer clients racing ≥ 100 fenced appends each on one stream with
  deliberate stale injections on both sides; per-attempt record (subject, `Stream-Seq`
  sent, payload digest, status, response `Stream-Seq`) written to the run's evidence;
  postcondition asserts every response is a success or the frozen 409 (no 5xx), every
  409's response header names the *requester's* lane sequence, and the final dump
  replays via `ef replay --digest` to a state containing exactly the accepted payloads
  in log order.
- `packages/stream-server/fixtures/fencing/` — a committed golden two-writer
  interleaving transcript: the scripted request sequence, the resulting event log dump,
  and a sibling `expected.json` with the replay digest; plus a refusal fixture (stale
  same-identity, forged header, forged body) with before/after digests.
- `evidence/` — the interleaving transcript + replay digests from two separate
  processes (`e2-t09-interleave-digests.txt`), refusal neutrality pairs
  (`e2-t09-refusals.txt` — covering the same-identity stale, forged-header, and
  forged-body cases, the E1-T04 stale-base dispatch subcase, plus the door-ordering
  transcripts: the tokenless 401, the grant-less E2-T07 refusal, and the subsequent
  authorized no-lane-created probes), the race harness records
  (`e2-t09-race.txt`), restart-proof
  transcript (`e2-t09-restart.txt`), and sensitivity transcripts
  (`e2-t09-sensitivity.md`).
- `Makefile`: `verify-E2-T09` per the E0-T02 target contract — golden interleaving
  replay (two processes, distinct pids), the two test files, refusal neutrality, the
  race run, the restart proof, the sensitivity proof, plus re-runs of the prior
  verifications proving the change is additive — resolution rule: for the E0-T05
  contract (resp. the E1-T04 contract), run the target the Makefile currently
  designates authoritative for that contract; if both the original target
  (`verify-E0-T05`, resp. `verify-E1-T04`) and its conformance-suite successor exist,
  run both, and either failing fails the target — and `verify-E2-T07`; nonzero exit
  on any failure.

## Acceptance criteria

- [ ] `make verify-E2-T09` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      with scrubbed env, output containing zero `SKIPPED:` lines.
- [ ] Two-writer interleaving: the committed golden transcript (subjects A and B, ≥ 12
      alternating fenced appends) executes with zero fencing conflicts, and the
      resulting combined event log replays via `ef replay <dump> --digest` to the
      digest committed in `expected.json`, in two separate node processes (distinct
      pids printed; harness fails on equal pids); transcript in
      `evidence/e2-t09-interleave-digests.txt`.
- [ ] Same-identity stale refusal is frozen E0-T05: writer A's stale-sequence append
      is refused HTTP 409 with the response `Stream-Seq` header literally equal to A's
      lane head and the exact E0-T05 error body, and the stream's head offset and dump
      digest are byte-identical before and after; pair committed in
      `evidence/e2-t09-refusals.txt`.
- [ ] Cross-identity independence: writer B sending the literal numeric value of A's
      current sequence is judged solely by B's lane (both the accept and refuse
      subcases asserted), no 409 returned to either writer ever carries the other's
      lane sequence in its `Stream-Seq` response header (literal assertions on every
      conflict in the race records), and in every committed transcript (the golden
      interleaving plus the race per-attempt records) every 409 issued to a writer is
      fully explained by that writer's own prior sends: the postcondition checker
      reconstructs each lane from the (subject, `Stream-Seq`, status) records and
      fails on any refusal not preceded by a same-lane advance.
- [ ] Forged-identity claim refused outright, and provably before the fence: a
      mutating request with a `Stream-Writer` header (any casing) → 400 with the
      frozen malformed shape; an append/dispatch body smuggling a writer/lane/actor
      field → 422 `schema-violation`; both asserted with exact status and body, both
      log-neutral by head offset and dump digest byte-equality. Each attack must
      additionally be sent carrying a `Stream-Seq` that is *stale for the requester's
      lane* — the response must still be the guard's exact 400 / 422, never the
      fence's 409 (a 409 on a designator-bearing request proves the fence ran before
      the guard and fails this criterion). After both attacks, A's and B's lanes
      accept their next in-sequence append unchanged; transcripts in
      `evidence/e2-t09-refusals.txt`.
- [ ] Door ordering: tokenless append → E2-T03's exact 401; token without an E2-T07
      write grant → E2-T07's exact frozen refusal; in both cases the log digest is
      unchanged and no fencing lane comes into existence for the refused identity,
      proven by the pinned probe protocol (not by inspecting internals): after C's
      E2-T07 refusal, grant C write, then (i) C's first append carrying the
      lane-initial `Stream-Seq` must be accepted, and (ii) a C append replaying the
      exact `Stream-Seq` value carried during the refused attempt must draw the
      identical verdict a never-before-seen identity draws on a fresh lane — both
      transcripts with literal status/header assertions; transcripts (tokenless 401,
      grant-less refusal, and both no-lane probe transcripts) in
      `evidence/e2-t09-refusals.txt`.
- [ ] Race integrity: the seeded two-writer race (≥ 100 fenced appends per writer,
      stale injections both sides) completes with zero 5xx, every response either a
      success or the frozen 409, and the final dump replays to a state containing
      exactly the accepted payloads in log order; per-attempt records committed in
      `evidence/e2-t09-race.txt`.
- [ ] Restart proof: after the interleaving, `kill -9` the server, restart on the same
      E0-T07 `--data-dir`, and assert A's and B's previously stale sequences are still
      refused and their next in-sequence appends still accepted — identical verdicts
      to pre-kill; transcript in `evidence/e2-t09-restart.txt`.
- [ ] Anonymous-lane seam: append fenced writes with auth off, restart with auth on on
      the same `--data-dir`, and assert neither A nor B inherits or can advance the
      anonymous lane's sequence while the anonymous lane's stale refusals are
      preserved; then the reverse order (build A/B lanes with auth on, restart with
      auth off) and assert the anonymous lane's verdicts are unchanged by identity
      history — no fencing verdict in any lane changes across either toggle;
      restart-toggle transcript appended to `evidence/e2-t09-restart.txt`.
- [ ] Sentinel non-mintability: mint (or attempt to mint) an E2-T02 token whose `sub`
      is the documented anonymous-lane sentinel value — either minting/verification
      is refused with the exact status pinned in the package README, or the token
      verifiably lands in a lane distinct from the anonymous lane (its fenced appends
      neither advance nor are fenced by the anonymous lane's history, asserted
      against the anonymous lane's pre-existing sequence state); literal transcript
      in `evidence/e2-t09-refusals.txt`.
- [ ] Auth-off equivalence: with E2-T03's auth env unset, the E0-T09 conformance suite
      (including its fencing transcripts) passes byte-identical against its committed
      goldens on this tree.
- [ ] Prior verifications additive, under the same resolution rule as the Makefile
      deliverable: for the E0-T05 contract (resp. the E1-T04 contract), the target
      the Makefile currently designates authoritative for that contract passes; if
      both the original target (`verify-E0-T05`, resp. `verify-E1-T04`) and its
      conformance-suite successor exist, both are run and either failing fails this
      criterion; `verify-E2-T09`'s re-run of `verify-E2-T07` passes likewise — each
      under its own frozen environment setup, unmodified.
- [ ] E1-T04 through the identity lane: with auth on, identity A dispatches a
      stale-base edit while identity B interleaves fenced appends on the same stream —
      E1-T04's frozen `stale-base` refusal fires unchanged (exact status and body), B's
      lane is unaffected (B's next in-sequence append accepted), and the dump digest is
      byte-equal before and after the refused dispatch; transcript in
      `evidence/e2-t09-refusals.txt`.
- [ ] Sensitivity proof runs inside `make verify-E2-T09`: in a scratch worktree,
      (a) collapse lanes back to one global sequence per stream (E0-T05 behavior under
      auth) — the interleaving criterion must go red; (b) key the lane from a
      client-controlled value (the forged header) instead of `auth.sub` — the
      forged-claim criterion must go red; (c) point the golden `expected.json` digest
      at a wrong value — red. Transcripts committed as
      `evidence/e2-t09-sensitivity.md`; any sabotage the target stays green on fails
      this criterion.
- [ ] All root gates pass: `pnpm format:check && pnpm lint && pnpm typecheck &&
      pnpm test && pnpm build`.
- [ ] Replay (browser layer): N/A — no browser-reaching surface; declared explicitly
      per AGENTS.md, with the interleaving transcript, refusal-neutrality pairs, race
      records, and restart proof as the stream-layer evidence currency.

## Adversarial verification

The claim under attack: "the fence is keyed by verified identity and nothing else —
teammates never conflict, a writer's own stale retry is still refused exactly as E0-T05
froze it, no identity can touch another's lane by any input whatsoever, and turning auth
off restores E0-T05 bit-for-bit." Use your own tokens, seeds, and schedules throughout;
invent at least one more angle.

1. **Cross-lane poisoning, your own schedule.** Do not reuse the builder's race. Mint
   your own A/B tokens, write your own racer with adversarial interleavings: B floods
   sequence values equal to, one above, and far above A's lane head; B triggers a 409
   and immediately replays the sequence named in *A's* last conflict response; B holds
   a long-poll open on the stream while A appends, then races the observed head. After
   every round, dump and replay: any A append refused because of B's activity, any
   accepted event out of its lane's sequence order, or any 409 whose response
   `Stream-Seq` matches the *other* writer's lane (check every conflict, not a sample)
   refutes independence — cite the request transcript and the offset pair.
2. **Lane-key forgery beyond the listed shapes.** The builder guards a header and a
   body field; attack the key derivation itself. Mint tokens with adversarial `sub`
   values through whatever claim-control surface E2-T02 froze: `sub` equal to another
   subject with trailing whitespace, differing only by Unicode normalization (NFC vs
   NFD), differing only by case, containing the lane-key separator character if the
   implementation concatenates `(streamId, sub)` into one string (probe with `sub`
   values embedding the stream id and plausible delimiters — a composite-key collision
   where `("s", "a:b")` and `("s:a", "b")` share a lane is a refutation), and a `sub`
   of the literal anonymous-lane sentinel the contract requires. Two distinct verified
   subjects sharing one lane, or one subject split across two, refutes the lane-key
   contract.
3. **The anonymous-lane seam.** Flip auth on and off across restarts on one
   `--data-dir`: append fenced writes with auth off (anonymous lane), restart with
   auth on, and probe whether either identity inherits or can advance the anonymous
   lane's sequence — then the reverse order. Whatever the behavior, it must be
   deterministic, documented in the package README, and free of a path where an
   authenticated writer is fenced by anonymous history it cannot see or vice versa; an
   undocumented verdict change across the seam is a refutation of the frozen contract
   (a contract hole, not a freedom). Also verify auth-off equivalence yourself: run
   the E0-T09 conformance suite against this tree with scrubbed env and diff its
   transcripts byte-for-byte against the committed goldens — any drift refutes the
   equivalence claim regardless of what the builder's re-run printed.
4. **Restart and durability sabotage.** Build lanes for A and B, `kill -9`, restart,
   and demand identical verdicts for stale and in-sequence appends on both lanes —
   then restart on a *copy of the stream store directory alone*: if lane state lives
   in a side file outside the E0-T05/E0-T07 store contract, verdicts will drift, and
   any drift is both a fencing refutation and a bet-4 finding. Truncate the store's
   last record (per whatever corruption semantics E0-T07 froze) and confirm fencing
   fails loudly per that contract rather than silently resetting a lane to zero — a
   lane that quietly resets accepts a replayed stale write, which is the exact
   corruption fencing exists to stop.
5. **Refusal neutrality under live observation.** Tail the stream via E0-T06 long-poll
   and SSE from a third client while driving every refusal class this task touches
   (same-identity stale, forged header, forged body, tokenless, grant-less): any frame
   emitted to the tailer during a refusal, or any dump-digest byte moved, refutes
   log-neutrality. Then fuzz the fence inputs: `Stream-Seq` values that are negative,
   zero, `2^53`, hex, empty, duplicated headers, and whitespace-padded — every
   response must be a frozen 4xx or a success, zero 5xx, and predicted before sent;
   any wrong status or a refusal that moved a byte is a refutation.
6. **Apparatus sabotage, your own.** Beyond re-running the builder's committed
   sensitivity proofs: (a) make the 409's response `Stream-Seq` header report a
   constant — the race postcondition must go red; (b) make the restart proof's
   assertions vacuous by pointing them at a fresh `--data-dir` — the harness must
   fail on the missing pre-kill state, not pass on an empty one; (c) swap one payload
   byte in the golden interleaving dump — `verify-E2-T09` must go red at the digest
   comparison. Any green run under sabotage refutes the measuring apparatus and, with
   it, every transcript cited in this task.
7. **Cold-clone, doors in order.** Run everything through
   `tools/verify/cold_clone.sh` with scrubbed env. Before presenting any token, probe
   the fenced append path tokenless and with malformed/expired tokens — anything but
   E2-T03's exact 401 (including a 409 from the fence, which would prove fencing runs
   before authentication) refutes door ordering; with a valid token but no E2-T07
   grant, anything but T07's exact refusal does the same. Extend the sweep to the
   designator guard: send a `Stream-Writer`-bearing (and body-smuggled) request whose
   `Stream-Seq` is stale for the requester's lane — anything but the guard's exact
   400 / 422, in particular a 409, proves the fence ran before the guard and refutes
   door ordering. Any log byte moved by any of these probes refutes neutrality.

Refutation currency: an HTTP transcript pair plus dump offsets showing cross-lane
interference, a 409 response header carrying the wrong lane's sequence, two subjects
provably sharing a lane, a verdict that changes across a restart, a digest pair that
should match and doesn't, or an exact transcript with the wrong status/class. "Writers
should be able to query each other's sequences" is a design note, not a finding. No
refutation → promote your best forged-`sub` case and your adversarial race schedule into
the committed corpus.

## Verification log
