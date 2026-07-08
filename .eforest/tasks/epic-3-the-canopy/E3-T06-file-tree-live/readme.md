---
id: E3-T06
epic: 3
title: "File tree browser: a branch's stream-fs metadata reduced to a live directory tree, rename- and tombstone-aware, with a DOM-exposed tree digest"
priority: 306
status: pending
depends_on: [E3-T05]
estimate: M
capstone: false
---

## Goal

The web app (`apps/web`, the E3-T02 shell) serves a **tree route** —
`/:org/:repo/tree/:branch` with an optional `/:path*` suffix addressing a directory —
that renders a branch's directory listing by reducing that branch's stream-fs metadata
stream (`fs:<repo>:<branch>:meta`, stream type `fs-meta`) through the E3-T03
`useServerReducer` hook: hydrate from `GET /state` at an offset, live-tail `/events`,
fold **the same standalone `fsReducer` module from `@eforest/streamfs` that
`ef replay --reducer` loads** — one reducer, never a browser re-implementation. Rows are
derived from `listTree(state)` (E1-T02's frozen segment-wise order), scoped to the
addressed directory: dirs and files, nested navigation by expanding a dir or following
its route link. Tombstoned entries are **absent** from the rows (they remain in the v2
reduced state `{ files, dirs, tombstones }` and therefore in the digest); a renamed
entry appears at its new path and only there, identity intact. The tree region exposes,
per the E3-T02 frozen DOM contract, both the offset it has replayed to and the
**canonical tree digest** — exactly `treeDigest(state) = stateDigest(state)` from
`@eforest/protocol` over the full reduced v2 state (tombstones included), computed
client-side from the hook's state, byte-equal to what `ef replay <dump> --digest
--reducer` prints for the same log folded to the same offset. Mid-session `mkdir`s,
`rename`s, and `delete`s dispatched through stream-fs by a **second client** appear,
move, and vanish in the already-open tree live — no reload, no refetch-the-world: the
DOM offset advances to each mutation's append offset and the DOM digest tracks it. The
page produces **zero console errors** across hydration, live mutations, and navigation.

## Context

This is the canopy's first contact with stream-fs: E3-T04 browsed the registry, E3-T05
browsed a repo's metadata — this task puts the E1 filesystem itself on screen and proves
the founding bet in the browser: the client folds the same events with the same reducer
to the same digest as the server and the CLI. It unblocks E3-T07 (the file viewer needs
a tree to click a file in), E3-T08 (the branch switcher re-anchors this tree), and the
E3-T10 capstone (org → repo → **tree** → file is the demo's spine).

What this task **consumes as frozen** (it freezes nothing new itself):

- **E1-T02's tree contract**: the v2 reduced state shape `{ files, dirs, tombstones }`,
  `FS_EVENT_VERSION = 2` event semantics (rename re-keys descendants in one event,
  delete writes a tombstone, create/rename at a tombstoned path clears it), `treeDigest
  = stateDigest`, and `listTree`'s segment-wise ordering rule (`a/b` before `a!`). The
  tree page renders `listTree` rows and **must not** contain a second ordering or
  hashing implementation.
- **E3-T02's DOM exposure contract**: the region-scoped attributes by which any page
  publishes the offset it has replayed to and the digest of its reduced state. The tree
  region registers under region id `tree`; the Playwright harness and every critic read
  offset and digest from those attributes and nowhere else. Whatever exact attribute
  names E3-T02 froze are binding here — this spec calls them "the DOM offset" and "the
  DOM digest".
- **E3-T03's hook contract**: `useServerReducer(streamId, reducer, { offset })` hydrate
  → tail → client-replay semantics and its digest-parity guarantee. This task is that
  guarantee applied to `fsReducer`; if parity breaks here the bug is triaged against
  T03's contract, not papered over in the page.
- **E3-T01's browse corpus**: the scripted seed (orgs, repos, branches, files with
  nested dirs, unicode paths, and at least one ordering-adversarial pair) with golden
  per-stream digests. The tree route's baseline assertions run against this corpus.
- **E2 authorization**: the tree route reads through the platform's authenticated
  surface; a branch the session cannot read renders the platform's refusal, never a
  partial tree. (Cross-tenant invisibility was proven in E3-T04; here it only must not
  regress.)

Non-goals: file content rendering (E3-T07 — a file row links to the viewer route but
this task asserts nothing about what loads there), branch switching UI (E3-T08 — the
branch is fixed by the URL here), history view (E3-T09), merge/conflict surfacing
(E1-T10 events beyond the three mutation types are out of scope for rendering but must
not crash the reducer — they fold, the digest moves, the rows re-derive), editing from
the tree UI (browsing epic; mutations arrive only from other clients through stream-fs).

## Deliverables

Path anchor: `evidence/` paths are relative to this task folder,
`.eforest/tasks/epic-3-the-canopy/E3-T06-file-tree-live/`.

- `apps/web/src/routes/tree/` — the tree route: directory listing component bound to
  `useServerReducer(fs:<repo>:<branch>:meta, fsReducer)`, nested navigation (expand
  in place and per-directory URLs), rows derived from `listTree(state)` filtered to the
  addressed directory, dir rows linking deeper, file rows linking to the E3-T07 viewer
  route (link target only). Empty-dir, missing-path (404 within the app), and
  unauthorized states each render a distinct, testable element.
- DOM contract wiring: the tree region exposes the replayed offset and the canonical
  tree digest per the E3-T02 attributes, updated synchronously with each folded event
  (offset and digest never observably disagree with each other — every DOM
  offset/digest pair the harness samples must be a consistent snapshot).
- A digest utility in the page that is **only** `treeDigest` imported from
  `@eforest/streamfs` (which delegates to `@eforest/protocol`'s `stateDigest`) — no
  hashing, sorting, or reducer code authored in `apps/web`. A committed grep-based
  check (script or test) scans `apps/web/src/routes/tree/` for `createHash`, `sha256`,
  `sort(`, `localeCompare`, and reducer-shaped `switch` on `fs.` event types, and
  returns nothing (legitimate hits, if any ever appear, must be moved into the shared
  packages instead).
- Playwright spec `apps/web/e2e/tree.spec.ts` (headless, zero-console-error assertion
  wrapping every test):
  1. **Seed parity**: against the E3-T01 corpus, open the tree route, wait for
     quiescence, read the DOM offset `o` and DOM digest `d`; dump the metadata stream,
     run `ef replay <dump> --digest --reducer <streamfs reducer path>` folded to `o`;
     assert byte-equality with `d`. Assert row order equals `listTree` output for the
     corpus (including the ordering-adversarial pair) and that no tombstoned corpus
     path has a row.
  2. **Live mutations**: with the tree open, a second client (Node-side `StreamFs` in
     the test) dispatches `mkdir` (under a currently-rendered directory), a **deep
     directory rename** (≥ 2 levels, ≥ 3 descendants, at least one unicode path), and
     a `delete`. After each mutation: the DOM row set changes accordingly (new dir row
     appears; renamed subtree present at new paths and absent at old; deleted row
     gone), the DOM offset equals that mutation's append offset, and the DOM digest
     equals `ef replay`'s digest of the freshly dumped log at that offset. No
     `page.reload()` anywhere; the spec asserts no document navigation occurred across
     the mutation phase.
  3. **Collapsed-subtree honesty**: a mutation under a directory the UI has not
     expanded still advances the DOM offset and digest (state is whole-stream; only
     rendering is scoped).
- `evidence/e3-t06-mutations.jsonl` — the dumped metadata log from the recorded final
  run, plus `evidence/e3-t06-digests.txt`: one line per checkpoint
  (`<offset> <digest>`) for the hydration point and each of the three mutations, each
  digest produced by `ef replay` (never by the web app) — the committed cross-reference
  the critic replays.
- Replay recording of the final run (`tools/replay/record-run.sh -o e3-t06-final`):
  one session showing hydration, all three mutation types landing live at their exact
  offsets, nested navigation, and zero console errors — URL cited in the Verification
  log.
- `Makefile`: `verify-E3-T06` in the marker section — build the app, start a fresh
  server, seed the E3-T01 corpus, run `apps/web/e2e/tree.spec.ts` headless, then a
  sensitivity step: rerun the parity assertion with a one-event-truncated dump (digest
  comparison must go red, printing `MUTATION fixture=e3-t06 truncated-dump
  digest-mismatch EXPECTED-FAIL OK` only after observing the failure). Joins
  `verify-all`; `tools/verify/self_check.sh` still passes.

## Acceptance criteria

- [ ] From a pristine cold clone via `tools/verify/cold_clone.sh` (scrubbed env, fresh
      server data dir): `make verify-E3-T06` exits 0 with zero skips — evidence:
      `make verify-E3-T06 2>&1 | grep -c '^SKIPPED:'` prints `0`.
- [ ] Seed parity: on the E3-T01 corpus, the DOM digest at the DOM offset is
      byte-identical to `ef replay <dump> --digest --reducer` folded to the same
      offset, and the DOM offset equals the server head at quiescence — evidence: the
      committed Playwright spec green, digests logged in the test output and in
      `evidence/e3-t06-digests.txt`.
- [ ] Live mutations, no reload: with the tree open, a second client's `mkdir`,
      deep `rename`, and `delete` each land in the open DOM (row appears / subtree
      moves with old paths gone / row vanishes), with the DOM offset equal to each
      mutation's append offset and the DOM digest equal to `ef replay`'s digest at
      that offset, and zero document navigations across the phase — evidence: the
      Playwright spec green plus the same three checkpoints visible in the cited
      Replay recording.
- [ ] Rename correctness in the UI: after the deep rename, every descendant row
      appears exactly once, at its new path, in `listTree` order, and no row exists
      under the old prefix; the file rows' identity (the viewer link target /
      content-stream identity carried in the DOM per the E3-T02 contract, if exposed)
      is unchanged — evidence: committed spec assertions.
- [ ] Tombstone semantics: a deleted path has no row, while the DOM digest still
      matches `ef replay` (whose state includes the tombstone) — i.e. the digest is
      over reduced state, not rendered rows; re-creating the path (dispatched by the
      second client) restores a row with fresh identity — evidence: committed spec
      assertions.
- [ ] Ordering: DOM row order equals `listTree` output byte-for-row on a corpus
      containing a segment-wise/whole-string separating pair (e.g. `a/b` vs `a!`) —
      evidence: committed spec assertion against the E3-T01 corpus fixture.
- [ ] Collapsed-subtree honesty: a mutation under an unexpanded directory advances the
      DOM offset and digest without that subtree being rendered — evidence: committed
      spec assertion.
- [ ] Zero console errors across hydration, all mutations, and navigation — evidence:
      the Playwright console assertion green AND the cited Replay recording showing an
      empty error console for the full session.
- [ ] No second reducer/sort/hash in the page: the committed grep check over
      `apps/web/src/routes/tree/` returns nothing, and the route's import graph
      reaches `fsReducer`/`listTree`/`treeDigest` only via `@eforest/streamfs` —
      evidence: the committed check green.
- [ ] Sensitivity: the `verify-E3-T06` truncated-dump step goes red before printing
      `EXPECTED-FAIL OK` — evidence:
      `make verify-E3-T06 2>&1 | grep -c 'EXPECTED-FAIL OK'` ≥ 1.
- [ ] All five workspace gates pass repo-wide; `tools/verify/self_check.sh` passes;
      `make verify-list` maps `verify-E3-T06` to this task; `verify-all` still green.
- [ ] Replay browser layer: **mandatory** (browser-reaching surface) — the
      Verification log cites the recording URL; `Replay: N/A` is not acceptable for
      this task unless `tools/replay/preflight.sh` fails on the machine, in which case
      the loud fallback (Playwright + console/network interrogation) and the reason
      are logged per AGENTS.md.

## Adversarial verification

Your mission: refute the claim that the browser's tree is the same fold as `ef replay` —
same reducer, same order, same digest, live. Use your own seeds, sessions, and
mutations, never the builder's. Any single success refutes.

1. **Digest parity, your own session (mandatory).** Ignore the corpus. Create your own
   repo and branch, dispatch your own sequence — nested mkdirs, unicode paths, writes,
   a deep rename landing on a tombstoned path, deletes, a re-create — with the tree
   route open the whole time. At three arbitrary quiescent points, read the DOM
   offset/digest pair, dump the log yourself, and run `ef replay --digest --reducer`
   folded to that offset. Any byte of disagreement refutes. Then check offset honesty:
   after your last dispatch, the DOM offset must reach the server head; a DOM digest
   that matches an *earlier* offset while claiming head (or vice versa — any sampled
   pair where offset and digest belong to different fold points) refutes the contract
   that the pair is a consistent snapshot.
2. **Second-reducer hunt.** Pull the actual JS bundle the session fetched from the
   Replay recording's network events (or the built `apps/web` output) and search it for
   a parallel implementation: a `switch` over `fs.*` types outside the shipped
   `@eforest/streamfs` module, any `localeCompare`/`Intl.Collator`/ad-hoc `sort`
   ordering the rows, any hashing outside `stateDigest`'s implementation. The one
   reducer must be the one module; a re-implementation that happens to agree today
   refutes the architecture claim even with green digests. Also run the builder's grep
   check and then try to defeat it: if you can add a trivially-renamed second sort the
   check misses, file the check as insufficient (needs-evidence), not the page.
3. **Rename surgery in the DOM.** Dispatch your own deep rename (≥ 3 descendants,
   unicode, destination whose parent was created mid-session) into the open tree. The
   row diff must be exactly the renamed subtree: old prefix absent, new paths present
   once each, order re-derived per `listTree`, no flicker-era duplicate rows persisting
   (sample the DOM after quiescence). Rename onto a tombstoned path: the tombstone must
   clear (verify via digest parity) and the row must carry the moved identity. Any
   ghost row, doubled row, or stale-path row refutes.
4. **Tombstone leak, both directions.** (a) Delete a file from your second client and
   hunt the DOM for any trace of it — a hidden row, a stale link — while confirming
   the digest still matches `ef replay` (state includes the tombstone). A digest
   computed over rendered rows only (test: delete a file; if the DOM digest diverges
   from `ef replay`'s state digest, the page digests the wrong thing) refutes. (b) A
   tombstoned path re-created must reappear with fresh identity — probe the viewer
   link/identity attribute for the retired content-stream identity; resurrection
   refutes E1-T02's contract as surfaced here.
5. **Reload smuggling and tail sabotage.** The claim is live, no reload. Interrogate
   the Replay recording's network: any document navigation, any full `/state` refetch
   *per mutation* (a page that re-hydrates from scratch on every event is polling, not
   tailing — check that mutation-phase traffic is the `/events` tail, not repeated
   hydrations), refutes "live". Then kill the tail yourself: pause the server (or drop
   the connection) mid-session, dispatch two mutations, resume — the tree must catch
   up to head with digest parity intact, without a reload. A page that silently stays
   stale at a pre-partition offset while rendering as if current refutes offset
   honesty.
6. **Ordering, adversarially named.** Seed your own separating names — `a/b` vs `a!`
   vs `a"b`, combining vs precomposed forms (NFC only per path rules), astral-plane
   names — and diff the DOM row order against `listTree` run by you on the replayed
   state. Stable-but-wrong order (whole-string comparison) refutes the spec claim, not
   just determinism.
7. **Sabotage the suite.** In a scratch worktree, break the page four ways: (a) sort
   rows with `localeCompare`, (b) render tombstoned entries, (c) compute the DOM
   digest over the rendered rows instead of the reduced state, (d) freeze the tail
   after hydration (never fold live events). For each, `make verify-E3-T06` (and/or
   `pnpm test`) must go red. Any sabotage that stays green refutes whichever gate it
   slipped past. Check the diff for `.skip`/`.todo`/inline lint disables while there.
8. **Cold start.** Fresh clone via `tools/verify/cold_clone.sh`, fresh server data
   dir, fresh browser profile: seed, run the spec, and independently re-derive one
   checkpoint digest (`ef replay` on your own dump). Any dependence on a warm server,
   a cached bundle, or builder-machine state — "works on the builder's machine" — is a
   refutation, not an excuse.
9. **Console and exception sweep.** Walk the full Replay recording: any uncaught
   exception or console error anywhere in the session — including during the rename
   burst and the partition-recovery you performed in angle 5 — refutes the
   zero-console-error criterion. Cite the point link.
10. **Coverage.** Hold the recording and committed spec against the diff: hydration,
    each of the three mutation types, collapsed-subtree honesty, the empty/missing/
    unauthorized states, and the no-second-reducer check must each have executed in a
    committed test or the cited recording. Unexecuted diff is unproven or dead — the
    builder picks which, you enforce it.

Refutation → `status: refuted`, repro appended below, back to the builder. No
refutation → promote at minimum: your own-session parity check as a committed e2e
fixture (seed script + expected digests), and any adversarial names or mutation
sequences that reached interesting surface into the corpus.

## Verification log
