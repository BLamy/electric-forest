---
id: E3-T05
epic: 3
title: "Repo home: metadata, live branch list with fork offsets, and the project status badge (building / complete / paused / invalid_loop)"
priority: 305
status: pending
depends_on: [E3-T03]
estimate: L
capstone: false
---

## Goal

The web app shell gains the **repo home** — the route every E3-T04 row link already
targets (`/orgs/:org/repos/:repo` per E3-T04's link contract; E3-T02's shell remains the
routing authority for the exact path shape) — rendering three regions, each a
`(stream, reducer)` pair read **exclusively through E3-T03's `useServerReducer`** (hydrate
from the door's snapshot at an offset, live-tail, client-replay through the same imported
reducer — no side store, no second implementation), and each exposing the E3-T02-frozen
DOM contract attributes (referred to here as `data-ef-stream` / `data-ef-offset` /
`data-ef-digest`; E3-T02's names are binding). Region 1, **repo facts**: org, repo name,
project, and visibility, reduced from the repo's namespace/metadata streams exactly as
pinned in the E3-T01 corpus manifest (the E2-T06 `ns:org:<org>` stream folded through the
imported namespace reducer, scoped to this repo's entry, plus the repo metadata stream
frozen below). Region 2, a **live branch list**: one row per branch — `main` from the
repo entry itself, forked branches from their `repo.branch.fork` registration events on
the repo metadata stream (the frozen E3-T01 corpus contains no such event; this task's
corpus extension seed, below, dispatches the registration for the corpus fork through
the door on top of the verified T01 corpus) — showing each branch's
live head offset (the `fs:<repo>:<branch>:meta` stream's head, advancing as events append)
and, for forked branches, the `forkOffset` carried by the E1-T08 fork record
(`fs.branch.fork { v: 1, parentStreamId, forkOffset }`, the first event of the branch's
meta stream); on the extended corpus (E3-T01 plus this task's extension seed),
`feature/typography`'s displayed fork offset literal-equals the T01 manifest's
`anchors.fork_offset` value. Every branch row links to the E3-T06
tree route for that branch (link target only; this task asserts nothing about what loads
there). Region 3, the roadmap's **project status badge**: `building` / `complete` /
`paused` / `invalid_loop`, rendered from the **`project.status.set` event and
`projectStatus` reducer frozen here** — default `building` when the log carries no status
event, invalid values and invalid transitions refused **log-untouched** by an E0-T11
dispatch-door validator (E0-T11's frozen 409 `validator-rejected` shape; head offset and
`ef replay --digest` identical before and after the refusal), with unit tests pinning the
reducer against **committed golden event logs reaching all four states**. The headline
behaviors, proven under Playwright inside `make verify-E3-T05` and captured in one Replay
recording: each region's `data-ef-digest` is byte-equal to `ef replay --digest` of that
region's stream dump folded to the region's `data-ef-offset`; and with the page open, a
**second session** (a plain node client, never the browser) forks a new branch and
dispatches a status flip mid-run — the new branch row and the flipped badge render live,
no reload, with each region's DOM offset advancing to the exact append offset of the event
that caused it. Zero console errors throughout.

## Context

This task fills the number four committed specs already cite: E3-T04's rows link to "the
E3-T05 repo route", E3-T06's tree route hangs off it and **depends on it in frontmatter**
(this folder repairs that dangling dependency), E3-T08's branch switcher re-anchors the
branch list built here, and ROADMAP.md's Epic 3 section names "repo home" and "project
status badge (`building` / `complete` / `paused` / `invalid_loop`)" explicitly. It is
also where the loop's contract (`.eforest/loop.md`, "Project states") first becomes
product data instead of a JSON file in a git repo: the status a project page shows in
Epic 6 is the reducer frozen here, so getting the event shape and transition rules right
now is the whole point — Epic 6 consumes them, it must not renegotiate them.

Builds on: **E3-T03** (the `useServerReducer` hook, consumed as-is — hook gaps found here
are findings against T03), **E3-T02** (shell, routes, Playwright harness, frozen DOM
offset/digest exposure contract), **E3-T01** (the corpus: `maple/reading-room` with
`feature/typography` forked from `main` at the manifest's `fork_offset` anchor, both
branches diverging after it — reached transitively through T03's dependency closure),
**E2-T06** (the `ns:org:<org>` namespace stream and its reducer, imported, never
reimplemented), **E1-T08** (the fork record and its `forkOffset` semantics), and
**E0-T11** (the validated dispatch door whose refusal shape the status validator rides).

Contracts frozen here (versioned; changing them later invalidates the golden status logs
and Epic 6's consumption):

- **The repo metadata stream** as the home of repo-scoped platform events: the stream the
  E3-T01 manifest pins as the repo's metadata stream carries two event families this task
  defines — `repo.branch.fork { v: 1, branch, parentBranch, forkOffset }` (appended
  through the dispatch door by whatever performs an E1-T08 fork, announcing the branch to
  reducers; the fork itself still appends nothing to the parent branch) and
  `project.status.set { v: 1, status, reason? }`. **This readme is the sole owner of
  both event shapes.** E3-T01's seed does not dispatch them and its frozen dumps do not
  contain them — T01's goldens are never modified or regenerated for this task. Instead,
  this task ships a **corpus extension seed** (see Deliverables): it appends the
  `repo.branch.fork` registration for the corpus's `feature/typography` fork through the
  dispatch door on top of the verified E3-T01 corpus, and commits its own dump + manifest
  under this task's `evidence/`. The fork-anchor and render-parity criteria for the
  branch-list region read the extension's manifest, not a T01 golden. **Wrong-stream
  outcome, frozen:** either event dispatched to a stream outside the repo-metadata
  stream pattern is refused with E0-T11's frozen 409 `validator-rejected` shape,
  log-untouched — never accepted-as-inert.
- **The `projectStatus` reducer**: state `{ status, reason, updatedAtOffset }`; default
  `building` on the empty log; `status ∈ building | complete | paused | invalid_loop`.
- **The transition matrix**, enforced by the door validator *before* append:
  `building → complete | paused | invalid_loop`; `paused → building`;
  `invalid_loop → building`; `complete → building` (new work planned). Self-transitions,
  unknown status strings, missing/extra payload fields, and wrong `v` are refused;
  `reason` is required for `invalid_loop` (loop.md's `statusReason`), optional otherwise.
  Every refusal is E0-T11's 409 `validator-rejected`, log-untouched.
- **The branch-row surface**: `{ branch, headOffset, forkOffset | null }`, `main` first
  then forked branches in branch-name bytewise order; `headOffset` is live per branch.

Non-goals: no tree or file rendering (E3-T06/T07), no branch switching UI (E3-T08 — rows
here are links, not a switcher), no history view (E3-T09), no merge surfacing, no UI for
*dispatching* a status change (browsing epic; status flips arrive from other clients —
the write door exists and is tested node-side, the button is Epic 6's), no automatic
status derivation from queue state (Epic 6 owns the loop that decides *when* to flip;
this task owns what a flip *is*), and **zero new HTTP endpoints** — new events and
reducers ride the existing frozen doors.

## Deliverables

- `packages/platform/src/project-status/events.ts` — the frozen
  `project.status.set { v: 1, status, reason? }` and
  `repo.branch.fork { v: 1, branch, parentBranch, forkOffset }` event types.
- `packages/platform/src/project-status/reducer.ts` — `projectStatus`: default
  `building`, folds `project.status.set`, canonical state per E0-T03 so
  `stateDigest`/`ef replay --digest` apply.
- `packages/platform/src/project-status/validator.ts` — the E0-T11 door validator
  enforcing the frozen transition matrix (validated against the *current reduced state*
  of the target stream, not the payload's word for it), registered for the repo metadata
  stream pattern.
- Branch-list reduction (`packages/platform/src/project-status/branches.ts` or the
  existing namespace reducer module, whichever E2-T06's structure dictates): fold
  `repo.branch.fork` into the frozen branch-row surface; `main` derived from the repo
  entry.
- `tools/verify/e3-t05/extend-corpus.ts` (runnable as `make seed-e3-t05-extension`) —
  the **corpus extension seed**: against a server freshly seeded with the verified
  E3-T01 corpus, it dispatches through the door (never a side write) the
  `repo.branch.fork` registration for `feature/typography` onto the repo metadata
  stream the T01 manifest pins for `maple/reading-room`, with `forkOffset` equal to the
  T01 manifest's `anchors.fork_offset` value. Deterministic (two runs, byte-identical
  output), it dumps the extended repo-metadata stream into this task's
  `evidence/dumps/` and pins it in `evidence/e3-t05-extension-manifest.json` (same
  `{stream, dump, head_offset, state_digest}` entry schema and anchor conventions as
  T01's manifest, plus a `branch_fork_offset` anchor naming the registration event's
  append offset). E3-T01's committed dumps and manifest are never touched or
  regenerated — the extension is append-only on top of the verified corpus, with its
  own frozen goldens under this task's folder.
- `packages/platform/test/goldens/project-status/` — four committed golden event logs
  (`reaches-building.jsonl`, `reaches-complete.jsonl`, `reaches-paused.jsonl`,
  `reaches-invalid-loop.jsonl`) with a pinned `expected.json` of state digests, plus the
  empty-log default case; unit tests replay each committed log and compare digests
  (goldens are frozen — the test never regenerates them), and refusal tests drive every
  cell of the transition matrix (all 16 ordered pairs plus unknown-status, bad-`v`,
  missing-`reason`-on-`invalid_loop`) against a live door, asserting the frozen 409 shape
  and log-neutrality (head offset + dump digest byte-identical before/after each
  refusal).
- `packages/webapp/src/routes/RepoHome.tsx` + `packages/webapp/src/repo/useRepoHome.ts` —
  the route and the one thin binding of `useServerReducer` to the three regions' streams
  and imported reducers; no other webapp module touches repo-home data; each region
  carries the E3-T02 DOM contract attributes; a repo the session cannot read renders the
  platform's refusal, never a partial page.
- `packages/webapp/test/repo-home.spec.ts` — the Playwright suite (E3-T02 harness):
  corpus render parity per region, the `fork_offset`-anchor assertion, default-badge
  case, the unauthorized-render refusal case, the live fork + live status-flip run with
  the node second client, tail-honesty
  (no re-snapshot in the live window, zero reloads/navigations asserted), zero console
  errors throughout.
- `tools/verify/e3-t05/second-client.ts` — the node-side driver: performs an E1-T08 fork
  + `repo.branch.fork` dispatch, then a `building → paused → building` status
  round-trip, printing dispatch-accept timestamps and append offsets for the transcripts;
  also drives the refusal barrage for the log-neutrality transcript.
- `evidence/` — `e3-t05-render-parity.txt` (per-region `(stream, offset, digest)` triples
  vs `ef replay --digest` of the corresponding dumps), `e3-t05-live-run.txt` (fork and
  status-flip append offsets, DOM offsets, row/badge appearance timestamps within the
  2000 ms live budget, dump digests at each checkpoint), `e3-t05-status-goldens.txt`
  (the four golden digests re-derived by `ef replay`), `e3-t05-refusals.txt` (the full
  matrix barrage with before/after head offsets and digests),
  `e3-t05-unauthorized.txt` (the unauthorized-render probe: refusal status/class, DOM
  attribute sweep, region-request outcomes), `e3-t05-sensitivity.md`; plus the corpus
  extension's `dumps/` and `e3-t05-extension-manifest.json` (frozen goldens, above).
- `Makefile`: `verify-E3-T05` per the E0-T02 target contract — fresh server + data dir,
  E3-T01 seed followed by this task's corpus extension seed (fresh extension dumps
  byte-diffed against the committed ones, extension digests checked against
  `e3-t05-extension-manifest.json`), build the webapp, run the unit + Playwright suites (final pass under
  `tools/replay/record-run.sh -o e3-t05-final`), then the digest-verdict and sensitivity
  phases; joins `verify-all` and `make verify-list`; `tools/verify/self_check.sh` stays
  green.

## Acceptance criteria

- [ ] `make verify-E3-T05` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      with scrubbed env and zero `SKIPPED:` lines, against a data dir created by the run
      (corpus seeded in-run, nothing reused from development).
- [ ] Render parity on the extended corpus (E3-T01 seed + this task's extension seed;
      region 2's repo-metadata dump and pinned digest come from this task's committed
      `evidence/e3-t05-extension-manifest.json`, never from a modified or regenerated
      T01 golden): for each of the three regions, `data-ef-digest`
      byte-equals `ef replay --digest` (with that region's reducer) over the region's
      stream dump folded to the region's `data-ef-offset`, and at quiescence each
      `data-ef-offset` equals that stream's server head fetched out-of-band. Transcript
      in `evidence/e3-t05-render-parity.txt`.
- [ ] Fork-offset anchor: the `feature/typography` row displays `headOffset` equal to
      that branch meta stream's head and `forkOffset` literal-equal to the E3-T01
      manifest's top-level `anchors.fork_offset` value, which in turn equals the
      `forkOffset` field of the
      `fs.branch.fork` record in the committed branch dump — three-way literal equality,
      asserted in the committed spec (the branch row itself comes from the extension
      seed's `repo.branch.fork` registration, whose `forkOffset` carries the same
      value). Anchor semantics, binding for all three terms: the anchor is E1-T08's
      `forkOffset` **payload value** — a parent-stream (`main`) offset in E1-T08's
      frozen valid domain — not the position the fork record itself occupies (per
      E1-T08 the fork record is the first event of the branch's meta stream and appends
      zero events to the parent, so the two coordinates differ). Note for E3-T01, still
      pending: its anchor-validity test phrasing ("the event at `fork_offset` is an
      E1-T08 fork event") must be corrected to this reading — assert that the fork
      record's `forkOffset` payload equals the anchor, not that an event sits at that
      offset. The `main` row shows no fork offset.
- [ ] Status reducer pinned by goldens: `ef replay <golden> --digest` over each of the
      four committed logs reproduces its pinned digest (committed unit test iterating
      `expected.json`), the empty log reduces to `building`, and a corpus repo with zero
      status events renders the `building` badge — evidence: the unit suite green plus
      `evidence/e3-t05-status-goldens.txt` re-derived at verify time from the committed
      logs (never regenerated by the code under test).
- [ ] Transition matrix enforced, refusals log-untouched: every invalid cell (all
      self-transitions and every ordered pair outside the frozen matrix), unknown status,
      bad `v`, missing `reason` on `invalid_loop`, and an otherwise-valid
      `project.status.set` dispatched to a stream outside the repo-metadata stream
      pattern (the frozen wrong-stream outcome) is refused with E0-T11's 409
      `validator-rejected`, and for each refusal the target stream's head offset and
      `ef replay --digest` dump digest are byte-identical before and after — full barrage
      transcript in `evidence/e3-t05-refusals.txt`. Every valid cell appends and folds.
- [ ] Live fork, no reload: with the repo home open and hydrated, the node second client
      performs the fork + `repo.branch.fork` dispatch; the new branch row (correct name,
      `forkOffset` equal to the dispatched value) renders within 2000 ms of
      dispatch-accept with zero reloads and zero navigations (navigation count asserted),
      after which the branch-list region's `data-ef-offset` equals that dispatch's append
      offset (and the server head) and its `data-ef-digest` equals the dump digest there.
- [ ] Live status flip, no reload: the second client dispatches `building → paused`; the
      badge renders `paused` within 2000 ms of dispatch-accept, the status region's
      `data-ef-offset` equals the flip's append offset and its digest matches the dump;
      then `paused → building` restores the badge the same way. Timestamps, offsets, and
      digests in `evidence/e3-t05-live-run.txt`.
- [ ] Live branch heads: a stream-fs event dispatched by the second client onto an
      already-listed branch advances that row's displayed `headOffset` to the mutation's
      append offset within 2000 ms of dispatch-accept, without reload — committed spec
      assertion, with the dispatch-accept and row-update timestamps recorded in
      `evidence/e3-t05-live-run.txt` alongside the other live criteria's.
- [ ] Unauthorized render is a refusal, never a partial page: with a token that cannot
      read `maple/secret-garden` (the E3-T01 corpus's private repo — reuse the corpus's
      `willow`-member subject and E2-T07's frozen refusal semantics), opening that
      repo's home route renders the platform's refusal surface carrying the same status
      and error class as E3-T01's committed privacy probe; zero
      `data-ef-stream`/`data-ef-offset`/`data-ef-digest` attributes are present
      anywhere in the resulting DOM, and zero of the three regions' stream requests
      succeed (asserted from the captured network log). Asserted in the committed
      Playwright spec; transcript in `evidence/e3-t05-unauthorized.txt`.
- [ ] The live updates rode the tail: the captured network log for the live window
      contains no snapshot/`/state`-shaped request after hydration for any of the three
      regions — each change is attributable to a live frame (frame offsets quoted in
      `evidence/e3-t05-live-run.txt`). An update that arrived via re-hydration fails
      this criterion.
- [ ] No second reducer: the webapp imports `projectStatus`, the branch-list reduction,
      and the namespace reducer from `@eforest/platform` only; a committed grep check
      over the route's source for reducer-shaped `switch`es on `ns.`/`repo.`/`project.`
      event types, ad-hoc sorts of branch rows, and any hashing outside `stateDigest`
      returns nothing.
- [ ] Sensitivity inside `make verify-E3-T05`: in a scratch worktree, (a) the client tail
      silently drops `repo.branch.fork` frames — the live-fork criterion goes red;
      (b) the badge is hardcoded to `building` — the live-flip criterion goes red;
      (c) the validator is weakened to accept `complete → paused` — the matrix barrage
      goes red; (d) a region publishes a stale `data-ef-offset` (head−1) — the parity
      phase goes red. Each observed-red is followed by the `EXPECTED-FAIL OK` marker;
      any sabotage the suite stays green on fails this criterion. Transcripts in
      `evidence/e3-t05-sensitivity.md`.
- [ ] One Replay recording (`tools/replay/record-run.sh -o e3-t05-final`) shows
      hydration, the branch row appearing live, both badge flips, and the advancing DOM
      offsets, with zero console errors and zero uncaught exceptions anywhere in the
      session; URL plus point/time anchors at each checkpoint cited in the Verification
      log. Mandatory (browser-reaching surface); `Replay: N/A` only if
      `tools/replay/preflight.sh` fails, declared per AGENTS.md with the loud fallback.
- [ ] No regression: `verify-E3-T02` and `verify-E3-T03` re-run green on this tree, all
      root gates pass (`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test &&
      pnpm build`), and `tools/verify/self_check.sh` exits 0.

## Adversarial verification

The claim under attack: "the repo home is three streams rendered live through one hook —
its facts, branch rows, and badge are at all times independently re-derivable from the
logs by `ef replay`, its fork offsets are the fork records' truth, and the project status
machine accepts exactly the frozen matrix and nothing else, refusing everything invalid
without touching the log." Use your own repos, branches, transition sequences, and
timings — never the builder's. Invent at least one more angle.

1. **Your repo, your fork, your offsets (mandatory).** Ignore the corpus. Create your own
   org/repo through the E2-T06 doors, write enough events to move `main`'s head, fork
   your own branch at an offset you chose, and open its repo home. Verify the displayed
   `forkOffset` equals the `forkOffset` inside the `fs.branch.fork` record of your own
   branch dump — and then verify the *meaning*: `ef replay` of the parent dump truncated
   at that offset must digest-equal the branch's resolved state at the fork per E1-T08's
   fork-identity claim. A displayed fork offset that matches the registration event but
   not the fork record (the two dispatches disagreeing) refutes the branch-row contract.
   At three quiescent points, re-derive every region's digest from your own dumps; one
   differing byte refutes.
2. **Transition-matrix differential.** Drive all 16 ordered status pairs plus your own
   garbage (unknown strings, `status: null`, extra fields, `v: 2`, unicode lookalikes
   like `pausеd` with a Cyrillic е, a valid payload dispatched to the *wrong* stream) —
   from a state you put the stream in yourself, not the builder's fixture. Diff observed
   accept/refuse decisions against the frozen matrix; one disagreement refutes. For every
   refusal, take head offset and `ef replay --digest` before and after yourself — one
   moved byte refutes log-neutrality. Then race it: two clients dispatch conflicting
   valid transitions concurrently; whatever the door accepts must be valid *from the
   state at its own append point* — an accepted event that was invalid against its
   predecessor refutes the validator's read-your-state claim.
3. **Default honesty and badge theater.** A fresh repo with zero status events must show
   `building` — then dispatch one flip and back, and confirm the badge tracked both
   (a badge that shows `building` because it is hardcoded survives the first probe but
   not the round-trip). Check the digest is over reduced state, not the rendered word:
   vandalize the badge text via injected script and confirm the parity assertion still
   measures hook state; conversely a digest that stays green while the DOM shows a state
   the log lacks refutes the exposure contract.
4. **The re-hydration cheat.** Watch the network yourself (Playwright log or the Replay
   recording's timeline): any snapshot re-fetch after hydration during the live window,
   for any of the three regions, refutes "live" even with green digests. Then force it:
   block snapshot-shaped requests after first load and run your own fork + flip sequence
   — both must still land via the tail. Kill the tail mid-run, dispatch two flips,
   restore: the badge must catch up to head with digest parity and no reload; a page
   rendering as current while stale at a pre-partition offset refutes offset honesty.
5. **Second-reducer and re-sort hunt.** Pull the built bundle (or the recording's fetched
   JS) and hunt for a parallel status machine or branch-list fold: a `switch` over
   `project.`/`repo.` event types outside `@eforest/platform`, an ad-hoc sort of branch
   rows, client-side filtering of branches. Then attack the ordering: register branch
   names that separate bytewise order from locale order (`Zeta` vs `alpha`, digits,
   unicode) and diff the rendered row order against the frozen contract — a page that
   "helpfully" re-sorts refutes. Run the committed grep check, then try to defeat it
   with a trivially-renamed fold; if you can, file the check as insufficient.
6. **Fork-announcement desync.** The fork is two appends (the E1-T08 fork record on the
   new branch meta stream, the `repo.branch.fork` registration on the repo metadata
   stream). Attack the seam: dispatch a registration for a branch whose meta stream you
   never created, and a registration whose `forkOffset` contradicts the fork record.
   Whatever the frozen validators accept, the page must render only re-derivable truth —
   a row whose head offset it cannot be tailing, or a crash, refutes; if the door accepts
   contradictory registrations silently, file the validator gap as a finding against the
   contract frozen here.
7. **Sabotage the suite.** In a scratch worktree, re-run the builder's four committed
   sabotages, then add your own: make the branch row render `headOffset` from the
   registration event instead of the live tail (a frozen number the fs-mutation criterion
   must catch), and regenerate a golden status log with the code under test at test time
   (the golden tests must fail on a modified log, not re-pin it). Any sabotage that stays
   green refutes whichever gate it slipped past. Sweep the diff for
   `.skip`/`.todo`/inline lint disables.
8. **Cold clone + coverage.** Everything through `tools/verify/cold_clone.sh`, scrubbed
   env, fresh browser profile; re-derive one checkpoint digest per region from your own
   dumps. Then hold the recording and committed specs against the diff: hydration, the
   live fork, both flips, the refusal barrage, the default-badge case, the unauthorized
   render, and the branch-head advance must each have executed in a committed test or
   the cited recording — confirm the recording actually contains the fork and both flips
   (a recording missing a claimed scene fails sufficiency). Works-only-warm refutes.

Refutation currency: a region digest that matches no truncation of its own dump, a
displayed fork offset the fork record contradicts, an accepted transition outside the
matrix (or a refusal that moved the log — offsets and digests quoted), a post-hydration
snapshot fetch in the live window, a sabotage run that stayed green, or a Replay point
link where the DOM contradicts the stream. "The badge should be a nicer color" is a
design note, not a finding. No refutation → promote your transition-differential driver
and your fork-desync probes into the committed suite.

## Verification log
