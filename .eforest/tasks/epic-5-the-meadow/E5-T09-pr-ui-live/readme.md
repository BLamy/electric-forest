---
id: E5-T09
epic: 5
title: "Pull requests in the web app: live PR list, since-fork diff, review timeline, approve and merge with conflicts and backlinks rendered"
priority: 509
status: in-progress
depends_on: [E5-T05, E5-T06, E5-T07]
estimate: L
capstone: false
---

## Goal

The PR negotiation gets a face, and the face is provably the log. `packages/webapp`
(`@eforest/webapp`; E3-T02 is the naming authority for routes and the DOM attribute
contract, E5-T02's `packages/pr` / `@eforest/pr` spelling governs event names and the
PR package — where the E5-T06 readme spells that package `packages/meadow`, the frozen
E5-T02 spec is the authority and the builder records the resolution in the Verification
log) gains the **PR list** at `/orgs/:org/repos/:repo/pulls` — read exclusively through
E3-T03's `useStreamReducer` over a **derived PR index stream** built here per the
E5-T03 pattern (`derivePrIndex` in the PR package: reducer-materialized, rebuilt from
replay, losing it loses nothing — the "E5-T03 pattern, applied to PRs" that E5-T02's
non-goals assigned to this task), the region's DOM carrying the E3-T02 contract
attributes (stream, replayed offset, state digest) **plus `data-ef-reducer`** naming
the index reducer per bet 4's every-list-view-names-its-reducer rule and the E5-T04
convention — and the **PR detail** page at `/orgs/:org/repos/:repo/pulls/:prId`: the
reduced `PrState` (E5-T02) rendered live, a **since-fork diff** computed by one pure
function `computeSinceForkDiff(baseTree, sourceTree): PrDiff` in the PR package fed
exclusively from replayed stream-fs state — `baseTree` = the target branch replayed to
exactly the PR's frozen `forkOffset`, `sourceTree` = the source branch replayed to its
live head — rendered in the web app with [@pierre/diffs](https://www.npmjs.com/package/@pierre/diffs)
and carrying the diff's canonical SHA-256 digest and both input `(stream, offset)`
pairs published in the DOM; a **review timeline** (comments threaded by root offset,
ids = event offsets, anchored by `pr.review-comment`'s frozen `path?` plus an additive
`v: 2` `line?` field revved here per E5-T02's own extension rule — rev, never loosen
v1); **approve / request-changes / merge / close buttons** each exactly one
`useDispatch` call (E5-T04's frozen write hook, consumed through the E5-T05 rendering
pattern, no optimistic apply) appending one real event through the E0-T11 door;
**conflict rendering** — a merge that lands as `pr.merge-conflicted { v: 1,
targetMergeOffset, conflicts: [{ path, kind }] }` (E5-T06) paints the conflicts array
(paths, kinds) from the reduced state, never from a side channel; and **backlinks both
ways** — the PR page renders its `closes` refs (E5-T07, `packages/entities`) as
navigable links to the E5-T05 issue detail pages, and the issue page renders
`issue/linked` provenance and, post-merge, the `closedBy { prStream, mergeOffset }`
citation as a link back to the PR. A merge attempted before approval, forced past the
UI guard, is refused server-side (`pr/merge-not-approved`, E5-T06) with both streams'
heads and digests byte-identical and the structured refusal surfaced inline. Headline
proof, inside `make verify-E5-T09`: two authenticated sessions hold the list and the
same PR detail open; session A opens a PR, reviews, approves, merges — entirely in the
browser; every step renders in B within the frozen 2000 ms live budget with zero
reloads and zero console errors; at each step the PR region's DOM-published offset
string-equals the PR stream's server head fetched out-of-band; a push to the source
branch while the PR is open updates the rendered diff live and its DOM digest
string-equals `computeSinceForkDiff` re-run over `ef replay` of the two dumped branch
logs; the merge flips the cross-linked issue to `done` in an open issue detail page and
its backlink flips to the `closedBy` citation; and after quiesce every DOM
`(offset, digest)` pair — list, PR, both branches, the issue — string-equals the server
head and the replay of the dumped logs. One Replay recording, cited by URL, carries the
whole arc.

## Context

ROADMAP.md, "Epic 5 — the-meadow": pull requests as merge-proposal streams targeting
branch streams, cross-linking events, every list view naming the derived stream or
reducer it reads, no database anywhere. This task is where the whole Epic-5 stack
becomes visible and drivable: E5-T02 froze the PR envelope and lifecycle reducer,
E5-T06 froze the merge executor and its two outcome events (`pr.merged { v: 1,
targetMergeOffset, kind, resultTreeDigest }` / `pr.merge-conflicted`), E5-T07 froze
closes-references and the exactly-once issue flip, E5-T04 froze the browser write path
(`useDispatch`, dispatch-promise-is-a-receipt, replay-carries-the-state), and E5-T05
set the read+write page pattern this task copies. E5-T09 adds **zero lifecycle, merge,
or linking semantics** — it renders reduced state and dispatches frozen actions. Every
behavior this page shows must be accountable to a replay of the streams it names;
anything else is theater, and the E5-T13 capstone ("review + approve, merge — the issue
flips to done — a second browser watches every step live") walks straight across this
page. E5-T11 (evidence rendered in the UI) also depends on the PR detail page existing.

Three things ARE owned here, all scoped:

- **The derived PR index stream** — `derivePrIndex(prLogs)` is a pure fold producing
  rows `{ prStream, status, title, sourceBranch, targetBranch, headOffset }` in
  canonical order; the materialized index stream is derived-only (rebuildable from
  replay of the underlying PR streams; the rebuild-equality proof rides the E5-T03
  discipline).
- **The since-fork diff apparatus** — `computeSinceForkDiff` is pure and canonical (two
  calls on equal trees are byte-identical), lives in `packages/pr/src/diff.ts`, and is
  the single diff authority: the webapp imports it over hook-materialized trees, the
  verify leg imports the same function over `ef replay` output, and the webapp renders
  that result with [@pierre/diffs](https://www.npmjs.com/package/@pierre/diffs). There is
  no diff endpoint, no server-side diff cache, and no second differ; `@pierre/diffs` is
  the presentation layer, not a replacement for the canonical computation or digest.
- **`pr.review-comment` v2** — additive `line?` (1-based line in the anchored `path` at
  the diff's source-side content), reducer version revved per E5-T02's rule; v1 events
  remain valid and reduce identically (asserted against E5-T02's committed golden
  digests). The rev is documented in the PR package readme next to the E5-T02 frozen
  blocks.

Builds on, without re-freezing: E5-T04 (`useDispatch` + reconciliation contract,
`data-ef-confirmed-offset`, the route/DOM conventions), E5-T05 (the board/detail
rendering pattern, the Playwright harness shape, `data-ef-reducer` — reuse, don't
fork), E5-T06 (the merge door, the two outcome events, `pr/merge-not-approved` /
`pr/already-merged` / `merge/target-advanced` typed refusals), E5-T07 (entity refs,
`issue/linked`, `closedBy`, `pr/link-noop`), E5-T02 (`PrState`, the ten refusal codes),
E3-T02/T03 (shell, DOM contract, `useStreamReducer`), E1/E4 (branch streams, tree
digests), E0-T04 (`ef replay --digest`, `ef bisect`).

Non-goals: no new merge/lifecycle/linking semantics (buttons dispatch frozen events;
the server decides), no conflict *resolution* UI (E1-T10's resolution protocol stays
CLI/stream territory; this page renders the conflicted state and whatever re-merge
happens after resolution lands elsewhere), no evidence attachments (E5-T10/T11), no
wiki (E5-T08), no free-text `#123` reference parsing (E5-T07 non-goal inherited — the
create form takes structured issue refs), no diff performance work beyond correctness
(pagination/virtualization out of scope), no new server endpoints beyond registering
the index reducer through the existing E5-T03-pattern machinery.

## Deliverables

Path anchor: `evidence/` paths are relative to this task folder,
`.eforest/tasks/epic-5-the-meadow/E5-T09-pr-ui-live/`.

- `packages/pr/src/index-stream.ts` — `derivePrIndex(prLogs)` pure fold + the derived
  index stream materialization per the E5-T03 pattern, reducer registered so
  `ef replay --reducer` and the server's state endpoint speak it;
  rebuild-from-replay equality test.
- `packages/pr/src/diff.ts` — `computeSinceForkDiff(baseTree, sourceTree): PrDiff`
  (canonical-JSON `{ files: [{ path, status: added|removed|modified, hunks }] }`,
  deterministic ordering) + `prDiffDigest(diff)` (SHA-256 over the canonical encoding,
  per E0-T03); unit tests: purity (two calls byte-identical), empty diff, add/remove/
  modify, unicode paths and contents.
- `packages/pr/src/events.ts` + `src/reducer.ts` — the additive `pr.review-comment`
  `v: 2` (`line?`) with the reducer rev; E5-T02's v1 golden logs still replay to their
  committed digests (asserted).
- `packages/webapp/src/routes/PrList.tsx` — `/orgs/:org/repos/:repo/pulls`: rows from
  the derived index via `useStreamReducer`, DOM contract attributes + `data-ef-reducer`,
  each row `data-testid="pr-row"` linking to detail; the **create-PR form** (source
  branch, target branch — `forkOffset` read from the fork record, never typed by the
  user — title, body, structured `closes` issue refs) dispatching one `pr.opened`.
- `packages/webapp/src/routes/PrDetail.tsx` — `/orgs/:org/repos/:repo/pulls/:prId`:
  reduced `PrState` header (status, branches, forkOffset), the since-fork diff region
  rendered with [@pierre/diffs](https://www.npmjs.com/package/@pierre/diffs) and
  publishing `data-ef-diff-digest` plus both input `(stream, offset)` pairs, the review
  timeline with a comment form (path/line anchoring from a diff-line affordance),
  approve / request-changes / merge / close buttons, inline structured-refusal
  surfacing, the conflicts panel rendered from reduced `conflicted` state, and the
  `closes` backlinks to `/orgs/:org/repos/:repo/issues/:issueId`.
- `packages/webapp/src/routes/IssueDetail.tsx` extension (E5-T05's page) — the backlink
  region: `issue/linked` provenance and `closedBy` citations rendered as links to
  `/pulls/:prId`, with the region's own DOM contract attributes.
- `packages/webapp/src/prs/usePrs.ts` — the one thin binding of `useStreamReducer` +
  `useDispatch` to the index stream, per-PR streams, both branch streams (for the diff
  trees), and the imported `packages/pr` reducers/diff; no other webapp module touches
  PR data, dispatch, or diffing.
- `packages/webapp/test/prs.spec.ts` — Playwright (E5-T04/T05 harness): create → review
  (path+line comment, threaded reply) → approve → merge through real pointer/keyboard
  events, asserting after each step that the PR region's DOM-published offset equals
  the PR stream's server head fetched out-of-band; two-context live sync (every step in
  B within 2000 ms, navigation count asserted zero); the forced merge-before-approval
  (UI guard bypassed via direct submit) refused with both heads/digests unchanged; a
  source-branch push (through the E4 uplink or direct dispatch) updating the open diff
  live, DOM diff digest asserted against the recomputed value; a conflict scenario
  (target advanced with overlapping edit) rendering the conflicts panel with
  paths/kinds equal to the reduced state; backlink navigation both directions; the
  issue flipping to `done` live with its backlink flipping to the `closedBy` citation;
  write-path audit (exactly one `/api/dispatch` POST per mutation, zero other writes);
  zero console errors and zero uncaught exceptions throughout, both sessions.
- `Makefile`: `verify-E5-T09` per the E0-T02 contract — fresh server + data dir, seed
  (repo, branches with a real fork record, one issue), build, Playwright (final pass
  under `tools/replay/record-run.sh -o e5-t09-final`), then the verdict phase: dump the
  index, PR, both branch, and issue logs; `ef replay --digest` each; recompute
  `computeSinceForkDiff` + `prDiffDigest` from the replayed trees at the DOM-published
  offsets; string-compare every DOM pair and the diff digest; `ef bisect` names the
  first divergent offset on any mismatch; sensitivity leg per the acceptance criteria.
  Joins `verify-all`.
- `evidence/` — `e5-t09-session.events.jsonl` (all dumped logs), `e5-t09-digests.txt`
  (every DOM `(offset, digest)` pair vs server heads vs replay, the per-step
  offset-equals-head probes, plus the diff digest vs the recomputation before and after
  the source push), `e5-t09-refusal.txt` (the forced premature merge: request,
  structured refusal, both streams' head/digest before/after — identical),
  `e5-t09-conflict.txt` (the rendered conflicts vs the target's merge-conflict events
  vs the PR's `pr.merge-conflicted` payload), `e5-t09-write-audit.txt`,
  `e5-t09-sensitivity.md`. The Replay recording is cited by URL in the Verification
  log — never committed.

## Acceptance criteria

- [ ] `make verify-E5-T09` exits 0 from a pristine cold clone via
      `tools/verify/cold_clone.sh` with scrubbed env, zero `SKIPPED:` lines, all state
      created in-run — evidence: `make verify-E5-T09 2>&1 | grep -c '^SKIPPED:'`
      prints `0`.
- [ ] **The list names its source and matches it.** The PR list region's DOM attributes
      name the derived index stream and its reducer id; the rendered rows literal-equal
      `derivePrIndex` over the dumped PR logs at the region's published offset
      (asserted from hook state, not a screenshot); rebuilding the index stream from
      replay of the underlying PR streams reproduces its digest — values in
      `evidence/e5-t09-digests.txt`.
- [ ] **The diff is a replay, twice over.** At two pinned moments — after PR open, and
      after the mid-review source push — the DOM-published diff digest string-equals
      `prDiffDigest(computeSinceForkDiff(replay(target @ forkOffset),
      replay(source @ publishedOffset)))` computed out-of-band from the two dumped
      branch logs, where `forkOffset` is read from the PR's reduced state and the
      published source offset equals the source branch's server head at quiesce. The
      push renders in the open detail page within 2000 ms with zero reloads, and the
      canonical result is displayed through [@pierre/diffs](https://www.npmjs.com/package/@pierre/diffs)
      without introducing a second diff computation. Both digest pairs in
      `evidence/e5-t09-digests.txt`.
- [ ] **Every mutation is one event through the one door, and the DOM tracks head at
      every step.** For the scripted run (create, ≥2 review comments incl. one
      path+line-anchored threaded reply, one changes-requested, one approve, one
      merge), the captured network log shows exactly one `/api/dispatch` POST per UI
      mutation and zero other state-writing requests; the dumped PR log contains
      exactly the corresponding events at consecutive offsets; comment ids in the DOM
      equal event offsets; and after each step's reconcile, the PR region's
      DOM-published offset string-equals the PR stream's server head fetched
      out-of-band (per-step probes quoted in `evidence/e5-t09-digests.txt`) —
      accounting in `evidence/e5-t09-write-audit.txt`.
- [ ] **Merge-before-approval refused end-to-end.** With the PR not `approved`, the
      merge forced past the UI guard is refused by the server
      (`pr/merge-not-approved`, E5-T06's frozen code), the structured refusal renders
      inline with zero console errors, and both the PR stream's and the target branch's
      head offsets and dump digests are byte-identical before/after — quoted in
      `evidence/e5-t09-refusal.txt`.
- [ ] **Conflicts render from the log.** The conflict scenario ends with the PR reduced
      state `conflicted`; the rendered conflicts panel's `(path, kind)` rows
      literal-equal the `pr.merge-conflicted` payload's `conflicts` array, which
      mirrors the target stream's merge-conflict events in order, and the rendered
      `targetMergeOffset` resolves to a real event in the target dump (all compared in
      `evidence/e5-t09-conflict.txt`); no merged-tree content is painted anywhere.
- [ ] **Backlinks resolve both ways, and the merge flips the issue live.** The PR page
      links each `closes` ref to its E5-T05 issue detail route; the issue page links
      its `issue/linked` and post-merge `closedBy { prStream, mergeOffset }` back to
      the PR; clicking both navigates correctly (Playwright-asserted); with the issue
      detail open in session B, the merge dispatched in A flips the rendered state to
      `done` and the backlink to the `closedBy` citation within 2000 ms, and the
      issue's DOM digest matches `ef replay --digest --reducer` over its dumped log;
      the `closedBy.mergeOffset` shown string-equals the merge event's offset in the
      dumps.
- [ ] **Live sync, two sessions.** With A and B holding the list and the same PR
      detail, each of A's steps (open, comment, approve, merge) renders in B within
      2000 ms with zero reloads (navigation count asserted); after quiesce, both
      sessions' DOM `(offset, digest)` pairs for every region string-equal the server
      heads fetched out-of-band and `ef replay --digest` over the dumps — all values in
      `evidence/e5-t09-digests.txt`.
- [ ] **No new semantics smuggled in.** A committed check greps
      `packages/webapp/src/prs/` for lifecycle transition tables, merge logic,
      propagation logic, or event folding that is not an import from the PR /
      entities packages; the E5-T02 v1 golden lifecycle logs still replay to their
      committed digests under the revved reducer.
- [ ] **Sensitivity proof inside `make verify-E5-T09`**: in a scratch worktree,
      (a) sentinel-mutate `computeSinceForkDiff` — the DOM diff digest and the
      recomputation must both move and the parity assertion must stay the arbiter (a
      hardcoded DOM digest goes red); (b) feed the diff the source tree at `forkOffset`
      instead of the target (wrong base) — the pinned post-push digest comparison goes
      red; (c) make the merge button's refusal client-side only — the refusal
      criterion's digest comparison goes red; (d) point the list region's
      `data-ef-reducer` at a different reducer id — the names-its-source assertion goes
      red; (e) publish a hardcoded PR-region offset — the per-step
      offset-equals-head probe goes red; (f) drop one live frame in B's tail — the sync
      criterion goes red. Any sabotage the suite stays green on fails this criterion;
      transcripts in `evidence/e5-t09-sensitivity.md`.
- [ ] **Replay recording**: one recording (`tools/replay/record-run.sh -o
      e5-t09-final`) containing the full open → review → approve → merge arc driven
      entirely in the browser while session B watches every step land live, the
      merge-before-approval refusal, the live source-push diff update, the conflict
      rendering, and the issue flipping to `done` with its backlink flipping in B —
      zero console errors and zero uncaught exceptions anywhere in it; URL plus
      point/time anchors at (a) the refusal rendering with unchanged digest, (b) the
      diff digest changing on the push, (c) the issue and its backlink flipping in B —
      cited in the Verification log; if `tools/replay/preflight.sh` fails, declared per
      AGENTS.md with the Playwright transcript + network/console interrogation standing
      in.
- [ ] No regression: `verify-E5-T02`, `verify-E5-T04`, `verify-E5-T05`, `verify-E5-T06`,
      `verify-E5-T07` and all root gates (`pnpm format:check && pnpm lint &&
      pnpm typecheck && pnpm test && pnpm build`) re-run green on this tree;
      `make verify-list` shows `verify-E5-T09`; `tools/verify/self_check.sh` passes.

## Adversarial verification

The claim under attack: "everything this page shows — list rows, the since-fork diff,
the review timeline, the conflict panel, the backlinks — is a replay of the streams its
DOM names, the offset the page publishes is the server's head, every button is exactly
one frozen event through the door, and the server — never the form — is what refuses a
premature merge." Use your own repos, branches, PRs, and browser contexts; invent at
least one angle this list lacks.

1. **Your PR, your replay.** Ignore the builder's script. Drive your own negotiation
   (unicode titles/paths, deep reply threads, changes-requested → re-approve flips),
   dump the index, PR, branch, and issue logs yourself, replay them, recompute the diff
   with the committed `computeSinceForkDiff`, and compare against every DOM pair in
   both of your sessions — at head and at sampled interior offsets (truncated replay,
   per E3-T03's discipline). Any mismatch refutes; pin it with `ef bisect`. Then prove
   the apparatus lives: one more dispatch must move the DOM offsets and digests.
2. **Diff-honesty attack.** The diff's base is the target at `forkOffset` — attack
   every way it could quietly be something else: advance the target branch after the PR
   opens (the rendered diff must NOT change — the base is pinned at `forkOffset`, only
   a source push moves it); push to source mid-render and race the tail; open a PR
   whose fork record sits many offsets behind target head. For each, recompute from the
   dumps yourself. A diff whose digest matches source-vs-target-head instead of
   source-vs-fork-base refutes the headline. Also grep the bundle and network log for
   any diff fetched rather than computed from replayed state — a diff endpoint or cache
   refutes "no second differ".
3. **Second-write-path and second-reducer hunt.** Grep the diff and built bundle for
   state-writing requests that aren't `/api/dispatch`, storage APIs, module-level PR
   caches, or any transition/merge/propagation logic under `packages/webapp/src/prs/`
   not imported from the protocol packages. Block `/api/dispatch` at the network layer:
   every button must fail loudly and no DOM digest may move. Reload with the server
   killed: any PR rendered refutes "no side store". Sentinel-mutate the E5-T02 reducer
   and `derivePrIndex` in a scratch worktree: every DOM digest must change; one that
   doesn't proves a second reduction path.
4. **The gate lives on the server.** Bypass the UI: craft `pr.merged` dispatches with
   your own authenticated client from `open`, from `changes-requested`, on a terminal
   PR, on a `conflicted` PR (E5-T06 documents `pr/merge-not-approved` covers it — an
   accepted re-merge from `conflicted` without resolution refutes E5-T06 as deployed),
   plus malformed v2 review comments (`line` on a missing `path`, negative/huge/
   non-integer lines, `replyTo` a non-comment offset). Every one must be refused typed
   with both streams' heads and dump digests byte-identical — verify by re-dumping
   yourself, don't trust the UI's error toast. A crafted event the server appends
   refutes the deployed gate and this task inherits the finding. Fuzz the refusal
   surface through the form too: no structured error may crash the page or hit the
   console.
5. **Conflict-suppression and citation audit.** Manufacture your own conflicted merge
   through the UI. The panel's rows must mirror the target stream's merge-conflict
   events in order; the target files rendered anywhere in the app must still show
   pre-merge bytes; `targetMergeOffset` in the rendered `pr.merge-conflicted` must
   resolve to the actual event in the target dump. Then in a scratch worktree render
   `merged` styling on a `conflicted` reduced state — the suite must go red. A panel
   fed by anything but reduced state, or a dangling citation, refutes.
6. **Backlink forgery.** Open PRs with `closes` refs to: a nonexistent issue, an issue
   in another repo, duplicate refs, and a ref added only at merge time. The PR page
   must render exactly what the reduced state carries (dangling refs render as the
   recorded `pr/link-noop`, never as a live link that 404s silently); the issue page
   must show `closedBy` only after a real merge, exactly once, with an offset you can
   resolve in the dumps. Two `closedBy` renderings for one merge, or a backlink the
   logs can't account for, refutes — and cross-reports to E5-T07.
7. **Offset and apparatus forgery, your own.** Re-run the committed sabotages, then add
   your own: publish a stale diff-input offset (source head − 1) — parity must go red;
   swap the two tree arguments to `computeSinceForkDiff` — added/removed must invert
   and the digest comparison must catch it; freeze the PR region's published offset at
   a past head — the per-step offset-equals-head probe must catch it; hardcode any DOM
   digest attribute — the interior-offset sampling must catch it. Any green run under
   sabotage refutes the measuring apparatus and every transcript this task committed.
8. **Cold clone + recording sufficiency.** `tools/verify/cold_clone.sh verify-E5-T09`
   twice back-to-back, scrubbed env, warm-server/planted-profile poison per the E3-T04
   pattern. Hold the cited Replay recording against the diff via the Replay MCP: the
   browser-driven open → review → approve → merge arc with B watching live, the refusal
   scene, the live diff update, the conflict panel, and the issue-backlink flip must
   actually be in it, console clean at every evaluated point. A recording missing a
   claimed scene fails sufficiency; a changed hunk no run executed is unproven or dead —
   builder picks which, you enforce it.

Refutation currency: a DOM region matching no truncation of the dumped log (offset
cited via `ef bisect`), a published offset the server head contradicts, a diff digest
the committed pure function cannot reproduce from the dumps, a crafted premature merge
the server appended, a conflict the panel hid or resolved, a backlink the logs can't
account for, divergent two-session digests after quiesce, a sabotage run that stayed
green, or a Replay point where the DOM contradicts the stream. "The diff looks right"
is not a finding. No refutation → promote your angle-2 diff-honesty scenario and your
angle-4 crafted-dispatch corpus into the committed suite.

## Verification log

(appended over time by builders and critics)

### 2026-08-27 — builder — implemented

- Implementation head: `76ae6c7d` (stack base `d30c7b38`, E5-T07 / PR #64).
- Added the reducer-materialized PR index, canonical since-fork diff and digest,
  review-comment v2 line anchors, authenticated PR/index projections, and target-branch
  projections pinned at the frozen fork offset (including the `-1` empty-tree boundary).
- Added the live PR list/create flow and Activity, Commits, Checks, and Changes routes; PR
  lifecycle controls dispatch frozen events through the existing door, conflicts and
  issue backlinks render reduced state, Markdown renders through Docstream, diffs through
  `@pierre/diffs`, desktop controls use source-owned shadcn-style primitives, and mobile
  navigation uses `@brett_lamy/ui`.
- Focused verification only, per the human's explicit instruction not to repeat dependency
  gates or the root suite: `pnpm exec vitest run apps/web/src/prs/usePrs.test.ts` (2/2),
  `pnpm --filter @eforest/web build`, the new PR/index/diff/platform focused tests recorded
  in `evidence/e5-t09-focused.txt`, and `git diff --check` all passed.
- One local in-app Browser sweep created and opened a real PR, compared the desktop activity
  hierarchy with E5-T14's reference at 1470 x 808, and rendered the same detail at 390 x 844.
  The sweep found and repaired Docstream's published classic-React-global crash and its
  light nested-article theme leak; the final desktop and mobile runs had zero console errors
  and warnings. See `design-qa.md`.
- Replay: N/A (the human explicitly waived another recording after repeated prior suite
  runs) + mitigation: focused exact-head web build and binding tests, committed stream/index/
  diff tests, and one in-app desktop/mobile visual plus console sweep.

### 2026-08-27 — critic — VERDICT: needs-evidence

- The exact-head two-identity browser run at `abd2c05b` is internally consistent: nine
  `/api/dispatch` writes and no other observed state writes; distinct author/reviewer
  identities; threaded and line comments recovered from the durable PR log; approval,
  merge, close, desktop/mobile projection parity; and zero guarded browser console,
  page, or request failures. Evidence: `evidence/e5-t09-browser.txt` and
  `evidence/e5-t09-browser-network.json`; verifier: `tools/verify/e5_t09_evidence.mjs`.
- COVERAGE — INSUFFICIENT. That focused run does not itself exercise the frozen-base
  diff parity after a source push, forced merge-before-approval refusal, conflict
  rendering, or the issue `closedBy` backlink flip. These are already owned by the
  pending E5-T12 negotiation and E5-T13 issue-to-merge capstone gates; consume those
  exact artifacts before re-judging rather than rerunning T09, any dependency verifier,
  the root suite, a cold clone, or Replay.
- SUITE: keep the focused two-identity oracle and network artifact; re-judge against the
  single shared E5-T12/E5-T13 capstone evidence run.

### 2026-08-27 — builder — shared-evidence coverage closure at `71f372fa`

- Consumed the verified E5-T06/T07/T12/T13 artifacts exactly as the prior critic
  requested. They close the server-neutral premature-merge refusal and the causal,
  live `closedBy` backlink flip without rerunning T09 or any dependency gate.
- Added only the two task-local focused assertions the re-judgment found residual:
  `computePrDetailDiff` is now the exact pure result returned by `usePrDetail`, and its
  post-push digest equals `prDiffDigest(computeSinceForkDiff(frozenBase, liveSource))`;
  `ConflictPanel` renders the verified E5-T06 conflicted dump's target offset,
  `same.txt` / `add-add` row, target-unchanged copy, and no merged styling.
- `CI=true pnpm exec vitest run --maxWorkers=1 apps/web/src/prs/usePrs.test.ts`
  passed 1 file / 5 tests in 793 ms. Evidence:
  `evidence/e5-t09-coverage-closure.txt`.
- Replay: N/A (no new browser run; this closes two deterministic rendering/computation
  gaps over already-verified stream artifacts) + mitigation: exact committed T06
  conflicted payload, pure digest parity, component markup assertions, and the verified
  T13 two-identity browser artifact. No broad, dependency, cold-clone, full T09, or
  browser gate was rerun.
