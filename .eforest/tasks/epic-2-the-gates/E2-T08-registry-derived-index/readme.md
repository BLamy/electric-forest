---
id: E2-T08
epic: 2
title: "The __registry__ promoted to a real project index: a derived stream rebuilt by replay — losing the index loses nothing"
priority: 208
status: in-progress
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

### 2026-07-22 — critic — VERDICT: refuted (run 2)

Judged from cross-examined findings of independent hostile sessions against
claim commit d50a240 (HEAD 9869c9f, code byte-identical; worktree
/private/tmp/electric-forest-e2-t08). Much survived, re-earned with critics'
own inputs: destruction (crueler rename-chain tree, corrupt/deleted leftover,
source-only machine-fresh rebuild, digest 9e1a49ac… reproduced), rebuild
determinism + pid-guard sensitivity, crash idempotence under two fresh seeds,
refusal neutrality incl. ns/prefix-claimed and an a→b→a rename chain,
__registry__ unwritable under a seven-probe battery, no-database sweep
line-sensitive under four sabotages, both run-1 sensor closures independently
re-sabotaged red, an independent no-import oracle agreeing with all three
doors for five identities, and frozen goldens that cannot regenerate at test
time. But the acceptance gate itself failed on an independent cold clone, and
one reachable branch of the single visibility filter is fully sensor-blind —
the same class that refuted run 1.

- FALSIFIED — acceptance criterion 1 (this readme lines 230-232: cold clone
  exits 0, scrubbed env, zero SKIPPED). Predicted
  `tools/verify/cold_clone.sh verify-E2-T08` exits 0 from a pristine clone at
  the claim head; observed exit 2 at 9869c9f: the sensitivity ZERO-MUTATION
  CONTROL went red ("control: registry suite RED"), registry.test.ts 10
  passed / 2 failed with 30000 ms vitest timeouts on the two run-2-added
  tests (long-poll CATCH-UP at registry.test.ts:475, 30217 ms;
  prefix-uniqueness at :527, 36372 ms) — after the identical suite passed
  380/380 earlier in the SAME clone (Duration 197.70s). Transcript preserved:
  work/critic-run2-cold-clone-exit2.log lines 96-98 (380/380), 179-222
  ("make: *** [_v-e2-t08] Error 1", "cold_clone: verify-E2-T08 FAILED
  (exit 2)"). The env scrub demonstrably worked; the load was the
  verification workflow's own parallel fan-out. "Works on the builder's
  machine-state" is a refutation, not an excuse (AGENTS.md cold-clone rule).
  Demand: make the gate honestly reproducible under concurrent load — timing
  margins sized for contention, cheaper fixtures, or gate-enforced
  single-tenancy — then re-earn the cold clone on an independently loaded
  machine.
- SABOTAGE SURVIVED — /registry/me's "owned" half is sensor-blind against the
  frozen clause "owned + member-org private + nothing else" (this readme
  lines 119-120). Predicted every reachable branch of the single filter is
  sensor-covered; observed mutating
  packages/platform/src/registry/filter.ts:121 (restrictToOwnRelations
  owner-fallback `.filter(([, repo]) => repo.owner === subject)` →
  `.filter(() => false)`) leaves the FULL committed suite green — 380/380,
  exit 0, independently re-applied with dist rebuilt and re-run — while real
  behavior changes through real doors: dave (no acme relation) dispatches
  ns.repo.create {daves-corner, private} to ns:org:acme (accepted 202) and
  /registry/me lists it unmutated, silently loses it mutated (probe
  work/critic-sabotage/dave-owner-probe.test.ts, green unmutated → red
  mutated). Cause: the golden tree's only repo owners (alice, bob) are their
  orgs' creators, and dave's /registry/me is asserted [] everywhere
  (registry.test.ts:167-170, evidence/e2-t08-visibility-matrix.txt
  "dave /registry/me []", evidence/e2-t08-destruction.txt:32) — no committed
  sensor reaches filter.ts:121's keep path, so even make verify-E2-T08 stays
  green. Reachable product state two ways: ns dispatch has no org-membership
  gate on ns.repo.create, and identity.membership.revoked
  (packages/identity/src/events.ts:106) strips a creator's relation after the
  fact. Demand: a permanent test (the probe is a ready template) where a
  subject owns a repo in an org they have no relation to — via non-member
  create and/or post-revocation — literal-asserting it present in
  /registry/me in snapshot AND live modes.
- ENV-DEPENDENCE — the promoted registry suite is broadly load-flaky, not one
  bad test: 3 sampled runs of
  `CI=true EFOREST_TEST_PREBUILT=1 pnpm exec vitest run
  packages/platform/test/registry.test.ts` at 9869c9f under host load 34-58
  produced 2 red / 1 green with a DIFFERENT test failing each time
  (refusal-neutrality at 30000 ms; SSE live-budget at its explicit 15000 ms;
  long-poll flip at its explicit 20000 ms + hook timeout), and the builder's
  own committed transcript shows the same 380-test gate degrading
  95.80s → 343.82s within one clone (evidence/e2-t08-cold-clone.txt lines 95,
  1713) — the committed evidence passed on luck-dependent margin. Budgets are
  stated in the gate itself (vitest.config.ts:34-35;
  registry.test.ts:370,:473), so this is not an unbudgeted performance nit.
  Samples preserved: work/critic-run2-load-samples.txt. Demand: harden the
  timing-sensitive sensors until repeated independent runs of the acceptance
  command converge on exit 0; record the re-earned cold clone.
- COVERAGE org-added/project-added visible arms — INSUFFICIENT. frameVisible's
  registry.org-added and registry.project-added visible arms
  (packages/platform/src/registry/doors.ts:98-101, this diff) recorded 0 hits
  in both coverage instruments; no evidence run ever delivered either frame
  to an identity that can see it (every authorized tail subscribes after
  head; the only after=-1 catch-ups are anonymous/non-member, for whom both
  frames are suppressed; matrix shows only repo-added/repo-renamed,
  evidence/e2-t08-visibility-matrix.txt:29-30). Mutating line 99 to
  `return false` survives every gate. Demand: an authorized tail/catch-up run
  receiving org-added and project-added frames literal-asserted visible, or a
  reasoned waiver in this readme.
- COVERAGE restrictToOwnRelations owned-no-relation arm — INSUFFICIENT.
  packages/platform/src/registry/filter.ts:124-128 (keep repos a subject OWNS
  in an org they have no relation to) recorded 0 hits in both instruments;
  reachable via identity.membership.revoked (a revoked repo creator's
  /registry/me depends exactly on this arm). The sabotage bullet's demanded
  test closes this too. Demand: revoke the repo creator's org membership and
  literal-assert /registry/me still lists the owned repo, or waive with
  reasoning.
- COVERAGE gateway registryRoute refusal arms — INSUFFICIENT. Nine refusal
  arms recorded 0 hits in both instruments: packages/platform/src/gateway.ts
  :389 (non-GET 405), :406 (decodeURIComponent catch), :410 (non-grammar org
  404), :413 (malformed path 404), :455 (malformed after 400
  invalid_follow_parameters), :462 (live mode neither sse nor long-poll 400),
  :466 (bad waitMs 400), fallback 401s :441/:444; only the /me-missing-token
  401 and valid-parameter paths ever ran. Demand: a refusal-table test
  driving each arm asserting the exact status/reason bodies, or waive
  441/444 individually as unreachable fallbacks.
- COVERAGE reducer reject arms — INSUFFICIENT (the run-2 claim's "reducer
  reject paths" prose overstates: 4 of 9 executed). The loud-refusal-arms
  describe (registry.test.ts:578-707) exercises reject sites 57/60/68/93
  only; packages/platform/src/registry/reducer.ts:70 (duplicate project),
  :77 (unknown project), :78 (duplicate repo), :95 (rename onto taken name),
  :116 (envelope non-object in replayRegistryStream) recorded 0 hits in both
  instruments — reject called exactly 4 times suite-wide. Not dead:
  rebuild.ts:64 feeds raw derived-stream records into replayRegistryStream.
  Demand: extend the describe to the remaining five arms (run-1's own
  precedent for this class), or classify each dead/waived in this readme.
- COVERAGE projector corrupt arms + silent-skip contradiction — INSUFFICIENT.
  parseSourceRecord's corrupt arms
  (packages/platform/src/registry/projector.ts:121-127: non-object record,
  missing offset) and the pass() "__registry__ record is not a registry
  event" arm (:188) recorded 0 hits everywhere (instrumented controls:
  parseSourceRecord invoked 3836x, corrupt arms 0x); and the new
  mintedPrefixNames fold guards (packages/platform/src/ns/dispatch.ts:79,:83)
  SILENTLY skip corrupt accepted-log records — the opposite of the frozen
  no-silent-skip policy (projector.ts:10-15) — and are unreachable dead code
  (dispatch.ts:191 replays the same array first, throwing
  ns/reducer-invalid). Demand: execute parseSourceRecord's corrupt arms and
  the pass() arm in the loud-arms describe; test, make loud, or delete the
  two silent-skip guards.
- SUITE: n/a until refutations clear. Critic promotion candidates staged in
  this task's work/ for the rework and the run-3 critic:
  critic-sabotage/dave-owner-probe.test.ts (the missing owned-outside-relation
  sensor, ready template), critic-run2-falsify.mjs, critic-run2-valid-subseq.mjs,
  critic2_oracle.mjs (no-import listing oracle), critic2_destruction.mjs
  (rename-chain destruction), critic-run2-registry-write-probes.mjs,
  critic-run2-restart-corrupt-leftover.mjs, own-seed crash transcripts, and
  the exit-2 cold-clone transcript critic-run2-cold-clone-exit2.log.

Commands: bash tools/verify/cold_clone.sh verify-E2-T08 (exit 2 at 9869c9f,
work/critic-run2-cold-clone-exit2.log); CI=true EFOREST_TEST_PREBUILT=1 pnpm
exec vitest run packages/platform/test/registry.test.ts x3 under load (2 red,
different test each time, work/critic-run2-load-samples.txt); full-suite run
with filter.ts:121 mutated (380/380 green, exit 0 — the refuting sabotage);
vitest v8 coverage + NODE_V8_COVERAGE/c8 over the 380-test suite and all
seven tools/verify/e2_t08_*.mjs harnesses.

### 2026-07-22 — builder — rework claim (run 3)

Commit: (this commit — gates + `CI=true make verify-E2-T08` green here; the
to-completion cold-clone transcript lands in the immediately following
commit, run-1/2 pattern). Every confirmed run-2 finding addressed, in
verdict order:

- COLD-CLONE GATE + ENV-DEPENDENCE (acceptance command red under load) —
  hardened with margins and cheaper fixtures, no assertion weakened: vitest
  hookTimeout/testTimeout 30s → 120s (harness scheduling budgets only — the
  frozen 2000 ms live budget and every literal product assertion are
  unchanged and still asserted in-test), the two explicit live-test budgets
  15s/20s → 60s/90s, `awaitRegistryLength` 5s → 15s, and the per-fixture
  2048-bit RSA keygen replaced by one process-cached signing key with a
  per-issuance `jti` keeping every JWT unique (the cache exposed a real
  fixture fragility first: byte-identical JWTs collided on
  `identity/active-token-hash` across the restart-on-copy proof — fixed by
  the `jti`, failure preserved in work/run3-pnpm-test-full.log).
  Re-earned: full 385-test suite green, six consecutive registry-suite
  runs green under concurrent load (work/run3-load-sample-{1..6}.log:
  1-3 are two-file runs at 35.5s/43.1s/53.7s during the rework's own
  fan-out; 4-6 record host load in-log — 1-min 8.3-9.1, 5-min 13.8-14.6 —
  while the seven sensitivity worktrees rebuilt concurrently), and the
  to-completion cold clone below. The first run-3 `make verify-E2-T08`
  attempt then caught the SAME class outside the registry suite — the
  identity corrupt-log CLI battery starved its explicit 30s budget at
  32.7s under load (work/run3-verify-attempt1.log:355) — so the three
  remaining explicit sub-120s scheduling budgets in UNPINNED test files
  were widened to 120s too (identity.test.ts:442, cli-tokens.test.ts:1075,
  three-way-merge.integration.test.ts:186; all completion timeouts on
  process-spawn/IO-heavy tests, zero product assertions touched).
  cli.test.ts and official.integration.test.ts keep their budgets: their
  source digests are pinned by the E1-T11 transport-provenance manifest,
  they have never been observed starving, and re-pinning E1 provenance for
  a timeout widen is disproportionate — accepted residual risk, on the
  record.
- SABOTAGE SURVIVED (/registry/me owned half, restrictToOwnRelations
  owner-fallback, filter.ts:121) — closed with a permanent snapshot+live
  test and an attributed sabotage. New registry.test.ts describe
  "owned-outside-relation": dave (no acme relation of any kind) creates a
  private repo in acme through the real dispatch door (accepted — no
  membership gate on ns.repo.create), and carol creates as a member before
  `identity.membership.revoked` strips her relation; `/registry/me`
  literal-asserts each owner's repo present — and NOTHING else — in
  snapshot AND long-poll live catch-up, frame offsets asserted, plus
  carol's owner-only `/registry/org/acme` view. e2_t08_sensitivity.sh gains
  sabotage (g): the exact run-2 surviving mutation (owner-fallback →
  `filter(() => false)`) — registry suite goes red, attribution grepped
  ("owned-outside-relation"). Seven attributed sabotages total,
  zero-mutation control first (`evidence/e2-t08-sensitivity.md`
  regenerated).
- COVERAGE frameVisible org-added/project-added visible arms
  (doors.ts:98-101) — the catch-up test gains an AUTHORIZED half: an acme
  member long-poll catch-up from after=-1 literal-asserts the full
  seven-frame (offset, type) list including registry.org-added @ …_0000 and
  registry.project-added @ …_0001. Self-checked: a `return false` mutation
  of either arm turns this sensor red.
- COVERAGE restrictToOwnRelations owned-no-relation arm (filter.ts:124-128)
  — executed by the same owned-outside-relation test (the post-revocation
  and non-member-create keep paths both drive it, snapshot and live).
- COVERAGE gateway registryRoute refusal arms — new refusal-table test
  drives :389 (non-GET ×2 → 405 method_not_allowed), :406+:410 (undecodable
  %80 → 404 not_found), :410 (non-grammar org → 404), :413 (extra segment;
  unknown single segment → 404), :455 (malformed `after` → 400
  invalid_follow_parameters), :462 (live=websocket → 400), :466 (waitMs
  -1 / 20001 / NaN → 400) — each asserting the exact frozen
  `{error:{code,reason}}` body. WAIVED, individually, per the verdict's own
  allowance: gateway.ts:441 (registryRoute's generic 401 malformed_token
  fallback — reachable only by a non-taxonomy error thrown mid-verification,
  e.g. the identity store failing between token verify and view read; it
  mirrors the dispatch door's frozen fallback at gateway.ts:375, and no
  committed run can force it without breaking the store mid-request) and
  gateway.ts:444 (`requireToken && subject === null` after the try —
  unreachable defensive fallback: `verifyAuthorization` of an absent header
  always throws UnauthorizedError(missing_bearer_token), caught and
  answered at :438-439, exactly what the committed /registry/me 401 test
  observes).
- COVERAGE reducer reject arms — the loud-refusal-arms describe now
  executes all nine reject sites: a new test drives reducer.ts duplicate
  project (:70), unknown project (:77), duplicate repo (:78), rename onto
  taken name (:95), and replayRegistryStream's envelope non-object arm
  (:116, via ["garbage"] and [null]) — each literal-asserting its
  `registry/reducer-invalid` message. (This also corrects the run-2 claim's
  overstated "reducer reject paths" prose the verdict flagged.)
- COVERAGE projector corrupt arms + silent-skip contradiction —
  parseSourceRecord's corrupt arms (projector.ts:121-127: non-object
  record, missing offset) and the pass() "__registry__ record is not a
  registry event" arm (:188) are executed through RegistryProjector.syncOnce
  over a stub StreamAdapter (corrupt `__registry__` AND corrupt ns:root
  source), each rejecting loudly; and the mintedPrefixNames fold's two
  silent-skip guards are now LOUD (`ns/prefix-fold-invalid` TypeError,
  never a skip — the frozen no-silent-skip policy made total), the fold
  exported and unit-tested over its accept path and all three refusal arms.
  Dispatch-path behavior is unchanged: the same accepted log is
  replay-validated before the fold runs, so the loud arms are defensive
  depth, now executed.

Standing-apparatus updates forced by this diff (review with it, run-1/2
precedent): the E2-T06 runtime-boundary manifest re-pins ns/dispatch.ts's
new content digest, and the E2-T06 no-database allowlist re-anchors the
shifted dispatch-fold Set and registry.helpers token-cache lines and gains
a run-3 disposition section for the two timeout-widened standing suites
that thereby entered the sweep's diff-set — identity.test.ts (E2-T01
mkdtemp bisect scratch, 4 tells) and three-way-merge.integration.test.ts
(stream-fs branch writeFile calls through the dispatch door, 14 tells;
the sweep's writeFile tell matches the streamfs API name) — every one a
pre-existing tell, none introduced by run 3 (sweep re-attests,
unallowlisted=0 stale=0). `evidence/e2-t08-no-database.txt` is
regenerated for exactly two new lines: the timeout-widened
identity.test.ts and three-way-merge.integration.test.ts entered the
since-E2-T07 diff-set, and their pre-existing mkdtemp-scratch tells are
swept as allowed (violations=0, no new storage or write tells introduced
by any run-3 code).

Commands (all green, in order, at this commit): `pnpm format:check && pnpm
lint` → `pnpm typecheck` → `pnpm test` (385 tests; 380 → 385: +5 registry)
→ `pnpm build` → `CI=true make verify-E2-T08` (byte-compares every
committed transcript; includes the full verify-E2-T06 re-run and the
seven-sabotage sensitivity proof) → `tools/verify/cold_clone.sh
verify-E2-T08` to completion at this commit, zero `SKIPPED:` lines
(transcript: `evidence/e2-t08-cold-clone.txt`, committed in the following
commit).

Evidence regenerated under this task's `evidence/`: e2-t08-sensitivity.md
(seven attributed sabotages, (g) new), e2-t08-no-database.txt (two allowed
tell lines, above), e2-t08-cold-clone.txt. Unchanged and still
byte-reproduced by `make verify-E2-T08`: e2-t08-destruction.txt,
e2-t08-rebuild-determinism.txt, e2-t08-live-tail.txt,
e2-t08-visibility-matrix.txt, e2-t08-refusal-neutrality.txt,
e2-t08-crash-idempotence.txt.

Replay: N/A (no browser-reaching surface until E3 — server internals and
stream-layer doors only) + mitigation: the stream-layer transcripts, digest
and offset citations above, re-earned by `make verify-E2-T08` and the cold
clone at this head.
