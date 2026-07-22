---
id: E2-T08
epic: 2
title: "The __registry__ promoted to a real project index: a derived stream rebuilt by replay — losing the index loses nothing"
priority: 208
status: implemented
depends_on: [E2-T06]
estimate: M
capstone: false
---

## Goal

`@eforest/platform` (`packages/platform`) promotes the `__registry__` pattern into the
platform's project index, and the index is **pure derivation** — bet 4's clause made
executable: "anything that looks like a query index is a derived stream or
reducer-materialized view, rebuildable from the logs by replay; losing every index loses
nothing." A projector tails the E2-T06 namespace source logs (`ns:root` and every
`ns:org:<org>`) and appends derived events to the server-minted, client-unwritable stream
`__registry__` (the name E2-T06 reserved via `^__.*__$`); a registry reducer over
`__registry__` materializes the index; read doors
`GET /registry/public`, `GET /registry/org/:org`, and `GET /registry/me` answer
list-projects-and-repos per org, per authenticated user, and publicly — each in snapshot
and live (long-poll + SSE per E0-T06 semantics) — **visibility-filtered per requesting
identity via the E2-T01 authorization view**, never by the client. Every derived event
carries `source: { stream, offset }` naming the exact namespace event it derives from;
the projector's resume checkpoint IS the last derived event's `source` pointer read back
from `__registry__` itself — no side file, no counter outside a stream. Two new source
events are frozen here, additive to E2-T06's `ns.*` envelope:
`ns.repo.rename { v: 1, name, newName }` and
`ns.repo.set-visibility { v: 1, name, visibility }`, dispatched through the E0-T11 door
with E2-T06's name grammar and refusal machinery plus two new frozen reason codes
(`ns/repo-not-found`, `ns/not-owner`). The headline evidence is the bet-4 destruction
test inside `make verify-E2-T08`: build a namespace tree with creates, renames, and
visibility flips; record the index's canonical state digest; **delete the materialized
index entirely** — the `__registry__` stream's persisted data and every cached
materialization — rebuild it by replay from the source logs alone via
`ef registry rebuild`; the rebuilt state digest is byte-identical to the pre-deletion
digest. Plus the live proof: a tailing filtered index receives a freshly dispatched
`ns.repo.create` as a derived frame within the frozen live budget, cited by
`__registry__` offset.

## Context

ROADMAP.md, "Epic 2 — the-gates": "the `__registry__` pattern promoted into a real
project index as a derived stream." Bet 4 ("The four irreversible architectural bets")
is the load-bearing claim: no database anywhere, indexes are rebuildable derivations,
"losing every index loses nothing." E1-T08 explicitly deferred any server-side "list
branches / list repos" index to this task; E2-T06 built the namespace source of truth
and named this task as the consumer of its creation events. Downstream: E3's repo list
and org pages read these registry doors (every list view must "name the derived stream
or reducer it reads" — this is that stream), E4's `ef clone` discovers repos through it,
and E5's issue boards copy this exact derived-stream pattern. If the index here quietly
becomes a second source of truth — a cache that survives what the logs don't say, a
checkpoint file beside the streams — bet 4 dies in the first task that was supposed to
prove it.

Builds on: E2-T06 (the `ns.*` creation events and namespace reducer are the sole source
this projector reads; its name grammar, reserved-name rule, refusal shapes, and
serialization guarantee all apply to the two new events frozen here; the
`resolvePath` semantics are not duplicated — the registry answers *listing* questions,
the resolver answers *path* questions, both reduced from the same logs), E2-T01
(the authorization view supplying org membership for visibility filtering — transitively
verified via E2-T06's deps), E2-T03 (bearer verification: `GET /registry/me` requires a
valid token; mutating dispatches die at T03's 401 before anything here runs), E0-T06
(live read semantics the filtered tail rides on), E0-T10/T11 (reducer registry and the
validated dispatch door), E0-T04 (`ef replay --digest` as the evidence instrument).

Contract frozen here, versioned from this task forward:

- **Source events (additive to E2-T06)**: `ns.repo.rename { v: 1, name, newName }` and
  `ns.repo.set-visibility { v: 1, name, visibility }` append to `ns:org:<org>`;
  `newName` obeys E2-T06's `NS_NAME_RE` and reserved-name rule; the actor is
  server-stamped from the verified token exactly as in E2-T06 (payload actor fields are
  422 `schema-violation`). New refusal reason codes, both E0-T11 `validator-rejected`
  (409), both log-neutral: `ns/repo-not-found` (rename/set-visibility naming a repo not
  live in that org), `ns/not-owner` (actor is not the repo's recorded creator —
  a minimal creator-only rule frozen here; E2-T07's grant-based per-stream authorization
  supersedes/extends it later and says so in its own contract, this task documents the
  handoff in the package README). Rename collisions reuse `ns/name-taken`; bad names
  reuse `ns/invalid-name` / `ns/reserved-name`. A third frozen reason code (added in
  verification run 2, same E0-T11 `validator-rejected` 409, log-neutral) enforces
  prefix uniqueness: `ns/prefix-claimed` refuses a `ns.repo.create` whose name would
  re-mint a `fs:<org>/<name>` prefix still claimed by a live repo — a name an earlier
  live repo was created as and later renamed away from — checked strictly after
  `ns/name-taken` (a live listing-name collision keeps its E2-T06 reason). v1 has no
  repo delete/transfer, so a minted prefix is never freed; a future delete/transfer
  contract must revisit the claim set. Consequence, frozen: no two live repos ever
  share a `repoStreamPrefix` (E2-T07 authorization and E4 clone consume this field).
- **Derived events** on `__registry__`, exactly one per accepted source event, in source
  order per source stream: `registry.org-added`, `registry.project-added`,
  `registry.repo-added`, `registry.repo-renamed`, `registry.repo-visibility-changed`,
  each `{ v: 1, ...entity fields, source: { stream, offset } }` and **a pure function of
  the source event alone** — no wall-clock timestamps, no random ids, no projector
  state beyond the source logs. Changing any shape invalidates the goldens committed
  here.
- **`__registry__` is server-only**: it exists per E2-T06's reserved-name rule, is
  minted by the server, and every client write path to it — raw protocol append and
  dispatch alike — is refused with the frozen door semantics (E2-T03/E0-T11 doctrine),
  log-neutral.
- **Ordering/commutativity**: derived events for one entity are totally ordered by
  their single source stream's offsets; the registry reducer is commutative across
  entities (per-entity last-write-wins keyed by source offset), so any interleaving of
  distinct source streams reduces to the same canonical state. Consequence, and the
  invariant all evidence hangs on: the **materialized state digest** (`ef replay
  <registry-dump> --digest` through the registry reducer, canonical JSON) is identical
  between live accumulation and cold rebuild; additionally `ef registry rebuild` itself
  is deterministic — a frozen total rebuild order (`ns:root` first, then each
  `ns:org:<org>` in lexicographic org order, each stream in offset order) makes two
  independent rebuilds produce byte-identical `__registry__` logs.
- **Idempotence/checkpoint**: the projector resumes from the `source` pointer of the
  last derived event on `__registry__`; a source event is projected at most once
  (duplicate suppression by `source.offset` per source stream). Crash and restart at
  any point never duplicates or drops a derived event.
- **Read doors**: `GET /registry/public` (no token needed) → public repos only;
  `GET /registry/org/:org` → that org's projects+repos, private entries included iff
  the requesting identity is an org member per the E2-T01 view (anonymous or non-member
  gets the public subset, not a 403 — listing is filtered, not refused);
  `GET /registry/me` (token required, else E2-T03's 401) → every repo visible to that
  subject (owned + member-org private + nothing else). Each response is canonical JSON
  `{ asOf: <__registry__ head offset>, entries: [{ org, project, repo, visibility,
  owner, repoStreamPrefix }] }`, entries sorted by `(org, repo)`.
  **`asOf` and live-frame offsets are raw `__registry__` offsets, and this is frozen
  as NOT a visibility leak**: the head offset advances on every derived event,
  including events the requesting identity may not see, so `asOf` jumps between
  snapshots and offset gaps between visible frames on a tail are expected,
  contract-conformant behavior — they reveal at most hidden *event counts*, never
  entry contents. The visibility filter governs entry contents and frame payloads
  only; offset metadata is deliberately exempt (this also keeps resume-by-offset a
  plain raw-offset cursor, identical for every identity).
  **`repoStreamPrefix` is minted at repo creation and immutable**: `ns.repo.rename`
  changes the listing name only, never the stream prefix — a renamed repo's entry
  carries its new `repo` name alongside its original creation-time
  `repoStreamPrefix`, byte-identical before and after the rename. Live mode (long-poll
  and SSE, E0-T06 semantics, resumable by offset) emits only frames the requesting
  identity may see — **the filter applies to live frames exactly as to snapshots**,
  where a frame's visibility is judged against the entry's **post-event** state.
  **Visibility-loss transitions are frozen as suppression**: when a
  `registry.repo-visibility-changed` event makes an entry invisible to a connected
  tail's identity (public→private, seen from an anonymous or non-member tail), that
  tail receives **exactly zero frames** for the transition — the flip is never
  announced to identities that may no longer see the entry — and the tail's
  accumulated view is accepted as stale: it may continue to show the now-private
  repo until it takes a fresh snapshot. This staleness is contract-conformant, not
  a leak and not a correctness bug; there is no removal/tombstone frame in v1.
- **Live budget**: an accepted `ns.repo.create` becomes a visible frame on a connected,
  authorized live registry tail within **2000 ms**, measured dispatch-accept to
  frame-receipt in-process; the frame carries its `__registry__` offset.

Non-goals: per-stream read/write enforcement on `fs:` streams (E2-T07 — this task
filters *listings* only), grant/role-based rename permission beyond creator-only
(E2-T07), search or pagination (E3 can add read-side affordances; the contract here is
the full filtered list), repo delete/transfer (future additive events), any web UI (E3).
Per AGENTS.md 3a this task has no browser-reaching surface: Replay browser evidence is
declared N/A with stream-layer digests and live-tail transcripts as the mitigation.

## Deliverables

- `packages/platform/src/registry/events.ts` — the five frozen `registry.*` derived
  event schemas with runtime guards (exact fields, no extras, mandatory `source`), plus
  the two new `ns.repo.rename` / `ns.repo.set-visibility` source schemas reusing
  E2-T06's exported `NS_NAME_RE` (one regex, no second implementation).
- `packages/platform/src/registry/projector.ts` — the pure projection function
  `projectSourceEvent(event, offset, stream) → RegistryEvent` — **total over accepted
  source events**: every accepted `ns.*` event projects to exactly one derived event,
  there is no null/skip return, and an unrecognized event type on a source log is a
  loud projector error, never a silent drop (this is the executable form of the
  one-derived-event-per-accepted-source-event clause, and the set the crash-idempotence
  "none missing" scan is measured against) — plus the follower:
  tails `ns:root` and each `ns:org:<org>` (discovering per-org streams from projected
  `registry.org-added` state, bootstrap from `ns:root`), appends to `__registry__`
  through the server's internal append path, resumes from the on-stream checkpoint,
  suppresses duplicates by `source`. No file, map, or variable that outlives a process
  carries state not recoverable from the streams.
- `packages/platform/src/registry/reducer.ts` — the registry reducer over
  `__registry__`, registered in E0-T10's registry, canonical-JSON state
  (orgs → projects → repos with `visibility`, `owner`, `repoStreamPrefix`), digestible
  by `ef replay --digest` with zero registry-specific flags.
- `packages/platform/src/registry/filter.ts` — pure
  `filterForIdentity(state, authView, subject | null)` used by all three read doors and
  by the live-frame gate — the single filter, no lookalikes.
- Server routes for `GET /registry/public`, `GET /registry/org/:org`,
  `GET /registry/me` in snapshot + long-poll + SSE modes, wired through
  `filterForIdentity`; dispatch-door validators for the two new source events with the
  frozen reason codes.
- `ef registry rebuild --data-dir <dir>` — verifies `__registry__` is absent (or is
  told `--force` to discard it), replays the source logs in the frozen total order
  through `projectSourceEvent`, writes the derived stream, prints its state digest.
- `packages/platform/fixtures/registry/` — golden source logs + sibling
  `*.expected.json` (registry state digest, per-identity filtered listings) for at
  least: (a) **two-orgs-lifecycle** — two orgs, mixed public/private repos by two
  E2-T01 subjects, one rename, one private→public flip and one public→private flip;
  (b) **refusal-neutral** — the valid sequence interleaved with a rename of a missing
  repo, a non-owner rename, a rename onto a taken name, and a reserved `newName`,
  whose final digest equals the valid subsequence's digest alone.
- `packages/platform/test/registry.test.ts` — over real HTTP: happy-path
  create/rename/flip and literal-assert all three doors' filtered listings per
  identity (owner, org member, non-member, anonymous) including `asOf`; the new
  refusal codes each with before/after head-offset + dump-digest byte-equality; client
  writes to `__registry__` (raw append and dispatch) refused log-neutrally; the live
  test: an authorized SSE tail receives the new repo's frame within 2000 ms with its
  offset asserted, while a concurrently connected **anonymous** tail of the same
  creation (a private repo) receives nothing.
- `packages/platform/test/registry.rebuild.test.ts` — the destruction test as a test:
  build, digest, delete the `__registry__` persisted data via the store's own surface,
  rebuild, digest byte-equal; projector crash/restart at randomized offsets (seed
  committed) with no duplicate/dropped derived events and final digest equal to an
  uninterrupted run; two independent-process rebuilds byte-identical.
- `evidence/` — destruction transcript with pre/post digests, offsets, and the
  corrupt-leftover probe result (`e2-t08-destruction.txt`), two-process rebuild
  determinism transcript (`e2-t08-rebuild-determinism.txt`), live-tail transcript
  with dispatch-accept and frame-receipt timestamps and the cited offset
  (`e2-t08-live-tail.txt`), the visibility matrix
  (`e2-t08-visibility-matrix.txt`), refusal-neutrality pairs — the `ns/*` refusals
  **and** the `__registry__` client-write refusals (raw append and dispatch), each
  with before/after dump digests (`e2-t08-refusal-neutrality.txt`), the crash-idempotence transcript with the
  committed seed, kill schedule with offsets, interrupted-run and uninterrupted-run
  digests, and the duplicate-source scan result
  (`e2-t08-crash-idempotence.txt`), sensitivity transcripts
  (`e2-t08-sensitivity.md`), and the no-database sweep output
  (`e2-t08-no-database.txt`).
- `Makefile`: `verify-E2-T08` per the E0-T02 target contract — the destruction test,
  rebuild determinism across two processes, both test files, the visibility matrix,
  the live-latency check, refusal neutrality, the sensitivity proof, the no-database
  sweep, plus a re-run of `verify-E2-T06` proving the source-event extension is
  additive; nonzero exit on any failure.

## Acceptance criteria

- [ ] `make verify-E2-T08` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      with scrubbed env, output containing zero `SKIPPED:` lines.
- [ ] **Bet-4 destruction test**: the harness builds a tree exercising all five derived
      event types, records the registry state digest and `__registry__` head offset,
      deletes the materialized index entirely (the derived stream's persisted data and
      any cached materialization — the source `ns:*` logs untouched), runs
      `ef registry rebuild`, and the rebuilt state digest is byte-identical to the
      pre-deletion digest. The harness additionally probes for cache consultation: it
      plants a leftover materialization copy, corrupts one byte of it, and asserts
      the rebuild output is unaffected (proving the rebuild never read it) — this
      probe's result is part of the criterion. Transcript with both digests, both
      head offsets, and the corrupt-leftover probe result in
      `evidence/e2-t08-destruction.txt`. A digest that differs, or a rebuild output
      that changes under the corrupt-leftover probe, fails this criterion.
- [ ] Rebuild determinism: two rebuilds in two separate node processes (distinct pids
      printed; harness fails on equal pids) produce byte-identical `__registry__` logs
      and identical state digests, both matching the committed golden
      `expected.json`; transcript in `evidence/e2-t08-rebuild-determinism.txt`.
- [ ] Live proof: with an authorized live registry tail connected (SSE, and repeated
      under long-poll), a dispatched `ns.repo.create` appears as a derived frame within
      2000 ms of dispatch accept, and the test literal-asserts the frame's
      `__registry__` offset equals the head offset of the corresponding
      `registry.repo-added` event in a subsequent dump; transcript with timestamps and
      the offset in `evidence/e2-t08-live-tail.txt`.
- [ ] Visibility matrix, snapshot and live: for golden (a), each of {owner A, owner B,
      org-1 member, non-member subject, anonymous} × {`/registry/public`,
      `/registry/org/:org` both orgs, `/registry/me` where applicable} returns exactly
      the expected entry set (literal assertions, committed in
      `evidence/e2-t08-visibility-matrix.txt`); a private repo's creation emits zero
      frames to a concurrently connected anonymous/non-member live tail, where the
      test window is pinned to the frozen live budget: the anonymous/non-member tail
      must remain connected until after the concurrently connected **authorized** tail
      has received the corresponding frame (i.e., at least 2000 ms past
      dispatch-accept), and its received-frame log is asserted empty at that instant —
      a tail closed before the authorized frame arrives does not satisfy this clause;
      after a private→public
      flip the repo appears to anonymous, after public→private it disappears from
      fresh anonymous snapshots. And the frozen transition behavior, binary: a
      connected anonymous live tail held open across a public→private flip — until
      after a concurrently connected authorized tail has received the corresponding
      `registry.repo-visibility-changed` frame — receives exactly **zero** frames
      for the flip (per the suppression clause frozen in the contract; one frame is
      a leak, and this clause cannot be satisfied by a tail that disconnected
      early); asserted in the live half of the matrix, transcript in
      `evidence/e2-t08-visibility-matrix.txt`.
- [ ] Rename/visibility source events: rename reflects in listings (old name absent,
      new present, and the renamed repo's `repoStreamPrefix` literal-asserted
      byte-identical to its pre-rename value per the frozen contract — minted at
      creation, immutable, never follows the new name); each of `ns/repo-not-found`, `ns/not-owner`, and rename-collision
      `ns/name-taken` is HTTP 409 `validator-rejected` with the exact reason, with
      source-stream head offset and dump digest byte-identical before and after;
      pairs in `evidence/e2-t08-refusal-neutrality.txt`. Golden (b)'s final digest
      equals its valid subsequence's digest.
- [ ] `__registry__` is unwritable by clients: a raw protocol append and a dispatch
      targeting it are both refused with the frozen door semantics, and the
      `__registry__` dump digest is byte-identical before and after each attempt.
      Both attempts, each with its refusal transcript and its before/after
      `__registry__` dump-digest pair, are committed to
      `evidence/e2-t08-refusal-neutrality.txt` alongside the `ns/*` refusal pairs —
      this criterion must be auditable from that evidence file alone, without
      re-running the tests.
- [ ] Crash idempotence: the seeded crash/restart test (seed committed) kills the
      projector at randomized points and restarts it; the final `__registry__` log
      contains exactly one derived event per accepted source event (no duplicate
      `source` pairs, none missing) and its state digest equals an uninterrupted
      run's; transcript committed to `evidence/e2-t08-crash-idempotence.txt` with the
      seed, the kill schedule with offsets, the interrupted-run and uninterrupted-run
      digests, and the duplicate-source scan result.
- [ ] No database, provably: the committed sweep script scans the task's diff for
      every storage tell (`sqlite`, `postgres`, `pg`, `mysql`, `level`, `redis`,
      `lowdb`, `better-sqlite3`, `writeFile`/`fs.` writes, new workspace dependencies
      one by one) and **exits nonzero** on any write outside {the E0-T07 stream
      store, `evidence/`, gitignored test scratch} or any new workspace dependency
      matching the tell list, unless that tell is carried on a committed waiver line
      in the script with a stated reason — an unwaived tell fails this criterion, and
      "classified but tolerated" output is not a pass; the sweep's output (including
      any waiver lines) committed to `evidence/e2-t08-no-database.txt`; and the
      restart proof: `kill -9` the server,
      restart on a copy of the stream-store directory alone, and all three read doors
      answer identically for every golden identity — any answer that lived only in
      process memory or a non-stream file fails this criterion.
- [ ] Sensitivity proof runs inside `make verify-E2-T08`: in a scratch worktree,
      (a) make the projector silently drop `registry.repo-visibility-changed` events,
      (b) make `ef registry rebuild` reuse a stale cached materialization instead of
      replaying, (c) make `filterForIdentity` return the unfiltered state, and
      (d) unfilter **live frames only** (snapshots left correctly filtered) — each
      turns the suite red; (d) specifically must be caught by the live half of the
      visibility matrix, not by any snapshot assertion; transcripts committed as
      `evidence/e2-t08-sensitivity.md`.
      Any sabotage the target stays green on fails this criterion.
- [ ] No regression: `verify-E2-T06` re-runs green against this tree (the additive
      source events break nothing), and all root gates pass (`pnpm format:check &&
      pnpm lint && pnpm typecheck && pnpm test && pnpm build`).
- [ ] Replay (browser layer): N/A — no browser-reaching surface until E3; declared
      explicitly per AGENTS.md, with the destruction transcript, rebuild-determinism
      digests, live-tail offsets, and the visibility matrix as the stream-layer
      evidence currency.

## Adversarial verification

The claim under attack: "the project index is a pure derivation of the namespace logs —
delete it and rebuild it and nothing was lost; it updates live; and no requesting
identity ever sees an entry the authorization view doesn't grant." Use your own inputs
throughout; invent at least one more angle.

1. **Your own destruction, crueler than the builder's.** Build your own tree — more
   orgs, interleaved renames and visibility flips, a rename chain a→b→a — digest, then
   destroy: delete the `__registry__` persisted data while live tailers are still
   connected, `kill -9` mid-rebuild and rebuild again, and rebuild on a machine-fresh
   copy of *only* the source `ns:*` stream files (nothing else from the old data dir).
   Any rebuilt digest differing from pre-deletion, any rebuild that errors without the
   old index present, or any rebuild that silently reuses surviving cache (verify by
   corrupting one byte of a leftover materialization copy and confirming the rebuild
   output is unaffected because it never read it) refutes "losing the index loses
   nothing."
2. **The second-source hunt.** Run your own sweep over the diff — every new dependency,
   every `fs.` write, every module-level mutable — then the runtime probes: after
   building state, restart on a stream-store-only copy and demand all three read doors
   answer identically; delete the source `ns:org:<org>` log for one org and rebuild —
   that org's entries MUST disappear from the rebuilt index (an index that still lists
   them proves a shadow store and refutes bet 4 at this task's root).
3. **Visibility leak fuzz.** Mint tokens for subjects across orgs plus expired,
   malformed, and unknown-subject tokens. Drive a burst of private-repo creations and
   private→public→private flips while tails for every identity (including anonymous)
   are connected in both live modes; record every frame each tail receives. One frame
   or snapshot entry showing a private repo to a non-member — including a
   *transiently* visible entry during a flip — is a refutation with the frame and
   offset cited. Entry contents and frame payloads only: per the frozen contract,
   raw `asOf`/offset values legitimately advance on hidden events, and their jumps
   or gaps are explicitly not a leak — do not cite them as one. Also
   confirm `/registry/me` with no token is E2-T03's exact 401 and `/registry/org/:x`
   for a non-member filters rather than 403s, per the frozen contract.
4. **Ordering and commutativity, adversarially.** Synthesize rebuild inputs that
   permute cross-org source interleavings: state digests must be identical across all
   permutations (a differing digest refutes the commutativity clause and with it
   live-vs-rebuild equality). Then permute *within* one org's stream and check the
   invariant: the rebuilt derived log must mirror the permuted source order
   event-for-event (cite the offset pairs on any disagreement), and its state digest
   must equal an independent oracle's reduction of the permuted source (angle 5's
   oracle serves) — a rebuild that reproduces the *unpermuted* order or the
   unpermuted digest proves a shadow store or cache and is the refutation; a rebuild
   that faithfully mirrors the permutation and matches the oracle passes, since the
   permuted source is legitimately a different history. Race two renames of the
   same repo and a rename against a set-visibility: the source log must serialize them
   per E2-T06's guarantee and the derived log must mirror exactly that order — cite
   offsets if the derived order disagrees with the source order.
5. **Independent listing oracle.** Write your own script that never imports
   `@eforest/platform`: parse the raw `ns:*` dumps, apply the frozen last-write-wins
   and filtering rules yourself, and compare against all three doors for every golden
   identity plus fuzzed ones. Any disagreement refutes either the reducer, the filter,
   or the frozen semantics — bisect which with `ef bisect` against the derived log.
6. **Duplicate injection.** Beyond the builder's seeded crash test: run your own kill
   schedule (including killing between the source read and the derived append, and
   double-starting two projector instances against one data dir — whatever happens,
   the derived log must end with exactly one event per source event; two derived
   events citing the same `source` refutes idempotence, cite both offsets). Then
   attempt to write `__registry__` yourself: raw append, dispatch, and a stream
   created as `__registry__` before the server mints it — any client byte landing on
   it refutes the server-only clause.
7. **Apparatus sabotage, your own.** Beyond re-running the committed sensitivity
   proofs: (a) make the destruction test's "delete" a no-op (rename instead of remove)
   — the harness must fail loudly, not compare an index to itself; (b) point a golden
   `expected.json` digest at the wrong value — red; (c) make the live test's frame
   assertion accept any frame regardless of offset — the offset-equality check must
   catch a planted mismatch. Any green run under sabotage refutes the measuring
   apparatus and every digest cited here.
8. **Cold-clone, doors first.** Run everything through `tools/verify/cold_clone.sh`
   with scrubbed env; before presenting any token, probe the mutating doors
   (`ns.repo.rename`, `ns.repo.set-visibility`, `__registry__` writes)
   unauthenticated: anything but the frozen typed refusals, or any log byte moved,
   refutes door ordering or neutrality.

Refutation currency: a pre/post destruction digest pair that differs, a derived-log
offset pair showing a duplicate or dropped `source`, a frame or listing entry a
non-member received with the tail transcript and offset, a rebuild answer that survives
only outside the source streams, or an exact HTTP transcript with the wrong
status/class/reason. "The registry should paginate" is a design note, not a finding. No
refutation → promote your independent listing oracle and your cruelest destruction
sequence into the committed corpus.

## Verification log

### 2026-07-22 — builder — claim (run 1)

Commit: 59e91a1 (gates + verify-E2-T08 + cold clone all green at this commit; the cold-clone transcript and this claim land in the immediately following commits). The project index is pure derivation, bet 4 made executable:
`packages/platform/src/registry/{events,projector,reducer,filter,doors,rebuild}.ts`
promote `__registry__` into the platform's project index. `projectSourceEvent` is
total over accepted `ns.*` events (one derived event each, unknown types are loud
`RegistryProjectionError`s, no skip path); the follower tails `ns:root` + every
`ns:org:<org>` (discovered from projected `registry.org-added` state), appends
through the server's internal path with `sequence` fencing, and resumes from the
last derived event's `source` pointer read back from `__registry__` itself — no
side file, no out-of-stream counter. Two new frozen source events
(`ns.repo.rename`, `ns.repo.set-visibility`) ride E2-T06's envelope, grammar
(one exported `NS_NAME_RE`), and refusal machinery with frozen `ns/repo-not-found`
and `ns/not-owner` (creator-only rule; E2-T07 grant-model handoff documented in
packages/platform/README.md). Read doors `/registry/public`, `/registry/org/:org`,
`/registry/me` answer snapshot + long-poll + SSE, all filtered through the single
`filterForIdentity` over the E2-T01 view; `asOf`/frame offsets are raw
`__registry__` offsets for every identity per the frozen not-a-leak clause;
visibility-loss transitions are suppression (zero frames). `ef registry rebuild
--data-dir` refuses a surviving index without `--force` and replays the frozen
total order.

Commands (all green at this commit):
`pnpm format:check && pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build`
→ `CI=true make verify-E2-T08` (includes the full `verify-E2-T06` re-run) →
`tools/verify/cold_clone.sh verify-E2-T08` to completion, zero `SKIPPED:` lines
(transcript: `evidence/e2-t08-cold-clone.txt`).

Evidence (stream layer, all committed under this task's `evidence/`):

- Bet-4 destruction: `e2-t08-destruction.txt` — pre-deletion state digest
  9e1a49ac763bea8c2b7f6452cb1b6eca4af9150f8b94808db6224653e04f54e4 at head
  offset 0000000000000000_0000000000000010; server killed with SIGKILL;
  `__registry__` deleted via `DELETE /streams/__registry__` (read 404s);
  a planted leftover materialization copy corrupted by one byte; child-process
  `ef registry rebuild` reproduces digest and head offset byte-identically —
  the corrupt leftover provably unread. Plus the kill-9 restart proof: a fresh
  process on a copy of the stream-store directory alone answers all three
  doors byte-identically for every golden identity (19 recorded answers —
  corrected from "17" per the run-1 verdict; the transcript always recorded 19).
- Rebuild determinism: `e2-t08-rebuild-determinism.txt` — two distinct-pid
  node processes rebuild both golden fixtures to byte-identical `__registry__`
  logs matching the committed derived dumps and digests
  (two-orgs-lifecycle 9e1a49ac…, refusal-neutral 9f34c08e…).
- Live proof: `e2-t08-live-tail.txt` — SSE frame 41 ms and long-poll frame
  29 ms after dispatch-initiate (budget 2000 ms), frame offsets
  literal-equal to the dump head offsets of the corresponding
  `registry.repo-added` events.
- Visibility matrix: `e2-t08-visibility-matrix.txt` — 5 identities × all
  doors, literal entry sets asserted against the committed golden listings;
  live half: private creation delivers exactly 1 frame to the authorized tail
  and 0 frames to concurrently connected anonymous AND non-member tails held
  past the authorized frame; public→private flip delivers the frame to the
  owner and exactly 0 frames to the held-open anonymous tail; fresh anonymous
  snapshot flips accordingly (edge appears after private→public, open
  disappears after public→private). Renamed `grove` carries creation-time
  `repoStreamPrefix=fs:acme/forest` byte-identically in every listing.
- Refusal neutrality: `e2-t08-refusal-neutrality.txt` — all five `ns/*`
  refusal reasons (409 `validator-rejected`) plus the `__registry__`
  client-write refusals (dispatch → 404 `authz/not-found`; raw protocol
  append → the frozen 404 door refusal) each with before/after head offsets
  and dump digests, byte-identical — auditable from the file alone.
- Crash idempotence: `e2-t08-crash-idempotence.txt` — seed 0xe2708, 7 kills
  across before-append and after-append phases with derived offsets recorded,
  final log exactly one derived event per source event (0 duplicates,
  0 missing), digest equal to the uninterrupted run; double-start of two
  projectors over one store converges without duplicates.
- No database: `e2-t08-no-database.txt` — full-diff sweep vs the E2-T07
  verified base (storage engines, fs writes, new workspace dependencies one
  by one); two waived dependency lines with reasons, zero violations, restart
  proof cross-checked. The E2-T06 structural sweep also re-passes with
  line-anchored dispositions and a regenerated runtime-boundary manifest
  (additive extension of the frozen E2-T06 boundary files — review with this
  diff).
- Sensitivity: `e2-t08-sensitivity.md` — zero-mutation control green, then
  (a) projector drops visibility events → registry suite red;
  (b) rebuild reads a planted stale cache → destruction proof red at the
  corrupt-leftover probe; (c) unfiltered snapshots → matrix snapshot half
  red; (d) live-frames-only unfiltered → caught specifically by the live half
  of the matrix (snapshot half runs first and passes). All four attributable.
- Goldens: `packages/platform/fixtures/registry/{two-orgs-lifecycle,
  refusal-neutral}` — frozen source dumps + derived dump + per-identity
  listings; refusal-neutral's final digest equals its valid subsequence's
  digest (proven at generation and re-proven live by
  `tools/verify/e2_t08_evidence.mjs`, which re-drives the frozen script and
  byte-compares every dump).

Tests: `packages/platform/test/registry.test.ts` (7) and
`registry.rebuild.test.ts` (6) over real HTTP with the production wiring
(GrantAwareVerifier + IdentityStore + shared dispatcher + projector), plus the
23 pre-existing ns tests and the full suite (366 tests) green.

Replay: N/A (no browser-reaching surface until E3 — server internals, CLI, and
stream-layer doors only) + mitigation: the destruction/rebuild digests,
live-tail offset citations, visibility matrix, crash-idempotence transcript,
and the cold-clone verify-E2-T08 run above are the stream-layer evidence
currency for every claim.

### 2026-07-22 — critic — VERDICT: refuted (run 1)

Judged from cross-examined findings of eight independent hostile sessions against
60186ce (worktree /private/tmp/electric-forest-e2-t08). Much survived — the cold
clone re-run green by a critic, destruction/rebuild/crash/refusal transcripts all
byte-reproduced, an independent from-scratch reducer oracle matching the platform
digest, six code sabotages red inside the claimed gates, a pinned-window
suppression attack observing zero unauthorized frames — but two sabotages the
target stays green on falsify the sensitivity and visibility-matrix criteria on
their own terms, and the claim prose contradicts its own transcript.

- SABOTAGE SURVIVED — sensitivity criterion FAILED per its own closing clause
  ("Any sabotage the target stays green on fails this criterion", this readme
  line 311). Predicted a live-frames-only unfilter confined to the long-poll
  catch-up call site leaks private frames with every sensor green; observed
  exactly that in a scratch clone of 60186ce with only the identity filter at
  packages/platform/src/registry/doors.ts:177 (long-poll catch-up) bypassed:
  anonymous GET /registry/org/acme?live=long-poll&after=-1&waitMs=0 returned
  private frames registry.repo-added 'secret' @ __registry__
  0000000000000000_0000000000000003 and registry.repo-visibility-changed
  (grove→private) @ 0000000000000000_0000000000000010, while
  registry.test.ts + registry.rebuild.test.ts (13/13) and all seven
  tools/verify/e2_t08_*.mjs harnesses exited 0 (pristine control:
  ANONYMOUS_PRIVATE_FRAMES=0). Cause: every anonymous long-poll assertion in
  the suite fires before the dispatch (only the follow loop at doors.ts:192
  runs) and the matrix live half is SSE-only — the catch-up filter call site
  is sensor-blind against the frozen clause "the filter applies to live
  frames exactly as to snapshots" (line 128). Independently reproduced
  end-to-end; transcript work/critic-run1-longpoll-catchup-leak.txt. Demand:
  an anonymous AND non-member long-poll catch-up sensor over pre-existing
  hidden events (early `after`, waitMs=0, private entries already on
  __registry__) asserting zero private frames — in the matrix live half
  and/or registry.test.ts — plus a catch-up-only unfilter mutation in
  e2_t08_sensitivity.sh that this sensor turns red.
- SABOTAGE SURVIVED — visibility-matrix live half asserts too early, missing
  the criterion's pinned window (lines 250-256: unauthorized tails held "at
  least 2000 ms past dispatch-accept"). Predicted a within-budget delayed
  leak must turn the matrix red; observed a sabotage delivering hidden SSE
  frames to anonymous tails 500 ms late leaks the private registry.repo-added
  frame @ 0000000000000000_0000000000000011 to a held-open anonymous tail at
  +499 ms — inside the frozen 2000 ms budget — while
  node tools/verify/e2_t08_matrix.mjs exits 0 and byte-matches the committed
  evidence, because tools/verify/e2_t08_matrix.mjs:107-110,139-145 and
  packages/platform/test/registry.test.ts:336 assert the unauthorized frame
  logs empty at the authorized-frame instant (~41 ms), and the transcript
  self-records window=held-until-after-authorized-frame
  (evidence/e2-t08-visibility-matrix.txt line 28). The behavior itself
  survives — an independent attack held anonymous/non-member tails
  2505/2504 ms past dispatch-accept and saw 0 frames (work/critic-attacks.mjs)
  — the committed apparatus does not measure the criterion. Demand: hold the
  anonymous/non-member tails and re-assert their frame logs empty at
  >=2000 ms past dispatch-accept in both matrix live halves and the SSE test,
  add a delayed-leak (within-budget skew) sensitivity variant, regenerate the
  matrix evidence.
- FALSIFIED — claim prose vs its own transcript. Predicted the restart proof
  records the claimed "17 recorded answers" (this readme line 442); observed
  evidence/e2-t08-destruction.txt line 13 records
  restart-on-stream-store-copy doors-identical=true answers=19 (3 anonymous +
  4×4 authenticated, independently recounted and byte-reproduced). Evidence
  stronger than claimed; the claim misdescribes it. Demand: correct the run-1
  claim to 19.
- COVERAGE restart-proof identities — INSUFFICIENT. Predicted every golden
  identity's filtered listings compared across the kill-9 restart; observed
  carol (the seeded acme member) and dave answer 401 token-revoked on all
  authenticated doors on both sides (e2-t08-destruction.txt lines 26-32)
  because tools/verify/e2_t08_destruction.mjs doorAnswers signs tokens with
  no grant enrollment — and carol is the only golden identity whose
  private-repo visibility exercises the E2-T01 membership view
  (filterForIdentity short-circuits on owner for alice/bob,
  packages/platform/src/registry/filter.ts:33,45), so a membership view
  living only in process memory is undetectable by all committed evidence.
  Demand: issue deterministic CLI grants for carol and dave in the
  destruction seed pass and regenerate with their 200 filtered listings among
  the compared answers.
- COVERAGE long-poll live proof — INSUFFICIENT. Predicted the long-poll
  repetition literal-asserts the frame offset against the repo-added event in
  a subsequent dump as the SSE half does; observed it asserts only against
  computed ordinals (tools/verify/e2_t08_live.mjs:94-97 vs :58-64;
  registry.test.ts:375-376) and the transcript line carries no dump-offset
  field (evidence/e2-t08-live-tail.txt line 4). doors.ts:168-206 shows frames
  carry the persisted record's own offset, so no fabrication path — a
  near-miss on the criterion's letter. Demand: dump-assert the long-poll
  frame offset and record dump-offset in the transcript.
- COVERAGE loud-refusal arms — INSUFFICIENT. The claim's headline ("unknown
  types are loud RegistryProjectionError, no null/skip path"; strict reducer/
  doors) rests on no executed run: projector.ts:16-25
  (RegistryProjectionError/projectionError), reducer.ts:48-50 (reject),
  doors.ts:36-52 (RegistryStreamCorruptError/parseRegistryRecord error arm)
  all count 0 across every harness, both registry suites, and the full
  366-test suite (merged NODE_V8_COVERAGE/c8/vitest sets, independently
  re-measured; sensitivity sabotage (a) exercises silent-drop, not the loud
  path). Demand: tests feeding an unknown source type, a state-contradicting
  derived event, and a corrupt __registry__ record, asserting each loud
  throw.
- COVERAGE CLI usage refusals — INSUFFICIENT.
  packages/cli/src/registry-command.ts:26-27,38-39,44-45,49-50,67 (new in
  this diff) never executed in any recorded command; packages/cli/test has no
  registry test. Demand: a CLI test driving each usage-refusal branch,
  asserting exit 2 with REGISTRY_USAGE on stderr.
- COVERAGE production /registry route — INSUFFICIENT. PlatformWebApp's
  /registry branch (packages/platform/src/auth/routes.ts:122, this diff)
  count 0 in all merged coverage sets: every recorded door answer flows
  through createPlatformHandler→gateway directly, while production
  (production.ts:115) serves /registry exclusively through the unexercised
  app route. Demand: one recorded run answering a /registry door through
  runtime.app.handle (e.g. extend the production-composition test in
  cli-tokens.test.ts) with the filtered 200 body asserted.
- CONTRACT GAP — repoStreamPrefix collision (invented attack; no frozen
  clause violated, flagged before E2-T07/E4 consume the field). Predicted the
  prefix identifies exactly one repo; observed that after golden (a)'s
  forest→grove rename, ns.repo.create name=forest is accepted (202) and mints
  a second live repo carrying repoStreamPrefix=fs:acme/forest — public
  'forest' and private 'grove' share the prefix in one /registry/org/acme
  listing (registry.repo-added @ 0000000000000000_0000000000000002, source
  ns:org:acme@…_0001; and @ 0000000000000000_0000000000000013, source
  ns:org:acme@…_0006; ns/reducer.ts:76-88 frees the old name on rename,
  projector.ts:83 mints from the creation-time name; repro
  work/critic-attacks.mjs attack C). A public entry advertises the stream
  prefix under which a private repo's fs streams live. Demand: freeze prefix
  uniqueness (refuse create on a name whose fs:<org>/<name> prefix is still
  claimed by a live repo, or mint prefixes independent of names) or document
  collision semantics in the contract before E2-T07/E4 build on it.
- Noted, non-blocking: the frozen total rebuild order is enforced only by the
  verify script's golden byte-compare, not the vitest suite (a reversed org
  rebuild order stayed green under pnpm test alone and was caught by
  e2_t08_evidence.mjs inside make verify-E2-T08) — the make target and cold
  clone are load-bearing for that clause.
- SUITE: n/a until refutations clear. Staged promotion candidates in this
  task's work/ for the re-verify: the pinned-window suppression attack and
  valid-subsequence drive (critic-attacks.mjs, critic-valid-subsequence.mjs),
  the long-poll catch-up leak probe
  (critic-run1-longpoll-catchup-leak.txt + critic_leak*.mjs), the crueler
  destruction/rename-chain sequence (critic_destruction.mjs,
  critic-destruction-probe.mjs), and the independent no-import listing
  oracle.

Commands: git -C /private/tmp/electric-forest-e2-t08 diff e23d04f..60186ce;
node tools/verify/e2_t08_{evidence,matrix,live,refusals,destruction,crash,no_database}.mjs
(all byte-reproduce committed transcripts); bash tools/verify/e2_t08_sensitivity.sh;
tools/verify/cold_clone.sh verify-E2-T08 (exit 0, zero SKIPPED:); sabotage clones at
60186ce (doors.ts:177 catch-up unfilter; SSE frameVisible else-branch
setTimeout 500 ms); NODE_V8_COVERAGE + c8 + vitest coverage merged over all recorded
commands; python3 tools/build_queue.py

### 2026-07-22 — builder — rework claim (run 2)

Commit: d50a240 (gates + `CI=true make verify-E2-T08` green at this commit;
the to-completion cold-clone transcript — cloning HEAD d50a240…db36, exit 0,
zero `SKIPPED:` — lands in the immediately following commit, run-1 pattern).
Every confirmed run-1 finding addressed, in verdict order:

- SENSOR-BLIND SABOTAGE 1 (long-poll catch-up unfilter, doors.ts catch-up call
  site) — closed with a permanent catch-up sensor and an attributed sabotage.
  New sensor, in BOTH the matrix live half (tools/verify/e2_t08_matrix.mjs) and
  registry.test.ts ("filters the long-poll CATCH-UP half…"): anonymous AND
  non-member long-poll catch-up over pre-existing hidden events (after=-1,
  waitMs=0, private entries already on `__registry__`) literal-asserts exactly
  the two visible frames (repo-added forest @ …_0002, repo-renamed grove @
  …_0008), zero private frames (no secret/vault), raw cursor …_0011.
  e2_t08_sensitivity.sh gains sabotage (f): the catch-up call site alone
  unfiltered (snapshots + follow loop untouched) — matrix goes red on
  "long-poll catch-up leaked hidden frames", attribution grepped.
- SENSOR-BLIND SABOTAGE 2 (suppression asserted at the authorized-frame
  instant) — closed by pinning the window. Both matrix live halves and both
  registry.test.ts live tests now HOLD the anonymous/non-member tails to
  >= 2000 ms past dispatch-accept (assert heldMs >= 2000) and re-assert the
  frame logs empty at that instant; matrix transcript records
  `window-held-past-dispatch-accept-ms>=2000` on both live lines.
  e2_t08_sensitivity.sh gains sabotage (e): hidden SSE frames delivered 500 ms
  late (inside the budget) — matrix goes red on "leaked within the held 2000ms
  window", attribution grepped. Six sabotages total now, zero-mutation control
  first, all attributable (`evidence/e2-t08-sensitivity.md` regenerated).
- PREFIX COLLISION — frozen shut, refusing (the verdict's preferred arm).
  New frozen reason code `ns/prefix-claimed` (409 `validator-rejected`,
  log-neutral, precedence strictly after `ns/name-taken`), added to this
  readme's contract and packages/platform/README.md: a `ns.repo.create` whose
  name would re-mint a `fs:<org>/<name>` prefix still claimed by a live repo
  (created under that name, later renamed away) is refused at the dispatch
  door (ns/dispatch.ts `mintedPrefixNames` — a fold over the same accepted
  org log the reducer replays; v1 has no delete, so minted prefixes are never
  freed). The critic's attack C now refuses: permanent test
  ("prefix uniqueness" describe: freed-name create → ns/prefix-claimed;
  live-name create → ns/name-taken precedence; never-minted past listing name
  → still creatable), refusal-neutrality pair appended to
  `evidence/e2-t08-refusal-neutrality.txt`, and golden (a)'s frozen script
  gains a refused ts=12 step re-proven live by e2_t08_evidence.mjs (dumps
  byte-identical — the refusal is log-neutral, digests unchanged).
- RESTART-PROOF IDENTITIES — the destruction seed pass now enrolls
  deterministic CLI grants for carol and dave (e2_t08_server_worker.mjs);
  `evidence/e2-t08-destruction.txt` regenerated with all 19 answers 200,
  carol's private acme listings (grove+secret via the E2-T01 membership view)
  literal-asserted among the compared answers on both sides of the kill-9
  restart (e2_t08_destruction.mjs asserts carol/dave contents explicitly).
- LONG-POLL DUMP OFFSET — e2_t08_live.mjs and registry.test.ts now dump-assert
  the long-poll frame offset against the corresponding registry.repo-added
  event in a subsequent dump, exactly as the SSE half; transcript line carries
  `dump-offset=` and the committed-transcript validator requires it
  (`evidence/e2-t08-live-tail.txt` regenerated: sse delta 19 ms, long-poll
  delta 31 ms, offsets-equal + dump-offset both modes).
- CLAIM PROSE — run-1 claim corrected in place: 17 → 19 recorded answers.
- LOUD-REFUSAL ARMS — new "loud refusal arms" describe in registry.test.ts
  executes projector.ts:16-25 (unrecognized source type, org.create off
  ns:root, per-org event on ns:root → RegistryProjectionError),
  reducer.ts reject paths (unknown org, duplicate org, unknown repo, invalid
  event → `registry/reducer-invalid`), and doors.ts:36-52 (parseRegistryRecord
  on non-object, corrupt payload, missing offset → RegistryStreamCorruptError).
- CLI USAGE REFUSALS — new packages/cli/test/registry-command.test.ts drives
  all seven usage-refusal branches (exit 2, REGISTRY_USAGE on stderr, empty
  stdout) plus the generic failure arm; registry-command.ts now opens the
  store INSIDE the failure arm so an unusable --data-dir is the loud
  `registry rebuild failed:` exit-1 line, never an unhandled crash.
- PRODUCTION /registry ROUTE — cli-tokens.test.ts gains a production-
  composition test answering the registry doors through `runtime.app.handle`
  (routes.ts /registry branch): web-mint grant minted through the production
  app, ns tree dispatched through the production dispatch route, anonymous
  `/registry/org/prodorg` literal-asserts the filtered 200 body (public entry
  only, private repo absent), `/registry/me` lists both; the production
  projector materializes the frames. Both composition tests now stop the
  runtime projector.
- Run-1 non-blocking note also closed: registry.rebuild.test.ts byte-compares
  the rebuilt derived log against the committed golden dump, so a reordered
  rebuild goes red under `pnpm test` alone.
- Standing-apparatus updates forced by this diff (review with it, run-1
  precedent): the E2-T06 runtime-boundary manifest re-pins ns/dispatch.ts's
  new content digest, the E2-T06 no-database allowlist re-anchors the shifted
  E2-T08 harness/test lines and adds line-anchored dispositions for the
  dispatch fold's per-call Set and the new CLI test's tmpdir scratch (sweep
  re-attests, unallowlisted=0 stale=0), and the E1 provenance/manifest
  artifacts are refreshed via the script's own `--refresh-approved-e2` path
  for the rebuilt registry-command dist bytes (all inside the approved E2 CLI
  file set; zero E1-closure file-set changes).

Commands (all green, in order, at this commit): `pnpm format:check && pnpm
lint` → `pnpm typecheck` → `pnpm test` (380 tests; 366 → 380: +5 registry,
+8 CLI registry, +1 production route) → `pnpm build` → `CI=true make
verify-E2-T08` (byte-compares every regenerated transcript; includes the full
verify-E2-T06 re-run) → `tools/verify/cold_clone.sh verify-E2-T08` to
completion at this commit, zero `SKIPPED:` lines (transcript:
`evidence/e2-t08-cold-clone.txt`, committed in the following commit).

Evidence regenerated under this task's `evidence/`: e2-t08-visibility-matrix.txt
(held windows + catch-up lines), e2-t08-live-tail.txt (dump-offset both
modes), e2-t08-refusal-neutrality.txt (+ ns/prefix-claimed pair, byte-identical
before/after), e2-t08-destruction.txt (19 × 200 answers, carol membership
view across restart), e2-t08-sensitivity.md (six attributed sabotages),
e2-t08-no-database.txt (re-swept over the run-2 diff, zero violations, same
two waivers), e2-t08-cold-clone.txt. Unchanged and still byte-reproduced:
e2-t08-rebuild-determinism.txt, e2-t08-crash-idempotence.txt.

Replay: N/A (no browser-reaching surface until E3 — server internals, CLI, and
stream-layer doors only) + mitigation: the regenerated stream-layer transcripts,
digests, and offset citations above, re-earned by `make verify-E2-T08` and the
cold clone at this head.
