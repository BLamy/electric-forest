---
id: E0-T08
epic: 0
title: "TypeScript client and writer: batched appends, resumable reads, live tail with offset checkpoints"
priority: 8
status: in-progress
depends_on: [E0-T04, E0-T05, E0-T06]
estimate: M
capstone: false
---

## Goal

`packages/client` exists in the pnpm workspace and ships the typed consumer library for
the durable-stream server: a **writer** (`StreamWriter`) whose `append(event)` calls are
transparently coalesced into batched `POST /streams/:id` appends carrying correct
`Stream-Seq` fencing headers, and a **reader** (`StreamReader`) that performs resumable
catch-up `GET`s from any offset, exposes a persistable **offset checkpoint** after every
delivered batch, and tails live in both protocol modes (`live=long-poll` and `live=sse`)
behind one `tail()` interface with automatic reconnect-from-checkpoint. Batching is
invisible at the protocol layer: N events appended through the batching writer land on
the stream as the same N canonical events, in the same order, digest-identical (via
`ef replay --digest`) to N one-at-a-time appends. A writer fenced out by a competing
`Stream-Seq` surfaces the conflict as a typed, catchable error (`StreamSeqConflictError`,
carrying the stream id, the sent seq, and the server's response) — never a swallowed
rejection, never a silent retry that overwrites the fence. This is the exact machinery
the E0-T13 capstone's process B runs, and the substrate stream-fs (E1), the CLI watcher
(E4), and the web hooks (E3) consume.

## Context

E0-T05/E0-T06 finished the server: create, fenced append, catch-up GET, long-poll and SSE
with exact resume semantics. But every consumer so far speaks raw HTTP in test scripts.
The capstone and every later epic need a library: terminal B in two-terminals-one-log
must tail live, get killed mid-stream, and resume from a saved offset with zero gap or
duplicate — that save/restore cycle is this task's checkpoint API. The reference
implementations (ElectricSQL durable-streams client, per `AGENTS.md` prior art) shape the
surface, and E0-T09 will freeze conformance over whatever wire behavior this client
emits, so the client must speak the v1.0-draft dialect already frozen in E0-T03/T05/T06
— same offset semantics, same headers, same live-mode query parameters. Do not invent
client-side conveniences that change wire shape.

Contract discipline inherited, not invented: the resume invariant from E0-T06 (*offset in
hand ⇒ exact suffix, digest-equal to cold read*) becomes a **client-visible** guarantee
here — a checkpoint the library hands out must always be safe to persist and resume from.
The checkpoint type is a plain serializable value (offset string, JSON-safe), because E4's
watcher will write it to disk and E3's hooks will hydrate from it.

Non-goals: reducers/state/`/dispatch` (E0-T10/T11), file-backed store specifics (E0-T07 —
the client is store-agnostic by construction), retry/backoff policy tuning beyond basic
reconnect (later epics harden it). This task may run against the in-memory server;
nothing in it may depend on which store backs the stream.

## Deliverables

- `packages/client/` workspace package covered by all E0-T01 gates
  (format/lint/typecheck/test/build), exporting typed `StreamWriter`, `StreamReader`,
  `StreamSeqConflictError`, and the checkpoint type.
- **Writer**: `append()` returning a promise that resolves only when the event is
  durably acknowledged by the server; internal batching (size- and time-windowed,
  configurable) that preserves per-writer submission order across batch boundaries;
  correct `Stream-Seq` sequencing across batches; `flush()` to force-drain. On a fencing
  rejection, the affected `append()` promises reject with `StreamSeqConflictError` and
  the writer stops advancing its seq — no auto-refetch-and-retry that would steal the
  fence back.
- **Reader**: `read(from: checkpoint)` catch-up iteration; `tail(from: checkpoint,
  {mode: "long-poll" | "sse"})` async-iterable of event batches, each yielding the
  events plus the new checkpoint; automatic re-arm/reconnect from the last delivered
  checkpoint on socket loss or long-poll timeout; `checkpoint` is only advanced after
  the corresponding events have been yielded to the consumer (crash between yield and
  persist duplicates nothing the consumer already owned).
- Integration tests in `packages/client/test/` against a **real server on an ephemeral
  port** (spawned by the test, not a warm dev server), including:
  - **Batching transparency**: writer A appends N scripted events with batching on;
    writer B appends the same N events to a second stream unbatched (batch size 1);
    cold-GET dumps of both streams fed to `ef replay --digest` print one identical
    digest, and the batched stream's dump contains exactly N events in submission order.
  - **Kill/resume**: a tailer consumes a prefix, persists its checkpoint to a file, is
    hard-killed (process/socket kill, not graceful close), restarts from the file's
    checkpoint, and receives precisely the remaining suffix; the concatenated
    received log replays via `ef replay --digest` to the same digest as an
    uninterrupted cold read. Run for both `long-poll` and `sse` modes.
  - **Fencing surfaces**: two writers on one stream; the fenced-out writer's pending
    `append()` promises reject with `StreamSeqConflictError` (asserted via
    `instanceof` and payload fields), the stream's cold dump contains only the winning
    writer's events, and the loser performed no further appends.
- `make verify-E0-T08` target composed into the E0-T02 verify spine (standard gates plus
  the integration suite and its digest comparisons), passing
  `tools/verify/self_check.sh`, added to `verify-all` and `make verify-list`.
- Evidence artifacts in `evidence/`: the batched and unbatched stream dumps; the tailer's
  pre-kill prefix and post-resume suffix logs per live mode
  (`e0-t08-tail-longpoll-prefix.jsonl`, `e0-t08-tail-longpoll-suffix.jsonl`,
  `e0-t08-tail-sse-prefix.jsonl`, `e0-t08-tail-sse-suffix.jsonl`); the uninterrupted
  cold-read dump; the fencing contested and winner-control dumps
  (`e0-t08-fencing-contested-dump.jsonl`, `e0-t08-fencing-winner-control-dump.jsonl`)
  and the fencing promise-settlement transcript (`e0-t08-fencing-settlements.jsonl`);
  and a digests file (`e0-t08-digests.txt`) showing the equalities, including the
  per-mode kill/resume equalities and the fencing dump equality.

## Acceptance criteria

- [ ] `make verify-E0-T08` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      (scrubbed env, fresh install), spawning its own server on an ephemeral port.
- [ ] Batching transparency: `ef replay --digest` over
      `evidence/e0-t08-batched-dump.jsonl` and `evidence/e0-t08-unbatched-dump.jsonl`
      prints the identical digest (recorded in `evidence/e0-t08-digests.txt`), and a
      committed test asserts the batched dump has exactly N events whose order equals
      the scripted submission order.
- [ ] Kill/resume exactness, both live modes: the resumed tailer's suffix contains no
      event at or before the persisted checkpoint and no gap after it. The run is
      recorded per mode: `evidence/e0-t08-tail-longpoll-prefix.jsonl` +
      `evidence/e0-t08-tail-longpoll-suffix.jsonl` for `long-poll`, and
      `evidence/e0-t08-tail-sse-prefix.jsonl` + `evidence/e0-t08-tail-sse-suffix.jsonl`
      for `sse`. For each mode, `ef replay --digest` over the prefix+suffix
      concatenation equals the digest of `evidence/e0-t08-cold-read.jsonl`, and
      `evidence/e0-t08-digests.txt` records that equality separately for each mode.
      Off-by-one in either direction (boundary duplicate or skipped first suffix
      event) fails the test.
- [ ] Checkpoint honesty: a committed test asserts the checkpoint yielded with batch k
      resumes to exactly batch k+1's first event — persist-after-every-yield then
      kill/resume at an arbitrary batch boundary loses and duplicates nothing. Evidence:
      the per-batch checkpoint transcript (batch index, yielded checkpoint, first event
      of the resumed suffix) written to `evidence/e0-t08-checkpoints.jsonl`, and the
      resumed log's `ef replay --digest` equality against the cold read recorded in
      `evidence/e0-t08-digests.txt`.
- [ ] Fencing: a committed test asserts the fenced-out writer's `append()` rejects with
      `StreamSeqConflictError` exposing stream id, sent seq, and server response; the
      contested stream's cold dump is written to
      `evidence/e0-t08-fencing-contested-dump.jsonl` and its `ef replay --digest`
      matches that of `evidence/e0-t08-fencing-winner-control-dump.jsonl` — a control
      dump produced by the winning writer appending the same events alone to a second
      stream (not by filtering the contested dump) — with the equality recorded in
      `evidence/e0-t08-digests.txt`; a promise-settlement transcript (one record per
      `append()`: resolved/rejected, error class, and error payload fields) is written
      to `evidence/e0-t08-fencing-settlements.jsonl`; no unhandled rejection escapes
      (test runs with unhandled-rejection strictness on).
- [ ] `append()` resolution = durability: a test kills the client-to-server connection
      (or the in-flight request) between an `append()` call and any acknowledgment and
      asserts the promise rejects unless the event is present in the log via cold GET
      against the still-running server — resolved-but-absent is a failure. (Store-
      agnostic by design: no server restart, so the test is valid against the in-memory
      server; restart-survival durability is E0-T07's concern.)
- [ ] Wire compatibility: a committed test freezes the stream (no writer running),
      records the head offset H via a raw `GET`, then takes a checkpoint the client
      produced, issues a raw `GET ?offset=` with it, and asserts the returned suffix
      digest-equals the client's tail from that checkpoint — both legs reading the
      closed window from the checkpoint up to exactly H, with the digest taken over
      that window; and feeds a raw-GET-derived offset into `StreamReader.read()` with
      the same digest assertion over the same closed window. The two round-trip
      transcripts are written to `evidence/e0-t08-wire-roundtrip-client-to-raw.jsonl`
      and `evidence/e0-t08-wire-roundtrip-raw-to-client.jsonl`.
- [ ] All standard gates pass: `pnpm format:check && pnpm lint && pnpm typecheck &&
      pnpm test && pnpm build` exit 0; E0-T05/E0-T06 server suites still pass unmodified.
- [ ] Replay (browser layer): N/A — library/CLI-level task, no browser-reaching surface;
      mitigation is the stream-layer digest evidence above, declared in the claim.

## Adversarial verification

Attack angles for the hostile critic. Run each with your own inputs, seeds, and timing,
never the builder's; any single success refutes. Invent at least one more.

1. **Batch-boundary sweep.** With your own script, append K events through the batching
   writer while varying batch size and flush timing (including flush racing an in-flight
   batch, and an append issued inside another append's `.then`). Cold-dump and
   digest-compare against an unbatched control for every configuration. Any reordering,
   duplication, merge of two events into one record, or split of one event across
   records refutes batching transparency. Do not trust the builder's N — pick your own,
   including N=1 and N not divisible by the batch size.
2. **Checkpoint torture.** Drive the tailer yourself: persist the checkpoint after every
   yielded batch, kill the process (SIGKILL, not close()) at randomized points including
   *between* yield and persist, resume from the last persisted file. Refutation: any
   run where prefix+suffix replay-digest differs from the cold read, or where an event
   the consumer never received is skipped. Repeat with the server's long-poll timeout
   firing mid-run (quiescent gaps) — a timeout that corrupts or regresses the
   checkpoint refutes.
3. **Fencing error laundering.** Grep the diff for `catch` blocks around the append
   path; then race two writers with your own interleaving and assert every losing
   `append()` promise settles as a *rejection* with `StreamSeqConflictError` — a
   promise that resolves, hangs forever, rejects with a generic `Error`, or a writer
   that silently re-fetches the seq and retries (check the server-side dump: any
   loser-authored event after the fence point refutes) all count as refutations.
4. **Durability lie.** Sabotage-style: make the writer resolve `append()` on send rather
   than on server acknowledgment in a scratch worktree — the durability acceptance test
   must go red. Then, unsabotaged, kill the client-to-server connection mid-batch
   yourself and verify every resolved promise's event is present in a cold GET dump
   against the still-running server and every absent event's promise rejected.
   Resolved-but-absent, or the inverse (rejected-but-present without documented
   at-least-once semantics), refutes.
5. **Sensitivity proof of the measuring apparatus (mandatory).** In a scratch worktree,
   sabotage the reader to (a) duplicate the boundary event on resume, and separately (b)
   drop the first suffix event; the kill/resume tests and `make verify-E0-T08` MUST go
   red under each mutation. Likewise sabotage batching to reorder two events within a
   batch. Green under any mutation refutes the apparatus, voiding the task's evidence.
6. **Wire-dialect drift (differential).** Capture the client's actual HTTP traffic (raw
   proxy or server-side logging) and diff headers, query params, and offsets against the
   frozen v1.0-draft surface E0-T05/T06 tests assert. A client that only works against
   this server because both sides share a private dialect refutes; cross-check by
   driving one leg with raw `curl` using a checkpoint the client produced, and feeding a
   raw-GET offset back into the client.
7. **Concurrency and slow-consumer.** Ten tailers (mixed modes) on one stream while a
   batching writer bursts; every tailer's accumulated log must digest-equal the cold
   read. A tailer that reads nothing during the burst then drains must converge too.
   Kill one tailer's socket mid-frame; other tailers diverging, an unhandled rejection,
   or a client/server crash refutes.
8. **Cold-clone + warm-state hunt.** Run everything only via
   `tools/verify/cold_clone.sh`. Verify the integration tests spawn their own server on
   an ephemeral port (grep for fixed ports / baseURL env reads); a test that passes
   against a dev server left warm — or fails without one — refutes the evidence. Check
   the checkpoint file format is plain serializable (write it, read it in a fresh
   process, resume) with no in-memory handle smuggled through.

Refutation currency: an event-log file + offset where a received log first diverges from
the cold read (use `ef bisect` once it lands, manual diff until then), a promise-settle
transcript contradicting the typed-error claim, or an HTTP transcript contradicting the
frozen wire surface. "Felt flaky" is not a finding.

## Verification log
