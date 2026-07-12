---
id: E0-T10
epic: 0
title: "Server-side redux read path: reducer registry, /events, /state with offset-keyed state cache"
priority: 10
status: implemented
depends_on: [E0-T04, E0-T05, E0-T07]
estimate: M
capstone: false
---

## Goal

`packages/server` grows the server-side redux **read** path on top of the stream core,
and state becomes an HTTP-addressable fact instead of a client-side computation. A
**reducer registry** (`src/redux/registry.ts`) binds a stream's declared type (a `type`
field in the stream's create config, frozen into `PUT /streams/{id}`'s accepted body from
this task forward) to a reducer module; a stream with no registered reducer serves
`/events` but answers `/state` with **422** and a body `{error, type}` naming the
unknown type (the code frozen in this document's Deliverables) — never a
5xx, never an empty-object impersonating state. `GET /streams/{id}/events` serves the raw
action log through the exact same read machinery as `GET /streams/{id}?offset=...` —
same offset semantics, same `Stream-Next-Offset` chaining, same error mapping, and the
same live modes the stream layer offers (plain reads at minimum; `live=long-poll|sse`
wherever E0-T06 has landed them — inherited by construction, not reimplemented).
`GET /streams/{id}/state[?offset={o}]` returns `replay(events)` from offset `-1` through
the reducer — computed by the **pure replay core from `@eforest/protocol` and nothing
else**; the server owns no second replay implementation — reduced up to and including
offset `o` (head when omitted), and the response carries the exact offset the state
reflects (`Stream-Offset` header) so every state claim is offset-anchored. An
**offset-keyed state cache** (`src/redux/state-cache.ts`, keyed by
`(streamId, reducerVersion, offset)`) makes repeated `/state` reads cheap: a hit returns
the cached state, a miss replays forward from the nearest cached ancestor, and a
`cache=bypass` query parameter forces a cold from-`-1` replay — cached and cold answers
are digest-identical at every offset, by construction and by proof. `/state` at head
digests byte-identical to `ef replay --digest` over the dump of the same stream's
`/events` log: one log, one replay path, one answer.

## Context

This task is bet 1 of ROADMAP.md ("One mutation door — state is `replay(events)` from
offset `-1`, always") arriving on the wire. E0-T05 froze the stream transport (create /
append / offset reads / fencing) and E0-T04 made `ef replay --digest` the citation
currency; this task composes them: the server now *answers* the question every critic
asks ("what is the state at offset o?") using the same frozen replay core the critic's
own `ef replay` uses. That single-replay-path property is what makes the differential
evidence below possible at all — if the server had its own fold, `/state` vs `ef replay`
agreement would prove nothing.

It also stands up the pattern every later entity rides (ROADMAP.md "One model to hold
them all"): issues, PRs, tasks, and identity views in Epics 2–6 are all
`(stream, reducer)` pairs read through exactly this `/state` `/events` surface, and the
E3 web app's `useServerReducer`-style hooks hydrate from `/state` + `Stream-Offset` and
tail `/events` live. The offset-keyed cache is the first "derived data is disposable"
proof (bet 4): the cache is a rebuildable index, and this task's evidence doctrine —
cache answers must digest-match cold replay or the cache is refuted — is the contract
all future reducer-materialized views inherit. Prior art: ElectricSQL durable-streams'
server-side redux layer (`/state` `/events` `/dispatch`, offset-keyed state caching) —
studied, rebuilt here.

Scope guard: **read path only.** `/dispatch` and action validation are E0-T11 — this
task adds no write surface, and appends still flow through E0-T05's `POST /streams/{id}`
(tests may use it to build logs). No cache persistence: the cache is in-memory and
process-local; losing it must change latency only, never answers. Reducer *extraction*
tooling is out of scope — the registry is fed by explicit registration (a committed
module map), not build-time magic. Live-mode `/events` tests beyond plain-read parity
are E0-T06's suite's job; here we prove `/events` delegates to the same read layer
(so live modes come along for free) rather than re-proving long-poll/SSE semantics.

Contracts frozen here: the `type` field in stream create config; the
`/streams/{id}/events` and `/streams/{id}/state` routes with their query parameters
(`offset`, `cache=bypass`), status codes, and the `Stream-Offset` response header;
canonical-JSON `/state` response bodies (so state digests are computable from the wire
bytes); and reducer versioning in the cache key (a reducer change may never serve state
cached under the old reducer). E0-T13's capstone and every Epic 3 hook parse this
surface forever after.

## Deliverables

- `packages/server/src/redux/registry.ts` — the reducer registry: `register(type,
  reducer, version)`, lookup by stream type, explicit error for unregistered types.
  Reducers themselves conform to the `@eforest/protocol` reducer signature the replay
  core consumes; the registry stores bindings, it never wraps or re-folds.
- `packages/server/src/redux/state-cache.ts` — offset-keyed cache: get/put by
  `(streamId, reducerVersion, offset)`, nearest-ancestor lookup for incremental replay,
  invalidation on stream deletion/recreation, and an instrumentation hook (hit / miss /
  bypass counters) the tests and verify target use to prove which path actually ran.
- `packages/server/src/redux/routes.ts` (wired into `src/http.ts`) —
  `GET /streams/{id}/events` delegating to the E0-T05 read layer (offset semantics,
  `Stream-Next-Offset`, error mapping, and live-mode passthrough all inherited, not
  duplicated); `GET /streams/{id}/state[?offset={o}][&cache=bypass]` returning the
  canonical-JSON reduced state with `Stream-Offset` set to the exact offset reflected;
  documented 4xx for: missing stream (404); malformed or out-of-range offset,
  explicitly including any offset past head, returns 400 — past-head never clamps to
  head; stream whose type has no registered reducer returns **422** with body
  `{error, type}` naming the unknown type. These codes are frozen here, in this
  document, which is the documentation of record. Every error path leaves log and
  cache untouched.
- `PUT /streams/{id}` config extension: optional `type` field accepted and persisted by
  the store (the `StreamStore` interface change is part of this task, and both the
  in-memory store and E0-T07's already-landed file-backed store must be updated to
  persist it), surfaced to the registry lookup.
- At least two committed reducers registered for tests: the `@eforest/protocol` default
  reducer (the one `ef replay` uses by default) bound to a test stream type, plus one
  alternate (usable via `ef replay --reducer`) to prove reducer-version cache keying.
- `test/redux.integration.test.ts` — against a real listening server: /events↔raw-read
  parity, /state at head and at every historical offset vs truncated replays, cache
  hit/miss/bypass digest equality (instrumentation-verified that each path executed),
  reducer-version key isolation, unregistered-type 4xx, error-path neutrality,
  /state-under-concurrent-append consistency (the returned state matches the returned
  `Stream-Offset`, whatever the race).
- `tools/verify/redux_state_check.sh` (or equivalent committed script) — drives a fresh
  server: creates a typed stream, appends a scripted action sequence, dumps `/events` to
  a JSONL file, runs `ef replay --digest` on the dump, fetches `/state` (cached and
  `cache=bypass`) at head and at ≥3 interior offsets, digests the canonical response
  bodies, and diffs every pair — exiting nonzero naming the first divergent offset.
- `Makefile`: `verify-E0-T10` composed per E0-T02's per-task contract (standard gates +
  the integration suite + `redux_state_check.sh`), added to `verify-all`, clean under
  `tools/verify/self_check.sh`.
- `evidence/`: the dumped event log + digest file from the final run, and the
  state-vs-replay comparison transcript at each checked offset.

## Acceptance criteria

- [ ] `make verify-E0-T10` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      with scrubbed env and no warm server or cache anywhere.
- [ ] Single replay path, proven differentially: after the scripted append sequence,
      the digest of `/state` at head (canonical response bytes) equals
      `ef replay --digest` over the dumped `/events` log — the verify target prints both
      digests and diffs them. Statically: the only code in `packages/server` that turns
      events into state is calls to the `replay()`/`reduceStep()` functions exported by
      `@eforest/protocol`; `redux_state_check.sh` runs a committed grep pattern
      (`grep -rn 'replay(\|reduceStep(' packages/server/src`) and fails unless every
      hit is in the whitelist of call sites the script embeds. The cache's
      nearest-ancestor incremental replay must itself be performed by calling the
      protocol core's step/fold function on the cached state — a reimplemented
      event-folding loop anywhere in the server fails this criterion. Decidable form
      of the static rule: no code in `packages/server` outside the whitelisted call
      sites may construct or modify a value that is ever serialized as a `/state`
      response body. Dynamically: the sentinel-sabotage angle (Adversarial
      verification #2 below) is this criterion's required dynamic evidence — its
      transcript, committed to `evidence/`, must show every `/state` answer's digest
      changing under a mutated protocol core.
- [ ] State-at-offset honesty: for ≥3 interior offsets `o`, `/state?offset={o}` digests
      identical to `ef replay --digest` over the `/events` dump truncated at `o`
      (inclusive), and each response's `Stream-Offset` header equals `o` exactly.
      Evidence: committed test + `redux_state_check.sh` output in the Verification log.
- [ ] Cache indistinguishability, both paths demonstrably exercised: the suite performs
      cold-miss, warm-hit, nearest-ancestor incremental, and `cache=bypass` reads at the
      same offsets; instrumentation counters prove each code path actually ran (a
      hit-count of zero fails the test even if digests match), and every cached/bypass
      response pair at the same `(stream, offset)` is byte-identical canonical JSON.
- [ ] /events adds nothing: `ef replay --digest` over a dump assembled by chaining
      `GET /streams/{id}/events` reads via `Stream-Next-Offset` equals the digest over
      the same stream dumped through E0-T05's raw read path, and equals the writer-side
      digest — defined as `ef replay --digest` over the JSONL the test writer emitted
      to disk before appending it to the stream. Evidence: asserted in
      `test/redux.integration.test.ts` and reproduced by `redux_state_check.sh`, whose
      output (all three digests) is committed to `evidence/`.
- [ ] Reducer registry boundaries: `/state` on a stream whose type has no registered
      reducer returns 422 with body `{error, type}` naming the type (log and cache untouched,
      asserted by digest-before/after); two streams of different types reduce through
      their respective reducers (different digests on identical event sequences,
      asserted in `test/redux.integration.test.ts` with both digests recorded in the
      Verification log); a
      reducer-version bump never serves state cached under the prior version —
      committed test flips the version and asserts a forced recompute.
- [ ] `type` survives the file-backed store: with the server running on E0-T07's
      file-backed `StreamStore`, PUT a typed stream, append events, restart the server
      (same data directory, stream *not* re-created), and `GET /state` must still route
      through the registered reducer — response digest-matched against
      `ef replay --digest` over the `/events` dump. Asserted by a committed test.
- [ ] `/state` during concurrent appends is offset-consistent: with a writer racing
      appends, every `/state` response's body digest matches `ef replay --digest` over
      the log truncated at that response's own `Stream-Offset` — no torn state, no
      state-ahead-of-offset, across ≥20 racing iterations. Asserted in
      `test/redux.integration.test.ts`; the per-response (`Stream-Offset`, body
      digest, truncated-replay digest) triples from the final run committed to
      `evidence/` so the critic can re-derive each match from the dumped log.
- [ ] Every `/state`/`/events` error path (404, bad offset, unregistered type) is
      log-neutral and cache-neutral: dump digest and cache counters unchanged across
      the failing request, asserted in the suite.
- [ ] All root gates pass: `pnpm format:check && pnpm lint && pnpm typecheck &&
      pnpm test && pnpm build` exit 0; `make _v-meta` stays green after the Makefile
      edits.
- [ ] Replay (browser) layer: N/A — server-only task, no browser-reaching surface;
      stream-layer evidence per AGENTS.md, declared explicitly in the claim.

## Adversarial verification

Written for the hostile critic. The claim under attack: "`/state` is nothing but
`replay(events)` through the one frozen replay core, at any offset, and the cache is
invisible." Any single success refutes.

1. **Your log, your offsets, your digests.** Ignore the builder's scripted sequence.
   Create your own typed stream, append your own action sequence (include events with
   unicode payloads, deep nesting, and key orders chosen to catch non-canonical
   encoding), dump `/events` yourself, and compare `ef replay --digest` against
   `/state` at head and at interior offsets *you* pick — including offset 0, the exact
   head offset, and one event before head. Any mismatch at any offset refutes the core
   claim. Then verify the measuring apparatus: append one more event and confirm the
   head `/state` digest changes; corrupt one byte of your dumped log and confirm
   `ef replay` goes red (E0-T04 sensitivity inherited — a comparison that can't fail
   proves nothing).
2. **Protocol-core sentinel sabotage (the second-fold hunt).** In a scratch worktree,
   mutate `@eforest/protocol`'s `replay()`/`reduceStep()` to inject a sentinel field
   into the reduced state. Then every `/state` answer must change digest: at head, at
   ≥1 interior offset, on a warm cache hit, under `cache=bypass`, and through the
   cache's nearest-ancestor incremental path (force it by fetching an interior offset,
   appending, then fetching head). Any `/state` answer that stays green — sentinel
   absent, digest unchanged — proves a second fold exists somewhere in the server and
   refutes the single-replay-path claim outright. This angle's transcript is the
   dynamic evidence the "Single replay path" criterion cites.
3. **Cache poisoning (the differential attack).** In a scratch worktree, sabotage the
   cache three ways — (a) return a cached entry for the wrong offset (off-by-one on
   ancestor lookup), (b) skip re-keying on reducer version, (c) mutate a cached state
   object in place after storing it (aliasing bug: a later incremental replay folding
   *onto* a shared cached object corrupts earlier offsets' answers) — and run the
   builder's suite and `make verify-E0-T10` after each. Any sabotage that stays green
   refutes the cache-equivalence evidence. Then attack aliasing live on the real build:
   fetch `/state?offset={o}`, advance the stream, fetch head, then re-fetch
   `/state?offset={o}` — cached and `cache=bypass` answers for the *old* offset must
   still be byte-identical.
4. **Bypass honesty.** Read the diff: does `cache=bypass` actually replay cold from
   `-1`, or does it consult the cache and relabel? Sabotage-check: poison one cache
   entry directly (test hook or scratch-worktree patch), then hit the same offset with
   `cache=bypass` — the bypass answer must be the *correct* digest, diverging from the
   poisoned cache answer, and the suite's hit/bypass counters must show the paths as
   claimed. A bypass that returns the poisoned value refutes the entire cache-vs-cold
   evidence scheme, which is this task's central proof.
5. **Offset fuzzing on `/state`.** `offset=` empty, `-2`, garbage, URL-encoded noise,
   an offset from a different stream, a lexicographic near-miss (flipped byte), an
   offset past head, a valid prefix of a real offset. Every one: 400 (404 for the
   missing-stream case), including past-head — never a clamp to head, never a 5xx,
   never a hang, never a state computed at some *other* offset silently. Follow each
   fuzzed request with a valid one and confirm the answer is uncontaminated (cache
   neutrality under garbage in).
6. **Registry edges.** `/state` on: an untyped stream, a typed stream whose type was
   never registered, a stream created before the reducer registered then read after.
   Each must produce the frozen 422 `{error, type}` response — and never a default
   `{}` state with a 200, which would let downstream consumers mistake "no reducer"
   for "empty state". Two streams with identical events but different registered
   reducers must digest differently; if they don't, the registry is decorative.
7. **Concurrency, your schedule.** Write your own racer: one writer appending while
   ≥2 readers hammer `/state` (mixed cached/bypass) and `/events`. For every `/state`
   response captured, independently verify body digest == `ef replay --digest` over
   the log truncated at that response's `Stream-Offset`. One torn read — a body that
   matches no truncation, or an offset header the body doesn't correspond to —
   refutes offset-consistency. Also confirm no reader ever observes a state reflecting
   an event `/events` hasn't yet served at that offset.
8. **/events delegation, not duplication.** Diff `/events` behavior against E0-T05's
   raw `GET /streams/{id}` with identical queries (offsets, errors, and — where E0-T06
   is verified — `live=long-poll` resume semantics): any divergence in status, headers,
   ordering, or `Stream-Next-Offset` chaining refutes the inheritance claim. Then read
   the diff for a second read implementation; a copy-pasted read path is a refutation
   of the deliverable even while behavior currently matches.
9. **Cold-start and residue hunt.** Everything through `tools/verify/cold_clone.sh`,
   scrubbed env. Then restart the server mid-suite: the in-memory cache vanishes —
   subsequent `/state` answers must be digest-identical to pre-restart answers for the
   same (re-created, re-appended) log, differing in latency only. Hunt for cache state
   leaking into evidence: transcripts that only replay green when the cache is warm, a
   digest computed once at build time and echoed, hit-counter expectations that encode
   the builder's exact request order.

## Verification log

### 2026-07-12 — builder — IMPLEMENTED

- Commits: `312bb94` (`feat: implement E0-T10 redux state read path`), `7b0aef8` (alternate/untyped registry coverage), `dfd9a3d` (critic rework: independent evidence, production registry isolation, and cache invalidation), `25f9d36` (unused-hook cleanup), and `c117a1a` (chained `/events` and protocol-sentinel proof).
- Gates passed: `CI=true pnpm format:check`; `CI=true pnpm lint`; `CI=true pnpm typecheck`; `CI=true pnpm test` (10 files, 85 tests); `CI=true pnpm build`; `make _v-meta`.
- Task target passed: `make verify-E0-T10`, including `tools/verify/redux_replay_path_check.sh`, the real-listening-server integration suite, and `tools/verify/redux_state_check.mjs`.
- Cold-clone target passed against code/evidence HEAD `c117a1a`, with the same target rerun successfully after the final metadata-only handoff: `tools/verify/cold_clone.sh verify-E0-T10` with scrubbed environment and no warm server/cache residue.
- Stream evidence: `.eforest/tasks/epic-0-the-seed/E0-T10-redux-state-and-events/evidence/e0-t10-writer.jsonl`; `e0-t10-events.jsonl`; independently chained `e0-t10-events-chained.jsonl`; per-offset truncated logs; `e0-t10-digests.txt`; `e0-t10-state-transcript.json`; `e0-t10-sentinel-transcript.json`; and forty `e0-t10-reader-*-{cached,bypass}.jsonl` logs. The final transcript records the independent pre-append writer, raw `/streams/{id}`, chained `/events`, cached `/state`, and bypass `/state` digests; interior-offset digests; cache hit/miss/bypass/incremental counters; twenty writer-racing iterations with two mixed-mode reader offset/body/replay digest triples each; and protocol-core sentinel propagation through cold, warm, incremental, and bypass paths.
- Claim: `/events` is parity-identical with the raw read route; `/state` uses the protocol `replay` core at exact historical offsets, preserves `Stream-Offset`, rejects past-head/non-event offsets, persists typed streams through file-store restart, isolates reducer versions, leaves unknown-type/error paths cache/log-neutral, and produces digest-identical cached, incremental, and bypass answers. Replay: N/A (server-only task with no browser-reaching surface) + mitigation: the committed event logs, canonical state digests, integration suite, replay-path whitelist, and cold-clone verification target provide stream-layer evidence.
