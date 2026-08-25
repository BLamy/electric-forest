---
id: E5-T02
epic: 5
title: "Pull-request event model frozen: merge-proposal streams referencing (sourceBranch, targetBranch, forkOffset) with a validated lifecycle reducer"
priority: 502
status: implemented
depends_on: [E4]
estimate: M
capstone: false
---

## Goal

A pull request on electric-forest is a **merge-proposal event stream**, and this task
freezes its whole shape: `@eforest/pr` (`packages/pr`) defines the versioned event
envelopes — `pr.opened { v: 1, sourceBranch, targetBranch, forkOffset, title, body,
author }` (mandatory first event), `pr.review-comment { v: 1, author, body, path?,
replyTo? }`, `pr.approved { v: 1, reviewer }`, `pr.changes-requested { v: 1, reviewer,
body }`, `pr.merged { v: 1, mergedBy }`, `pr.closed { v: 1, closedBy, reason? }` — and a
pure, versioned reducer (`prReducer`, version 1) that folds them into a canonical-JSON
`PrState`: `{ v: 1, status, sourceBranch, targetBranch, forkOffset, title, body, author,
approvals, reviews, threads, openedAtOffset, resolvedAtOffset }` where `status ∈ open |
approved | merged | closed` and `approved` is **derived** (at least one approval and no
reviewer whose latest verdict is `changes-requested`; `author` may never count as a
reviewer). Comment identity is deterministic: a comment's id **is** its event offset,
and `replyTo` must name the offset of an earlier `pr.review-comment` on the same stream.
The lifecycle machine is enforced at the dispatch door via E0-T11 `ActionValidator`s —
**no `pr.merged` unless `status === approved`, no event of any kind after `merged` or
`closed`, no second `pr.opened`, no non-`opened` first event, and `pr.opened` is refused
unless `forkOffset` is a real offset on the `targetBranch` stream** (exists in its
resolved log, `≤` head, per the E1-T08 fork-offset domain) and both named branch streams
exist with `sourceBranch !== targetBranch`. Every refusal is an E0-T11
`validator-rejected` **409** carrying a frozen `error.reason` from this task's code list,
and is log-neutral: head offset and `ef replay --digest` dump digest byte-identical
before and after. The reducer registers with the Durable Streams service's reducer registry
(E0-T10 `register('pr', prReducer, 1)`) so application projection bootstrap, official live follow, and `ef replay` all speak
PR natively: `ef replay <pr-dump> --digest` of a golden lifecycle log reproduces a
committed digest, twice, byte-identically. Recording the merge **event** is this task;
performing the merge onto the target branch is E5-T05's.

## Context

This is the "pull requests as merge-proposal streams" line of ROADMAP.md Epic 5 and of
"One model to hold them all": a merged PR is not a row, it is a replayable negotiation
ending in a merge event. E4's capstone (the dependency) proved branch streams are real
enough to hang a proposal off of: `(sourceBranch, targetBranch, forkOffset)` is exactly
the triple E1-T08's `fs.branch.fork` record established, so a PR is "the fork, plus the
argument about merging it back." Everything downstream leans on the contract frozen
here: E5-T05 consumes `pr.merged` to drive the actual log-aware merge and appends
conflict events back onto this stream; E5-T06 adds closes-references on top of the same
envelope; E5-T08 renders the reduced `PrState` and dispatches these exact actions from
the browser; E5-T11 replays whole negotiations to one composite digest; E5-T12's
capstone walks the full machine. E5-T01 freezes the sibling issue model with the same
shape (per-entity stream + workflow reducer + door-enforced machine) — the two tasks
share doctrine but no code contract, and neither depends on the other.

Builds on, without re-freezing: E0-T03 (action/event envelope, canonical JSON, SHA-256
state digests), E0-T10 (reducer registry, application projection bootstrap, reducer-version cache keying),
E0-T11 (the four-class dispatch validation taxonomy — every refusal here is a
`validator-rejected` 409 within that frozen taxonomy, never a new status code), E0-T04
(`ef replay --digest` as the evidence instrument), E1-T08 (branch streams, the
fork-offset domain, `fs.branch.fork`), E2 (dispatch authentication — this task adds no
auth rules and weakens none).

Contract frozen here (versioned from this task forward; changing any of it later
invalidates the golden lifecycle logs):

- **The six event types and their `v: 1` payload schemas** listed in the Goal. Unknown
  fields are refused at schema validation (E0-T11 `schema-violation`, 422), not ignored.
- **The state machine**: stream must begin with exactly one `pr.opened`; `pr.merged`
  legal only from derived `approved`; `pr.closed` legal from `open` or `approved`;
  `merged` and `closed` are terminal — the door refuses **every** action type on a
  terminal PR, so a terminal stream's log can never grow (E5-T05's conflict/backlink
  events will extend this machine by revving the reducer version, not by loosening v1).
- **Derived approval**: `approvals` is the set of reviewers whose *latest* verdict event
  is `pr.approved`; one `pr.changes-requested` from any reviewer whose verdict was
  counted drops the PR from `approved` back to `open`. A reviewer's repeat of their own
  standing verdict is refused (`pr/duplicate-verdict`). The PR author is refused as a
  verdict-giver (`pr/self-review`).
- **Refusal reason codes** (each an E0-T11 `validator-rejected` 409):
  `pr/first-event-must-be-opened`, `pr/already-opened`, `pr/unknown-branch`,
  `pr/same-branch`, `pr/fork-offset-out-of-range`, `pr/merge-without-approval`,
  `pr/terminal`, `pr/duplicate-verdict`, `pr/self-review`,
  `pr/reply-to-unknown-comment`.
- **`PrState` canonical shape** as in the Goal, digested per E0-T03. All temporal facts
  are **offsets**, never wall-clock: `openedAtOffset`, `resolvedAtOffset`, comment ids,
  `replyTo`. `threads` groups review comments by root comment offset, ordered by offset.
- **Reducer totality**: `prReducer` is pure and total over *any* event sequence — fed a
  log the door would have refused (hand-built dump), it still terminates
  deterministically (illegal events reduce to no-ops on the frozen state) — because
  `replay(log)` must never depend on the door having existed.

Non-goals: executing the merge or fast-forward onto `targetBranch` and conflict events
(E5-T05), closes-references and issue flipping (E5-T06), any web UI or browser dispatch
(E5-T04/E5-T08), PR lists/boards as derived streams (E5-T03 pattern, applied to PRs in
E5-T08), evidence attachments (E5-T09), and re-validating that `forkOffset` still equals
the source branch's actual fork record after later rebases — the door checks the triple
at open time against the target's log; drift handling is merge-time (E5-T05) territory.

## Deliverables

- `packages/pr` (`@eforest/pr`): `src/events.ts` (the six frozen envelope schemas),
  `src/reducer.ts` (`prReducer` v1, pure, conforming to the `@eforest/protocol` reducer
  signature, total per the contract), `src/state.ts` (`PrState` type + canonical
  ordering), `src/validate.ts` (one E0-T11 `ActionValidator` per action type, emitting
  exactly the ten frozen reason codes; the `pr.opened` validator resolves
  `sourceBranch`/`targetBranch` streams and checks `forkOffset` against the target's
  resolved log through the server's own store — one lookup path, nothing invented).
- Server registration: stream type `pr` bound to `(prReducer, 1)` in the E0-T10 registry
  and its validators wired into the E0-T11 dispatch stage — so application projection bootstrap on a PR stream
  serves reduced `PrState` and `ef replay` resolves the reducer by stream type (and via
  `--reducer pr` explicitly).
- `packages/pr/test/pr-lifecycle.test.ts` — over a real Durable Streams service via real HTTP
  through `/api/dispatch`: the happy merged path (open → comment → changes-requested →
  comment → approve → merge) and the closed path, each asserting reduced state at every
  intermediate offset, `approved`-derivation flips in both directions, comment ids ==
  offsets, `replyTo` threading.
- `packages/pr/test/pr-refusals.test.ts` — every one of the ten reason codes triggered
  through the door, each asserting: status 409, `error.class === "validator-rejected"`,
  the exact frozen `error.reason`, and byte-identical head offset + dump digest
  before/after.
- `packages/pr/test/pr-property.fuzz.test.ts` — seeded (seeds committed): a generator
  over arbitrary interleavings of the six event types dispatches each sequence through
  the door and asserts the invariants — every accepted prefix reduces to a `PrState`
  satisfying the machine (merged ⇒ a counted approval stood at merge time with no later
  `changes-requested` before the merge; no event ever follows a terminal event in any
  accepted log; first accepted event is always `pr.opened`), every refusal is
  log-neutral, and `replay(accepted log)` twice yields one digest.
- `evidence/` — `e5-t02-lifecycle-merged.jsonl` + `e5-t02-lifecycle-closed.jsonl`
  (frozen golden logs) with `e5-t02-digests.txt` (their committed `ef replay --digest`
  values, produced by two separate processes), `e5-t02-refusals.txt` (frozen golden
  transcript: one block per reason code — dispatch body, 409 body, before/after head
  offset + dump digest), `e5-t02-sensitivity.md` (sabotage transcripts).
- `Makefile`: `verify-E5-T02` per the E0-T02 target contract — cold-clone runnable;
  replays both goldens and diffs digests against `e5-t02-digests.txt` (never
  regenerates them); re-drives every refusal fresh and diffs the transcript against the
  committed golden; runs the fuzz suite on the committed seeds; includes the
  sensitivity proof; re-runs `verify-E0-T11` proving the dispatch taxonomy is
  unperturbed.

## Acceptance criteria

- [ ] `make verify-E5-T02` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      with scrubbed env, output containing zero `SKIPPED:` lines.
- [ ] **Golden replay determinism**: `ef replay evidence/e5-t02-lifecycle-merged.jsonl
      --digest` (reducer resolved as `pr`) run twice in two separate node processes
      prints one byte-identical digest equal to the committed value in
      `evidence/e5-t02-digests.txt`; same for the closed-path golden. The goldens are
      frozen committed artifacts the verify run compares against, never rewrites.
- [ ] **The machine holds at every offset**: for the merged golden, application projection bootstrap queried at
      each successive offset shows exactly the expected `status` progression
      (`open → open → open → open → approved → merged`), `approvals` emptying on
      `changes-requested` and refilling on `pr.approved`, `resolvedAtOffset` equal to
      the merge event's offset, and every comment's id equal to its event offset —
      asserted by test as literal canonical-JSON equality, not spot fields.
- [ ] **Every illegal transition refused, log untouched**: each of the ten frozen
      reason codes is produced through `/api/dispatch` by test — including `pr.merged` on a
      never-approved PR, `pr.merged` after an approval that a later
      `changes-requested` revoked, any action after `pr.merged`, any action after
      `pr.closed`, `pr.opened` with `forkOffset` = target head + 1, with a nonexistent
      `targetBranch`, and with `sourceBranch === targetBranch` — each returning 409
      `validator-rejected` with the exact frozen reason, and for **every** refusal the
      stream's head offset and `ef replay --digest` dump digest are byte-identical
      before and after. The full set matches the committed golden
      `evidence/e5-t02-refusals.txt` byte-for-byte.
- [ ] **forkOffset is real, positively and negatively**: a `pr.opened` whose
      `forkOffset` is an offset actually present in the target branch's resolved log is
      accepted; the same dispatch with that offset bumped past head, or naming an
      offset outside the E1-T08 fork-offset domain, is refused
      `pr/fork-offset-out-of-range` — both cases in one test against the same live
      target branch, the accepted PR's reduced state carrying the triple verbatim.
- [ ] **Property suite green on committed seeds**: the seeded fuzz run (≥ 500 generated
      sequences) reports zero invariant violations — no accepted log contains an event
      after a terminal event, none merges without a standing approval, none begins with
      a non-`opened` event, and every generated refusal was log-neutral. Seeds are
      committed; the verify target runs exactly those seeds.
- [ ] **Reducer totality**: a hand-built dump containing door-illegal events (an event
      after `pr.merged`, a `pr.approved` before any `pr.opened`) replays without throw
      to a deterministic digest, twice byte-identical — proving `replay(log)` never
      depends on dispatch validation having run.
- [ ] Sensitivity proof inside `make verify-E5-T02`: in a scratch worktree, (a)
      deleting the `pr/merge-without-approval` check, (b) making `changes-requested`
      stop revoking a standing approval, and (c) flipping one byte of a golden
      lifecycle log, each turn the target red; transcripts in
      `evidence/e5-t02-sensitivity.md`. Any sabotage the target stays green on fails
      this criterion.
- [ ] No regression: `verify-E0-T11` re-runs green (the four-class taxonomy and its
      status codes unperturbed — this task added validators, not classes), and all root
      gates pass (`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test &&
      pnpm build`).
- [ ] Replay (browser layer): N/A — server/package task with no browser-reaching
      surface (the PR UI is E5-T08); declared explicitly per AGENTS.md, with the golden
      lifecycle logs, committed digests, refusal transcripts, and fuzz seeds as the
      stream-layer currency.

## Adversarial verification

The claim under attack: "a PR stream can only ever contain a legal negotiation — the
door refuses everything else without moving a byte — and replaying any accepted log
reproduces the committed lifecycle state exactly." Use your own branches, sequences, and
seeds throughout — never the builder's fixtures — and invent at least one angle this
list lacks.

1. **Your own negotiation, your own arithmetic.** From a cold clone: create a repo,
   fork a branch (E4/E1-T08 machinery), open a PR with the triple *you* compute from
   the fork record, and drive a full review-to-merge sequence with your own event
   bodies. Replay your log yourself and hand-derive the expected `PrState` from the
   frozen contract before querying application projection bootstrap. Any field mismatch — a wall-clock value
   where an offset belongs, a comment id that isn't its offset, an `approvals` set that
   survives a `changes-requested` — refutes the reducer.
2. **Order-of-operations fuzz with your seeds.** Run the property generator with fresh
   seeds (≥ 1000 sequences) and independently re-check its two directions: pick ten
   accepted logs and confirm by hand that each satisfies the machine; construct ten
   sequences that are illegal *by the written contract* (merge with zero approvals,
   merge where the only approval was later revoked, approve-after-close, second opened,
   reply to a comment offset that is a `pr.approved` event, self-review by the author)
   and confirm each is refused with the exact frozen reason. A single accepted-illegal
   or refused-legal sequence refutes; a generator that never *generates* the merge path
   (check the run's coverage of accepted `pr.merged`) refutes the apparatus instead.
3. **Refusal neutrality, byte-level.** For every one of the ten reason codes — trigger
   them yourself, not via the golden — dump the stream and record head offset +
   `ef replay --digest` before and after. One moved byte anywhere refutes. Then check
   the *cache*: after a refused dispatch, application projection bootstrap at head must still serve the
   pre-refusal state (a poisoned offset-keyed cache entry is a refutation even with a
   clean log).
4. **The TOCTOU race at the merge door.** With two concurrent clients: get a PR to
   `approved`, then fire `pr.changes-requested` and `pr.merged` simultaneously
   (repeat under load, many iterations). Whatever order the door serializes, the final
   log must be legal under the machine: if `changes-requested` landed first, the merge
   must have been refused. Dump every resulting log and check — any log containing
   `changes-requested` (revoking the only approval) followed by `pr.merged` refutes
   dispatch-time state reading. Same shape for terminal races: `pr.closed` vs
   `pr.merged` fired together must never both land.
5. **forkOffset frontier attack.** Probe the boundary yourself: exactly head (must
   accept), head + 1 (refuse), the E1-T08 `-1` sentinel and below (per the frozen
   domain), an offset on the *source* branch that doesn't exist on the target, a
   `targetBranch` stream created but empty, a target compacted (E1-T07) below the
   claimed offset. Every outcome must match the written contract with the frozen
   reason; an accepted PR pointing at an offset you can prove absent from the target's
   resolved log refutes. Also confirm the check reads the **target's** log, not the
   source's: a valid-on-source-only offset accepted refutes.
6. **Terminal really means terminal.** Merge a PR, then throw the whole action
   vocabulary at it — all six types, plus a well-formed action of a type registered for
   a *different* stream type (must be `unknown-action-type` 404 per E0-T11, not a 409),
   plus schema-invalid junk (422). The PR's log must not grow by one event across the
   barrage (dump digest before/after the entire volley). Any append refutes; any
   refusal arriving under the wrong E0-T11 class/status refutes the taxonomy claim.
7. **Golden and sabotage sensitivity.** Flip one byte in a copy of a golden lifecycle
   log and run the verify comparison — it must go red; a green run refutes the
   measuring apparatus. Independently re-run the builder's three sabotages from
   scratch worktrees and add one of your own (e.g. make the `pr.opened` validator skip
   the branch-existence lookup); the builder's tests must go red for each. Then the
   self-licking check: confirm the committed digests in `e5-t02-digests.txt` predate
   and are never rewritten by the verify run (`git log` the file; a target that
   regenerates its own expectation refutes it as evidence).
8. **Cold-clone reducer independence.** From a pristine clone in a scratch dir with
   scrubbed env, replay both goldens in a process that imports only
   `@eforest/protocol` + `@eforest/pr`'s reducer (no server, no test harness) and
   compare digests to the committed values. A mismatch — or any dependence on server
   state, env, or wall clock to reproduce them — refutes replay determinism.

## Verification log

### 2026-08-24 — Sol builder checkpoint — composed proof passed; cold clone environment-failed

- The single composed run at exact implementation HEAD
  `5a13630847e0a249290067f8cec91aff3fcf842a` passed
  `make --no-print-directory verify-E5-T02`. Its 22,698-line transcript is preserved
  as `evidence/e5-t02-composed-5a136308-passed.txt` with SHA-256
  `b680456da64ab29b3ab48069074c9743ef6ea21e5da36f20591b1a591666b5d6`;
  it ends in the unique `verify-E5-T02: OK` marker with zero `SKIPPED:` markers.
- Exactly one pristine-clone run was then launched from preservation commit
  `797c92bff3b3d6acc596be512265354b3bbb020d`. It exited `2` after the managed
  execution sandbox denied loopback listeners with
  `listen EPERM: operation not permitted 127.0.0.1` (first at transcript lines 353
  and 625), cascading through the live HTTP/Durable Streams tests. The full transcript
  and audit metadata are preserved as
  `evidence/e5-t02-cold-clone-797c92bf-environment-failed.txt` and its
  `.meta.txt` companion (SHA-256
  `6c30beafa23adfda36dcf9a7e906bfa2d21b0c42ca84c5ef05f9891d260b9006`).
- No duplicate gate or cold-clone retry was launched, no test was weakened, and the
  task remains `in-progress`. The next admissible proof action is one cold-clone run
  on an execution host that permits binding `127.0.0.1`; E5-T03 remains queued behind
  E5-T02. Replay: N/A (server/package task; committed stream-layer transcripts and
  digest artifacts are the mitigation).

### 2026-08-25 — builder — exact-head cold clone passed; submitted to fresh Sol critic

- The pristine-clone attempt at `292b7482` exposed two inherited contention lifecycle
  defects after `646/648` root tests passed: an idempotent snapshot dump could lose a
  reset local connection, and graceful watcher shutdown could time out while durable
  journals were still advancing. The failed run remains frozen at
  `evidence/e5-t02-cold-clone-292b7482-contention-lifecycle-failed.txt` (SHA-256
  `9918f1ecc7ea9bf6e96f78537d1a1c66b473ceca9d7b2f46bf5e4e74114bee4e`).
- Commit `9c978705` adds one bounded retry only to the idempotent snapshot dump request
  for connection-reset/socket-close failures, while a second failure remains loud. It
  also renews the graceful-stop deadline only when a durable journal makes progress,
  so a draining watcher can cross the original deadline but a stalled drain still
  fails. Both regressions were reproduced red before the repair and pass afterward;
  commit `99f7e010d9438cd8199872bc203324f12cf8e756` is the exact code and provenance
  candidate tested below.
- Exactly one `tools/verify/cold_clone.sh verify-E5-T02` run was launched from
  `99f7e010d9438cd8199872bc203324f12cf8e756`. It exited `0` from a pristine clone.
  The verbatim transcript is
  `evidence/e5-t02-cold-clone-99f7e010-passed.txt`: SHA-256
  `f6f8e5b91c6315c7a06fe86c5e27918d106a7a78fa6c7616312e809ded319307`,
  `23,020` lines, `1,656,526` bytes. It contains one `verify-E5-T02: OK`, one
  `cold_clone: verify-E5-T02 PASSED from a pristine clone`, and zero `SKIPPED:`
  markers. The audit metadata is committed beside it in the `.meta.txt` companion;
  preservation commit `e9952f31` changes only that proof and the two inherited
  no-database inventories it necessarily extends.
- The same exact-head transcript records all root gates green (`69/69` test files,
  `650/650` tests), E5-T02's four focused files green (`14/14` tests), both lifecycle
  goldens replaying through separate processes, all ten refusal blocks remaining
  byte-neutral, `512` seeded property sequences, and all three named sabotages going
  red with `EXPECTED-FAIL OK`. It also re-earns the serialized E2-E4 dependency gates,
  including E4-T12's live/partition/reunion browser capstone with zero console errors
  and the contention-sensitive E4 watcher/snapshot paths repaired here.
- Replay: N/A (non-browser PR event/reducer/server validation) + mitigation: the
  committed pristine-clone transcript, deterministic lifecycle logs and digests,
  byte-neutral refusal transcript, seeded property suite, mutation sensitivities, and
  exact-head inherited gate evidence above. Browser behavior itself is unchanged; the
  inherited E4-T12 browser run is regression coverage, not the evidence layer claimed
  for this task.
