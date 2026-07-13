---
id: E1-T05
epic: 1
title: "watch(): chokidar-compatible live events from a tailing client, resumable from a saved offset"
priority: 105
status: in-progress
depends_on: [E1-T02, E1-T03]
estimate: M
capstone: false
---

## Goal

`packages/streamfs` (`@eforest/streamfs`, per E1-T01) exports `watch(root, {from?: checkpoint})`, returning a
`StreamFsWatcher` that live-tails the repo's **metadata stream only** through the
E0-T08 client (`StreamReader.tail()`, both `live=long-poll` and `live=sse` modes work)
and emits **chokidar-compatible** filesystem events: `add`, `addDir`, `change`,
`unlink`, `unlinkDir`, each carrying the repo-relative POSIX path and the
**metadata-stream offset** of the fs event that produced it (`{event, path, offset}`).
Per-file content streams are never tailed: E1-T01 mirrors every content write as a
metadata event, watcher events carry no bytes, and all emissions derive solely from the
metadata stream — so there is exactly one offset space and one checkpoint. The mapping from stream-fs
events to watcher events is pinned here: file create → `add`; content full-write and
**patch apply (E1-T03)** on an existing file → `change`; file delete/tombstone →
`unlink`; `mkdir` → `addDir`; `rmdir` → `unlinkDir`; `rename`/`move` (E1-T02) →
`unlink`(+`unlinkDir` for directories, deepest-first) at the old path followed by
`add`(+`addDir`, shallowest-first) at the new path — chokidar has no rename event and we
do not invent one. The watcher exposes a persistable **checkpoint** (the E0-T08
serializable offset value). Because one fs event (e.g. a rename) decomposes into
several watcher events sharing that fs event's offset, checkpoint and transcript
atomicity are pinned at **fs-event boundaries**: `.checkpoint()` returns the offset of
the last fs event whose decomposition has been *fully* emitted (it never advances
mid-decomposition), and the transcript writer flushes all lines of a decomposition
atomically — a persisted transcript never contains a partial decomposition.
`watch(root, {from: saved})` resumes strictly after the checkpointed fs event and the
emitted event sequence is **exactly** the suffix — no missed events, no duplicates, no
reordering — such that a watcher killed and resumed produces, by concatenation, the
byte-identical event transcript an uninterrupted watcher produces.
Every emission is a pure function of the log: the same stream replayed into `watch()`
from offset `-1` yields the same transcript every time.

## Context

This is the "live" half of stream-fs, and the pattern donor is Nut's registry-stream
tailing (see ROADMAP.md prior art): a filesystem you can only poll is not a filesystem
agents and editors can sit on. E1-T01 froze the fs event envelope, E1-T02 added directory
ops and rename tombstones, E1-T03 added patches; this task derives the standard watcher
interface from those events without adding any new mutation path — `watch()` is a
**reader**, built entirely on the E0-T06 live modes and the E0-T08 checkpoint contract
(*offset in hand ⇒ exact suffix*). The chokidar shape is deliberate: it is what the E4
CLI watcher daemon syncs the working tree with, what the E3 file viewer's live updates
reduce from, and what third-party tooling already understands. The event-name set and
the rename decomposition order pinned in the Goal are contract here — E4 will diff its
downstream behavior against this exact dialect, so changing names or ordering later
invalidates this task's golden transcripts and E4's fixtures.

Determinism discipline: the watcher transcript for a given log window is canonical.
Wall-clock timing, live mode (long-poll vs SSE), and batch boundaries may vary; the
emitted `(event, path, offset)` sequence may not. That is what makes a committed golden
transcript legitimate evidence rather than a flaky snapshot.

Non-goals: writing anything to any stream (watch is read-only), materializing files to
disk (E1-T06 `ef materialize`, E4 watcher daemon), watching a branch other than the one
addressed (branches are E1-T08), snapshot bootstrap for watchers on compacted streams
(E1-T07 extends this reader), and chokidar options we don't need (globs, `awaitWriteFinish`,
polling fallbacks). Stale-write fencing (E1-T04) is orthogonal: rejected writes never
reach the log, so the watcher never sees them by construction.

## Deliverables

- `packages/streamfs/src/watch.ts`: `watch(root, opts)` returning `StreamFsWatcher`
  (an `EventEmitter`-style `.on(event, (path) => …)` surface matching chokidar, plus
  `.onAll((event, path, offset) => …)`, `.checkpoint()` returning the E0-T08
  serializable offset of the last fully-emitted fs event (advancing only at
  decomposition boundaries, per the Goal), and `.close()`), with `opts.mode:
  "long-poll" | "sse"` selecting the tail transport and `opts.from` accepting a saved
  checkpoint. Exported types for the event union and the transcript record
  `{event, path, offset}`.
- The event-mapping reducer as a pure, separately exported function
  `fsEventsToWatchEvents(fsEvents, state)` so the mapping is unit-testable without a
  server and reusable by E3/E4.
- Rename decomposition honoring the pinned ordering (old-path removals deepest-first,
  new-path additions shallowest-first) including directory renames that move whole
  subtrees: every contained file/dir yields its own `unlink`/`unlinkDir` + `add`/`addDir`
  pair.
- A transcript writer used by tests and evidence: each emitted event appended as one
  canonical-JSON line `{event, path, offset}` to a `.jsonl` file, with all lines of one
  fs event's decomposition flushed atomically (a kill can never leave a partial
  decomposition in the file).
- Two-process integration test in `packages/streamfs/test/watch.test.ts` against a real
  server on an ephemeral port (spawned by the test, never a warm dev server):
  - **Golden transcript**: a writer process dispatches the scripted mutation sequence in
    `evidence/e1-t05-writer-script.jsonl` (covering create, full write, ≥3 patch appends
    to one file, nested `mkdir`, file rename, directory rename moving a subtree, file
    delete, `rmdir`) while a separate watcher process tails from offset `-1`; the
    watcher's transcript must be byte-identical to the committed golden
    `evidence/e1-t05-golden-transcript.jsonl`. Run once per live mode; both transcripts
    identical to the golden.
  - **Kill/resume**: the watcher under test reports each **in-memory emission** (a
    watcher event at the moment it is emitted, *before* the transcript writer's atomic
    flush) over a side channel separate from the transcript file (a pipe/fd or a
    separate per-line-flushed report file), and persists its checkpoint on every
    checkpoint advance. The harness hard-kills (SIGKILL) the watcher on receipt of the
    N-th emission report, with N chosen **strictly inside** the directory-rename
    decomposition's emission index range as computed from the golden transcript (after
    the index of its first `unlink`, before the index of its last `add`/`addDir`). The
    harness commits the chosen N, the decomposition's emission index range, and the
    count of emission reports actually received before the kill to
    `evidence/e1-t05-killpoint.json`, so the kill's placement inside the decomposition
    is observable from committed artifacts rather than asserted counterfactually.
    Because the transcript flushes per decomposition and the checkpoint never advances
    mid-decomposition, the persisted checkpoint in
    `evidence/e1-t05-checkpoint.json` must be the fs event immediately preceding the
    directory rename, and the committed test asserts the persisted prefix ends exactly at
    that decomposition boundary (no partial decomposition). A new watcher process resumes
    from the persisted file; prefix+suffix concatenation is byte-identical to the golden —
    a boundary duplicate, a skipped first suffix event, or a prefix bleeding into the
    rename decomposition fails the test. In addition, the committed integration test runs
    a scripted kill-point sweep: SIGKILL on receipt of the k-th emission report for every
    k across the whole sequence — k counts **in-memory emitted watcher events
    (pre-flush)**, never flushed transcript lines, so the sweep necessarily includes kill
    points strictly inside multi-event decompositions — resume from the persisted
    checkpoint each time, and byte-diff every prefix+suffix concatenation against the
    golden. The committed sweep output enumerates which k values landed strictly inside
    a decomposition, and the test asserts that set is non-empty and includes at least
    one interior point of the directory-rename decomposition.
  - **Patch = change**: a test asserting an E1-T03 patch append to an existing file
    emits exactly one `change` (never `add`, never a spurious `unlink`/`add` pair) and
    that replaying the log through `fsEventsToWatchEvents` yields the same record.
- `make verify-E1-T05` target composed into the E0-T02 verify spine (standard gates +
  the integration suite + byte-diff of transcripts against the golden), passing
  `tools/verify/self_check.sh`, added to `verify-all` and `make verify-list`.
- Evidence artifacts in `evidence/`: `e1-t05-writer-script.jsonl`,
  `e1-t05-golden-transcript.jsonl`, per-mode live transcripts
  (`e1-t05-transcript-longpoll.jsonl`, `e1-t05-transcript-sse.jsonl`), the kill/resume
  prefix and suffix (`e1-t05-resume-prefix.jsonl`, `e1-t05-resume-suffix.jsonl`) with
  the persisted checkpoint value (`e1-t05-checkpoint.json`) and the kill-point record
  (`e1-t05-killpoint.json`: chosen N, the directory-rename decomposition's emission
  index range from the golden, emission reports received, plus the sweep's
  inside-a-decomposition k set), the raw fs event-log dump
  the transcripts derive from (`e1-t05-fs-log.jsonl`), and `e1-t05-digests.txt`
  recording the `ef replay --digest` of the fs log plus SHA-256 of every transcript
  showing the byte-equalities.

## Acceptance criteria

- [ ] `make verify-E1-T05` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      (scrubbed env, fresh install), spawning its own server on an ephemeral port, and
      prints the transcript SHA-256 values it compared.
- [ ] Golden exactness, both modes: `diff evidence/e1-t05-transcript-longpoll.jsonl
      evidence/e1-t05-golden-transcript.jsonl` and `diff
      evidence/e1-t05-transcript-sse.jsonl evidence/e1-t05-golden-transcript.jsonl`
      both exit 0 (byte-identical, not "semantically equal"), with the SHA-256 equalities
      recorded in `evidence/e1-t05-digests.txt`.
- [ ] The golden covers the full mapping: a committed test asserts
      `evidence/e1-t05-golden-transcript.jsonl` contains at least one of each event type
      (`add`, `addDir`, `change`, `unlink`, `unlinkDir`), at least one `change` produced
      by a patch append, and a directory-rename subsequence whose old-path events are
      deepest-first and new-path events shallowest-first, contiguous in the pinned order.
- [ ] Kill/resume exactness at the pinned hard case: the SIGKILL is triggered by the
      side-channel emission report mechanism pinned in Deliverables, and a committed
      test asserts from `evidence/e1-t05-killpoint.json` that the chosen N falls
      strictly inside the directory-rename decomposition's emission index range as
      computed from the golden (so the kill demonstrably landed mid-decomposition, in
      memory, after the pre-flush emission reports up to N). The persisted checkpoint in
      `evidence/e1-t05-checkpoint.json` is the offset of the fs event immediately
      preceding the directory-rename decomposition, and a committed test asserts
      `evidence/e1-t05-resume-prefix.jsonl` ends exactly at that decomposition boundary —
      it contains no record of the directory-rename decomposition. Concatenating
      `evidence/e1-t05-resume-prefix.jsonl` + `evidence/e1-t05-resume-suffix.jsonl`
      byte-equals the golden; the committed test asserts the suffix's first record has
      offset strictly greater than the persisted checkpoint and equals byte-for-byte the
      golden record at index `len(prefix)` (the first record of the directory-rename
      decomposition). Off-by-one in either direction fails the test. The committed
      kill-point sweep (SIGKILL on the k-th **in-memory emission report**, pre-flush,
      for every k, per Deliverables) passes for every k, and its committed output's set
      of k values that landed strictly inside a decomposition is non-empty and includes
      at least one interior point of the directory-rename decomposition.
- [ ] Replay determinism: feeding the raw dump `evidence/e1-t05-fs-log.jsonl` through
      `fsEventsToWatchEvents` (no server, no network) reproduces the golden transcript
      byte-for-byte, and `ef replay evidence/e1-t05-fs-log.jsonl --digest` printed in
      `evidence/e1-t05-digests.txt` pins which log the golden is a function of.
- [ ] Watch is a pure reader: a committed test dumps the stream heads before and after a
      full watch session (`GET` head offsets + `ef replay --digest` of the metadata
      stream) and asserts they are unchanged — a watcher that appends anything fails.
- [ ] Every emitted event carries the metadata-stream offset of the fs event that
      produced it; a committed test asserts offsets in the transcript are non-decreasing
      (events within one decomposition share the fs event's offset) and that, for
      **every** fs event k in the golden sequence (checked offline via the pure
      `fsEventsToWatchEvents` over the committed `evidence/e1-t05-fs-log.jsonl` dump —
      no server needed), resuming from the checkpoint taken after fs event k's
      decomposition emits exactly the decomposition of fs event k+1 first — nothing
      re-emitted, nothing skipped. This exhaustive-k check necessarily includes the k
      whose k+1 decomposition is the multi-event directory rename; a version that only
      checks a single convenient k does not satisfy this criterion.
- [ ] All standard gates pass: `pnpm format:check && pnpm lint && pnpm typecheck &&
      pnpm test && pnpm build` exit 0; E1-T02/E1-T03 suites still pass unmodified.
- [ ] Replay (browser layer): N/A — node library task, no browser-reaching surface;
      mitigation is the stream-layer transcript/digest evidence above, declared in the
      claim.

## Adversarial verification

Attack angles for the hostile critic. Run each with your own mutation scripts, timing,
and kill points, never the builder's; any single success refutes. Invent at least one
more.

1. **Your own script, differential.** Write your own mutation sequence (different paths,
   different op order, patches interleaved with renames, a file deleted and re-created at
   the same path, a rename onto a path vacated in the same sequence). Run a live watcher
   AND `fsEventsToWatchEvents` over the resulting cold log dump. The two transcripts must
   be byte-identical to each other. Any divergence refutes the determinism claim — do not
   let the committed golden be the only sequence ever tested.
2. **Kill-point sweep.** Drive the kill/resume yourself: SIGKILL the watcher on the
   k-th **in-memory emission** (counted via the pre-flush side-channel emission reports
   pinned in Deliverables, never via flushed transcript lines — flushed lines only ever
   land at decomposition boundaries) for every k across the whole sequence (script it),
   resume from the persisted checkpoint each time, byte-diff prefix+suffix against the
   uninterrupted transcript. Verify your sweep actually placed kills strictly inside
   multi-event decompositions — a sweep whose every kill lands at a boundary tests
   nothing.
   Pay special attention to kills landing *inside* a rename decomposition (after the
   `unlink`, before the `add`): the checkpoint and transcript writer are pinned at
   fs-event boundaries, so the persisted prefix must end at a decomposition boundary —
   a prefix containing a partial decomposition, a resume whose suffix re-emits any
   event already in the prefix (e.g. the `unlink`), skips the `add`, or emits the pair
   out of order refutes. Repeat with the long-poll timeout firing during
   the dead window.
3. **Chokidar dialect fidelity.** Point real chokidar at a scratch directory, perform the
   analogous OS-level mutations (create, append-write, rename, rmdir), and compare the
   event-name vocabulary and per-path event kinds against this watcher's transcript for
   the equivalent stream sequence. A `change` where chokidar says `add`, a missing
   `unlinkDir`, or an invented event name (`rename`, `move`) refutes the compatibility
   claim. (Ordering of unrelated paths need not match chokidar's OS races; the per-path
   kind mapping must.)
4. **Patch/change confusion fuzz.** Generate randomized sequences mixing full writes,
   patches (E1-T03), and deletes on a small path set (seeded, seed recorded). For each:
   every patch to a live file must surface as exactly one `change`; a patch is never
   dropped, never doubled, never misread as `add`. Also dispatch a patch targeting a
   deleted path: assert the dispatch is refused (per E1-T03 semantics — E1-T03, a
   declared dependency, owns the guarantee that a patch against a deleted/nonexistent
   path is refused and never reaches the log; head offset unchanged) and assert the
   watcher transcript contains zero events for that
   dispatch — any emitted event for a refused dispatch refutes. Cross-check by counting:
   transcript events per path must equal the reduced expectation computed independently
   from the log. Any mismatch, with its offset, refutes.
5. **Sensitivity proof of the measuring apparatus (mandatory).** In a scratch worktree,
   sabotage the watcher to (a) drop exactly one event on resume, (b) duplicate the
   boundary event, (c) swap the rename decomposition order, and (d) emit `add` instead of
   `change` for patches. `make verify-E1-T05` MUST go red under each mutation
   independently. Any sabotage that stays green refutes the apparatus and voids the
   task's evidence.
6. **Read-only violation hunt.** Grep the watch path for any `POST`/`dispatch`/writer
   import; then run a watch session against a stream, record head offsets and
   `ef replay --digest` before and after, and diff. Any append attributable to the
   watcher — including "harmless" marker events — refutes the pure-reader claim.
7. **Live-mode divergence.** Run long-poll and SSE watchers simultaneously on one stream
   during your own writer burst (irregular timing, bursts racing the long-poll re-arm).
   Their transcripts must be byte-identical to each other and to the cold-log-derived
   transcript. Also kill one watcher's socket mid-frame: the other must converge and the
   server must not crash.
8. **Cold-clone + golden provenance.** Run only via `tools/verify/cold_clone.sh`. Confirm
   the tests spawn their own server on an ephemeral port (grep for fixed ports/baseURL
   env). Then regenerate the golden from `evidence/e1-t05-writer-script.jsonl` yourself
   from scratch and byte-diff against the committed golden — a golden that cannot be
   re-derived from the committed script and the code refutes the evidence's provenance.

Refutation currency: a transcript file + the first offset where it diverges from the
golden or from the cold-log-derived transcript (use `ef bisect` where applicable), or a
before/after digest pair showing the watcher wrote to a stream. "Looked laggy" is not a
finding.

## Verification log
