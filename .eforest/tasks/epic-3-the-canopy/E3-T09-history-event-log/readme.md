---
id: E3-T09
epic: 3
title: "Commit-less history view: the branch's event log humanized, every row citing its offset and actor, appended live"
priority: 309
status: pending
depends_on: [E3-T05]
estimate: M
capstone: false
---

## Goal

The web app (`apps/web`, the E3-T02 shell) serves a **history route** —
`/:org/:repo/history/:branch` — that renders the roadmap's commit-less history: the
branch's event log itself, humanized. One row per record of the branch's metadata stream
(`fs:<repo>:<branch>:meta`, hydrated at an offset from `GET /state` and live-tailed via
`/events` through the E3-T03 `useServerReducer` hook), newest first, ordered by offset
and by offset only. Each row is produced by a single pure, total function
`humanizeRecord(record): HistoryRow` exported from `@eforest/streamfs` — covering the
event kinds a branch log can carry (`create` / `patch` / `rename` / `delete`, the
branch's fork marker, and project status events where they land on the branch log) and
rendering any kind it does not recognize as an explicit raw-event row rather than
dropping it, so **row count always equals record count**. Every row cites its exact
append offset and the actor subject **from the server-stamped event envelope** (the E2
identity the platform recorded at dispatch, never a client-supplied claim), and every
row is an offset-addressed permalink: `/:org/:repo/history/:branch#o{offset}` deep-links
to, scrolls to, and highlights that row, and out-of-range or malformed fragments degrade
loudly to a testable not-found element, never a crash. The history region registers
under the E3-T02 frozen DOM contract (region id `history`), exposing the offset it has
replayed to and the digest (`stateDigest` from `@eforest/protocol`) of its reduced row
state. A dispatch from a second client appends exactly one new row at the new head
offset to the **already-open** page — no reload, no re-hydration — and the page produces
zero console errors across hydration, the live append, and permalink navigation. This
route is the destination of the offset citations E3-T01, E3-T03, and E3-T06 already
carry: an offset anywhere in the canopy is a link into this log.

## Context

This is the epic's thesis rendered as a page: there are no commits because the log *is*
the history — replayable, offset-addressed, actor-attributed. E3-T05 put the repo's
metadata and branch list on screen (this route hangs off a branch row there and off the
fork-offset citations it renders); E3-T06/T07 proved the client folds the same events as
the server — this task proves the client can also *show* them, one row per record,
without editorializing. It unblocks nothing on the E3-T10 capstone's critical path
(the capstone's spine is org → repo → tree → file) but is required by the epic gate:
the roadmap names the "commit-less history view (the event log, humanized)" as canopy
scope, and E5's issues/PRs will reuse the humanized-log pattern for their own streams.

What this task **consumes as frozen** (it freezes one thing, named below):

- **E3-T02's DOM exposure contract**: region-scoped offset + digest attributes; the
  history region registers as `history`; whatever exact attribute names T02 froze are
  binding, and the Playwright harness and every critic read them and nothing else.
- **E3-T03's hook contract**: hydrate → tail → client-replay; the history reducer is a
  fold of records into a row list, and the DOM offset/digest pair must always be a
  consistent snapshot of one fold point.
- **E3-T01's browse corpus**: committed dumps `evidence/dumps/<stream-id>.jsonl` and
  `evidence/corpus-manifest.json` with per-stream `{stream, dump, head_offset,
  state_digest}`. This task's golden transcript is pinned over one named corpus branch
  stream and cross-checked against that manifest's `head_offset` and that dump's record
  count.
- **E0's event envelope**: offsets and the server-stamped actor subject come from the
  envelope; the humanizer takes the record as given and never re-derives either.

**Frozen here**: the `HistoryRow` shape — `{ offset, actor, kind, summary }` with
`summary` a deterministic pure-text rendering (no wall-clock formatting, no locale
dependence, no HTML) — and the rule that a history page renders exactly one row per
record, unfiltered. Changing the shape or the humanizer's wording later invalidates the
golden transcript and requires the documented regen + review-diff path, exactly like the
E3-T01 corpus.

Non-goals: diff rendering between offsets (a `patch` row cites its offset and file, it
does not render the hunk — the file viewer is E3-T07's), pagination/virtualization
beyond what the corpus needs (note it if the corpus forces it, don't gold-plate it),
history across a merge graph (E1-T10 merge events fold as rows like any other kind),
filtering or search, and any second stream — this page is one branch's one log.

## Deliverables

Path anchor: `evidence/` paths are relative to this task folder,
`.eforest/tasks/epic-3-the-canopy/E3-T09-history-event-log/`.

- `packages/streamfs/src/history.ts` (exported from `@eforest/streamfs`) —
  `humanizeRecord(record): HistoryRow` and `historyRows(records): HistoryRow[]`
  (newest-first by offset, pure, total, one row per record, unknown kinds → raw-event
  rows). Unit tests cover every known kind, an unknown kind, and determinism (same
  records → byte-identical rows across runs and Node versions in CI).
- `apps/web/src/routes/history/` — the route: rows bound to
  `useServerReducer(fs:<repo>:<branch>:meta, …)` folded through `historyRows`; each
  row rendering offset, actor subject, and summary as text (payload-derived strings —
  paths, names — must be inert text nodes, never interpolated markup); each row an
  `#o{offset}` anchor; deep-link scroll + highlight; distinct testable elements for
  empty log, unknown branch (in-app 404), unauthorized, and bad-fragment states. No
  humanizing, ordering, or hashing logic authored in `apps/web` — the binding check
  is a committed **import-graph assertion**: the route module's only path to row
  construction is `historyRows`/`humanizeRecord` imported from `@eforest/streamfs`,
  and no module under `apps/web/src/routes/history/` defines or imports any other
  row-building, ordering, or digest function. A committed grep over
  `apps/web/src/routes/history/` serves as a supplementary tripwire (not the
  evidence) and must return nothing for: `sort(`, `toSorted(`, `reverse()`,
  `localeCompare`, `Intl.`, `createHash`, `sha256`, other digest/hash identifiers,
  `switch`/`if-else` chains on event kinds, `dangerouslySetInnerHTML`, `innerHTML`,
  `insertAdjacentHTML`, and `outerHTML`.
- DOM contract wiring: region `history` exposes the replayed offset and
  `stateDigest(rows)`; every sampled offset/digest pair is one consistent fold point.
- `evidence/golden-history-transcript.txt` — the **frozen golden**: one line per row
  (`{offset}\t{actor}\t{kind}\t{summary}`), newest first, over the named E3-T01 corpus
  branch stream, produced once by a Node-side transcript script committed alongside it
  (`work/`-born, promoted here), then never regenerated at test time. A documented
  `regen-E3-T09-golden` Make target is the only sanctioned regen path and prints the
  review diff; the verify target never writes into `evidence/`.
- Playwright spec `apps/web/e2e/history.spec.ts` (headless, zero-console-error
  assertion wrapping every test):
  1. **Golden parity**: open the history route on the corpus branch, wait for
     quiescence, extract the DOM rows, and compare byte-exact against the committed
     `golden-history-transcript.txt` — the comparison reads the frozen file, it never
     invokes the transcript generator. Assert row count equals the record count of the
     committed corpus dump, the first (newest) row's offset equals the manifest's
     `head_offset` for that stream, and the DOM offset equals it too.
  2. **Live append**: with the page open, a second client (Node-side `StreamFs` in the
     test) dispatches exactly one mutation; assert exactly one new row appears, at the
     top, carrying the dispatch's append offset and the dispatching session's actor
     subject, with the DOM offset advanced to that offset and no document navigation
     and no re-hydrating `/state` fetch during the append phase.
  3. **Permalinks**: navigate to `#o{offset}` for a mid-log offset — the row is
     highlighted and scrolled into view; navigate to an offset past head and to a
     malformed fragment — the bad-fragment element renders, zero console errors.
- `evidence/e3-t09-live-append.jsonl` + `evidence/e3-t09-checkpoints.txt` — the dumped
  branch log from the recorded final run and one line per checkpoint
  (`<offset> <digest>`) for the hydration point and the live append, digests produced
  server-side/by `ef replay` tooling, never by the web app.
- Replay recording of the final run (`tools/replay/record-run.sh -o e3-t09-final`):
  hydration to the golden state, the live append landing as one row at the new head
  offset, permalink navigation, zero console errors — URL cited in the Verification
  log.
- `Makefile`: `verify-E3-T09` in the marker section — build, fresh server, seed the
  E3-T01 corpus, run `apps/web/e2e/history.spec.ts` headless, then a sensitivity step:
  rerun the golden comparison against a scratch copy of the transcript with one byte
  flipped. The step must actually run the mutated comparison and **emit the observed
  failure into the transcript before the marker**: the comparison's mismatch output
  (its diff line) and its nonzero exit status must appear in the `make` output, and
  the marker line must embed that captured status —
  `MUTATION fixture=e3-t09 golden-byte-flip transcript-mismatch observed-exit=<n>
  EXPECTED-FAIL OK` with `<n>` the comparison's real exit code (nonzero), printed
  only after the failure was observed. A marker echoed without the preceding
  mismatch output is a broken step. Joins
  `verify-all`; `tools/verify/self_check.sh` still passes.

## Acceptance criteria

- [ ] From a pristine cold clone via `tools/verify/cold_clone.sh` (scrubbed env, fresh
      server data dir): `make verify-E3-T09` exits 0 with zero skips — evidence:
      `make verify-E3-T09 2>&1 | grep -c '^SKIPPED:'` prints `0`.
- [ ] Golden parity: the DOM rows on the corpus branch are byte-identical to the
      committed `evidence/golden-history-transcript.txt`, the comparison never invokes
      the transcript generator, row count equals the committed dump's record count,
      and the newest row's offset equals the manifest `head_offset` — evidence: the
      committed Playwright spec green; the spec's diff/count/offset assertions in the
      committed test source.
- [ ] One record, one row, unfiltered: for the corpus dump, `historyRows` emits
      exactly one row per record including any kind the humanizer does not specially
      render (raw-event row, never a drop) — evidence: committed unit test feeding an
      unknown kind and asserting count invariance.
- [ ] Actor honesty: every row's actor is the server-stamped envelope subject; two
      dispatches by two distinct authenticated identities in the spec produce two rows
      with the two correct subjects — evidence: committed spec assertion.
- [ ] Live append, no reload: a second client's dispatch appends exactly one row at
      the top with the dispatch's append offset, DOM offset advances to it, zero
      document navigations and zero `/state` re-hydrations during the append phase —
      evidence: the Playwright spec green plus the append visible in the cited Replay
      recording at that offset.
- [ ] Newest-first by offset only: row order is strictly descending offset with no
      timestamp or arrival-order dependence — evidence: committed unit test folding
      the same records delivered in shuffled batches to identical output.
- [ ] Permalinks: `#o{offset}` for any offset present in the log highlights that row;
      past-head, negative, and malformed fragments render the bad-fragment element
      with zero console errors — evidence: committed spec assertions.
- [ ] Empty-log, unknown-branch (in-app 404), and unauthorized states each render
      their distinct testable element with zero console errors — evidence: committed
      spec assertions driving each state (a fresh branch with zero records; a
      nonexistent branch; an unauthenticated/unauthorized session).
- [ ] Payload inertness: a file path containing markup (e.g.
      `<img src=x onerror=…>.txt`) seeded through stream-fs renders as literal text in
      its row; no element is injected, no console error fires — evidence: committed
      spec assertion.
- [ ] DOM contract: region `history` exposes offset and `stateDigest(rows)` per the
      E3-T02 attributes, and every pair sampled by the harness is a consistent
      snapshot — evidence: committed spec assertion; checkpoints in
      `evidence/e3-t09-checkpoints.txt`.
- [ ] No second implementation in the page: the route reaches
      `historyRows`/`humanizeRecord` only via `@eforest/streamfs` — evidence: the
      committed import-graph assertion green (the route module's only import path to
      row construction is `@eforest/streamfs`, and nothing under
      `apps/web/src/routes/history/` defines or imports another row-building,
      ordering, or digest function), with the committed extended-grep tripwire also
      returning nothing.
- [ ] Sensitivity: the `verify-E3-T09` golden-byte-flip step runs the mutated
      comparison, emits the observed mismatch output into the transcript, and only
      then prints the marker with the comparison's captured nonzero exit status —
      evidence, both greps over the same run:
      `make verify-E3-T09 2>&1 | grep -c 'transcript-mismatch observed-exit=[1-9]'`
      ≥ 1 (the marker embeds the real failure status), and the transcript contains
      the comparison's own mismatch/diff line preceding the marker (cite it in the
      Verification log). A marker line with `observed-exit=0` or with no preceding
      mismatch output fails this criterion.
- [ ] All five workspace gates pass repo-wide; `tools/verify/self_check.sh` passes;
      `make verify-list` maps `verify-E3-T09` to this task; `verify-all` still green.
- [ ] Replay browser layer: **mandatory** (browser-reaching surface) — the
      Verification log cites the recording URL; `Replay: N/A` is not acceptable unless
      `tools/replay/preflight.sh` fails on the machine, in which case the loud
      fallback (Playwright + console/network interrogation) and the reason are logged
      per AGENTS.md.

## Adversarial verification

Your mission: refute the claim that this page is the log — every record, one row, exact
offset, real actor, live. Use your own repos, identities, and dispatches, never the
builder's. Any single success refutes.

1. **Transcript parity, your own session (mandatory).** Ignore the corpus. Create your
   own branch and dispatch your own sequence — creates, patches, a deep rename, a
   delete, a re-create, at least one adversarially-named path — then dump the log
   yourself, run `historyRows` (or the transcript script) over your dump Node-side, and
   diff byte-exact against the DOM rows of the open page. Any byte of disagreement —
   wording, ordering, a missing row, an extra row — refutes. Then count: DOM rows must
   equal your dump's record count exactly; any delta means the page filters or
   duplicates.
2. **Row-drop hunt.** Get a record onto the branch log whose kind the humanizer does
   not specially render (a merge/conflict event from E1-T10, or any valid envelope with
   an unhandled kind if the dispatch door admits one). The page must show a raw-event
   row at that offset; a page whose count silently loses it refutes "one row per
   record". Also probe batch boundaries: dispatch a burst during hydration and diff the
   final count against the dump — a row lost in the hydrate→tail handoff refutes.
3. **Actor spoofing.** Dispatch with two distinct authenticated identities and, if the
   dispatch surface lets you, include a forged actor field in the event *payload*. The
   rows must attribute each record to the envelope's server-stamped subject; a row that
   trusts a payload-borne actor, or shows one identity's subject on the other's
   dispatch, refutes actor honesty at the platform layer, not just the page.
4. **Golden-regeneration smuggling.** Read the committed spec and the verify target: if
   any test-time code path can regenerate `golden-history-transcript.txt` (or compares
   against a freshly generated transcript instead of the committed file), the golden
   proves nothing — refute the apparatus. Then confirm with sabotage: change one word
   of a `humanizeRecord` summary in a scratch worktree; the golden comparison must go
   red. A green run after a wording change refutes the freeze.
5. **Sabotage the suite.** In a scratch worktree, break the page four ways: (a) sort
   rows by a timestamp or arrival order instead of offset, (b) drop unknown-kind
   records, (c) render the actor from the payload instead of the envelope, (d) freeze
   the tail after hydration so the live append never lands. For each, `make
   verify-E3-T09` (and/or `pnpm test`) must go red. Any sabotage that stays green
   refutes whichever gate it slipped past. Check the diff for `.skip`/`.todo`/inline
   lint disables while there.
6. **Permalink fuzzing.** Hammer the fragment: `#o0`, `#o{head}`, `#o{head+1}`,
   `#o-1`, `#o18446744073709551616`, `#o1e3`, `#oNaN`, `#o%3Cscript%3E`, a fragment
   for an offset that exists but whose record is mid-batch. Every in-log offset must
   highlight its row; everything else must land on the bad-fragment element. Any
   crash, blank page, or console error refutes; so does a permalink that highlights
   the wrong row (off-by-one against the envelope offset).
7. **Injection sweep.** Seed paths and payload strings built to escape: HTML tags,
   `javascript:` URLs where a row might link, RTL-override and zero-width characters
   that could visually forge an actor or offset, astral-plane names. Inspect the DOM:
   any injected element, any executed handler, any row where the *rendered* actor or
   offset text disagrees with the envelope values refutes. (Visual forgery of the
   actor column via bidi controls counts — the citation must be trustworthy, not just
   technically present.)
8. **Reload smuggling and tail sabotage.** Interrogate the Replay recording's network:
   any document navigation or per-append `/state` re-hydration during the live phase
   refutes "appended live". Then partition it yourself: pause the server mid-session,
   dispatch three records, resume — the page must catch up with exactly three new rows
   in offset order and its DOM offset at the new head. A page rendering as current
   while stale at a pre-partition offset refutes offset honesty.
9. **Cold start.** Fresh clone via `tools/verify/cold_clone.sh`, fresh server data
   dir, fresh browser profile: seed, run the spec, and independently re-derive the
   transcript from your own dump. Any dependence on the builder's machine, a warm
   server, or a cached bundle is a refutation, not an excuse.
10. **Console/exception sweep and coverage.** Walk the full Replay recording: any
    uncaught exception or console error — including during your fuzzing and the
    partition recovery — refutes the zero-console-error criterion; cite the point
    link. Then hold recording + committed specs against the diff: hydration, golden
    parity, the live append, both actor identities, permalink success and failure,
    unknown-kind rendering, the injection probe, and the empty-log, unknown-branch
    (in-app 404), and unauthorized states must each have executed in a committed test
    or the cited recording — a state whose element never rendered under test is a
    refutation. Unexecuted diff is unproven or dead — the builder picks which, you
    enforce it.

Refutation → `status: refuted`, repro appended below, back to the builder. No
refutation → promote at minimum: your own-session transcript parity as a committed
fixture (seed script + expected transcript), and any injection or fuzzing input that
reached interesting surface into the spec.

## Verification log
