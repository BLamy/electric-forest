---
id: E5-T04
epic: 5
title: "Issues live in the web app: the browser dispatch hook (first write path), issue board, and issue detail — every mutation an event, synced live"
priority: 504
status: pending
depends_on: [E5-T03]
estimate: L
capstone: false
---

## Goal

The web app can **write**. `packages/web-hooks` (`@eforest/web-hooks`, E3-T03's package)
gains `useDispatch(streamId)`, the browser's first and only write path: it returns
`dispatch(action) => Promise<{ offset }>`, POSTing the action to E0-T11's frozen
`/dispatch` door authenticated by the E2-T04 web session, resolving with the server's
confirmed append offset, and **reconciling through the one replay path** — the promise's
offset is a receipt, never a state mutation; the UI's state advances only when
E3-T03's `useServerReducer` tail replays the event at that offset (no optimistic apply,
no second reducer, no local echo — a pending dispatch is `pending` until the tail's
replayed offset reaches its confirmed offset, tracked by instrumentation counters
`dispatches-sent / dispatches-confirmed / dispatches-reconciled`). Riding it, the shell
(`packages/webapp`, `@eforest/webapp`; E3-T02 is the naming authority for routes and the
DOM attribute contract) gains the **issue board** at `/orgs/:org/repos/:repo/issues` —
columns per E5-T01 workflow state (`open` / `in-progress` / `done` / `closed` /
`wont-do`), label filters, read exclusively through `useServerReducer` over E5-T03's
derived board stream with the region's DOM contract attributes naming that stream, the
replayed offset, the state digest, **and the reducer it reads** (the E5-T03 board reducer
id, per the roadmap rule "every list view names the derived stream or reducer it reads")
— and the **issue detail** page at `/orgs/:org/repos/:repo/issues/:issueId`: the
per-issue event stream (E5-T01's frozen model) rendered as a timeline, with forms to
file an issue, comment, add/remove labels, and flip workflow state, every one of them a
single `useDispatch` call appending one event. An illegal workflow transition (e.g.
`done → in-progress` where E5-T01's validated reducer forbids it) submitted from the UI
is **refused by the server-side validator**, surfaced as an inline error, and leaves the
stream's head offset and state digest unchanged. Headline proof, inside
`make verify-E5-T04`: two authenticated browser sessions hold the board and a detail page
open; session A files, comments, labels, and transitions; every mutation appears in
session B without reload within the frozen 2000 ms live budget; after quiesce both
sessions' DOM `(offset, digest)` pairs string-equal the server head and
`ef replay --digest` over the dumped logs; and the run's own event log replays to exactly
the digest the DOM shows.

## Context

ROADMAP.md, "Epic 5 — the-meadow": issues as per-issue event streams with a derived
board, no database anywhere, every list view naming its reducer. This task is where the
web app stops being a reading room: E3 built the replica (hydrate + tail + client replay,
digest parity), and E5-T04 opens the dispatch door from the browser. It is the write-path
pattern every later browser mutation inherits — wiki edits (E5-T07), PR review/approve/
merge (E5-T08), evidence attachment (E5-T10), and both Epic 5 and Epic 6 capstones — so
the reconciliation contract frozen here is load-bearing: **the dispatch promise carries
an offset, the replay path carries the state**. If this hook can paint state the reducer
never produced, every "live" claim above it is theater.

Builds on: **E5-T03** (the derived board stream and its reducer — this task renders it
and adds zero board-derivation logic; a board row the derived stream can't account for is
a finding against whichever side diverged), **E5-T01** through the dependency closure
(the frozen per-issue event model, the validated workflow reducer registered with
`ef replay`, and its transition table — this task consumes the validator, never restates
the rules client-side beyond disabling obviously-illegal buttons, and even a disabled
transition must be server-refused when forced), **E3-T03** (`useServerReducer`, digest
parity discipline, the instrumentation pattern), **E3-T02** (shell, auth, Playwright
harness, DOM attribute contract), **E0-T11** (`/dispatch`), **E2-T04/T05** (web session
and tokens).

Contract frozen here: the `useDispatch` public API — `dispatch(action)` resolving
`{ offset }` on server confirmation, rejecting with the server's structured refusal (the
E5-T01 validator's error, surfaced verbatim) on an invalid action; the no-optimistic-
apply rule; the pending-reconciliation instrumentation; and the board/detail route paths
above. Changing the reconciliation semantics later invalidates every downstream browser-
write task's fixtures.

Non-goals: PR surfaces (E5-T08), wiki (E5-T07), cross-entity linking (E5-T06), evidence
attachments (E5-T09/T10), issue search/pagination, markdown rendering beyond plain text,
drag-and-drop on the board (transitions go through the detail page's form or an
equivalent explicit control), offline queueing of dispatches (a dispatch with the server
unreachable rejects — that is the design), and any new server endpoint: this task adds
**zero server surface**.

## Deliverables

- `packages/web-hooks/src/useDispatch.ts` — the write hook: authenticated POST to
  `/dispatch`, confirmed-offset resolution, structured-refusal rejection, pending-until-
  reconciled tracking keyed on the confirmed offset against the paired
  `useServerReducer`'s replayed offset, and the instrumentation counters
  (`dispatches-sent / confirmed / reconciled / refused`) tests and the pages read.
- `packages/webapp/src/routes/IssueBoard.tsx` — `/orgs/:org/repos/:repo/issues`: workflow
  columns + label filters over the E5-T03 derived stream via `useServerReducer`; the
  region carries the E3-T02 DOM contract attributes (stream, offset, digest) **plus the
  reducer name** (attribute per the E3-T02 contract's extension rule; if the contract has
  no reducer attribute yet, freezing one — e.g. `data-ef-reducer` — is in scope here and
  becomes the epic-wide convention); each card `data-testid="issue-card"` linking to its
  detail route; a "new issue" form dispatching the E5-T01 create event.
- `packages/webapp/src/routes/IssueDetail.tsx` — `/orgs/:org/repos/:repo/issues/:issueId`:
  the per-issue stream rendered as an event timeline (create, comments, label ops, state
  changes, each with its offset), region attributes exposing the issue stream's offset
  and state digest, and the four mutation forms (comment, label add/remove, state
  transition, plus inline error surfacing of a server refusal).
- `packages/webapp/src/issues/useIssues.ts` — the one thin binding of
  `useServerReducer` + `useDispatch` to the board stream, per-issue streams, and the
  imported E5-T01/E5-T03 reducers; no other webapp module touches issue data or dispatch.
- `packages/webapp/test/issues.spec.ts` — the Playwright suite (E3-T02 harness): file /
  comment / label / transition through real pointer+keyboard events; two-context live
  sync (A mutates, B sees each mutation within 2000 ms, zero reloads asserted); the
  forced illegal transition (form guard bypassed via direct submit) refused with the
  head offset and digest unchanged; write-path audit from the captured network log
  (exactly one `/dispatch` POST per mutation, zero non-dispatch writes); zero console
  errors throughout.
- `Makefile`: `verify-E5-T04` per the E0-T02 target contract — fresh server + data dir,
  seed, build, Playwright (final pass under `tools/replay/record-run.sh -o e5-t04-final`),
  then the verdict phase: dump the board and per-issue logs, `ef replay --digest` each,
  string-compare against the DOM-published pairs from both sessions; nonzero exit naming
  the first divergent offset (`ef bisect`) on mismatch.
- `evidence/` — `e5-t04-session.events.jsonl` (the run's dumped logs) +
  `e5-t04-digests.txt` (DOM pairs from both sessions vs server head vs replay digests),
  `e5-t04-refusal.txt` (the forced illegal transition: request, structured refusal,
  head/digest before and after — identical), `e5-t04-write-audit.txt` (the per-mutation
  network accounting), and `e5-t04-sensitivity.md`. The Replay recording is cited by URL
  in the Verification log — never committed.

## Acceptance criteria

- [ ] `make verify-E5-T04` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      with scrubbed env, zero `SKIPPED:` lines, all state created in-run.
- [ ] Every mutation is one event through the one door: for the scripted run (≥1 create,
      ≥2 comments, ≥2 label ops, ≥2 legal transitions), the captured network log shows
      exactly one `/dispatch` POST per UI mutation and zero other state-writing requests,
      and the dumped per-issue log contains exactly the corresponding events at
      consecutive offsets — accounting committed in `evidence/e5-t04-write-audit.txt`.
- [ ] No optimistic apply: after each dispatch resolves, the suite asserts the new state
      appeared only at/after the tail replayed the confirmed offset —
      `dispatches-reconciled` equals `dispatches-confirmed` at quiesce, and a variant run
      with the tail connection severed shows a confirmed-but-unreconciled dispatch whose
      state is **absent** from the DOM until reconnect replays it. A DOM that shows the
      mutation before the tail delivered it fails this criterion.
- [ ] Live sync, two sessions: with A and B both hydrated (board + the same issue's
      detail), each of A's mutations renders in B within 2000 ms of dispatch-accept with
      zero reloads/re-navigations (navigation count asserted); after quiesce, both
      sessions' DOM `(offset, digest)` pairs for the board region and the issue region
      string-equal the server heads fetched out-of-band and `ef replay --digest` over the
      dumps — all values in `evidence/e5-t04-digests.txt`.
- [ ] The board names its source: the board region's DOM attributes name the E5-T03
      derived stream and its reducer id, and the rendered columns/cards literal-equal the
      reduced board state at the region's published offset (asserted from hook state, not
      a screenshot).
- [ ] Illegal transition refused end-to-end: a transition the E5-T01 table forbids,
      forced past the form's client-side guard, is rejected by the server validator; the
      UI surfaces the structured refusal inline with zero console errors; the issue
      stream's head offset and state digest are byte-identical before and after (both
      quoted in `evidence/e5-t04-refusal.txt`); `dispatches-refused` increments and
      nothing else does.
- [ ] The session replays: `ef replay --digest` over `evidence/e5-t04-session.events.jsonl`
      (board and per-issue dumps) reproduces exactly the digests the DOM showed at quiesce
      — the same values committed in `e5-t04-digests.txt`.
- [ ] Replay (browser layer): one recording (`tools/replay/record-run.sh -o e5-t04-final`)
      containing both sessions' live sync **and** the refused illegal transition, zero
      console errors and zero uncaught exceptions anywhere in it; URL plus point/time
      anchors at (a) A's create dispatch confirming, (b) the card appearing in B, (c) the
      refusal rendering with the unchanged digest, cited in the Verification log; if
      `tools/replay/preflight.sh` fails, declared per AGENTS.md with the Playwright
      transcript + network/console interrogation standing in.
- [ ] Sensitivity proof inside `make verify-E5-T04`: in a scratch worktree, (a) make
      `useDispatch` apply the action locally on confirmation (optimistic) — the
      severed-tail criterion goes red; (b) make the refusal client-side only (server
      accepts the illegal event) — the refusal criterion's digest comparison goes red;
      (c) drop one live frame in B's tail — the sync criterion goes red; (d) publish a
      stale board offset (head−1) — the parity assertion goes red. Any sabotage the suite
      stays green on fails this criterion; transcripts in `evidence/e5-t04-sensitivity.md`.
- [ ] No regression: `verify-E3-T03`, the E5-T01 and E5-T03 verify targets, and all root
      gates (`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test &&
      pnpm build`) re-run green on this tree.

## Adversarial verification

The claim under attack: "every issue mutation the browser performs is exactly one event
appended through `/dispatch`, the UI's state is at all times a replay of the log and
nothing else, two sessions converge to string-equal digests live, and the workflow
validator — not the form — is what refuses an illegal transition." Use your own issues,
your own action sequences, your own two (or more) browser contexts; invent at least one
more angle.

1. **Your session, your replay.** Ignore the builder's script. Drive your own sequence
   (unicode titles, adversarial label strings, rapid transition chains), dump the board
   and per-issue logs yourself, `ef replay --digest` them, and compare against the DOM
   pairs in both of your sessions. Any mismatch at head or at any sampled interior offset
   (truncated replay, per E3-T03's discipline) refutes; pin it with `ef bisect`. Then
   prove the apparatus lives: one more dispatch must change the DOM digest.
2. **Second-write-path hunt.** Grep the diff and the built bundle for any state-writing
   request that isn't `/dispatch`, any storage API, any module-level issue cache. Then
   attack dynamically: block `/dispatch` at the network layer — every form must fail
   loudly and the DOM digest must not move; a mutation that lands anyway found another
   door and refutes. Reload with the server killed: any issue rendered refutes
   "no side store".
3. **Optimistic-echo hunt.** Sever B's tail, mutate from A, reconnect: exactly-once, in
   order, digest-equal — bisect any divergence. Then the crueler version on the writer
   itself: sever A's own tail, dispatch from A, and watch A's DOM — the confirmed offset
   in the promise must NOT surface as state; a card appearing in A before A's tail
   replayed it proves a local echo and refutes the reconciliation contract. Check the
   counters against the network log; a counter the network contradicts refutes the
   instrumentation.
4. **The validator, not the form.** Bypass the UI entirely: craft illegal-transition
   dispatches with your own authenticated client (raw POST, stale-state replays of a
   previously-legal event, transitions for a nonexistent issue, malformed action
   payloads). Every one must be refused server-side with head offset and digest
   unchanged — verify by re-dumping and replaying yourself. A crafted illegal event the
   server appends refutes E5-T01-as-deployed, and this task inherits the finding. Also
   fuzz the refusal surface: the structured error rendered inline must never crash the
   page or hit the console.
5. **Concurrent writers.** Two sessions dispatch conflicting transitions on the same
   issue near-simultaneously, repeatedly (≥20 trials). The log is the arbiter: exactly
   one wins per the validator's rules against the state at each event's own offset, both
   sessions converge to the identical digest, and the loser's UI shows a refusal or the
   winner's state — never a phantom state no replay produces. One trial with divergent
   final digests, or a DOM state matching no truncation of the log, refutes.
6. **Reducer-inheritance sabotage.** In a scratch worktree, inject a sentinel field into
   the E5-T01 workflow reducer and the E5-T03 board reducer: every DOM digest (board and
   detail, both sessions, post-refusal included) must change, and parity with the
   equally-mutated server must hold. Any digest unchanged under the mutated core proves a
   second reduction path in the webapp and refutes. Separately grep
   `packages/webapp/src/issues/` for any event-folding or transition-table logic that
   isn't an import from the protocol/platform packages.
7. **Apparatus sensitivity, your own.** Re-run the committed sabotages, then add: make
   the board region publish the reducer name of a different reducer — the names-its-
   source assertion must go red; hardcode the DOM digest attribute — the truncated-replay
   sampling must catch it. Any green run under sabotage refutes the measuring apparatus
   and every transcript this task committed.
8. **Cold clone + recording sufficiency.** `tools/verify/cold_clone.sh verify-E5-T04`,
   scrubbed env, warm-server/planted-profile poison per the E3-T04 pattern. Then hold the
   cited Replay recording against the diff: the refusal scene, the two-session sync, and
   the severed-tail moment must actually be in it — evaluate at points via the Replay
   MCP. A recording missing a claimed scene fails sufficiency; a changed hunk no run
   executed is unproven or dead.

Refutation currency: a mutation with no corresponding `/dispatch` event (or two events
for one mutation), a DOM state matching no truncation of the dumped log (offset-cited via
`ef bisect`), a crafted illegal event the server appended, divergent two-session digests
after quiesce, a sabotage run that stayed green, or a Replay point link where the DOM
contradicts the stream. "The board feels snappy" is not a finding. No refutation →
promote your concurrent-writer trial script and your crafted-illegal-dispatch corpus into
the committed suite.

## Verification log

(appended over time by builders and critics)
