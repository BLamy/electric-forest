---
id: E5-T05
epic: 5
title: "Issues live in the web app: board and issue detail on the derived stream, every mutation an event, synced live"
priority: 505
status: pending
depends_on: [E5-T04]
estimate: M
capstone: false
---

## Goal

Issues are a working product surface. The shell (`packages/webapp`, `@eforest/webapp`;
E3-T02 is the naming authority for routes and the DOM attribute contract) gains the
**issue board** at `/orgs/:org/repos/:repo/issues` — columns per E5-T01 workflow state
(`open` / `in-progress` / `done` / `closed` / `wont-do`), label filters, read exclusively
through E3-T03's `useStreamReducer` over E5-T03's derived board stream, the region's DOM
contract attributes naming that stream, the replayed offset, the state digest, **and the
E5-T03 board reducer id** (per the roadmap rule "every list view names the derived stream
or reducer it reads") — and the **issue detail** page at
`/orgs/:org/repos/:repo/issues/:issueId`: the per-issue event stream (E5-T01's frozen
model) rendered as a timeline with the issue region publishing its own replayed offset
and state digest, plus forms to file an issue, comment, add/remove labels, and flip
workflow state, every one of them exactly one action through E5-T04's `useDispatch` —
no optimistic apply, no second write path, no board-derivation or transition logic in the
webapp beyond imports of the E5-T01/E5-T03 reducers. A server refusal (E5-T01's validator
rejecting an illegal transition) renders inline via E5-T04's structured-refusal contract
and leaves the issue stream's head offset and digest unchanged. Headline proof, inside
`make verify-E5-T05`: two authenticated sessions — A mutating, B only watching — hold the
board and the same issue's detail open; each of A's mutations (file, comment, label,
transition) lands in B without reload within the frozen 2000 ms live budget with zero
console errors in either session; after quiesce, B's DOM board `(offset, digest)` pair
byte-equals the board endpoint's digest fetched out-of-band at the same offset, and
`ef replay --digest` over the dumped per-issue log reproduces exactly the state digest
B's issue region shows.

## Context

ROADMAP.md, "Epic 5 — the-meadow": issues as per-issue event streams with a derived
board, no database anywhere, every list view naming its reducer — this task is the first
full read+write product page and the rendering pattern the rest of the meadow copies (PR
UI in E5-T09, evidence rendering in E5-T11, the capstone E5-T13 watches issues flip live
through exactly these two pages).

Builds on: **E5-T04** (the browser write path — `useDispatch` with confirmed offsets,
reconcile-through-replay, and typed refusals is *frozen there and consumed here
unchanged*; this task adds zero dispatch machinery and zero server surface), **E5-T03**
through the dependency closure (the derived board stream and reducer — this task renders
it and adds zero board-derivation logic; a board row the derived stream can't account for
is a finding against whichever side diverged), **E5-T01** (the frozen per-issue event
model and validated workflow reducer — the webapp never restates the transition table
beyond disabling obviously-illegal controls, and even a disabled transition must be
server-refused when forced), **E3-T03** (`useStreamReducer`, digest parity, truncated-
replay discipline), **E3-T02** (shell, auth, Playwright harness, DOM attribute contract).

Contract frozen here: the two route paths above; the board region's DOM attributes
(stream id, replayed offset, state digest, reducer id — if the E3-T02 contract lacks a
reducer attribute, freezing one, e.g. `data-ef-reducer`, is in scope here and becomes the
epic-wide convention); and the issue-detail region's (stream, offset, digest) triplet.
E5-T09's PR pages and the E5-T13 capstone assert against these attributes; renaming them
later invalidates those suites' fixtures.

Non-goals: PR surfaces (E5-T09), wiki (E5-T08), cross-entity linking (E5-T07), evidence
attachments (E5-T10/T11), issue search/pagination, markdown beyond plain text, board
drag-and-drop (transitions go through an explicit control), and any change to
`useDispatch` or the server — this task is pages and bindings only.

## Deliverables

- `packages/webapp/src/routes/IssueBoard.tsx` — `/orgs/:org/repos/:repo/issues`:
  workflow columns + label filters over the E5-T03 derived stream via `useStreamReducer`;
  region carries stream/offset/digest/reducer-id DOM attributes; each card
  `data-testid="issue-card"` linking to its detail route; a "new issue" form dispatching
  the E5-T01 create event through `useDispatch`.
- `packages/webapp/src/routes/IssueDetail.tsx` — `/orgs/:org/repos/:repo/issues/:issueId`:
  the per-issue stream as an event timeline (create, comments, label ops, state changes,
  each with its offset); region attributes exposing the issue stream's offset and state
  digest; comment / label add/remove / state-transition forms, each one `useDispatch`
  call; inline rendering of a structured server refusal.
- `packages/webapp/src/issues/useIssues.ts` — the one thin binding of `useStreamReducer`
  + `useDispatch` to the board stream, per-issue streams, and the imported E5-T01/E5-T03
  reducers; no other webapp module touches issue data or dispatch.
- `packages/webapp/test/issues.spec.ts` — Playwright (E3-T02 harness): two contexts, A
  mutating (≥1 create, ≥2 comments, ≥2 label ops, ≥2 legal transitions) and B watching;
  per-mutation ≤2000 ms arrival in B with navigation count asserted zero; the forced
  illegal transition refused with head offset and digest unchanged; write-path audit from
  the captured network log (exactly one `/api/dispatch` POST per mutation, zero other
  state-writing requests); zero console errors in both contexts throughout.
- `Makefile`: `verify-E5-T05` per the E0-T02 target contract — fresh server + data dir,
  seed, build, Playwright (final pass under `tools/replay/record-run.sh -o e5-t05-final`),
  then the verdict phase: fetch the board endpoint's digest at B's published offset and
  byte-compare with B's DOM pair; dump the per-issue log, `ef replay --digest`, and
  byte-compare with B's issue-region digest; nonzero exit naming the first divergent
  offset (`ef bisect`) on mismatch.
- `evidence/` — `e5-t05-session.events.jsonl` (board + per-issue dumps),
  `e5-t05-digests.txt` (both sessions' DOM pairs vs board endpoint at-offset vs replay
  digests), `e5-t05-write-audit.txt` (per-mutation network accounting),
  `e5-t05-refusal.txt` (forced illegal transition: request, structured refusal,
  head/digest before and after — identical), `e5-t05-sensitivity.md`. The Replay
  recording is cited by URL in the Verification log — never committed.

## Acceptance criteria

- [ ] `make verify-E5-T05` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      with scrubbed env, zero `SKIPPED:` lines, all state created in-run.
- [ ] Every mutation is one event through the one door: for the scripted run, the
      captured network log shows exactly one `/api/dispatch` POST per UI mutation and zero
      other state-writing requests, and the dumped per-issue log contains exactly the
      corresponding events at consecutive offsets — accounting committed in
      `evidence/e5-t05-write-audit.txt`.
- [ ] Live sync, watcher-verified: each of A's mutations renders in B (board and detail)
      within 2000 ms of dispatch-accept, zero reloads/re-navigations (asserted), zero
      console errors in either session for the whole run.
- [ ] Board digest parity at-offset: at quiesce, B's board region publishes an
      `(offset, digest)` pair that **byte-equals** the board endpoint's digest fetched
      out-of-band at that same offset — and A's pair equals B's. Values committed in
      `evidence/e5-t05-digests.txt`.
- [ ] The detail page replays: `ef replay --digest` over the dumped per-issue log in
      `evidence/e5-t05-session.events.jsonl` reproduces exactly the state digest B's
      issue region showed at quiesce (same file).
- [ ] The board names its source: the region's DOM attributes name the E5-T03 derived
      stream and its reducer id, and the rendered columns/cards literal-equal the reduced
      board state at the published offset (asserted from hook state, not a screenshot).
- [ ] Refusal surfaces cleanly: an illegal transition forced past the client-side guard
      is refused server-side, rendered inline via the E5-T04 structured-refusal contract
      with zero console errors, and the issue stream's head offset and digest are
      byte-identical before and after — both quoted in `evidence/e5-t05-refusal.txt`.
- [ ] Replay (browser layer): one recording (`tools/replay/record-run.sh -o
      e5-t05-final`) containing the two-session live sync and the refused transition,
      zero console errors and zero uncaught exceptions anywhere in it; URL plus
      point/time anchors at (a) A's create dispatch confirming, (b) the card appearing in
      B, (c) the refusal rendering with the unchanged digest, cited in the Verification
      log; if `tools/replay/preflight.sh` fails, declared per AGENTS.md with the
      Playwright transcript + network/console interrogation standing in.
- [ ] Sensitivity proof inside `make verify-E5-T05`: in a scratch worktree, (a) drop one
      live frame in B's tail — the sync criterion goes red; (b) publish a stale board
      offset (head−1) — the at-offset parity comparison goes red; (c) render an extra
      phantom card from local state — the literal-equality assertion goes red. Any
      sabotage the suite stays green on fails this criterion; transcripts in
      `evidence/e5-t05-sensitivity.md`.
- [ ] No regression: `verify-E5-T04`, the E5-T01/E5-T03 verify targets, `verify-E3-T03`,
      and all root gates (`pnpm format:check && pnpm lint && pnpm typecheck &&
      pnpm test && pnpm build`) re-run green on this tree.

## Adversarial verification

The claim under attack: "the board and detail pages are pure renders of the derived
stream and the per-issue log at a published offset, every mutation is exactly one event
through the E5-T04 door, and a second session sees everything live with digests that
byte-equal the server's at the same offset." Use your own issues, your own action
sequences, your own browser contexts; invent at least one more angle.

1. **Your session, your replay.** Ignore the builder's script. Drive your own sequence
   (unicode titles, adversarial label strings, rapid transition chains, an issue with
   50+ events), dump the board and per-issue logs yourself, `ef replay --digest`, and
   compare against the DOM pairs in both of your sessions — at head and at sampled
   interior offsets (truncated replay, per E3-T03's discipline). Any mismatch refutes;
   pin it with `ef bisect`. Then prove the apparatus lives: one more dispatch must change
   both DOM digests.
2. **Second-write-path / side-store hunt.** Grep the diff and the built bundle for any
   state-writing request that isn't `/api/dispatch`, any storage API, any module-level issue
   cache; grep `packages/webapp/src/issues/` for event-folding or transition-table logic
   that isn't an import from the protocol/platform packages. Then dynamically: block
   `/api/dispatch` — every form must fail loudly and neither region's digest may move; reload
   with the server killed — any issue rendered refutes "no side store".
3. **Phantom-render hunt.** The pages must show only replayed state. Sever B's tail,
   mutate from A, verify B is frozen at its last replayed offset (digest unchanged, no
   spinner-masked state), reconnect, verify exactly-once in-order catch-up to digest
   equality. Then sever A's own tail and dispatch from A: the confirmed offset in the
   promise must not surface as state — a card appearing in A before A's tail replayed it
   refutes the E5-T04 contract *as consumed here*.
4. **At-offset, not at-head.** The board-parity claim is at the *same offset*, not
   "eventually equal". While a mutation storm runs (scripted rapid dispatches), sample
   B's `(offset, digest)` pair repeatedly and fetch the endpoint digest at each sampled
   offset: every pair must match its own offset exactly. A DOM pair whose digest belongs
   to a different offset (stale digest, fresh offset — or vice versa) refutes the
   attribute contract everything downstream asserts against.
5. **The validator, not the form.** Craft illegal transitions with your own authenticated
   client and force them through the UI's guards: each must be server-refused, rendered
   inline without crashing the page or hitting the console, with head offset and digest
   unchanged — verify by re-dumping and replaying yourself. Fuzz the refusal surface with
   adversarial error payload content (long strings, markup, unicode).
6. **Concurrent writers.** Promote B to a second writer: both dispatch conflicting
   transitions on the same issue near-simultaneously, ≥20 trials. The log is the arbiter:
   exactly one wins per the validator against the state at each event's own offset, both
   sessions converge to identical digests, and the loser's UI shows a refusal or the
   winner's state — never a state no truncation of the log produces. One divergent trial
   refutes.
7. **Reducer-inheritance sabotage.** In a scratch worktree, inject a sentinel field into
   the E5-T01 workflow reducer and the E5-T03 board reducer: every DOM digest (board and
   detail, both sessions) must change and still match the equally-mutated server. Any
   digest unchanged under the mutated core proves a second reduction path in the webapp
   and refutes. Also point the board region's reducer-id attribute at a different
   reducer — the names-its-source assertion must go red.
8. **Cold clone + recording sufficiency.** `tools/verify/cold_clone.sh verify-E5-T05`,
   scrubbed env, warm-server/planted-profile poison per the E3-T04 pattern. Then hold the
   cited Replay recording against the claim: the two-session sync, the refusal scene, and
   zero console errors must actually be in it — evaluate at points via the Replay MCP. A
   recording missing a claimed scene fails sufficiency; a changed hunk no run executed is
   unproven or dead.

Refutation currency: a mutation with no corresponding `/api/dispatch` event (or two events
for one), a DOM `(offset, digest)` pair the endpoint contradicts at that offset, a DOM
state matching no truncation of the dumped log (offset-cited via `ef bisect`), divergent
two-session digests after quiesce, a sabotage run that stayed green, or a Replay point
link where the DOM contradicts the stream. "The board looks right" is not a finding. No
refutation → promote your mutation-storm at-offset sampler and your concurrent-writer
trials into the committed suite.

## Verification log

(appended over time by builders and critics)
