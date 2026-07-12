---
id: E0-T07
epic: 0
title: File-backed store: durable persistence with identical protocol semantics across restarts
priority: 7
status: in-progress
depends_on: [E0-T06] # transitively implies E0-T04 and E0-T05 (E0-T06 depends on both)
estimate: M
capstone: false
---

## Goal

The durable-stream server (`packages/stream-server`) has a second store implementation,
`FileStore`, behind the same `StreamStore` interface the E0-T05 `MemoryStore` implements:
an append-only on-disk log per stream under a configurable data directory
(`--data-dir` flag / `EF_DATA_DIR` env), where offsets are stable identities across
process restarts — a `GET /streams/:id?offset=<o>` after kill-and-restart returns exactly
the suffix a never-restarted server would return, and `ef replay --digest` over the full
post-restart log equals the pre-kill digest. Appends are crash-safe: a record is either
fully durable or not part of the stream, and on startup the store detects a torn tail
(partial trailing record) and either recovers to the last complete record or refuses to
serve the stream with a loud, explicit error — it never silently serves a corrupt or
partial event. The server selects the store via config; every protocol behavior (`PUT`
create, `POST` append, `Stream-Seq` fencing, offset `GET`, and the E0-T06 live modes) is
store-agnostic, proven by one shared store spec suite that runs verbatim against both
stores.

## Context

E0-T05 landed the server core on an in-memory store; E0-T06 added live tailing. But
memory dies with the process, and the capstone (E0-T13) requires kill/resume with digests
intact — that only means anything if the log survives the kill. This task makes the log
durable and, just as importantly, keeps the protocol layer honest: if any semantics leak
into the store (offset formats, fencing behavior, catch-up boundaries), E0-T09's
conformance freeze and every later store (snapshots/compaction in E1) inherit the leak.
The shared spec suite established here is the enforcement mechanism: it becomes the seed
of the E0-T09 conformance suite, so "identical semantics across stores" is a running
test, not a design intention.

Contract discipline: the `StreamStore` interface boundary and the offset semantics frozen
in E0-T03/E0-T05 (opaque, lexicographically ordered, resolvable across restarts) are held
here, not reinvented. The on-disk format is internal and may evolve, but two properties
are frozen by this task's evidence: (1) offsets handed to any client remain valid across
restarts of the same data dir, and (2) a torn write is never observable through the
protocol surface. Weakening either later invalidates every restart/convergence fixture
downstream (E0-T13, E4 watcher sync).

Non-goals: compaction, snapshots, retention/`410 Gone` (Epic 1); client-side anything
(E0-T08); multi-node replication. One process, one data dir, durable and honest.

## Deliverables

- `packages/stream-server/src/store.ts` (or the E0-T05 location): the `StreamStore`
  interface extracted/confirmed as the single seam — creation, append (with fencing
  inputs), read-from-offset, head/metadata — with `MemoryStore` unchanged in behavior.
- `packages/stream-server/src/file-store.ts`: `FileStore` implementing `StreamStore` —
  append-only log file(s) per stream under `<data-dir>/streams/…`, length- or
  delimiter-framed records each carrying a per-record checksum (framing alone is not
  sufficient) so that truncation of the tail *and* byte-level corruption of any record,
  interior or tail, is detectable on read, fsync-or-equivalent durability on the append acknowledgment path, and startup recovery
  that scans the tail, truncates to the last complete record (recovery) or throws a
  descriptive error naming the stream and byte offset (refusal) — the choice must be
  deterministic and documented in the file header comment.
- Server config plumbing: store selection via config/flag (`--store=memory|file`,
  `--data-dir=<path>`), used by tests to boot either store; default remains memory so
  E0-T05/E0-T06 suites run unmodified.
- Shared store spec suite `packages/stream-server/test/store-spec.ts`: one parameterized
  suite (create/append/fencing/read-from-offset/boundary conditions, including the
  E0-T05 protocol tests refactored to run through it where applicable) executed against
  both `MemoryStore` and `FileStore` — same assertions, zero store-specific forks in the
  spec body.
- Restart test `packages/stream-server/test/restart.test.ts` (real server process, real
  HTTP): appends a scripted N-event log, records the head offset and several mid-log
  offsets from live responses, SIGKILLs the server process, restarts it on the same data
  dir, then proves: full `GET` replays to an `ef replay --digest` identical to the
  pre-kill digest; each saved mid-log offset still resolves to exactly the suffix it
  resolved to before the kill (digest of pre-kill suffix == digest of post-kill suffix);
  a fresh append after restart continues the offset order (new offsets sort after old).
- Torn-write test `packages/stream-server/test/torn-write.test.ts`: writes a log, stops
  the server, truncates the tail file mid-record (multiple truncation points: mid-length
  prefix, mid-payload, mid-checksum), restarts, and asserts the documented behavior —
  either the store recovers to the last complete record and a full `GET` + `ef replay
  --digest` equals the digest of the intact prefix, or the affected stream's requests
  fail with the explicit error status/message. In no case does any `GET` return a record
  that was not fully appended.
- `make verify-E0-T07` target (composed into the E0-T02 verify spine): runs the shared
  spec suite against both stores, the restart test, and the torn-write test; nonzero exit
  on any failure.
- Evidence artifacts in `evidence/`: the scripted input log, pre-kill and post-restart
  full-log dumps, a digest file showing their equality plus the mid-offset suffix
  equalities, and a torn-write transcript (truncation byte position + observed
  recovery/refusal per truncation point).

## Acceptance criteria

- [ ] `make verify-E0-T07` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      (scrubbed env, fresh install), printing the pre-kill and post-restart digests as
      one identical value.
- [ ] Shared semantics: the store spec suite in
      `packages/stream-server/test/store-spec.ts` runs against both stores from a single
      spec body with no store-conditional logic of any form in the spec body — no
      branches, per-store expected values or expected-value tables, per-store skips, or
      inspection of the store name — verifiable by reading the file; the suite passes for
      both stores and `pnpm test --filter stream-server` is green.
- [ ] Restart determinism: the restart test SIGKILLs (not graceful-stops) the server,
      restarts on the same `--data-dir`, and asserts `ef replay --digest` over the
      post-restart full `GET` dump equals the pre-kill digest (recorded in
      `evidence/e0-t07-digests.txt` with dumps
      `evidence/e0-t07-prekill.jsonl` / `evidence/e0-t07-postrestart.jsonl`).
- [ ] Offset stability: for at least 3 saved mid-log offsets taken from live pre-kill
      responses, the post-restart `GET ?offset=<o>` suffix digest equals the pre-kill
      suffix digest for the same offset — asserted per-offset, not just end-to-end.
- [ ] Append continuity: a `POST` after restart succeeds under the correct `Stream-Seq`,
      its offset sorts lexicographically after every pre-kill offset, and a stale
      `Stream-Seq` (valid before the kill, consumed since) is still rejected — fencing
      state survives restart.
- [ ] Torn tail handled loudly: the torn-write test exercises at least these truncation
      classes — mid-length-prefix, mid-payload, and mid-checksum; a test exercising fewer
      classes does not satisfy this criterion. For every truncation point exercised, the
      test asserts the store's documented behavior (recovery to last complete record with
      a digest equal to the intact prefix, or an explicit error on access); any code path
      where a truncated/partial record is returned by `GET` fails the test.
- [ ] Record integrity end to end: a `GET` never serves a record whose stored bytes fail
      checksum verification, including interior (non-tail) records — evidenced by a test
      that flips one byte inside an interior record and asserts the read path surfaces an
      integrity error (or documented refusal) rather than the mutated bytes.
- [ ] Durability on the ack path: an append acknowledged with 2xx before a SIGKILL is
      present in the post-restart log (the restart test kills immediately after the last
      acknowledged append, with no grace sleep).
- [ ] Store-agnostic live modes: with the server booted on `--store=file`, either the
      full E0-T06 live test suite passes parameterized over both stores, or a named
      mandatory subset passes that includes, at minimum, each of these cases: (a)
      long-poll catch-up-to-live handoff at the boundary offset, (b) SSE resume from a
      saved offset after a disconnect, and (c) live visibility of an append made after
      server boot. Each named case must be identifiable in the test file; a subset
      missing any of them does not satisfy this criterion.
- [ ] All standard gates pass: `pnpm format:check && pnpm lint && pnpm typecheck &&
      pnpm test && pnpm build` exit 0.
- [ ] Replay (browser layer): N/A — no browser-reaching surface; mitigation is the
      digest/restart evidence above, this task's native currency.

## Adversarial verification

Attack angles for the hostile critic. Run each with your own inputs, offsets, and kill
timing — never the builder's fixtures. Invent at least one more.

1. **Torn-write fuzz sweep.** Write your own script: append K events, stop the server,
   then truncate the tail file at *every* byte position in the last record (not just the
   builder's chosen cut points), restarting and probing `GET` each time. Any truncation
   position where the server returns a partial/corrupt event — or returns fewer events
   than the intact prefix while claiming success as if nothing happened, with no
   recovery/refusal signal distinguishable from a normal short log — refutes.
   Additionally, flip one byte *inside* an interior (non-tail) record: a `GET` that
   serves the mutated bytes as a valid event without any integrity error refutes the
   torn-write claim's integrity mechanism.
2. **Kill-timing race on the ack path.** Drive appends in a loop and SIGKILL the server
   at random points; after each restart, every append that received a 2xx must be in the
   log and every append that errored/never-answered must be either absent or fully
   present (never partial). A single acknowledged-but-lost or half-present record
   refutes durability. Repeat ≥20 kill cycles on one data dir; the final log must still
   `ef replay --digest` cleanly.
3. **Cross-store differential.** Run your own scripted session (creates, appends,
   fenced rejections, reads from assorted offsets) twice — once against `--store=memory`,
   once against `--store=file` — and diff every HTTP response pair: status, offset
   headers, bodies, error shapes. Any observable difference (beyond timing) refutes
   "identical protocol semantics". Then do the same for a fencing rejection specifically:
   the file store rejecting with a different status/shape than memory refutes.
4. **Offset archaeology.** Take offsets from a pre-kill session, restart, and probe not
   just the saved offsets but neighbors: an offset just past head must behave exactly as
   it did pre-kill (per the E0-T05 contract), and a garbage/foreign offset must produce
   the same error as on the memory store. Restart the server a second and third time
   (restart-of-restart): digests and offset resolutions must remain fixed. Any drift
   across restart count refutes offset stability.
5. **Spec-suite sensitivity.** In a scratch worktree, sabotage `FileStore` subtly: make
   read-from-offset off by one record, or make recovery keep the torn record. The shared
   spec suite / torn-write test respectively MUST go red. Then sabotage the *spec suite
   seam* — hardcode it to only instantiate `MemoryStore` — and confirm
   `make verify-E0-T07` goes red (it must actually exercise the file store; a green run
   that never touched disk refutes the measuring apparatus). Check the data dir mtime or
   strace-equivalent if in doubt. Finally, inject a per-store expected value into the
   spec body (e.g. an expected-value table keyed by store name) and confirm your
   reading check of the "Shared semantics" criterion catches it — if it slips past,
   the single-spec-body claim is unverified.
6. **Dirty data-dir cold start.** Boot the file store on: an empty dir, a dir with an
   unrelated file dropped into `streams/`, a dir from a *different* stream server version
   of itself (re-run after hand-editing a log file's header), and a dir with read-only
   permissions. Refutation: a crash loop, a silent empty-stream answer for a stream whose
   file exists but is unreadable/corrupt, or serving data from a file the store cannot
   have validated.
7. **Fsync theater.** Read the append path source: if the 2xx is sent before the bytes
   are durably flushed (no fsync/fdatasync or documented equivalent on the ack path),
   attempt to demonstrate it — kill -9 immediately after ack under load (attack 2) or
   run the data dir on a small tmpfs/loop device and look for acked-but-lost records.
   Code that comments "fsync omitted for speed" while the acceptance criteria claim
   ack-durability refutes on inspection even if the race is hard to hit.
8. **Cold-clone + leftover-state hunt.** Run `make verify-E0-T07` via
   `tools/verify/cold_clone.sh`. Verify the tests create their own temp data dirs and
   ephemeral ports; a test that reuses a fixed path (surviving state between runs could
   mask recovery bugs) or a warm dev server refutes the evidence.

Refutation currency: a data dir + truncation byte position (or kill transcript) where the
protocol surface served a record it should not have, an HTTP transcript pair where the
two stores diverge, or a digest inequality with the offset where logs first differ
(`ef bisect` once it lands, manual diff until then). "Disk stuff is probably fine" is not
a finding.

## Verification log
