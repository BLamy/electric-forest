---
id: E0-T05
epic: 0
title: Durable-stream server core: in-memory store, PUT create, POST append, offset GET, Stream-Seq fencing
priority: 5
status: pending
depends_on: [E0-T02, E0-T03, E0-T04]
estimate: L
capstone: false
---

## Goal

`packages/server` serves the durable-streams HTTP protocol core over an in-memory store,
and it is the first externally visible behavior in the repo — drivable end-to-end with
nothing but `curl`. `PUT /streams/{id}` creates a stream (201 on create; idempotent
re-PUT with identical config succeeds without mutating the log; conflicting re-PUT is
refused with 409 and the log digest unchanged). `POST /streams/{id}` appends a batch of
events in the frozen `@eforest/protocol` envelope, assigns each event the next opaque
lexicographic offset, and enforces `Stream-Seq` writer fencing: a monotonically advancing
per-stream writer sequence where any sequence less than or equal to the current one
(stale *or* replayed — replays are refused, not deduplicated) is refused with 409 and
the response's `Stream-Seq` header names the current sequence — the losing writer
learns exactly where it stands and the log is untouched. `GET /streams/{id}?offset={o}`
returns events strictly after offset `o` (`offset=-1` means from the beginning), sets
`Stream-Next-Offset` so a reader can chain reads with no gaps and no duplicates, and
returns pinned errors for a missing stream (404) and a malformed offset or append body
(400); a *well-formed* offset is treated purely as a lexicographic position — past the
head it yields 200 with an empty batch and `Stream-Next-Offset` equal to the current
head offset, and one that never appeared in this stream yields 200 with every event
whose offset sorts strictly after it — every error path leaving the log
byte-identical. A server-side dump of any stream replays through `ef replay --digest` to
the same digest as the events the client appended: the server adds transport, never
meaning.

## Context

E0-T03 froze the meaning layer (event envelope, canonical JSON, opaque lexicographic
offsets, SHA-256 state digests, pure replay core); E0-T02 froze the verify spine this
task must be provable under (`make verify-E0-T05`, composed recipes, cold-clone,
sensitivity self-check). This task puts the frozen meaning on the wire: the HTTP surface
is deliberately compatible with the durable-streams protocol v1.0 draft (studied prior
art: `replayio/durable-streams` `PROTOCOL.md` — see ROADMAP.md "Prior art"), because
E0-T09 will freeze conformance against that draft and E0-T06/T07/T08 (live modes,
file-backed store, client) all build on the exact status codes, headers, and offset
semantics established here. Getting `Stream-Seq` fencing and offset chaining right here
is what makes the epic capstone (two-terminals-one-log) possible: resumable reads depend
on `Stream-Next-Offset` being exact, and single-writer integrity depends on fencing
refusing stale writers without corrupting the log.

Scope guard: in-memory store only (the store is behind an interface E0-T07 will
re-implement file-backed); plain `GET` reads only — `live=long-poll|sse` is E0-T06; no
auth (Epic 2); no reducers or `/dispatch` (E0-T10/T11). `ef replay` is E0-T04's
deliverable (a declared dependency of this task); evidence here consumes it, it does
not reimplement it.

Contract frozen here: the HTTP surface — routes, methods, status codes for
create/append/read/error paths, the `Stream-Seq` request header and its conflict
response, and the `Stream-Next-Offset` response header — is versioned from this task
forward. E0-T09 turns it into golden transcripts; changing any of it later invalidates
those transcripts and is a breaking protocol change, not a refactor.

## Deliverables

- `packages/server` — new workspace package wired into all root gates
  (`format:check`, `lint`, `typecheck`, `test`, `build`).
- `src/store/types.ts` — the `StreamStore` interface (create, append with expected
  sequence, read-from-offset, dump, head/sequence inspection) that E0-T07's file-backed
  store must satisfy unchanged.
- `src/store/memory.ts` — `MemoryStreamStore` implementing it, using
  `@eforest/protocol` for envelope validation, canonical encoding, and offset
  generation (no local reimplementation of any frozen primitive).
- `src/http.ts` — the Node HTTP handler mapping `PUT`/`POST`/`GET` on
  `/streams/{id}` to the store, owning all status-code and header decisions:
  create/idempotent-create/create-conflict; append with `Stream-Seq` fencing and a
  409 whose `Stream-Seq` response header names the current sequence; read with
  `offset` query param,
  `Stream-Next-Offset` on every successful read, 404/400 error mapping; malformed-body
  rejection that names what failed.
- `src/index.ts` + a `serve` bin entry — starts the server on a configurable port,
  prints the listening URL; plus a dump entry point (endpoint or CLI subcommand) that
  emits any stream's events in the exact format `ef replay` consumes.
- `test/http.integration.test.ts` — integration suite driving a real listening server
  over real HTTP sockets (no handler-level shortcuts): create/append/read round-trips,
  offset chaining across multiple reads, every error status, fencing accept/refuse
  matrix, idempotent PUT, and a concurrent-writer race test (two writers, interleaved
  appends under distinct sequences, exactly one winner per fenced write; the race
  harness records every append attempt's `Stream-Seq` sent, payload digest, response
  status, and response `Stream-Seq` header to the run's evidence, and every run's
  final dump plus that request/response record passes the committed invariant
  checker — see acceptance criterion 6).
- `evidence/curl-transcript.md` + `tools/verify/replay_transcript.sh` (or equivalent
  script committed with the task) — a committed curl transcript of the full protocol
  surface (happy paths and every error path) and a replayer that runs it against a
  fresh server and diffs actual statuses/headers/bodies against the committed
  expectations.
- `tools/verify/no_reimpl_grep.sh` — deny-list script enumerating forbidden
  frozen-primitive constructs in `packages/server/src` (hashing, canonical-JSON
  encoding, offset arithmetic; see acceptance criterion 9); exits 0 iff none are
  found outside imports of `@eforest/protocol`.
- `Makefile`: `verify-E0-T05` target composed per E0-T02's per-task target contract —
  runs the integration suite, replays the curl transcript against a fresh server,
  dumps the resulting stream, checks `ef replay --digest` on the server-side dump
  against the digest of the client-side event sequence, and runs
  `tools/verify/no_reimpl_grep.sh`.

## Acceptance criteria

- [ ] `make verify-E0-T05` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      with scrubbed env, on a machine with no server already running.
- [ ] The curl transcript replay proves the protocol surface end-to-end: against a
      fresh server, every request in `evidence/curl-transcript.md` reproduces its
      committed status code, committed protocol headers (including
      `Stream-Next-Offset`), and committed body; any drift is a nonzero exit naming
      the first divergent request. The transcript covers, at minimum: PUT create
      (201), idempotent re-PUT, conflicting re-PUT (409), POST append with valid
      `Stream-Seq`, stale `Stream-Seq` refusal (409), GET from `offset=-1`, GET from
      a mid-stream offset, GET with a well-formed offset past the head (200, empty
      batch, `Stream-Next-Offset` equal to the current head offset), GET with a
      well-formed offset that never appeared in this stream (200, every event whose
      offset sorts lexicographically strictly after it, `Stream-Next-Offset` set as
      on any successful read), GET on a missing stream (404), GET with a malformed
      offset (400), and POST with a malformed body (400).
- [ ] Offset chaining is gapless and duplicate-free: a scripted reader that follows
      `Stream-Next-Offset` across N reads of a stream appended in multiple batches
      reconstructs the exact appended event sequence — asserted by digest equality
      (`ef replay --digest` over the concatenated reads equals the digest over the
      writer's own record of what it appended), not by count.
- [ ] Transport adds nothing: after the transcript run, the server-side dump of the
      stream replays via `ef replay --digest` to a digest byte-identical to the digest
      of the client-side appended sequence; the verify target prints both digests and
      diffs them.
- [ ] Fencing proof: with the current writer at sequence S, an append bearing a stale
      sequence (< S) and, separately, a replay of S itself are each refused with 409 —
      replays are refused like stale writes, never accepted or deduplicated — the
      response's `Stream-Seq` header carries the current sequence, and `ef replay
      --digest` over the dump before and after each refused attempt yields the
      identical digest — refusal demonstrably did not touch the log.
- [ ] Concurrent-writer race: the integration suite runs two writers racing appends
      against one stream with fencing; every response is either a success or a 409
      (nothing else, no 5xx), and exactly one writer's fenced write wins each
      contested sequence. This spec declares the race schedule-dependent: which
      writer's payload wins a contested sequence may vary run to run, so digest
      stability across runs is *not* the check. Instead, a committed invariant
      checker (a script or test helper committed with the task) must pass
      unconditionally on every one of at least 20 repetitions of the race. The
      checker's input per run is the stream dump PLUS each writer's committed
      request/response record — for every append attempt: the `Stream-Seq`
      sent, the payload digest, the response status, and the response's
      `Stream-Seq` header. The race harness writes that record to the run's
      evidence, and the checker cross-references it against the dump,
      asserting for each run: exactly one 2xx response per contested sequence;
      every event in the dump traceable (by payload digest) to exactly one
      accepted request; no refused request's payload present anywhere in the
      dump; offsets strictly increasing with no gaps, per `@eforest/protocol`'s
      offset generator; and `ef replay --digest` exiting 0 on the dump. All 20
      runs pass or the criterion fails — there is no alternative branch.
- [ ] Every error path is log-neutral: for each 4xx in the suite (bad offset, missing
      stream, malformed body, create conflict, fencing conflict), the test asserts the
      stream dump digest is unchanged from before the request.
- [ ] All root gates pass with the new package included: `pnpm format:check && pnpm
      lint && pnpm typecheck && pnpm test && pnpm build` exit 0.
- [ ] `packages/server` contains no reimplementation of frozen protocol primitives:
      envelope validation, canonical JSON, offset generation, and digests are imported
      from `@eforest/protocol`. Checked by the committed deny-list script
      `tools/verify/no_reimpl_grep.sh`, which greps `packages/server/src` for
      forbidden constructs — at minimum `crypto.createHash`, key-sorting /
      canonical-JSON encoding (e.g. `Object.keys(`...`.sort(` feeding
      `JSON.stringify`), and local offset-formatting/incrementing logic — and exits
      nonzero on any hit outside imports of `@eforest/protocol`. The criterion is:
      that script exits 0 (it is run by `make verify-E0-T05`), with differential
      attack 5 below as the semantic backstop for reimplementations the deny-list
      cannot name.

## Adversarial verification

Written for the hostile critic. The claim under attack: "the server speaks the v1.0
draft protocol core correctly, fencing works, and transport never alters meaning."

1. **Transcript vs. reality, your requests not theirs.** Ignore the committed
   transcript's inputs and drive the same surface with your own curl sequence —
   different stream ids, different batch sizes, different orderings. Any response
   status/header the committed transcript would not predict for the analogous request
   refutes the transcript as evidence (it was curated, not representative). Then check
   the transcript replayer itself for greenwash: edit one expected status code in the
   committed transcript and re-run the replay — if it stays green, the measuring
   apparatus is refuted (E0-T02 sensitivity doctrine applies to this task's own
   verifier).
2. **Offset fuzzing.** GET with `offset` values the builder never tried: empty string,
   `-2`, an offset from a *different* stream, an offset lexicographically past the
   head, one with a flipped byte mid-string, URL-encoded garbage, an offset that is a
   valid prefix of a real one. Each response must match the semantics pinned in the
   acceptance criteria: malformed offsets (empty string, `-2`, URL-encoded garbage,
   anything failing `@eforest/protocol` offset syntax) get 400; any *well-formed*
   offset — including one from another stream, a byte-flipped one, a prefix of a real
   one, or one past the head — is a lexicographic position and gets 200 with exactly
   the events whose offsets sort strictly after it (empty batch with
   `Stream-Next-Offset` = head when past the head). Never a 5xx, never a hang, never
   events the reader should not receive. One event delivered twice or skipped across
   any fuzzed-then-valid read sequence refutes offset semantics.
3. **Malformed-body fuzzing.** POST bodies: truncated JSON, valid JSON that violates
   the envelope, an empty batch, a batch where event 3 of 5 is invalid, duplicate
   keys, a multi-megabyte body, wrong content type. Refutation conditions: any 5xx or
   process crash; or any *partial* append — after a batch whose event 3 is invalid,
   the dump digest must equal the pre-request digest exactly (events 1–2 must NOT
   have landed). Partial application on a rejected batch is a hard refutation.
4. **Fencing under real concurrency, your schedule.** Write your own racer (do not
   reuse the builder's): two or more writers hammering one stream with overlapping
   and deliberately stale `Stream-Seq` values, including simultaneous submissions of
   the *same* sequence. Your racer must keep the same request/response record the
   builder's harness is required to keep (per attempt: `Stream-Seq` sent, payload
   digest, response status, response `Stream-Seq` header). After each run, dump and
   cross-reference that record against the dump: offsets strictly increasing with no
   gaps, exactly one 2xx per contested sequence, every event in the dump traceable
   by payload digest to exactly one accepted request, `ef replay --digest` succeeds,
   and no refused request's payload present in the dump.
   Any interleaved corruption, double-accepted sequence, or 5xx under contention
   refutes the fencing claim.
5. **Differential replay (transport-neutrality).** Append a sequence of events whose
   client-side digest you compute yourself with `@eforest/protocol` directly (not via
   any server code path). Dump the stream server-side and run `ef replay --digest`.
   Any digest mismatch refutes the core claim. Then run
   `tools/verify/no_reimpl_grep.sh` and additionally hunt `packages/server` by hand
   for local canonical-JSON/offset/digest logic under any name the deny-list misses;
   finding a reimplementation of a frozen primitive refutes acceptance criterion 9
   even if the script and the digests currently pass.
6. **Sabotage the suite.** In a scratch worktree, break the implementation three
   ways — make fencing accept stale sequences, make GET return events *at* the
   offset instead of strictly after, make PUT-conflict return 200 — and run the
   builder's integration suite and `make verify-E0-T05` after each. Any mutation the
   suite fails to go red on refutes the suite as evidence for that behavior.
7. **Cold-start and residue hunt.** Run the entire acceptance set through
   `tools/verify/cold_clone.sh` with scrubbed env. Then hunt residue: a port assumed
   free, a server left warm from development, transcript expectations that encode a
   development-machine hostname/port/timestamp, test ordering dependence (run the
   integration suite with shuffled test order and in isolation per test). Any
   pass-only-when-warm behavior is a refutation, not an environment note.
8. **Restart honesty.** The store is in-memory by design; verify the claim doesn't
   quietly exceed it. Kill and restart the server mid-transcript: subsequent reads on
   the vanished stream must 404 (fresh world), not serve stale state from any hidden
   cache; and nothing in the task's claim or transcript may imply persistence E0-T07
   hasn't delivered yet.

## Verification log
