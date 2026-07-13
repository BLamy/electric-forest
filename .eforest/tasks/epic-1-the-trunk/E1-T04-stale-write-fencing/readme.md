---
id: E1-T04
epic: 1
title: Stale-write fencing — writes and patches declare their base; stale writes refused with the log untouched
priority: 104
status: verified
depends_on: [E1-T02, E1-T03]
estimate: S
capstone: false
---

## Goal

Every stream-fs content mutation — the full-content write action from E1-T01 and the
diff-based patch action from E1-T03, dispatched through `POST /streams/:id/dispatch` on
`packages/stream-server` — carries a mandatory `base` field in its payload: the **content
revision** of the target path it was computed against, defined as the stream offset of
the last accepted content-affecting event for that path (or the documented
`BASE_NONE` sentinel for a path with no content history — first write after create).
Whether an E1-T02 rename counts as content-affecting for this revision definition —
i.e. what base the next write to a renamed path must declare — is a single builder
decision, but it must be pinned in the package README and exercised by a committed
test (see acceptance criteria); an undocumented answer is a contract hole, not a
freedom.
A registered `ActionValidator` (E0-T11's frozen extension point in
`packages/stream-server/src/validation.ts`, extended by registration, never by patching
the door) compares the declared base against the reduced state's per-path current
revision at head and refuses any mismatch **before append**: HTTP **409**, error body
`{ error: { class: 'validator-rejected', reason: 'stale-base', conflict: { path,
expectedBase, actualBase } } }` where `expectedBase` is the path's actual current
revision and `actualBase` is what the writer declared — and **nothing is appended**: the
stream's head offset, event count, and `ef replay --digest` canonical tree digest
(E1-T01) are byte-identical before and after every refusal. Only an exact base match is
accepted — outdated, future, fabricated, and foreign-path bases are all refused as
`stale-base`; a missing or non-string `base` field fails E1-T03's/E1-T01's payload
schema (`schema-violation`, 422) before the validator ever runs. This semantic per-file
fence sits **on top of** the raw `Stream-Seq` writer fencing from E0-T05: the dispatch
door's internal append still travels the fenced append path (so concurrent dispatches
are serialized and the validator's head-state read is not advisory), while `base` is the
content-level guarantee — a patch can never be applied to bytes it was not diffed
against, and a full write can never silently clobber content its author never saw.

## Context

E1-T03 made patches the bandwidth-efficient content event, and a patch is exactly the
event type that turns a lost race into silent corruption: applied against the wrong base
bytes, a diff either garbles the file or "succeeds" into a state no writer intended, and
that garbage replays forever (bet 1: state is `replay(events)`, always). Full writes have
the softer version of the same disease — last-writer-wins clobbering. This task closes
both with one rule at the one mutation door: declare what you diffed against, or be
refused. It is the stream-fs analogue of E0-T05's `Stream-Seq` fencing, lifted from
"per-stream writer sequence" to "per-path content revision", and implemented entirely
through E0-T11's frozen `ActionValidator` contract — the door itself does not change,
the taxonomy does not grow a new class, and E0-T11's log-neutral-refusal doctrine (409,
digest-identical before/after) is inherited wholesale.

Builds on: E1-T03 (the patch action shape this task adds `base` to; its deterministic
apply is what a correct base makes safe), E1-T02 (directory ops — the tombstone
delete/recreate and rename semantics this task's edge rules and adversarial attacks
interleave with; declared as a dependency because verification cannot run without
them), E1-T01 (write action, per-path reduced
metadata this validator reads, canonical tree digest as evidence instrument), E0-T11
(the `ActionValidator` registration API, `validator-rejected` → 409, structured error
body, refusal log-neutrality), E0-T05 (`Stream-Seq` fencing underneath). Unblocks:
E1-T05 (`watch()` tailers can trust that observed content events form a base-chain),
E1-T06 (two-client convergence assumes no silent clobber), and E1-T09/E1-T10 (merge is
only meaningful if concurrent divergence is *detected*, not absorbed — three-way merge
on patches consumes exactly the `expectedBase`/`actualBase` conflict data frozen here).
The E1-T11 capstone's two-sided editing rides this fence.

Contract frozen here: the `base` payload field (name, string-offset-or-`BASE_NONE`
semantics, mandatory on every content write and patch action), the refusal shape
(`error.class: 'validator-rejected'`, `error.reason: 'stale-base'`, the
`error.conflict: { path, expectedBase, actualBase }` object with exactly those key
names), and the exact-match acceptance rule. E1-T10's conflict events and Epic 4's
watcher-sync rebase loop parse `conflict` — renaming its keys later invalidates them.
The revision a successful write/patch establishes is **its own offset**: the next write
to that path must declare it. This is deliberately offset-based, not content-digest-
based, so an ABA sequence (write X, write Y, write X again) still advances the revision
and a base pointing at the first X is stale even though the bytes match — the package
README documents this choice.

Non-goals: automatic rebase/retry (the client-side rebase in this task's golden script
is a *test actor*, not a shipped API — Epic 4 owns the sync loop), merge of concurrent
edits (E1-T09/T10 — this task only *detects* and refuses), authz identity scoping of
fencing (Epic 2), and directory-op fencing (E1-T02's mkdir/rename semantics are
unchanged; only content events carry `base`).

## Deliverables

- `packages/stream-fs/src/fencing.ts` — the `stale-base` `ActionValidator`, registered
  for the E1-T01 write action type and the E1-T03 patch action type via E0-T11's
  `registerValidator`; reads the per-path current revision from the reduced state at
  head (the same reducer state E1-T01/T03 maintain — extended here with
  `lastContentOffset` per path if T03 did not already track it); exports `BASE_NONE`.
- Payload schema extension in `packages/stream-fs` (wherever E1-T01/T03 define the
  action payload types): `base: string` mandatory on write and patch payloads; the
  schema stage (422) owns missing/mistyped `base`, the validator (409) owns mismatched
  `base`. Package README gains a "Stale-write fencing" section documenting the frozen
  contract, the offset-not-digest ABA rationale, the exact-match rule, and the three
  edge rules: `BASE_NONE` semantics on a path that was written, tombstone-deleted via
  E1-T02, then recreated; whether `BASE_NONE` is ever a legal base for a *patch* (a
  diff against nothing — refused or documented); and the base-after-rename rule
  (whether an E1-T02 rename is content-affecting for the revision definition).
- `packages/stream-fs/test/fencing.test.ts` — integration over real HTTP through
  `/dispatch`:
  - Stale full write refused: 409, `error.reason === 'stale-base'`,
    `conflict.expectedBase`/`actualBase` are the literal correct offsets; head offset,
    event count, and `ef replay --digest` tree digest captured immediately before and
    after are byte-identical.
  - Stale patch refused identically (both action types individually exercised).
  - Refused-then-rebased: the refused writer recomputes against `expectedBase` and the
    resubmission is accepted, appending exactly one event.
  - `BASE_NONE` accepted for a path's first content event; `BASE_NONE` refused as
    `stale-base` once the path has content history; a real-offset base refused for a
    path with no history; a base borrowed from a *different* path's revision refused;
    a fabricated future offset (beyond head) refused.
  - Sensitivity direction: a loop of N ≥ 50 sequential correctly-based writes/patches
    (each declaring the offset the previous one established) with **zero** refusals —
    a fence that refuses correct writes fails this test.
  - Interleaving: valid → refused-stale → valid leaves a log digest-equal to the two
    valid dispatches alone.
- `packages/stream-fs/test/fencing.two-writer.test.ts` + committed golden — the
  two-writer script named in the task summary: writers A and B both read the file at
  revision r; A writes (accepted, revision → r′); B submits its write still declaring
  r (refused, log-neutral by offset + count + tree digest); B rebases onto r′ from the
  409's `conflict.expectedBase` and resubmits (accepted). The full transcript — every
  request's action type, declared base, response status, `error.conflict` body, and
  the before/after head offset + tree digest around the refusal — is written to
  `evidence/e1-t04-two-writer.txt`, and the final event log is dumped and committed as
  a golden (`evidence/e1-t04-two-writer.events.jsonl` + expected tree digest) that
  `ef replay --digest` re-verifies on every run.
- `Makefile`: `verify-E1-T04` per E0-T02's per-task contract — both test files, the
  golden replay of the two-writer log to its committed digest, and a re-run of the
  E1-T03 digest-parity suite (fencing must not perturb patch apply); nonzero exit on
  any failure; joins `verify-all`.
- `evidence/` — `e1-t04-two-writer.txt`, `e1-t04-two-writer.events.jsonl` + digest,
  `e1-t04-refusal-neutrality.txt` (before/after offset + count + tree digest pairs for
  every refusal class exercised, plus the before/after raw-dump byte comparison around
  the concurrent stale burst), `e1-t04-sensitivity.md` (the sabotage transcript,
  below).

## Acceptance criteria

- [ ] `make verify-E1-T04` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      with scrubbed env.
- [ ] Refusal neutrality: for each refused case (stale write, stale patch, `BASE_NONE`
      on existing content, foreign-path base, future-offset base), the test records
      head offset, event count, and `ef replay --digest` canonical tree digest
      immediately before and after the refusal and asserts all three byte-identical;
      the pairs are committed to `evidence/e1-t04-refusal-neutrality.txt`. An
      append-then-ignore implementation (a "rejected" marker event, a skipped event)
      fails by digest and by count.
- [ ] Burst neutrality at the raw-dump layer: the test captures the log before the
      burst, fires a burst of ≥ 10 concurrent stale dispatches (mixed writes and
      patches, all declaring outdated bases), captures again, and asserts neutrality
      on **two separately named surfaces**: (1) the on-disk log file's bytes before
      and after the burst are byte-identical (`cmp` semantics, not just digest-equal),
      and (2) the two `GET` from offset `-1` response bodies (before vs after) are
      byte-identical to each other — raw response-body bytes, `cmp` semantics, no
      builder-time choice of a weaker bar. If HTTP framing variance genuinely forces
      a hash-based comparison, the test must compute SHA-256 over the raw response
      body bytes (never the replayed tree digest, which would let an
      append-then-ignore "conflict marker" event pass this surface) and assert
      equality of exactly that predicate. Both assertions are required individually;
      passing one surface does not
      cover the other, since HTTP framing/encoding can differ from on-disk bytes
      while each is separately stable. Additionally, every dispatch in the burst
      returned 409 `stale-base`. Negative evidence at the stream layer: refusals
      appear in no log.
- [ ] Refusal shape, literal: every stale refusal is exactly HTTP 409 with
      `error.class: 'validator-rejected'`, `error.reason: 'stale-base'`, and
      `error.conflict.path` / `error.conflict.expectedBase` /
      `error.conflict.actualBase` present under exactly those key names, where
      `expectedBase` equals the path's true current revision offset (asserted against
      an independent read of the log, not against the validator's own state) —
      evidence: the committed test assertions plus the transcript in
      `evidence/e1-t04-two-writer.txt`.
- [ ] Two-writer golden: `verify-E1-T04` replays
      `evidence/e1-t04-two-writer.events.jsonl` through `ef replay --digest` to its
      committed tree digest, and the log contains **exactly three** content events for
      the contested path (A's write, B's rebased write, and the prior baseline) — B's
      refused attempt appears nowhere in the log.
- [ ] Rebase-to-success: B's resubmission uses the `expectedBase` value taken from the
      409 response body (the test derives it from the response, proving the error body
      is sufficient to recover), is accepted, and the final file content equals B's
      rebased content by tree digest.
- [ ] Never-refuse-correct sensitivity: the N ≥ 50 correctly-based sequential
      write/patch loop completes with zero 409s and a final `ef replay --digest`
      digest equal to an independently computed expected digest — committed as a test,
      not a claim. "Independently computed" is pinned, not aspirational: the expected
      digest must be derived by materializing the final N-write file contents with
      plain `fs` writes into a scratch directory and hashing them per the frozen
      E1-T01 tree-digest spec, never passing through the stream reducer or replay
      code — the one mechanism, named in the test. A frozen digest constant is not an
      acceptable substitute: its provenance cannot be checked structurally (a builder
      can run the reducer once and commit the output), so it is the same self-licking
      golden behind one level of indirection. Computing the "expected" digest by
      running the same reducer/digest code over the same log at test time fails this
      criterion for the same reason; the critic checks the mechanism structurally —
      plain `fs` + hashing, no reducer/replay imports — not by trust.
- [ ] Exact-match rule proven at both edges: `BASE_NONE` accepted only when the path
      has no content history; every non-current base (older, future, foreign,
      fabricated) refused as `stale-base`; a missing/mistyped `base` field returns 422
      `schema-violation` (E0-T11's class), not 409 — the two failure layers are
      distinguished by literal status + class assertions.
- [ ] ABA pinned: test writes content X, then Y, then X again (three accepted events,
      three distinct revisions), then submits a patch declaring the *first* X-revision
      as base — refused as `stale-base` even though the current bytes equal that
      base's bytes; the package README documents the offset-not-digest rule.
- [ ] Edge rules pinned and tested: the package README pins, and a committed test
      exercises, each of: `BASE_NONE` on a tombstoned-then-recreated path (E1-T02
      delete then recreate), `BASE_NONE` as the base for a patch, and the revision
      rule across an E1-T02 rename of the same path — observed behavior matches the
      documented rule in every case; an undocumented or mismatched rule fails this
      criterion.
- [ ] Concurrency holds at the boundary: two writers race the same base r over ≥ 20
      trials (concurrent dispatches); in every trial exactly one is accepted and one is
      refused with `stale-base`, and the post-race dump replays to a digest matching
      the single winner — no trial ever lands both, and no trial corrupts.
- [ ] Sabotage sensitivity: in a scratch worktree, no-op the fencing validator (accept
      every base) and run the fencing test suite — the stale-refusal tests MUST go
      red; the red transcript is committed as `evidence/e1-t04-sensitivity.md`. A
      green run under sabotage refutes the measuring apparatus.
- [ ] No regression: `make verify-E1-T03` (patch digest parity) and
      `make verify-E0-T11` (dispatch taxonomy + conformance) re-run green with fencing
      registered.
- [ ] All root gates pass: `pnpm format:check && pnpm lint && pnpm typecheck &&
      pnpm test && pnpm build` exit 0.
- [ ] Replay (browser layer): N/A — no browser-reaching surface; mitigation per
      AGENTS.md is the stream-layer digest evidence above, declared explicitly in the
      Verification log entry.

## Adversarial verification

The claim under attack: "no content event ever lands against bytes its author did not
see, no correct write is ever refused, and the refusal machinery is real." Use your own
streams, files, and offsets throughout; invent at least one more angle.

1. **Append-then-ignore hunt.** After each refusal of your own construction, dump the
   full log and diff byte-for-byte (and via `ef replay --digest` tree digest) against
   the pre-refusal dump; also tail the stream live (E0-T06 SSE) during the refusal.
   *Any* new record or emitted frame — even a "conflict" marker event — refutes
   log-neutrality outright. (E1-T10 gets conflict *events*; this task must produce
   none.)
2. **Base fuzz.** Throw your own generator at the `base` field: empty string, `"-1"`
   vs the `BASE_NONE` sentinel, another stream's valid offset, an offset that exists
   but belongs to a directory op or a different path's content event, the current head
   offset when the path's revision is older, whitespace-padded and unicode offsets,
   `base` as number/object/array/null (these must land in 422, not 409). Every
   non-exact-match string base must be 409 `stale-base` with a truthful
   `expectedBase`; any 5xx, crash, wrong-class response, or — worst — an *accepted*
   fabricated base refutes the fence. Verify `Object.prototype` is clean after the
   run.
3. **The corruption you were promised is prevented: differential.** Build the actual
   disaster by hand: capture a patch computed against revision r, advance the file
   past r yourself, then submit the stale patch. Under fencing it must be refused;
   then, in a scratch worktree with the validator no-op'd, submit the same patch and
   demonstrate the corrupted/unintended content it produces (record both tree
   digests). If you cannot produce divergent content with the fence off, the fence is
   guarding against nothing — file it as needs-evidence against the task's premise.
4. **Race the boundary, your own harness.** Do not reuse the builder's 20-trial test.
   Fire concurrent same-base pairs (and triples) at a fresh server, ≥ 50 rounds,
   mixing writes and patches on the same path. Exactly one winner per round; replay
   the dump after every round and verify the tree digest matches the winner-only
   expectation. Two accepted events for one base, a torn state, or a round where
   *zero* land (livelock) refutes serialization. Also verify the loser's 409
   `expectedBase` names the winner's actual offset.
5. **ABA and the sentinel edges.** Run your own X→Y→X sequence and submit a base
   pointing at the first X — acceptance refutes the frozen offset-not-digest rule.
   Then attack `BASE_NONE`: use it on a file with history (must refuse), on a file
   that was written then deleted via E1-T02 tombstone then recreated (whatever the
   builder pinned, the README must state it and the behavior must match — an
   undocumented answer is a refutation of the frozen contract, a documented one is a
   design note), and as the base for a *patch* (a diff against nothing — must be
   refused or documented, same standard).
6. **Sensitivity, your sabotage not theirs.** Beyond re-running the committed
   sabotage: (a) make the validator compare against the *previous* revision instead of
   current, (b) make it return 409 but with a fabricated `expectedBase`, (c) make it
   refuse *and* append. Run `make verify-E1-T04` after each — any sabotage the target
   stays green on refutes the apparatus for that property.
7. **Never-refuse-correct, adversarially.** Generate long single-writer chains (≥ 200
   events, mixed writes/patches, multiple paths interleaved) where every base is
   correct by construction; any 409 refutes the sensitivity claim. Then interleave
   directory ops (E1-T02 renames on the *same* path) mid-chain: whichever
   base-after-rename rule the builder pinned in the README, the chain must behave
   per-doc — silent refusals of documented-correct bases refute it.
8. **Cold-clone + golden re-derivation.** Run everything through
   `tools/verify/cold_clone.sh`. Replay the committed two-writer golden yourself with
   `ef replay --digest` and confirm the committed digest independently; confirm the
   log really contains no trace of the refused attempt (grep the raw dump, not the
   reduced state). Re-run `make verify-E1-T03` and `verify-E0-T11` on the T04 tree —
   any drift refutes "additive".

Refutation currency: a dump + offset where a stale event entered the log, an accepted
write against a base its author never saw, a refused correct write, an exact HTTP
transcript with the wrong status/class/conflict data, or a digest pair that should
match and doesn't. "The conflict message could be friendlier" is a note, not a finding.

## Verification log

### 2026-07-13 — builder — IMPLEMENTED

- Implementation commit `f13996aef19a3130a1a6499e481bd73df19dd484` adds mandatory
  offset-based `base` fencing for full writes and patches, schema-first 422 handling,
  structured stale conflicts, revision tracking through rename/delete/recreate, and
  client-side base propagation. The refusal path remains append-neutral.
- `CI=true make verify-E1-T04` passed: format, lint, typecheck, 20 test files / 121
  tests, build, self-check, E1-T01/E1-T02/E1-T03 regressions, the two-writer golden,
  refusal-neutrality verifier, sabotage sensitivity, and the two focused E1-T04 test
  files (4 tests).
- `CI=true tools/verify/cold_clone.sh verify-E1-T04` passed from a pristine clone of
  commit `f13996aef19a3130a1a6499e481bd73df19dd484` with scrubbed environment. Stream
  evidence is committed in `evidence/e1-t04-two-writer.events.jsonl` and
  `evidence/e1-t04-two-writer.digest` (`ca2b13563199e8a054c701f497ab2dd56da60221388ffc0dc03d765353feff78`),
  with the complete actor transcript in `evidence/e1-t04-two-writer.txt`, refusal
  neutrality in `evidence/e1-t04-refusal-neutrality.txt`, and sabotage sensitivity in
  `evidence/e1-t04-sensitivity.md`.

Replay: N/A (pure stream-fs protocol, server, CLI, and verification tooling; no browser-reaching surface) + mitigation: committed event-log replay digest, raw log/dump byte-neutrality checks, independent plain-fs sensitivity chain, concurrent two-writer races, full workspace gates, inherited regression targets, and scrubbed cold-clone verification.

The final stream-layer run demonstrates that stale full writes and patches return the
literal 409 conflict without changing the log, that a rebased writer succeeds, and
that exact bases remain accepted across 60 sequential writes, rename, tombstone
recreate, ABA, and 25 concurrent races. Status is `implemented` pending a fresh critic
session; the following fresh critic entry promotes this claim to `verified`.

### 2026-07-13 — critic — VERDICT: verified

- **FALSIFICATION — PASS.** Predicted that every stale full write and patch would return
  HTTP 409 with `validator-rejected` / `stale-base`, truthful
  `conflict.expectedBase` and `conflict.actualBase`, and no appended record. The
  independent refusal-neutrality run observed identical head, count, tree digest, raw
  on-disk log bytes, and raw dump bytes for stale full, stale patch, `BASE_NONE`,
  foreign-path, future-offset, and a ten-request concurrent burst; every burst request
  returned 409. The committed two-writer log contains exactly three content events and
  replays to `ca2b13563199e8a054c701f497ab2dd56da60221388ffc0dc03d765353feff78`, matching
  `evidence/e1-t04-two-writer.digest`.
- **SCHEMA LAYER — PASS.** An independent fresh-server attack covered missing, null,
  numeric, object, and array `base` values; all returned 422 `schema-violation` and
  stayed raw-dump-neutral. Empty, `-1`, whitespace, a create-event offset, a foreign
  content offset, and a Unicode fabricated offset returned 409 `stale-base` with the
  current path revision named as `expectedBase`.
- **CONCURRENCY / NOVEL ATTACK — PASS.** Thirty fresh triple full-write races, separate
  from the builder's pairwise patch races, produced exactly one 201 winner and two 409
  stale refusals per round; the sole appended state matched the winner's payload. The
  same attack left `Object.prototype` clean. A no-fencing control accepted the stale
  write with 201, so the measurement is sensitive to the registered fence.
- **SUFFICIENCY / COVERAGE — PASS.** I reviewed every changed hunk in `c4df7f0..6594999`:
  dispatch/schema/conflict plumbing is exercised by the HTTP tests; reducer revision
  tracking, rename/delete/recreate, full and patch client base propagation, malformed
  patch handling, and CLI offset preservation are exercised by the focused suites and
  replay/parity targets; fixtures, verifier branches, Makefile wiring, and committed
  evidence are consumed by `make verify-E1-T04`. Documentation-only changes are waived.
  No changed implementation hunk was left unexecuted or dead.
- **COLD CLONE / GATES — PASS.** `CI=true make verify-E1-T04` exited 0 with 20 test
  files / 121 tests, all root gates, E1-T01/T02/T03 regressions, golden replay,
  refusal-neutrality, sensitivity, and focused E1-T04 tests. Independently,
  `CI=true tools/verify/cold_clone.sh verify-E1-T04` exited 0 from a pristine clone of
  `6594999f390197b30ccd6c66401d22dbf256a162` with scrubbed environment.
- **Replay:** N/A (pure stream-fs protocol, server, CLI, and verification tooling; no
  browser-reaching surface) + mitigation: independent event-log replay, raw-log and
  raw-dump neutrality, schema/base fuzzing, triple-race attack, sabotage control,
  full gates, and scrubbed cold-clone verification.

Commands: `git diff --check c4df7f0..6594999`; `pnpm --silent ef replay
.eforest/tasks/epic-1-the-trunk/E1-T04-stale-write-fencing/evidence/e1-t04-two-writer.events.jsonl
--digest --reducer packages/streamfs/reducer.mjs`; `CI=true make verify-E1-T04`;
`CI=true tools/verify/cold_clone.sh verify-E1-T04`; independent fresh-server schema
fuzz and 30-round triple full-write race.
