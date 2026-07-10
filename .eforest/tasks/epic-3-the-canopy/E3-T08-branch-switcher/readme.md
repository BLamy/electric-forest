---
id: E3-T08
epic: 3
title: "Branch switcher: re-anchor tree and viewer routes across branch streams with the fork point visible and divergence isolated"
priority: 308
status: pending
depends_on: [E3-T07]
estimate: M
capstone: false
---

## Goal

The web app (`apps/web`) carries a **branch switcher** on the tree route
(`/:org/:repo/tree/:branch/:path*`, E3-T06) and the viewer route
(`/:org/:repo/blob/:branch/:path*`, E3-T07 — whatever exact route shape T07 froze is
binding): a control that lists the repo's branches from the E3-T05 repo-metadata
reduction (each non-main branch annotated with its **fork offset**, sourced from the
E1-T08 fork event — for the corpus, the `fork_offset` anchor pinned in
`evidence/corpus-manifest.json`), and switching from `main` to `feature/typography` (or
back) is a **client-side route change** that swaps the underlying `(stream, reducer)`
subscription: the tree region rebinds `useServerReducer` from `fs:<repo>:main:meta` to
`fs:<repo>:feature/typography:meta` — where `<repo>` is the E2-T06-resolved `<org>/<repo>`
id (for the corpus, `maple/reading-room`, giving `fs:maple/reading-room:main:meta` etc.) —
the viewer rebinds to the target branch's per-file
content stream, and each region's `data-ef-stream` / `data-ef-offset` /
`data-ef-digest` triple (E3-T02 contract) now names the **target branch's stream** at
its head. The current path is preserved when it exists on the target branch; when it
does not (never existed, or tombstoned there), the route lands on a **typed absence
state** — a distinct, testable element whose region triple still exposes the target
branch's stream at head (absence is a rendering state, never a dead or stale region).
Divergence is **isolated**: a live second-session edit on `feature/typography` advances
only that branch's DOM offset and digest (to the exact append offset, with `ef replay`
parity), while an open `main` view's triple stays **byte-identical** across the edit —
asserted by exact string comparison of sampled triples, not eyeballs. Switching is SPA
navigation: no document navigation, no reload, zero console errors throughout.

## Context

E3-T06 put one branch's tree on screen and E3-T07 one branch's file; this task proves
the model's central promise in the browser — **branches are separate streams**, and a
view is just a subscription that can be re-anchored. It closes the reference E3-T06's
spec already makes ("the branch switcher re-anchors this tree") and is the last piece
of browse machinery before history (E3-T09) and the capstone (E3-T10), whose demo walks
org → repo → tree → file and must not be confounded by cross-branch leakage.

What this task **consumes as frozen** (it freezes one small thing, below):

- **E3-T02's DOM exposure contract**: `data-ef-stream` / `data-ef-offset` /
  `data-ef-digest` on every stream-backed region, internally consistent triples,
  `collectEfRegions(page)` as the reading apparatus. After a switch, the *same* region
  root (region ids `tree`, `viewer`) must carry the *target* branch's stream name in
  `data-ef-stream` — the stream attribute is how the critic knows the subscription
  actually moved.
- **E3-T03's hook contract**: subscription swap = unmount/rebind of `useServerReducer`
  on a new stream id; hydrate-at-offset → tail → digest parity. Events from a
  torn-down subscription must never fold into the successor's state; if they do, the
  bug is triaged against T03, not papered over here.
- **E3-T05's branch list**: the reduced repo metadata (branch names + fork offsets) the
  switcher renders. The switcher must derive branch rows from that reduction — no
  hardcoded branch names, no second fold of the repo stream in the component.
- **E3-T06 / E3-T07's regions**: tree rows from `listTree` via `@eforest/streamfs`,
  viewer content from the per-file reducer — this task authors **no** reducer, sort, or
  hash; it only re-points existing regions at other streams.
- **E3-T01's corpus**: `maple/reading-room` with `main` and `feature/typography` forked
  at the manifest's `fork_offset` anchor, both branches' metadata + content streams
  pinned with `{stream, dump, head_offset, state_digest}`. All baseline switch
  assertions compare DOM triples against these pinned manifest entries.

**Frozen here**: the switcher's own DOM contract — the switcher is a conforming region
(region id `branch-switcher`, triple bound to the repo metadata stream), and each
branch option element carries `data-ef-branch` (the branch name) and, for forked
branches, `data-ef-fork-offset` (the fork event's offset as a decimal string). Critics
and later epics (E4's `ef checkout` parity checks, E3-T10) read the fork point from
this attribute and nowhere else.

Non-goals: creating or deleting branches from the UI (browse epic — branches arrive via
E1-T08 dispatches from other clients; a branch created mid-session must *appear* in the
switcher live, but no UI authors the fork), merge/conflict UI (E1-T09/T10 render
nothing here), history view (E3-T09), any diff-between-branches view (the isolation
claim is digest equality/inequality, not a rendered diff).

## Deliverables

Path anchor: `evidence/` paths are relative to this task folder,
`.eforest/tasks/epic-3-the-canopy/E3-T08-branch-switcher/`.

- `apps/web/src/components/branch-switcher/` — the switcher region: branch rows derived
  from the E3-T05 repo-metadata reduction via `useServerReducer` (live: a branch forked
  by a second client appears without reload), each row carrying `data-ef-branch` and
  `data-ef-fork-offset`, selection performing a client-side route navigation to the
  same route/path on the target branch. The URL is the single source of branch truth —
  no component state that can disagree with the route.
- Tree and viewer route wiring: branch segment change ⇒ subscription swap (old stream's
  tail torn down before the new region reports any offset), path preserved verbatim
  when present on the target; typed absence element (distinct selector, names the
  missing path and the target branch, links to the target branch's tree root) rendered
  when the path is absent or tombstoned on the target — with the region triple at the
  target branch's head in both cases.
- Playwright spec `apps/web/e2e/branch-switcher.spec.ts` (headless, zero-console-error
  assertion wrapping every test, and an assertion that **no document navigation**
  occurs across any switch):
  1. **Manifest parity per switch**: on the E3-T01 corpus, open
     `maple/reading-room@main` tree at quiescence, sample the tree triple `t0`; switch
     to `feature/typography`; assert the triple now names the target branch's `stream`
     field as pinned in `evidence/corpus-manifest.json` — i.e. the full E2-T06-resolved
     id `fs:maple/reading-room:feature/typography:meta` — with offset/digest byte-equal
     to that stream's manifest `head_offset`/`state_digest`; switch back; assert the tree
     triple is byte-identical to `t0`. Repeat the pair for the viewer route on a file
     the corpus patches on `feature/typography` (its content digest must *differ*
     between the two branches — same digest on both sides refutes the corpus binding
     and fails the test).
  2. **Fork point**: the switcher's `data-ef-fork-offset` for `feature/typography`
     equals the manifest's `fork_offset` anchor, and the test independently confirms
     the event at that offset in a fresh dump is an E1-T08 fork event.
  3. **Path preservation and typed absence**: a path present on both branches survives
     the switch verbatim (URL and rendered path both); a `main`-only path switched to
     `feature/typography` (and a path tombstoned on the target — both cases) lands on
     the absence element with the region triple at the target branch's head.
  4. **Divergence isolation**: two browser contexts — A on `main` tree + viewer, B on
     `feature/typography` viewer for the same file. A Node-side second client
     dispatches a patch and a `mkdir` to `feature/typography`. After each append: B's
     region offset equals the append offset and B's digest equals
     `ef replay <fresh dump> --digest --reducer` at that offset; A's tree and viewer
     triples are byte-identical to their pre-edit samples (exact string equality on
     all three attributes). Then A switches to `feature/typography` and lands at the
     post-edit head with digest parity — the switch, not the edit, is what moves A.
- `evidence/e3-t08-isolation.txt` — one line per checkpoint
  (`<session> <region> <stream> <offset> <digest>`) for A-before, each B checkpoint,
  A-after (identical), and A-post-switch, with each digest cross-derived by `ef replay`
  (never by the web app); plus `evidence/e3-t08-edit.jsonl`, the dumped
  `feature/typography` metadata + content log from the recorded final run.
- Replay recording of the final run (`tools/replay/record-run.sh -o e3-t08-final`): one
  session performing the **switch → edit → switch** walkthrough — open `main`, switch
  to `feature/typography` (fork offset visible), second-session edit lands live,
  switch back to a byte-identical `main`, switch forward to the advanced head — zero
  console errors; URL cited in the Verification log.
- `Makefile`: `verify-E3-T08` in the marker section — build the app, fresh server, seed
  the E3-T01 corpus, run `apps/web/e2e/branch-switcher.spec.ts` headless, then a
  sensitivity step: rerun the manifest-parity assertion with the two branches' manifest
  entries deliberately swapped (main's triple compared against feature's pinned digest)
  — the comparison must go red, first printing a `MISMATCH` line with the observed vs.
  swapped-expected digest pair, then `MUTATION fixture=e3-t08 swapped-branch
  digest-mismatch EXPECTED-FAIL OK` only after observing that failure (never
  unconditionally). Joins
  `verify-all`; `tools/verify/self_check.sh` still passes.

## Acceptance criteria

- [ ] From a pristine cold clone via `tools/verify/cold_clone.sh` (scrubbed env, fresh
      server data dir): `make verify-E3-T08` exits 0 with zero skips — evidence:
      `make verify-E3-T08 2>&1 | grep -c '^SKIPPED:'` prints `0`.
- [ ] Re-anchoring is real: after each switch, `data-ef-stream` on the tree and viewer
      regions names the target branch's stream, and offset/digest are byte-equal to
      that stream's `evidence/corpus-manifest.json` entry; switching back reproduces
      the prior triple byte-identically — evidence: the committed Playwright spec
      green, triples logged in test output.
- [ ] Fork point visible and true: the switcher's `data-ef-fork-offset` for
      `feature/typography` equals the manifest `fork_offset` anchor and addresses an
      E1-T08 fork event in an independently taken dump — evidence: committed spec
      assertion.
- [ ] Path behavior is typed: same-path switch preserves the path; missing-on-target
      and tombstoned-on-target both land the distinct absence element with the region
      triple at the target branch's head (never a stale render of the source branch's
      content, never an empty tree posing as absence) — evidence: committed spec
      assertions covering both absence causes.
- [ ] Divergence isolation by digest: during live edits to `feature/typography`, that
      branch's open regions advance to each exact append offset with `ef replay` digest
      parity, while the open `main` regions' triples remain byte-identical across the
      whole edit phase (exact string equality, all three attributes) — evidence: the
      committed spec green plus `evidence/e3-t08-isolation.txt` with every digest
      cross-derived by `ef replay`.
- [ ] The switch is SPA: zero document navigations across every switch and the edit
      phase, and the mutation-phase traffic is the `/events` tail plus at most one
      `/state` hydration per *newly bound* stream. **"Newly bound" is defined as the
      first bind of that stream id in the browser session** — a rebind after teardown
      (e.g. A→B→A switching back to a stream bound earlier) is *not* newly bound.
      Permitted switch-back traffic is exactly: resume the `/events` tail from the
      last-seen offset for that stream id, or one `/state` hydration *at the cached
      last-seen offset* — never a from-scratch `/state` at offset -1. This refines,
      not contradicts, the E3-T03 hydrate-at-offset → tail rebind lifecycle: the
      rebind's hydrate-at-offset step is satisfied from a client-side resume cache
      **keyed by stream id and anchored at that stream's last-seen offset** (such a
      cache is legitimate; a cache keyed by reducer is contamination, per angle 6) —
      evidence: committed spec assertion plus the cited Replay recording's network
      timeline.
- [ ] Switcher is a live conforming region: it carries its own triple bound to the repo
      metadata stream, and a branch forked by a second client mid-session appears as a
      new row (with its fork offset) without reload — evidence: committed spec
      assertion.
- [ ] No new reducer/sort/hash in `apps/web`: the switcher and route wiring reach
      reducers and digests only via `@eforest/streamfs` / `@eforest/protocol` imports;
      the E3-T06 grep check extended to cover the switcher paths returns nothing —
      evidence: the committed check green.
- [ ] Zero console errors across switches, edits, and absence states — evidence: the
      Playwright console assertion green AND the cited Replay recording showing an
      empty error console for the full session.
- [ ] Sensitivity: the `verify-E3-T08` swapped-branch step goes red before printing
      `EXPECTED-FAIL OK`, and the output proves the comparison actually ran and failed —
      evidence: `make verify-E3-T08 2>&1 | grep -c 'EXPECTED-FAIL OK'` ≥ 1 AND the same
      output contains, *before* the marker, a `MISMATCH` line printing the mismatched
      digest pair (observed vs. swapped-manifest expected); a marker with no preceding
      observed failure fails this criterion.
- [ ] All five workspace gates pass repo-wide; `tools/verify/self_check.sh` passes;
      `make verify-list` maps `verify-E3-T08` to this task; `verify-all` still green.
- [ ] Replay browser layer: **mandatory** (browser-reaching surface) — the Verification
      log cites the switch-edit-switch recording URL; `Replay: N/A` is not acceptable
      unless `tools/replay/preflight.sh` fails on the machine, with the loud fallback
      and reason logged per AGENTS.md.

## Adversarial verification

Your mission: refute the claim that switching branches swaps the subscription cleanly —
that each view is exactly `replay(that branch's stream)` and nothing else, live. Use
your own repos, forks, and edit sequences, never the builder's. Any single success
refutes.

1. **Divergence isolation, your own session (mandatory).** Ignore the corpus. Create
   your own repo, fork your own branch at an offset you record, open `main` in one
   context and the fork in another. Hammer the fork from a Node-side client — patches,
   mkdirs, a deep rename, a delete. Sample `main`'s triples before, during (mid-burst),
   and after: any byte of drift refutes. Then verify the fork's regions against your
   own `ef replay --digest --reducer` of a dump *you* take at three arbitrary offsets.
   Finally edit `main` and confirm the mirror image: the fork's triples must not move.
   One-directional isolation is not isolation.
2. **Stale-subscription race.** Switch A→B→A rapidly while a second client is
   mid-burst on B; also dispatch to B in the window *between* route change and the new
   region's first reported offset. Any event from B folding into A's state is invisible
   to eyeballs but not to the instrument: A's DOM digest must equal `ef replay` of
   A's log alone at A's stated offset. A digest that matches no fold point of A's own
   stream refutes; so does a triple whose `data-ef-stream` says A while its digest
   matches a fold of B.
3. **Fork-point forgery.** The displayed fork offset must come from the fork event, not
   a constant or the manifest. Fork your own branch at an offset the corpus never uses
   and check `data-ef-fork-offset` against the fork event in your own dump. Then fork a
   *second* branch off the first (if E1-T08 permits) or a second branch at a different
   offset — every row must show its own event's offset. Any row showing the corpus
   `fork_offset` for a non-corpus branch refutes.
4. **Absence honesty.** Three probes: (a) a path that never existed on the target must
   land the absence element, not an empty-directory render; (b) a path tombstoned on
   the target must land absence while the region digest still matches `ef replay`
   (whose state carries the tombstone); (c) the absence page's triple must sit at the
   target branch's head — an absence element over a stale or missing triple is a dead
   region wearing a costume, and refutes. Also switch *away* from an absence state and
   back: no residue.
5. **Reload smuggling and re-hydration bloat.** Interrogate the Replay recording's
   network: any document navigation on switch refutes SPA re-anchoring. Hold the
   traffic against the SPA criterion's definitions exactly: a stream is *newly bound*
   only on its first bind in the session, and a switch back to a previously bound
   stream may only resume the `/events` tail from the last-seen offset or issue one
   `/state` at that cached offset — a from-scratch `/state` at offset -1 on switch
   back is repeated hydration posing as tailing and refutes on excess. Then partition: kill the server mid-session with both
   contexts open, dispatch nothing, resume, switch — the switch must land at true head
   with parity, not a cached pre-partition state rendered as current.
6. **Shared-cache contamination.** Both branches' metadata streams reduce with the same
   `fsReducer`; hunt for a shared client-side cache keyed by reducer instead of stream
   id. (The resume cache the SPA criterion permits — keyed by stream id, anchored at
   that stream's last-seen offset — is legitimate and is not a refutation; anything
   keyed by reducer, or serving one stream's state under another stream's id, is.) Open the same path on both branches in one context via rapid switches and check
   each side's digest against its own stream's `ef replay` at its own offset. Any
   cross-pollination — B's file content flashing under A's route even transiently
   (sample DOM during the switch, and walk the recording frame-by-frame) — refutes.
7. **Sabotage the suite.** In a scratch worktree, break the switcher (and its
   verification apparatus) five ways: (a) keep the old stream subscription and only
   rewrite the URL, (b) render the absence element as an empty tree, (c) hardcode
   `data-ef-fork-offset` to the corpus value, (d) let the torn-down tail keep folding
   into the new state, (e) neuter the swapped-branch sensitivity step itself — make its
   comparison always pass, or make it print the `EXPECTED-FAIL OK` marker
   unconditionally without running the comparison — and confirm `verify-E3-T08` goes
   red or the marker (with its required preceding `MISMATCH` line) disappears. For each,
   `make verify-E3-T08` (and/or `pnpm test`) must go red. Any sabotage that stays green
   refutes whichever gate it slipped past. Check the diff for `.skip`/`.todo`/inline
   lint disables while there.
8. **Cold start.** Fresh clone via `tools/verify/cold_clone.sh`, fresh server data dir,
   fresh browser profile: seed, run the spec, then independently re-derive one
   isolation checkpoint (your own dump, your own `ef replay`) and one fork-offset
   check. Any dependence on a warm server, cached bundle, or builder-machine state
   refutes.
9. **Console and exception sweep.** Walk the full Replay recording — including the
   switch bursts, the absence landings, and your partition recovery from angle 5: any
   uncaught exception or console error refutes the zero-console-error criterion. Cite
   the point link.
10. **Coverage.** Hold the recording and committed spec against the diff: switch in
    both directions, both absence causes, fork-offset rendering, live branch-row
    appearance, the isolation phase, and the swapped-branch sensitivity step must each
    have executed in a committed test or the cited recording. Unexecuted diff is
    unproven or dead — the builder picks which, you enforce it.

Refutation → `status: refuted`, repro appended below, back to the builder. No
refutation → promote at minimum: your own-fork isolation sequence as a committed e2e
fixture (seed script + expected triples), and any race window or contamination probe
that reached interesting surface into the spec.

## Verification log
(appended over time by builders and critics)
