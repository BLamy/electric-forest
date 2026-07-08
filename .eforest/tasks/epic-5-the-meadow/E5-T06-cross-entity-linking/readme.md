---
id: E5-T06
epic: 5
title: "Cross-entity linking: closes-references tie PRs to issues, and the merge event flips the referenced issue to done, exactly once"
priority: 506
status: pending
depends_on: [E5-T01, E5-T05]
estimate: S
capstone: false
---

## Goal

`packages/entities` (`@eforest/entities`) carries a **frozen entity-reference
convention** that lets a pull request name the issues it closes, and a **propagation
step wired into the dispatch door** that makes those references live: dispatching a
`pr/opened` event whose payload carries `closes: [entityRef, ...]` appends one
`issue/linked` event to each referenced issue's stream (through the E0-T11 validated
dispatch door, fenced); dispatching the `pr/merged` event (the same event that drives
E5-T05's log-aware merge) appends `issue/state-changed { to: "done" }` to each
referenced issue **exactly once** — re-dispatching or re-replaying the same merge
appends zero further events to any stream (head offsets byte-identical before/after),
because propagation is keyed on the merge's `(prStream, mergeOffset)` provenance
already visible in the issue's reduced state. A reference to a nonexistent issue
stream is a **typed no-op recorded on the PR** (`pr/link-noop { ref, reason:
"dangling-reference" }`), never a crash, never a partial close; a PR that closes
without merging (`pr/closed`) appends **nothing** to any referenced issue — the issue
stream's head offset is unmoved and its `ef replay --digest --reducer` output is
byte-identical to before the PR close. The whole negotiation is provable offline: a
committed golden multi-stream fixture (one PR stream + one issue stream) replays under
the E5-T01 issue reducer to the committed done-state golden digest, with the flip
occurring at exactly the offset whose event cites the merge — twice, from scratch,
byte-identically. `make verify-E5-T06` proves all of it.

## Context

This is the cross-linking bet of Epic 5 (ROADMAP.md, "Epic 5 — the-meadow": "pull
requests ... with cross-linking events (a merge event can close an issue)") and the
load-bearing joint of the E5-T12 capstone, whose headline moment is "the issue flips
to `done` via the merge's closing event." E5-T01 froze the per-issue event stream and
workflow reducer (`open` / `in-progress` / `done` / `closed` / `wont-do`) registered
with `ef replay`; E5-T02 froze the PR lifecycle stream; E5-T05 made the `pr/merged`
event drive the actual log-aware merge onto the target branch. This task adds the last
edge: entities that point at each other, with effects that cross stream boundaries —
the first time in the repo that dispatching one event legitimately appends events to
*other* streams. That is exactly why "exactly once" is the headline invariant: replay
is ground truth (`replay(log)` from offset `-1`, per AGENTS.md), so any propagation
that re-fires on re-replay would corrupt the very evidence layer the doctrine stands
on. Propagation therefore runs only at **dispatch time** (a side effect of accepting
the triggering event through the door), never inside any reducer — reducers stay pure
and replay stays a pure fold.

Dependency convention note: `depends_on` lists direct contract dependencies. E5-T01
(the issue reducer and `issue/*` envelope this task appends into) and E5-T05 (the
`pr/merged` event whose acceptance triggers close propagation) are listed. E5-T02's PR
envelope arrives transitively through E5-T05; the `closes` payload field and the
`pr/link-noop` event are **not** E5-T02 contracts — they are added and frozen here.

The two frozen blocks below are the byte-level source of truth; each must be
reproduced byte-for-byte in the `packages/entities` README under identical marker
pairs, with the golden-invalidation rule stated (changing them invalidates this task's
golden fixture).

<!-- frozen:E5-T06:entity-ref -->
An entity reference is the canonical-JSON object `{ "entity": <kind>, "stream":
<streamId> }` where `<kind>` is a member of the closed set `"issue"` (this task
freezes only `"issue"`; later tasks may extend the set, never reinterpret it) and
`<streamId>` is the referenced entity's stream id echoed verbatim as an opaque string
(E0-T03 opacity: never parsed, never fabricated, only compared and echoed).
Closes-references live in exactly two places: the `closes` array of the `pr/opened`
payload and the `closes` array of the `pr/merged` payload; the merged event's array is
the one that closes (the opened event's array only links). An empty or absent `closes`
array is valid and propagates nothing.
<!-- /frozen:E5-T06:entity-ref -->

<!-- frozen:E5-T06:propagation-rules -->
Propagation runs at dispatch time only, never in a reducer. On accepting `pr/opened`:
for each ref in `closes`, append `issue/linked { by: { entity: "pr", stream:
<prStream> }, atOffset: <openedOffset> }` to the referenced issue stream. On accepting
`pr/merged`: for each ref in `closes`, read the issue's reduced state; if
`state === "done"` or `closedBy` already contains `{ prStream, mergeOffset }`, append
`pr/link-noop { ref, reason }` to the PR stream (reason `"already-done"`) unless an
identical no-op for the same `(ref, mergeOffset)` is already in the PR's reduced state,
in which case append nothing; otherwise append `issue/state-changed { to: "done",
via: { prStream, mergeOffset } }` to the issue stream, fenced at the issue head read
during planning. A ref whose stream does not exist yields `pr/link-noop { ref,
reason: "dangling-reference" }` on the PR, deduplicated the same way. On accepting
`pr/closed` (close without merge): propagate nothing; every referenced issue stream's
head is untouched. All propagated appends go through the validated dispatch door; a
fencing race retries from a fresh read of the issue state (re-planning, so the
idempotence check re-runs) — propagation never blind-appends.
<!-- /frozen:E5-T06:propagation-rules -->

Contracts frozen here (documented verbatim in the `packages/entities` README, enforced
by tests): the two blocks above; the `issue/linked`, `issue/state-changed.via`, and
`pr/link-noop` payload shapes; and the rule that the issue reducer folds
`state-changed(done)` with `via` into both `state` and a `closedBy` set (an ordered,
canonically-encoded array in reduced state) so exactly-once is checkable from reduced
state alone. The issue reducer refuses (typed `link/duplicate-close`, through the
door, log untouched) any `issue/state-changed` whose `via` duplicates an entry already
in `closedBy` — defense in depth under the dispatch-time check.

Non-goals: no UI (E5-T08 renders backlinks), no reference kinds beyond `"issue"`, no
free-text `#123`-style reference parsing from comment bodies (references are structured
payload fields only), no reopening semantics (a `done` issue manually reopened and then
closed by a *second distinct* merge is covered by the rules above; no other reopen
machinery lands here), no evidence attachments (E5-T09).

## Deliverables

Path anchor: `evidence/` paths are relative to this task folder,
`.eforest/tasks/epic-5-the-meadow/E5-T06-cross-entity-linking/`.

- `packages/entities/src/link/refs.ts` — `parseEntityRef` / `isEntityRef` validation
  for the frozen shape (rejects unknown kinds, non-string streams, fabricated
  offsets), pure.
- `packages/entities/src/link/propagate.ts` — pure planner
  `planLinkPropagation(trigger, issueStates): PropagationStep[]` (trigger = the
  accepted `pr/opened` | `pr/merged` | `pr/closed` event with its offset; issueStates
  = reduced state or `absent` per ref) returning the exact ordered appends per the
  frozen rules — canonically encodable, so determinism is byte-checkable; plus the
  effectful driver that executes a plan through the dispatch door with fencing and
  re-plans on a fence refusal.
- Dispatch-door wiring in `packages/server`: accepting `pr/opened` / `pr/merged` /
  `pr/closed` runs the driver; reducer extensions in `packages/entities` for
  `issue/linked`, `issue/state-changed.via`/`closedBy`, `pr/link-noop`, and the
  `link/duplicate-close` refusal — all registered so `ef replay --reducer` folds them.
- `packages/entities/fixtures/linking/close-on-merge/` — the golden multi-stream
  fixture: `pr.events.jsonl`, `issue.events.jsonl` (full histories: issue opened →
  in-progress, PR opened with `closes` → linked event lands → review → merged →
  state-changed(done) lands), `expected.json` with the issue's golden digest at three
  pinned points — before the link, after the link, and final done-state — plus the
  pinned `via.mergeOffset` value that must equal the `pr/merged` event's offset in
  `pr.events.jsonl`.
- `packages/entities/fixtures/linking/dangling/` and `.../close-without-merge/` —
  fixture streams plus expected outcomes (the exact `pr/link-noop` event; the issue
  head offset and digest that must be unchanged).
- `packages/entities/test/link.plan.test.ts` — planner purity (two calls →
  byte-identical canonical plans), every propagation-rule row (link on open, close on
  merge, duplicate merge re-dispatch → empty plan, already-done → no-op step, dangling
  → no-op step, deduplicated no-op → empty plan, `pr/closed` → empty plan, empty
  `closes` → empty plan), and ref validation rejects.
- `packages/entities/test/link.lifecycle.test.ts` — against a live server: the full
  open→merge flow appends exactly the fixture's events; re-dispatching the merge
  appends zero events anywhere (all head offsets read before/after, byte-equal);
  duplicate `issue/state-changed` injected directly is refused `link/duplicate-close`
  with head unchanged; fencing race (a write lands on the issue between plan and
  append) re-plans and still closes exactly once; dangling and close-without-merge per
  their fixtures.
- `tools/verify/cross_entity_linking.sh` — the Makefile leg, printing one greppable
  line per check: `LINK fixture=close-on-merge digest=<d> expected=<d> OK` (link-point
  digest), `CLOSE fixture=close-on-merge offset=<o> via=<o> digest=<d> OK` (printed
  only after asserting the state-flip event's `via.mergeOffset` string-equals the
  merge event's offset in the dump **and** the final digest equals the golden),
  `IDEMPOTENT appended=0 OK` (re-dispatch of the merge; every stream head byte-equal),
  `DANGLING noop=dangling-reference issue-head=unchanged OK`,
  `CLOSE-NO-MERGE issue-head=unchanged digest=<d> OK`,
  `DETERMINISM fixture=close-on-merge OK` (the whole two-stream flow run twice from
  fresh servers, canonical event batches and digests byte-compared), and a mutation
  leg: flip one byte of a copy of the golden fixture's issue log, assert `ef replay`
  goes red (nonzero) before printing `MUTATION byte=<offset> EXPECTED-FAIL OK`; then
  sabotage the idempotence key in a scratch worktree (drop the `closedBy` check) and
  assert the suite goes red before `SENSITIVITY key=closedBy EXPECTED-FAIL OK`.
- `Makefile`: `verify-E5-T06` per the E0-T02 per-task contract; joins `verify-all`;
  `make verify-list` maps it; `tools/verify/self_check.sh` still passes.
- `packages/entities` README section "Cross-entity linking" carrying both frozen
  blocks under identical markers plus the payload shapes and the golden-invalidation
  rule; doc-sync checked mechanically (byte-diff of the delimited blocks) inside
  `cross_entity_linking.sh` or the test suite.
- `evidence/` — `e5-t06-verify.txt` (the full `make verify-E5-T06` transcript with
  every line above), `e5-t06-issue-log.jsonl` + `e5-t06-pr-log.jsonl` (dumped from the
  live lifecycle run), `e5-t06-digests.txt` (the three pinned digests plus the
  `via`/merge offset pair), `e5-t06-dangling.txt` and `e5-t06-close-no-merge.txt`
  (transcripts showing the PR-side no-op event and the unmoved issue head with
  before/after digests).

## Acceptance criteria

- [ ] `make verify-E5-T06` exits 0 from a pristine cold clone via
      `tools/verify/cold_clone.sh` (fresh server data dir, ephemeral port), zero skips
      — evidence: `make verify-E5-T06 2>&1 | grep -c '^SKIPPED:'` prints `0`.
- [ ] **Golden close-on-merge.** The committed multi-stream fixture replays under the
      registered issue reducer to the committed done-state golden digest, and the
      state flip is at exactly the merge's cited offset: the issue log's
      `issue/state-changed` event carries `via.mergeOffset` string-equal to the
      `pr/merged` event's offset in the committed PR log, the digest at the offset
      before the flip equals the pre-close golden, and the final digest equals the
      done golden — evidence:
      `make verify-E5-T06 2>&1 | grep -c '^CLOSE fixture=close-on-merge .* OK$'`
      prints `1`, with the `offset=`/`via=` fields equal in the transcript.
- [ ] **Exactly once.** Re-dispatching the identical `pr/merged` trigger against the
      already-propagated state appends zero events to the issue stream, the PR stream,
      and every other stream touched by the test (head offsets read before and after,
      byte-equal; dumped logs byte-identical) — evidence:
      `make verify-E5-T06 2>&1 | grep -c '^IDEMPOTENT appended=0 OK$'` prints `1`,
      plus the committed lifecycle assertion; and a directly-injected duplicate
      `issue/state-changed` (same `via`) is refused typed `link/duplicate-close` with
      the issue head unchanged — committed test assertion, `pnpm test` exit 0.
- [ ] **Determinism.** The full two-stream flow (open → link → merge → close
      propagation) run twice from fresh server processes yields canonically
      byte-identical event logs on both streams and identical digests — evidence:
      `make verify-E5-T06 2>&1 | grep -c '^DETERMINISM fixture=close-on-merge OK$'`
      prints `1`, and the replay leg replays the committed fixture twice with
      byte-identical digest output.
- [ ] **Dangling is typed, recorded, and harmless.** A `closes` ref to a nonexistent
      issue stream yields exactly one `pr/link-noop { ref, reason:
      "dangling-reference" }` on the PR stream, no crash, no new stream created, and
      re-dispatch appends nothing further — evidence:
      `make verify-E5-T06 2>&1 | grep -c '^DANGLING .* OK$'` prints `1`, transcript in
      `evidence/e5-t06-dangling.txt`.
- [ ] **Close without merge touches nothing.** `pr/closed` on a PR with live
      closes-references leaves every referenced issue stream's head offset and
      `ef replay --digest --reducer` output byte-identical to before — evidence:
      `make verify-E5-T06 2>&1 | grep -c '^CLOSE-NO-MERGE issue-head=unchanged .* OK$'`
      prints `1`, before/after digests in `evidence/e5-t06-close-no-merge.txt`.
- [ ] **Sensitivity.** Inside the same run: one byte of a fixture copy flipped →
      replay goes red before `MUTATION byte=<offset> EXPECTED-FAIL OK` prints; the
      `closedBy` idempotence check dropped in a scratch worktree → the suite goes red
      before `SENSITIVITY key=closedBy EXPECTED-FAIL OK` prints — evidence:
      `make verify-E5-T06 2>&1 | grep -c 'EXPECTED-FAIL OK'` prints ≥ `2`.
- [ ] **Frozen contract.** Both frozen blocks are reproduced byte-for-byte in the
      `packages/entities` README under identical `<!-- frozen:E5-T06:* -->` markers,
      the doc-sync check compares them mechanically and goes red on drift, and
      propagation code contains no reducer-side effects — a committed test replays the
      golden fixture through the pure reducer alone and asserts the fold performs zero
      dispatches/appends (replay is a pure fold) — evidence: doc-sync green in the
      transcript, committed test, `pnpm test` exit 0.
- [ ] All workspace gates pass repo-wide: `pnpm format:check && pnpm lint &&
      pnpm typecheck && pnpm test && pnpm build` exit 0; `make verify-list` shows
      `verify-E5-T06`; `verify-all` green; the E5-T01 and E5-T05 suites re-run green
      unmodified.
- [ ] Durable evidence committed under `evidence/` as listed in Deliverables, cited by
      path and digest in the Verification log.
- [ ] Replay browser layer: N/A (no browser surface lands here; E5-T08 renders
      backlinks) — mitigation: stream-layer evidence above is the currency; the
      Verification log entry declares this explicitly per AGENTS.md.

## Adversarial verification

The claim under attack: "the merge closes the referenced issue exactly once, dangling
references are typed no-ops on the PR, and a close-without-merge touches nothing."
Manufacture one double-close, one lost close, one silent dangling failure, or one
issue mutated by a non-merging PR — any single success refutes. Use your own streams,
refs, and timing throughout; invent at least one angle this list lacks.

1. **Replay-vs-dispatch honesty (mandatory).** The exactly-once claim lives or dies on
   propagation never running during replay. Take the committed golden logs, replay
   them from offset `-1` on a cold clone with `ef replay --digest --reducer` — then
   dump both streams from the live server after the lifecycle run and byte-compare.
   Any extra event on any stream after replay, or any code path where a reducer
   dispatches, refutes the architecture. Grep the reducers for dispatch/append/fetch
   calls — a reducer that reaches for the network is refuted on sight.
2. **Double-close hammering.** Re-dispatch the merge trigger N times, concurrently
   (parallel clients racing the propagation window), across server restarts, and after
   killing the server mid-propagation (between the PR-side merge accept and the
   issue-side append — restart must converge to exactly one `state-changed(done)`, or
   the gap is a finding: a merge accepted whose close never lands is a *lost* close,
   as fatal as a double one). Count `issue/state-changed` events with the same `via`
   in the dump: any count ≠ 1 refutes. Then race the fence yourself: land your own
   issue event between plan and append and verify the re-plan still closes once.
3. **Idempotence-key forgery.** Dispatch `issue/state-changed { to: "done" }` with:
   a `via` citing a merge offset that does not exist in the PR dump, a `via` citing a
   different PR, no `via` at all (a manual close — must be *allowed* per E5-T01's
   workflow, and must not block or be blocked by a later distinct merge close per the
   frozen already-done rule), and a byte-tweaked duplicate `via` (offset string padded
   or numerically re-rendered — E0-T03 opacity says comparison is string equality, so
   a "duplicate" that only matches after numeric coercion must NOT be treated as
   duplicate; a system that coerces refutes opacity). Each behavior must match the
   frozen rules with the log untouched on refusal.
4. **Dangling and hostile refs.** Feed `closes` arrays with: a nonexistent stream, a
   stream that exists but is a PR (wrong kind — must refuse or no-op typed, never
   close a PR as if it were an issue), `entity: "wiki"` (unknown kind — the ref
   validator must reject at dispatch, log untouched), duplicate refs to the same issue
   in one array (must close once, not twice), a ref to the PR's own stream, and 500
   refs in one merge (must propagate completely or refuse atomically — a partial
   close set with no record refutes; count `state-changed` events against the ref
   list). Verify every no-op is *recorded* on the PR and deduplicated on re-dispatch.
5. **Close-without-merge, adversarially.** Open a PR linking an issue, then: close it,
   reopen-equivalent flows if E5-T02 allows, close it again, and only then merge a
   *different* PR citing the same issue. The issue must be untouched by every
   `pr/closed` (byte-diff dumped issue log around each) and closed exactly once by the
   real merge. Also check the link event itself: `pr/opened` with `closes` on a PR
   that is *never* merged must leave the issue's workflow state at its pre-link value
   forever — an `issue/linked` event that nudges reduced `state` refutes the reducer.
6. **Golden rot and mutation independence.** Regenerate the fixture expectations from
   the committed logs with the committed code and byte-diff against `expected.json` —
   drift refutes determinism or reveals check-time regeneration. Flip your own byte
   (different offset than the harness's mutation leg) in the committed issue log and
   confirm red. Verify the `CLOSE` line's offset assertion has teeth: edit a copy of
   the fixture so `via.mergeOffset` cites a different (existing) offset and confirm
   the harness goes red — a green run refutes the offset-citation check specifically.
7. **Sensitivity, your sabotage not theirs.** In a scratch worktree: (a) make
   propagation fire on `pr/closed` too, (b) skip the `already-done` guard, (c) key
   idempotence on `prStream` alone (dropping `mergeOffset` — a second distinct merge
   from the same PR lineage must still close a reopened issue), (d) swallow dangling
   refs silently (no `pr/link-noop`). `make verify-E5-T06` and/or `pnpm test` must go
   red under each; any sabotage that stays green refutes the apparatus for that
   property.
8. **Cold clone + scope audit.** Run only via `tools/verify/cold_clone.sh`, twice
   back-to-back. Hold the diff against the evidence: the planner, the driver's fence
   retry, every propagation-rule row, both refusal types, and the doc-sync check must
   each have been executed by a test or transcript; check nothing out-of-scope was
   smuggled in (no comment-body reference parsing, no UI, no new reference kinds).
   Unexecuted diff is unproven or dead — the builder chooses which, you enforce it.

Refutation currency: a dump with two `state-changed` events sharing a `via`, a merge
whose close never lands after crash-recovery, an issue log whose head moved on
`pr/closed`, an unrecorded dangling ref, a reducer that dispatches, or a sabotage run
that stays green. Refutation → `status: refuted`, repro appended below. No refutation
→ promote your surviving angle-4 hostile-ref cases into the fixture corpus.

## Verification log
