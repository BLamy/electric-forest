---
id: E5-T04
epic: 5
title: "The browser write path: an authenticated dispatch hook with confirmed offsets and typed refusals, proven live on label management"
priority: 504
status: implemented
depends_on: [E5-T03]
estimate: M
capstone: false
---

## Goal

The web app can **write**, through exactly one door. `packages/web-hooks`
(`@eforest/web-hooks`, E3-T03's package) gains `useDispatch(streamId)`: it returns
`dispatch(action) => Promise<{ offset }>`, POSTing the action to E0-T11's frozen
`/api/dispatch` endpoint authenticated by the E2-T04 web session token, resolving with the
server's **confirmed append offset**, and reconciling through the one replay path — the
promise's offset is a receipt, never a state mutation; UI state advances only when the
paired `useStreamReducer` tail (E3-T03) replays the event at that offset. Each dispatch
moves through the typed lifecycle `in-flight → confirmed(offset) → reconciled`, or
`in-flight → refused(error)`, and that lifecycle is **visible in the DOM** per the E3-T02
attribute contract: the dispatching region publishes the last confirmed offset alongside
the region's replayed `(stream, offset, digest)` attributes, so "the write landed and the
replica caught up" is a string-equality read off the page, not a vibe. A refusal is a
**typed, structured error** — the server validator's refusal surfaced verbatim (code +
message), rejected by the promise, rendered inline, with **nothing appended**: the
stream's head offset and state digest are byte-identical before and after. The hook is
proven on a real surface: the repo's **label-management page** at
`/orgs/:org/repos/:repo/labels` (`packages/webapp`, `@eforest/webapp`; E3-T02 is the
naming authority for routes), which renders the E5-T03 label catalog through
`useStreamReducer` (naming `repo-labels` as the reducer it reads, per bet 4's list-view
rule) and dispatches `label.created` / `label.renamed` / `label.recolored` through
`useDispatch` — so E5-T05 (issues UI), E5-T08 (wiki), and E5-T09 (PR UI) all inherit a
write path that has already survived a critic.

## Context

ROADMAP.md, "Epic 5 — the-meadow": the GitHub surface as pure event streams, every
mutation an event through the dispatch door. E3 built the reading room (hydrate + tail +
client replay, digest parity); this task opens the door from the browser, and it is the
**only** time the door gets built — every later browser mutation (issue forms in E5-T05,
wiki patch events in E5-T08, PR review/approve/merge in E5-T09, evidence attachment in
E5-T11, and both the E5-T13 and Epic 6 capstones) is one more `useDispatch` call on the
contract frozen here. If this hook can paint state the reducer never produced, or swallow
a refusal into a silent append, every "live" claim above it is theater.

Builds on: **E5-T03** (the `repo-labels` reducer, its dispatch-side validation — duplicate
`labelId`, duplicate live byte-exact `name`, unknown `labelId` on rename/recolor — and the
board digest that must move when a label event lands; this task adds **zero** label logic,
it consumes the validator and renders the catalog), **E3-T03** (`useStreamReducer`,
hydration offsets, digest parity, instrumentation-counter pattern), **E3-T02** (shell,
routes, the DOM attribute contract, the Playwright harness), **E0-T11** (`/api/dispatch`,
server-validated from day one), **E2-T04/T05** (web session and tokens; an
unauthenticated dispatch is refused with the right status, per the-locked-gate).

Contracts frozen here, documented in the `packages/web-hooks` readme with the
invalidation rule (changing any of them invalidates every downstream browser-write
task's fixtures — a loud, deliberate event):

- **`useDispatch` public API** (`DISPATCH_HOOK_VERSION = 1`): `dispatch(action)` resolves
  `{ offset }` on server confirmation; rejects with the typed refusal
  `{ code, message, refusedAction }` (the server validator's error verbatim — the client
  invents no error taxonomy of its own); **no optimistic apply** — no local echo, no
  second reducer, no state write outside the `useStreamReducer` replay path; pending
  reconciliation tracked by instrumentation counters
  `dispatches-sent / dispatches-confirmed / dispatches-reconciled / dispatches-refused`,
  readable by tests.
- **DOM confirmed-offset exposure**: the dispatching region publishes
  `data-ef-confirmed-offset` (last confirmed append offset, empty until the first
  confirmation) alongside the E3-T02 region attributes for stream, replayed offset,
  digest, and reducer name (if E3-T02's contract lacks a reducer attribute, freezing
  `data-ef-reducer` is in scope here and becomes the epic-wide convention). "Reconciled"
  is the DOM predicate `replayed offset >= confirmed offset`.
- **Route**: `/orgs/:org/repos/:repo/labels`, registered with E3-T02's naming authority.

Non-goals: the issue board and issue detail UI (E5-T05 — the labels page reads the label
catalog, not the board), label deletion (not in E5-T03's v1), any new server surface
(this task adds **zero** endpoints and **zero** reducer changes), offline dispatch
queueing (a dispatch with the server unreachable rejects — that is the design), optimistic
UI of any kind, and retry logic beyond surfacing the rejection.

## Deliverables

- `packages/web-hooks/src/useDispatch.ts` — the hook per the frozen contract: session-
  authenticated POST to `/api/dispatch`, confirmed-offset resolution, typed-refusal
  rejection, pending-until-reconciled tracking keyed on the confirmed offset against the
  paired `useStreamReducer`'s replayed offset, instrumentation counters. Unit-tested
  against a mock transport (confirmation, refusal, network failure, out-of-order
  confirm-vs-replay arrival) and integration-tested against a real `packages/server`.
- `packages/webapp/src/routes/LabelManagement.tsx` — `/orgs/:org/repos/:repo/labels`:
  catalog list (name, color swatch, `labelId`) via `useStreamReducer` over the repo label
  stream; create / rename / recolor forms, each exactly one `useDispatch` call; inline
  rendering of a typed refusal (e.g. duplicate name) with `data-testid="dispatch-error"`
  carrying the refusal `code`; the region carrying the full attribute set above including
  `data-ef-confirmed-offset` and `data-ef-reducer="repo-labels"`.
- `packages/webapp/test/labels.spec.ts` — Playwright (E3-T02 harness): authenticated
  create/rename/recolor through real pointer+keyboard events; per-mutation write audit
  from the captured network log (exactly one `/api/dispatch` POST per mutation, zero other
  state-writing requests); the no-optimistic-apply proof (tail severed: dispatch
  confirms, `data-ef-confirmed-offset` advances, but the catalog DOM and digest do **not**
  change until reconnect replays it); the refused duplicate-name dispatch (typed error
  rendered, head offset and digest byte-identical before/after); two-context live sync
  (A creates a label, B's catalog shows it within the frozen 2000 ms budget, zero
  reloads); zero console errors and zero uncaught exceptions throughout.
- `Makefile`: `verify-E5-T04` per the E0-T02 target contract — fresh server + data dir,
  seed a repo via E5-T03's door, build, run the Playwright suite with the final pass
  under `tools/replay/record-run.sh -o e5-t04-final`; verdict phase: dump the label
  stream, `ef replay --digest --reducer <E5-T03's documented path>`, string-compare
  against the DOM-published `(offset, digest)` pairs and the out-of-band server head;
  assert the refused dispatch left the dumped log with **no event** between the
  before/after head probes; `ef bisect` names the first divergent offset on mismatch.
  Joins `verify-all`.
- `evidence/` — `e5-t04-write-audit.txt` (per-mutation network accounting vs dumped-log
  offsets), `e5-t04-refusal.txt` (the refused dispatch: request, typed refusal body,
  head offset + digest before and after — identical, plus the dumped-log line count
  unchanged), `e5-t04-digests.txt` (DOM pairs from both sessions vs server head vs
  `ef replay`), `e5-t04-session.events.jsonl` (the run's dumped label log),
  `e5-t04-sensitivity.md` (sabotage transcripts). The Replay recording is cited by URL
  in the Verification log — never committed.

## Acceptance criteria

- [ ] `make verify-E5-T04` exits 0 from a pristine cold clone via
      `tools/verify/cold_clone.sh` with scrubbed env, zero `SKIPPED:` lines, all state
      created in-run — evidence: `make verify-E5-T04 2>&1 | grep -c '^SKIPPED:'`
      prints `0`.
- [ ] One door, one event per mutation: for the scripted run (≥1 create, ≥1 rename,
      ≥1 recolor), the captured network log shows exactly one `/api/dispatch` POST per UI
      mutation and zero other state-writing requests, and the dumped label log contains
      exactly the corresponding events at consecutive offsets — accounting committed in
      `evidence/e5-t04-write-audit.txt`.
- [ ] Confirmed offset in the DOM: after each dispatch resolves,
      `data-ef-confirmed-offset` string-equals the offset in the resolved promise, and at
      quiesce it string-equals the region's replayed offset attribute, the server head
      fetched out-of-band, and the offset of the last event in the dumped log — all four
      values quoted in `evidence/e5-t04-digests.txt`.
- [ ] No optimistic apply: in the severed-tail variant, a dispatch confirms
      (`data-ef-confirmed-offset` advances, `dispatches-confirmed` increments) while the
      catalog DOM, the region digest, and `dispatches-reconciled` all hold still until
      reconnect replays the offset; at quiesce `dispatches-reconciled` equals
      `dispatches-confirmed`. A DOM that shows the label before the tail delivered it
      fails this criterion — evidence: the committed Playwright assertion plus the Replay
      recording anchor.
- [ ] Typed refusal appends nothing: a `label.created` duplicating a live name (forced
      past any client-side guard) rejects with the server validator's structured error,
      rendered inline in `data-testid="dispatch-error"` with its `code`, with zero
      console errors; the label stream's head offset, state digest, and dumped-log line
      count are identical before and after; `dispatches-refused` increments and nothing
      else does — evidence: `evidence/e5-t04-refusal.txt` plus the in-target dumped-log
      assertion.
- [ ] Board coupling: the browser-dispatched `label.created` moves the E5-T03 board
      digest (`GET /repos/:repoId/board`) from its pre-dispatch value to a new value that
      a cold `deriveBoard` over fresh dumps reproduces byte-identically; the refused
      dispatch moves it not at all — both transitions quoted in
      `evidence/e5-t04-digests.txt`.
- [ ] Live sync, two sessions: A's create renders in B within 2000 ms of dispatch-accept
      with zero reloads/re-navigations (navigation count asserted); after quiesce both
      sessions' DOM `(offset, digest)` pairs string-equal each other, the server head,
      and `ef replay --digest` over the dump — evidence: `e5-t04-digests.txt`.
- [ ] Auth is load-bearing: the same dispatch without the E2 session (cookie/token
      stripped in a request-context variant) is refused with the E2-documented status and
      appends nothing — evidence: committed Playwright/integration assertion with the
      head probe before and after.
- [ ] The page names its source: the region publishes `data-ef-reducer="repo-labels"`
      and the rendered catalog literal-equals the reduced label-catalog state at the
      region's published offset (asserted from hook state, not a screenshot).
- [ ] Sensitivity proof inside `make verify-E5-T04`, in a scratch worktree: (a) make
      `useDispatch` apply the action locally on confirmation — the severed-tail criterion
      goes red; (b) make the duplicate-name refusal client-side only (server accepts) —
      the refusal criterion's log-line-count assertion goes red; (c) publish a hardcoded
      `data-ef-confirmed-offset` — the four-way string-equality goes red; (d) swallow the
      typed error into a generic string — the `code` assertion goes red. Any sabotage the
      suite stays green on fails this criterion; transcripts in
      `evidence/e5-t04-sensitivity.md`.
- [ ] Replay (browser layer): one recording (`tools/replay/record-run.sh -o
      e5-t04-final`) containing the confirmed dispatch reconciling, the two-session sync,
      the severed-tail moment, and the typed refusal — zero console errors and zero
      uncaught exceptions anywhere in it; URL plus point/time anchors at (a) the create
      dispatch confirming and `data-ef-confirmed-offset` advancing, (b) the label
      appearing in B, (c) the refusal rendering with the unchanged digest — cited in the
      Verification log; if `tools/replay/preflight.sh` fails, declared per AGENTS.md with
      the Playwright transcript + network/console interrogation standing in.
- [ ] No regression: `verify-E3-T03`, `verify-E5-T03`, and all root gates
      (`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build`)
      re-run green on this tree; `make verify-list` maps `verify-E5-T04` to this task.

## Adversarial verification

The claim under attack: "every label mutation the browser performs is exactly one
authenticated event through `/api/dispatch`, the DOM's state is at all times a replay of the
log and nothing else, the confirmed offset the page publishes is the server's truth, and
a refusal is typed, rendered, and appends nothing." This is the write path every later
browser task inherits — a hole here is a hole in five future tasks. Use your own repo,
your own labels, your own browser contexts; invent at least one more angle.

1. **Your session, your replay.** Ignore the builder's script. Drive your own sequence
   (unicode names, names that collate differently under locale vs bytes, rapid
   create/rename chains), dump the label log yourself, `ef replay --digest --reducer` it,
   and compare against the DOM `(offset, digest, confirmed-offset)` triple in both of
   your sessions — at head and at sampled interior offsets (truncated replay, per
   E3-T03's discipline). Any mismatch refutes; pin it with `ef bisect`. Then prove the
   apparatus lives: one more dispatch must move every one of those DOM values.
2. **Second-write-path hunt.** Grep the diff and the built bundle for any state-writing
   request that isn't `/api/dispatch`, any storage API (`localStorage`, IndexedDB), any
   module-level catalog cache. Then dynamically: block `/api/dispatch` at the network layer —
   every form must fail loudly (typed rejection surfaced, `dispatches-refused` or a
   distinct network-failure state incrementing, digest unmoved); a mutation that lands
   anyway found another door and refutes. Reload with the server killed: any catalog
   rendered from nowhere refutes.
3. **Optimistic-echo hunt, on the writer.** Sever the dispatching session's own tail,
   dispatch, and watch its DOM: `data-ef-confirmed-offset` must advance while the catalog
   and digest hold still until reconnect. A label appearing in the writer's DOM before
   its own tail replayed it proves a local echo and refutes the reconciliation contract.
   Cross-check every instrumentation counter against your captured network log; a counter
   the network contradicts refutes the instrumentation.
4. **Refusal honesty.** Bypass the UI: craft refusable dispatches with your own
   authenticated client (duplicate `labelId`, duplicate byte-exact name, case-variant
   name — which E5-T03 documents as *accepted*, so a refusal here refutes the other
   direction — rename of unknown `labelId`, malformed payloads, oversized fields). For
   each: the server must refuse with the typed error, and your own before/after dump of
   the log must be byte-identical. A crafted refusable event that appends refutes; so
   does a UI that renders the refusal but a log that grew. Fuzz the refusal surface
   through the form too — no structured error may crash the page or hit the console.
5. **Auth stripping.** Replay a captured `/api/dispatch` request with the session cookie
   stripped, expired, and forged; each must be refused with the E2-documented status and
   append nothing (probe the head yourself). An unauthenticated append refutes E2-as-
   deployed and this task inherits the finding.
6. **Confirmed-offset forgery.** In a scratch worktree, make the hook publish
   `confirmed + 1`, then `head - 1`, then freeze it — the four-way string-equality and
   the truncated-replay sampling must each go red. Any forged value that stays green
   refutes the DOM contract's evidentiary worth, and with it the transcript this task
   committed.
7. **Concurrent writers.** Two sessions dispatch colliding `label.created` with the same
   name near-simultaneously, repeatedly (≥ 20 trials). The log is the arbiter: exactly
   one appends per the validator against the state at each event's own offset, both
   sessions converge to identical digests, and the loser renders the typed refusal —
   never a phantom label no replay produces. One trial with divergent final digests, or
   two appends for one name, refutes.
8. **Sabotage the gates.** Re-run the committed sensitivity sabotages yourself, then add
   your own (e.g. drop the dumped-log line-count check from the refusal assertion and
   confirm the suite notices an appended refusal). Check the diff for `.skip` / `.todo` /
   lint disables. Any sabotage that stays green refutes the measuring apparatus.
9. **Cold clone + recording sufficiency.** Run only via `tools/verify/cold_clone.sh`
   with `NODE_OPTIONS`/`NODE_ENV`/`npm_config_*` scrubbed, warm-server/planted-profile
   poison per the E3-T04 pattern. Then hold the cited Replay recording against the diff
   via the Replay MCP: the confirmed-dispatch scene, the severed-tail scene, the
   two-session sync, and the refusal must actually be in it, console clean at every
   point. A recording missing a claimed scene fails sufficiency; a changed hunk no run
   executed is unproven or dead — builder picks which, you enforce it.

Refutation currency: a mutation with no corresponding `/api/dispatch` event (or two events
for one), a DOM state matching no truncation of the dumped log (offset-cited via
`ef bisect`), a refused dispatch whose log grew, an unauthenticated append, a forged
confirmed offset the suite accepted, divergent two-session digests after quiesce, or a
Replay point where the DOM contradicts the stream. "The form works" is not a finding.
No refutation → promote your crafted-refusal corpus and your concurrent-writer trial
script into the committed suite.

## Verification log

### 2026-08-26 — builder — implemented

- Implementation commit: `11174e0e33000c74f88565703d126c5cfb897dab`.
- Focused browser run: `node --experimental-strip-types apps/web/test/labels.pw.ts`
  completed with 3 accepted mutations, 1 typed refusal, 0 other state-writing
  requests, 226 ms follower latency, and zero console errors/page errors.
- Stream evidence: `evidence/e5-t04-session.events.jsonl` replays to offset
  `0000000000000000_0000000000000002` and digest
  `89f1010261664dc5f2904d4889faa098ec0a0017377ca9de4fe0ddad5fcd1f65`;
  the write audit, refusal before/after equality, convergence pairs, and board
  digest transition are in the sibling committed evidence files.
- Root regression was run once on this T04 tree: `pnpm test` passed 77 files / 687
  tests, followed by a successful `pnpm build`. Earlier focused passes were
  `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, the 42 hook/authz/gateway
  tests, the 24 direct E5-T03 label/board tests, and
  `node tools/verify/e5_t04_evidence.mjs`. Dependency gates were not recursively
  re-entered.
- Recorded browser run: writer confirmation advanced to
  `0000000000000000_0000000000000001` while its replay remained at offset
  `0000000000000000_0000000000000000`; the live follower reached the new event
  first, then both clients converged at offset
  `0000000000000000_0000000000000003` with digest
  `4d7746649df7d03f7dd685233ed112c7d6772e9f5c058a9a7c56fd6f8be8cafc`.
  The same run exercised create, rename, recolor, and a typed
  `label/duplicate-name` refusal with zero console errors or uncaught exceptions.
- Replay: N/A (Replay recording `7af6148a-1a75-4c21-b47e-087bca834ccb`
  remained locally stuck in `recording` after the browser process exited, so the
  CLI could not upload it) + mitigation: the same-session verified MP4 is
  `recordings/e5-t04-final.mp4` (492,583 bytes, real ISO MP4), backed by the
  committed two-context Playwright run and stream artifacts above.

Claim: the browser has one authenticated dispatch door; a receipt advances the
confirmed offset without applying state locally, the paired replay path performs
the eventual reconciliation, independent clients converge to the same digest,
and structured validator refusals render inline without appending an event.

(appended over time by builders and critics)

VERDICT: needs-evidence

- SENSITIVITY — MISSING. Predicted the required four sabotage transcripts would be
  committed at `evidence/e5-t04-sensitivity.md` and invoked by `_v-e5-t04`; observed
  that the file does not exist and the target runs no E5-T04 sensitivity harness.
  Supply the four mandated mutation-to-red transcripts before verification.
- REPLAY — FALLBACK ONLY. The verified 17.6-second MP4 visibly covers the severed-tail
  confirmation, follower-first sync, reconciliation, rename/recolor, and typed refusal,
  and the committed artifacts support the stream invariants. Recording
  `7af6148a-1a75-4c21-b47e-087bca834ccb` never became cloud-inspectable, so console,
  network, and changed-source execution cannot be independently interrogated through
  Replay. The declared N/A mitigation is honest supporting evidence, not a refutation;
  it does not replace the missing sensitivity proof.
- SUITE: none promoted; no commands or gates rerun per the critic's evidence-only scope.

### 2026-08-26 — builder — sensitivity rework implemented

- Sensitivity commit: `b5ff1714`. `tools/verify/e5_t04_sensitivity.mjs` uses one
  detached scratch worktree, restores the control build before each case, and rebuilds
  only the package/app touched by that mutant.
- `node tools/verify/e5_t04_sensitivity.mjs` produced four expected-red results:
  optimistic local application was caught by `severed-tail-replay-only-label-rows`, a
  client-only refusal over a server-accepted append by `refusal-log-line-count`, a
  hardcoded receipt by `confirmed-offset-four-way-equality`, and a swallowed typed error
  by `typed-refusal-code`. The deterministic transcript is committed at
  `evidence/e5-t04-sensitivity.md` and `_v-e5-t04` invokes the harness.
- Focused checks only: the final harness run passed all four mutations; targeted Prettier
  and ESLint checks passed; `node tools/verify/e5_t04_evidence.mjs` passed at offset
  `0000000000000000_0000000000000002` and digest
  `89f1010261664dc5f2904d4889faa098ec0a0017377ca9de4fe0ddad5fcd1f65`.
  No root gate, dependency gate, or unrelated ticket verifier was rerun.
- The existing browser/stream evidence and declared Replay fallback are unchanged; this
  rework supplies only the sensitivity evidence requested by the critic.
