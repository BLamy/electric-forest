---
id: E5-T07
epic: 5
title: "Cross-entity linking: closes-references tie PRs to issues, and the merge event flips the referenced issue to done, exactly once"
priority: 507
status: pending
depends_on: [E5-T01, E5-T06]
estimate: M
capstone: false
---

## Goal

`@eforest/meadow` (`packages/meadow`, E5-T02/E5-T06's package) gains a `links` module
(`packages/meadow/src/links/`) that freezes the **entity-reference convention** — a PR
names the issues it closes via a `closes: [entityRef, ...]` array on the `pr.opened`
payload — and a **propagation step wired into the dispatch door** that makes those
references live in both directions: accepting `pr.opened` appends one
`issue.linked { v: 2, by: { entity: "pr", stream }, atOffset }` backlink event to each
referenced issue's stream (through E0-T11's validated door, fenced); the `pr.merged`
outcome event landing (the same event E5-T06's executor appends) appends
`issue.state-changed { v: 2, to: "done", via: { prStream, prMergedOffset } }` to each
referenced issue **exactly once**, plus a `pr.link-closed { v: 1, ref, issueOffset }`
backlink on the PR stream citing exactly where the close landed — so the relation is
traversable from either side's reduced state alone. Idempotence is **structural**, not
best-effort: propagation runs only at dispatch time, never in a reducer, and is keyed
on the `via` provenance already visible in the issue's reduced `closedBy` set — so
`ef replay --digest --reducer` over the pair of committed logs from offset `-1` yields
exactly one `issue.state-changed` to `done`, and re-dispatching the identical merge
trigger against the live server appends zero events to every stream (head offsets and
dump digests byte-identical before and after). A ref to a nonexistent stream, an
already-`done` issue, an issue whose current state makes `to: "done"` illegal under
E5-T01's `WORKFLOW_TRANSITIONS`, or a duplicate ref in one `closes` array is a **typed,
recorded, deduplicated no-op** (`pr.link-noop { v: 1, ref, reason }`) — never a crash,
never a partial close, never a second close. `pr.closed` (close without merge)
propagates nothing: every referenced issue's head offset and replay digest are
byte-identical to before. A committed golden two-stream fixture (issue log + PR log)
replays on both sides to committed digests with the flip at exactly the offset whose
event cites the merge; `make verify-E5-T07` proves all of it cold.

## Context

This is the cross-linking bet of Epic 5 (ROADMAP.md, "Epic 5 — the-meadow": "pull
requests ... with cross-linking events (a merge event can close an issue)") and the
load-bearing joint of the E5-T13 capstone, whose headline moment is "the issue flips to
`done` via the merge's closing event." E5-T01 froze the per-issue event stream, the
seven-action `v: 1` envelope, and the workflow reducer registered with `ef replay`;
E5-T02 froze the PR lifecycle stream; E5-T06 made `pr.merge` drive the real log-aware
merge and froze the `pr.merged { v: 1, targetMergeOffset, kind, resultTreeDigest }`
outcome event. This task adds the last edge: entities that point at each other, with
effects that cross stream boundaries — the first time in the repo that accepting one
event legitimately appends events to *other* streams. That is exactly why "exactly
once" is the headline invariant: replay is ground truth (`replay(log)` from offset
`-1`, per AGENTS.md), so any propagation that re-fires on re-replay would corrupt the
very evidence layer the doctrine stands on. Propagation therefore runs only at
**dispatch time** (a side effect of accepting the triggering event through the door),
never inside any reducer — reducers stay pure and replay stays a pure fold. E5-T09
renders the backlinks this task records; E5-T12's negotiation harness replays the
multi-stream session this task makes coherent.

Dependency convention note: `depends_on` lists direct contract dependencies. E5-T01
(the issue envelope, `WORKFLOW_TRANSITIONS`, and reducer this task appends into and
consults) and E5-T06 (the `pr.merged` outcome event whose landing triggers close
propagation, and its recovery contract this task must compose with). E5-T02's PR
envelope arrives transitively through E5-T06; the `closes` payload field,
`pr.link-closed`, and `pr.link-noop` are **not** E5-T02 contracts — they are added and
frozen here under the additive-extension rules both dependency tasks documented.

Envelope extensions, both explicitly additive per the frozen extension rules of the
tasks that own them (existing `v: 1` goldens must replay byte-identically — the E5-T01,
E5-T02, and E5-T06 suites re-run green unmodified, asserted in this task's gates):

- **Issue side (E5-T01's rule):** new action type `issue.linked { v: 2 }` and a `v: 2`
  form of `issue.state-changed` carrying the optional `via` object. `v: 1` payloads are
  untouched and validate exactly as before; validators for the `v: 2` forms are
  registered alongside, and the reducer folds both.
- **PR side (E5-T02/E5-T06's rule):** `pr.opened` gains an optional `closes` array;
  new event types `pr.link-closed` and `pr.link-noop`.

The three frozen blocks below are the byte-level source of truth; each must be
reproduced byte-for-byte in the `packages/meadow` readme under identical
`<!-- frozen:E5-T07:<block> -->` marker pairs (doc-sync checked mechanically, like
E5-T06's), with the golden-invalidation rule stated: changing any of them invalidates
this task's golden fixture and every later Epic-5 linking golden.

<!-- frozen:E5-T07:entity-ref -->
An entity reference is the canonical-JSON object `{ "entity": <kind>, "stream":
<streamId> }` where `<kind>` is a member of the closed set `"issue"` (this task freezes
only `"issue"`; later tasks may extend the set additively, never reinterpret it) and
`<streamId>` is the referenced entity's stream id echoed verbatim as an opaque string —
never parsed, never fabricated, compared only by string equality. Closes-references
live in exactly one place: the optional `closes` array of the `pr.opened` payload. The
set of issues a merge closes is the `closes` array of the PR's own `pr.opened` event as
recorded on the PR stream — payload data on `pr.merge` or `pr.merged` never adds,
removes, or reorders refs. An empty or absent `closes` array is valid and propagates
nothing.
<!-- /frozen:E5-T07:entity-ref -->

<!-- frozen:E5-T07:propagation-rules -->
Propagation runs at dispatch time only, never in a reducer. On accepting `pr.opened`
with `closes`: for each ref, in array order, append `issue.linked { v: 2, by:
{ entity: "pr", stream: <prStream> }, atOffset: <openedOffset> }` to the referenced
issue stream; a ref whose stream does not exist yields `pr.link-noop { v: 1, ref,
reason: "dangling-reference" }` on the PR stream instead. After the E5-T06 executor
appends `pr.merged` at offset M on PR stream P: for each ref, in array order, read the
issue's reduced state; (a) if `closedBy` already contains `{ prStream: P,
prMergedOffset: M }`, append nothing for that ref; (b) else if `state === "done"`,
append `pr.link-noop { v: 1, ref, reason: "already-done" }`; (c) else if
`WORKFLOW_TRANSITIONS` makes `issue.state-changed { to: "done" }` illegal from the
current state, append `pr.link-noop { v: 1, ref, reason: "illegal-transition" }`;
(d) else if the ref's stream does not exist, `pr.link-noop { v: 1, ref, reason:
"dangling-reference" }`; (e) otherwise append `issue.state-changed { v: 2, to: "done",
via: { prStream: P, prMergedOffset: M } }` to the issue stream, fenced at the issue
head read during planning, followed by `pr.link-closed { v: 1, ref, issueOffset:
<offset of that state-changed event> }` on the PR stream. Duplicate refs to the same
stream within one `closes` array collapse to the first occurrence. Every `pr.link-noop`
is deduplicated on `(ref, prMergedOffset)` against the PR's reduced state — a re-run
that would re-record an identical no-op appends nothing. On accepting `pr.closed`
(close without merge): propagate nothing; every referenced issue stream's head is
untouched. All propagated appends go through the validated dispatch door; a fencing
race retries from a fresh read of the issue state (re-planning, so the idempotence
check re-runs) — propagation never blind-appends.
<!-- /frozen:E5-T07:propagation-rules -->

<!-- frozen:E5-T07:post-terminal-links -->
Amendment to E5-T02's terminal rule, additive and validator-enforced: after `pr.merged`,
exactly two event types remain legal on a PR stream — `pr.link-closed` and
`pr.link-noop` — and each is legal only when its `prMergedOffset` provenance
(`issueOffset`'s citing close for `link-closed`; the dedup key for `link-noop`) refers
to this PR's own `pr.merged` event. They carry no lifecycle effect: the reducer's
`status` stays `merged`; they fold only into the reduced `links` array. Every other
event type after `merged` or `closed` is refused `pr/terminal` exactly as E5-T02 froze.
After `pr.closed`, `pr.link-closed` and `pr.link-noop` are refused too — there is no
merge to cite.
<!-- /frozen:E5-T07:post-terminal-links -->

Contracts frozen here (documented verbatim in the `packages/meadow` readme, enforced by
tests): the three blocks above; the `issue.linked`, `issue.state-changed.via`,
`pr.link-closed`, and `pr.link-noop` payload shapes; the rule that the issue reducer
folds `state-changed(done)` with `via` into both `state` and a `closedBy` set (an
ordered, canonically-encoded array in reduced state) so exactly-once is checkable from
reduced state alone; the issue-side refusal `link/duplicate-close` (typed, through the
door, log untouched) for any `issue.state-changed` whose `via` duplicates an entry
already in `closedBy` — defense in depth under the dispatch-time check; and the PR
reducer's `links` array — one entry per ref, `{ ref, state: "linked" | "closed" |
"noop", reason?, issueOffset? }`, offset-ordered by resolution — the PR-side half of
traversability.

Non-goals: no UI (E5-T09 renders backlinks and the review timeline), no reference kinds
beyond `"issue"`, no free-text `#123`-style reference parsing from comment bodies
(references are structured payload fields only), no reopening machinery (a `done` issue
manually reopened via E5-T01's `issue.reopened` and later closed by a *second distinct*
merge is covered by the rules above; nothing more lands here), no evidence attachments
(E5-T10), no changes to E5-T06's merge executor beyond hooking propagation after its
outcome event, no database (bet 4 — the link index on each side is `replay(stream)`,
full stop).

## Deliverables

Path anchor: `evidence/` paths are relative to this task folder,
`.eforest/tasks/epic-5-the-meadow/E5-T07-cross-entity-linking/`.

- `packages/meadow/src/links/refs.ts` — `parseEntityRef` / `isEntityRef` validation for
  the frozen shape (rejects unknown kinds, non-string streams, extra fields), pure.
- `packages/meadow/src/links/propagate.ts` — pure planner
  `planLinkPropagation(trigger, prState, issueStates): PropagationStep[]` (trigger =
  the accepted `pr.opened` or landed `pr.merged` event with its stream id and offset;
  `issueStates` = reduced issue state or `absent` per ref) returning the exact ordered
  appends per the frozen rules — canonically encodable, so determinism is
  byte-checkable; plus the effectful driver that executes a plan through the dispatch
  door with fencing and re-plans on a fence refusal. The driver is re-entrant: run
  against a partially-applied plan (crash window between issue-side and PR-side
  appends) it completes exactly the missing steps, keyed on `closedBy` /
  `(ref, prMergedOffset)`.
- Dispatch-door wiring in the Durable Streams service: accepting `pr.opened` runs the link
  driver; the E5-T06 executor's `pr.merged` landing runs the close driver (composed
  with E5-T06's recovery scan — a recovered merge propagates too, exactly once).
- Reducer and validator extensions: `@eforest/platform` issues module gains the `v: 2`
  `issue.linked` / `issue.state-changed.via` validators, `closedBy` folding, and the
  `link/duplicate-close` refusal; `packages/meadow/src/pr/reducer.ts` gains
  `pr.link-closed` / `pr.link-noop` folding into `links` and the post-terminal-links
  validator — all registered so `ef replay --reducer` folds them offline.
- `packages/meadow/fixtures/linking/close-on-merge/` — the golden two-stream fixture:
  `pr.events.jsonl`, `issue.events.jsonl` (full histories: issue opened →
  `in-progress`; PR opened with `closes` → `issue.linked` lands → review → approved →
  merged → `issue.state-changed(done)` lands → `pr.link-closed` lands), and
  `expected.json` pinning: the issue digest at three points (before the link, after the
  link, final done-state), the final PR digest, the `via.prMergedOffset` value (must
  string-equal the `pr.merged` event's offset in `pr.events.jsonl`), and the
  `pr.link-closed.issueOffset` value (must string-equal the closing event's offset in
  `issue.events.jsonl`).
- `packages/meadow/fixtures/linking/dangling/`, `.../already-done/`, and
  `.../close-without-merge/` — fixture streams plus expected outcomes (the exact
  `pr.link-noop` event; the issue head offsets and digests that must be unchanged).
- `packages/meadow/test/links.plan.test.ts` — planner purity (two calls →
  byte-identical canonical plans), every propagation-rule row (link on open, close on
  merge, rule (a) re-run → empty plan, already-done → no-op step, illegal-transition
  (issue in `closed`) → no-op step, dangling on open and on merge, duplicate refs in
  one array collapse to one step, deduplicated no-op → empty plan, `pr.closed` → empty
  plan, empty/absent `closes` → empty plan), and ref-validation rejects.
- `packages/meadow/test/links.lifecycle.test.ts` — against a live server: the full
  open → link → approve → merge → close flow appends exactly the fixture's events;
  re-dispatching `pr.merge` refuses `pr/already-merged` (E5-T06) **and** appends zero
  events to the issue stream and the PR stream (all head offsets read before/after,
  byte-equal; dumped logs byte-identical); a directly-injected duplicate
  `issue.state-changed` (same `via`) is refused `link/duplicate-close` with head
  unchanged; the crash window (issue-side close landed, PR-side `pr.link-closed`
  withheld, driver re-run) completes with exactly one `state-changed(done)` and one
  `pr.link-closed`; a fencing race (a write lands on the issue between plan and append)
  re-plans and still closes exactly once; post-terminal validator refuses any
  non-link event after `merged` and any link event citing a foreign or nonexistent
  merge; dangling, already-done, and close-without-merge per their fixtures.
- `tools/verify/cross_entity_linking.sh` — the Makefile leg, fresh file-backed server
  per scenario, one greppable line per check:
  `LINK fixture=close-on-merge digest=<d> expected=<d> OK` (link-point issue digest),
  `CLOSE fixture=close-on-merge offset=<o> via=<o> backlink=<o> OK` (printed only
  after asserting the flip event's `via.prMergedOffset` string-equals the `pr.merged`
  offset in the PR dump, the `pr.link-closed.issueOffset` string-equals the flip
  event's offset in the issue dump, and both final digests equal the goldens),
  `IDEMPOTENT appended=0 OK` (re-dispatch of the merge; every stream head byte-equal),
  `REPLAY-ONCE count=1 OK` (grep the replayed issue log for `state-changed` events
  with `to: "done"`: exactly one, and offline replay of both committed logs matches
  the golden digests — replay fires no propagation),
  `DANGLING noop=dangling-reference issue-head=n/a pr-digest=<d> OK`,
  `ALREADY-DONE noop=already-done issue-head=unchanged OK`,
  `CLOSE-NO-MERGE issue-head=unchanged digest=<d> OK`,
  `DETERMINISM fixture=close-on-merge OK` (the whole two-stream flow run twice from
  fresh servers; canonical event logs and digests on both streams byte-compared), and
  a mutation leg: flip one byte of a copy of the golden issue log, assert `ef replay`
  goes red (nonzero) before printing `MUTATION byte=<offset> EXPECTED-FAIL OK`; then
  sabotage the idempotence key in a scratch worktree (drop the `closedBy` check in the
  planner) and assert the suite goes red before
  `SENSITIVITY key=closedBy EXPECTED-FAIL OK`.
- `Makefile`: `verify-E5-T07` composing the frozen `_v-*` gates plus
  `cross_entity_linking.sh`; joins `verify-all`; `make verify-list` maps it;
  `tools/verify/self_check.sh` still passes.
- `packages/meadow` readme section "Cross-entity linking" carrying all three frozen
  blocks under identical markers plus the payload shapes, the `links` reduced shape,
  and the golden-invalidation rule; doc-sync checked mechanically (byte-diff of the
  delimited blocks) inside `cross_entity_linking.sh` or the test suite.
- `evidence/` — `e5-t07-verify.txt` (the full `make verify-E5-T07` transcript with
  every line above), `e5-t07-issue-log.jsonl` + `e5-t07-pr-log.jsonl` (dumped from the
  live lifecycle run), `e5-t07-digests.txt` (the pinned digests plus the two
  offset-citation pairs), `e5-t07-probes.txt` (transcripts of the re-dispatched merge,
  duplicate-reference, dangling-reference, and already-done probes, each with
  before/after head offsets and digests).

## Acceptance criteria

- [ ] `make verify-E5-T07` exits 0 from a pristine cold clone via
      `tools/verify/cold_clone.sh` (fresh server data dir, ephemeral port), zero skips
      — evidence: `make verify-E5-T07 2>&1 | grep -c '^SKIPPED:'` prints `0`.
- [ ] **Golden close-on-merge, cited from both sides.** The committed two-stream
      fixture replays under the registered reducers to the committed golden digests on
      both streams, and the citation loop closes: the issue log's flip event carries
      `via.prMergedOffset` string-equal to the `pr.merged` offset in the PR log, and
      the PR log's `pr.link-closed` carries `issueOffset` string-equal to the flip
      event's offset — evidence:
      `make verify-E5-T07 2>&1 | grep -c '^CLOSE fixture=close-on-merge .* OK$'`
      prints `1`, with equal `offset=`/`via=` fields in the transcript, plus
      `grep -c '^LINK fixture=close-on-merge .* OK$'` prints `1`.
- [ ] **Exactly once, structurally.** (a) Offline: replaying the pair of committed
      logs from offset `-1` yields exactly one `issue.state-changed` with
      `to: "done"`, and replay appends nothing (post-replay digests equal the goldens;
      the reducers perform zero dispatches — a committed test folds the golden fixture
      through the pure reducers alone and asserts no network/append occurs) —
      evidence: `make verify-E5-T07 2>&1 | grep -c '^REPLAY-ONCE count=1 OK$'` prints
      `1`. (b) Live: re-dispatching the identical `pr.merge` refuses
      `pr/already-merged` and appends zero events to the issue stream, the PR stream,
      and every stream touched by the test (head offsets before/after byte-equal;
      dumped logs byte-identical) — evidence:
      `make verify-E5-T07 2>&1 | grep -c '^IDEMPOTENT appended=0 OK$'` prints `1`.
      (c) Defense in depth: a directly-injected duplicate `issue.state-changed` (same
      `via`) is refused typed `link/duplicate-close` with the issue head unchanged —
      committed test assertion, `pnpm test` exit 0.
- [ ] **Determinism.** The full two-stream flow run twice from fresh server processes
      yields canonically byte-identical event logs on both streams and identical
      digests — evidence:
      `make verify-E5-T07 2>&1 | grep -c '^DETERMINISM fixture=close-on-merge OK$'`
      prints `1`.
- [ ] **Every degenerate ref is typed, recorded, and harmless.** Dangling ref → exactly
      one `pr.link-noop { reason: "dangling-reference" }`, no crash, no stream
      created; already-`done` issue → exactly one `pr.link-noop { reason:
      "already-done" }` with the issue head untouched; issue in a state where
      `to: "done"` is illegal → `pr.link-noop { reason: "illegal-transition" }`, issue
      head untouched; duplicate refs in one `closes` array close the issue once (one
      `state-changed`, one `pr.link-closed`); re-running any of these appends nothing
      further — evidence: `make verify-E5-T07 2>&1` greps for `^DANGLING .* OK$` and
      `^ALREADY-DONE .* OK$` each print `1`; duplicate-ref and illegal-transition
      cases are committed test assertions; probe transcripts in
      `evidence/e5-t07-probes.txt`.
- [ ] **Close without merge touches nothing.** `pr.closed` on a PR with live
      closes-references leaves every referenced issue stream's head offset and
      `ef replay --digest --reducer` output byte-identical to before — evidence:
      `make verify-E5-T07 2>&1 | grep -c '^CLOSE-NO-MERGE issue-head=unchanged .* OK$'`
      prints `1`.
- [ ] **Crash-window recovery.** The committed test that withholds the PR-side
      `pr.link-closed` after the issue-side close landed, then re-runs the driver,
      ends with exactly one `state-changed(done)` on the issue and exactly one
      `pr.link-closed` on the PR — counted in the dumps, not inferred — evidence:
      committed test assertions, `pnpm test` exit 0.
- [ ] **Sensitivity.** Inside the same run: one byte of a fixture copy flipped →
      replay goes red before `MUTATION byte=<offset> EXPECTED-FAIL OK` prints; the
      `closedBy` idempotence check dropped in a scratch worktree → the suite goes red
      before `SENSITIVITY key=closedBy EXPECTED-FAIL OK` prints — evidence:
      `make verify-E5-T07 2>&1 | grep -c 'EXPECTED-FAIL OK'` prints ≥ `2`.
- [ ] **Frozen contract and additive extension.** All three frozen blocks are
      reproduced byte-for-byte in the `packages/meadow` readme under identical
      `<!-- frozen:E5-T07:* -->` markers with the doc-sync check green; propagation
      code contains no reducer-side effects (committed grep/test: the issue and PR
      reducers contain no dispatch/append/network calls); and the extension is
      additive: the E5-T01, E5-T02, and E5-T06 suites and their committed goldens
      re-run green unmodified — evidence: doc-sync green in the transcript, committed
      tests, `pnpm test` exit 0, `verify-all` green.
- [ ] All workspace gates pass repo-wide: `pnpm format:check && pnpm lint &&
      pnpm typecheck && pnpm test && pnpm build` exit 0; `make verify-list` shows
      `verify-E5-T07`; `tools/verify/self_check.sh` passes.
- [ ] Durable evidence committed under `evidence/` as listed in Deliverables, cited by
      path and digest in the Verification log.
- [ ] Replay browser layer: N/A (no browser-reaching surface lands here; E5-T09
      renders backlinks) — mitigation: stream-layer evidence above is the currency;
      the Verification log entry declares this explicitly per AGENTS.md.

## Adversarial verification

The claim under attack: "the merge closes the referenced issue exactly once — under
replay and re-delivery alike — degenerate references are typed, recorded no-ops, and a
close-without-merge touches nothing." Manufacture one double-close, one lost close, one
silent dangling failure, one issue mutated by a non-merging PR, or one replay that
fires propagation — any single success refutes. Use your own streams, refs, and timing
throughout; invent at least one angle this list lacks.

1. **Replay-vs-dispatch honesty (mandatory).** The exactly-once claim lives or dies on
   propagation never running during replay. Take the committed golden logs, replay
   them from offset `-1` on a cold clone with `ef replay --digest --reducer` — then
   dump both streams from the live server after the lifecycle run and byte-compare.
   Any extra event on any stream after replay, or any code path where a reducer
   dispatches, refutes the architecture. Grep the reducers (issue and PR both) for
   dispatch/append/fetch calls — a reducer that reaches for the network is refuted on
   sight. Then count: exactly one `state-changed` with `to: "done"` in the issue dump,
   exactly one `pr.link-closed` in the PR dump. Any other count refutes.
2. **Double-close hammering.** Re-dispatch the merge trigger N times, concurrently
   (parallel clients racing the propagation window), across server restarts, and after
   killing the server mid-propagation — in *both* crash windows: between the E5-T06
   target/PR appends and the issue-side close, and between the issue-side close and
   the PR-side `pr.link-closed`. Restart-plus-redispatch must converge to exactly one
   `state-changed(done)` and one `pr.link-closed`, or the gap is a finding: a merge
   accepted whose close never lands is a *lost* close, as fatal as a double one. Count
   events sharing a `via` in the dumps: any count ≠ 1 refutes. Then race the fence
   yourself: land your own issue event between plan and append and verify the re-plan
   still closes exactly once.
3. **Idempotence-key forgery.** Dispatch `issue.state-changed { to: "done" }` with: a
   `via` citing a `prMergedOffset` that does not exist in the PR dump, a `via` citing
   a different PR, no `via` at all (a manual close — must be *allowed* per E5-T01's
   workflow, and a later distinct merge citing the same issue must then hit the
   `already-done` no-op path, not a crash or a double-close), and a byte-tweaked
   duplicate `via` (offset string padded or numerically re-rendered — offsets are
   opaque strings compared by string equality; a "duplicate" that only matches after
   numeric coercion must NOT be treated as duplicate, and a system that coerces
   refutes opacity). Each behavior must match the frozen rules with the log untouched
   on refusal. Then forge the PR side: dispatch `pr.link-closed` citing a foreign PR's
   merge, a nonexistent `issueOffset`, and onto a PR that closed without merging —
   each must refuse typed per the post-terminal-links block with the PR log untouched.
4. **Dangling and hostile refs.** Feed `closes` arrays with: a nonexistent stream, a
   stream that exists but is a PR (wrong kind — must refuse or no-op typed, never
   close a PR as if it were an issue), `entity: "wiki"` (unknown kind — the ref
   validator must reject the `pr.opened` at the door, log untouched), duplicate refs
   to the same issue (must close once, not twice), a ref to the PR's own stream, an
   issue sitting in `closed` and one in `wont-do` (the illegal-transition no-op, not a
   forced flip), and 200 refs in one PR (must propagate completely, in array order, or
   refuse atomically — a partial close set with no record refutes; count
   `state-changed` events against the ref list). Verify every no-op is *recorded* on
   the PR, folded into the reduced `links` array, and deduplicated on re-dispatch.
5. **Close-without-merge and link-inertness.** Open a PR linking an issue, close it
   without merging, then merge a *different* PR citing the same issue. The issue must
   be untouched by every `pr.closed` (byte-diff the dumped issue log around each) and
   closed exactly once by the real merge. Also check the link event itself:
   `pr.opened` with `closes` on a PR that is never merged must leave the issue's
   workflow `state` at its pre-link value forever — an `issue.linked` event that
   nudges reduced `state` refutes the reducer. And backwards compatibility: replay an
   E5-T01-era pure-`v: 1` issue golden under the extended reducer — any digest drift
   refutes the additive-extension claim.
6. **Golden rot and citation teeth.** Regenerate the fixture expectations from the
   committed logs with the committed code and byte-diff against `expected.json` —
   drift refutes determinism or reveals check-time regeneration. Flip your own byte
   (different offset than the harness's mutation leg) in the committed issue log and
   confirm red. Verify the `CLOSE` line's citations have teeth: edit a copy of the
   fixture so `via.prMergedOffset` cites a different (existing) offset and confirm the
   harness goes red; do the same to `pr.link-closed.issueOffset` — a green run refutes
   the offset-citation check specifically.
7. **Sensitivity, your sabotage not theirs.** In a scratch worktree: (a) make
   propagation fire on `pr.closed` too, (b) skip the `already-done` guard, (c) key
   idempotence on `prStream` alone (dropping `prMergedOffset` — a second distinct
   merge lineage must still close a reopened issue), (d) swallow dangling refs
   silently (no `pr.link-noop`), (e) let the post-terminal validator accept arbitrary
   events after `merged`. `make verify-E5-T07` and/or `pnpm test` must go red under
   each; any sabotage that stays green refutes the apparatus for that property. Check
   the diff for `.skip`/`.todo`/inline lint disables while there.
8. **Cold clone + scope audit.** Run only via `tools/verify/cold_clone.sh`, twice
   back-to-back with scrubbed env. Hold the diff against the evidence: the planner,
   the driver's fence retry, both crash windows, every propagation-rule row (a)–(e),
   both refusal types, the post-terminal validator, and the doc-sync check must each
   have been executed by a committed test or cited transcript. Check nothing
   out-of-scope was smuggled in: no comment-body reference parsing, no UI, no new
   reference kinds, no side-channel append that bypasses the dispatch door (grep the
   diff — one direct store write refutes bet 1 regardless of green gates). Unexecuted
   diff is unproven or dead — the builder chooses which, you enforce it.

Refutation currency: a dump with two `state-changed` events sharing a `via`, a merge
whose close never lands after crash-recovery, an issue log whose head moved on
`pr.closed`, an unrecorded dangling ref, a reducer that dispatches, a replay that
propagates, or a sabotage run that stays green. Refutation → `status: refuted`, repro
appended below. No refutation → promote your surviving angle-4 hostile-ref cases into
the committed fixture corpus.

## Verification log
