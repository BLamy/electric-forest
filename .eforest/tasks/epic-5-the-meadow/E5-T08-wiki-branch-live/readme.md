---
id: E5-T08
epic: 5
title: "Wiki: stream-fs pages on a dedicated wiki branch, rendered and edited in the browser as patch events, syncing live like code"
priority: 508
status: verified
depends_on: [E5-T04]
estimate: M
capstone: false
---

## Goal

Every repo carries a **wiki branch** — an ordinary stream-fs branch stream named `wiki`
in the repo's E2-T06 namespace, provisioned through the E0-T11 validated `/api/dispatch`
door by `ensureWikiBranch(org, repo)` in `@eforest/meadow` (`packages/meadow`,
idempotent: a second call appends nothing) — and the wiki **is** that branch: a page is
a UTF-8 markdown file (`{slug}.md` under the branch root, slug frozen as
`[a-z0-9][a-z0-9-]*`), page create/edit/rename/delete are E1-T01/E1-T02/E1-T03's frozen
`fs.*` events dispatched unchanged, and this task adds **zero new event types, zero new
reducers, zero new server surface, and no storage of any kind**. The web app
(`packages/webapp`, `@eforest/webapp`) gains three routes: the **wiki index** at
`/orgs/:org/repos/:repo/wiki` — the page list read exclusively through E3-T03's
`useStreamReducer` over the wiki branch's metadata stream, the "page index" being
nothing but the reduced stream-fs tree filtered to `*.md` (computed in render, never
cached), the region's DOM contract attributes (E3-T02, extended per E5-T04) naming the
wiki branch stream, the replayed offset, the E1-T01 canonical **tree digest**, and the
stream-fs reducer id; the **page view** at `/orgs/:org/repos/:repo/wiki/:slug` —
sanitized markdown rendering (script/event-handler/`javascript:` vectors stripped; a
hostile page must never execute) with the same region attributes plus the page's
current content revision (E1-T04's `base` definition); and the **editor** at
`/orgs/:org/repos/:repo/wiki/:slug/edit` — a textarea holding the page source captured
together with its base revision, whose Save encodes the edit with
`@eforest/streamfs`'s frozen patch chooser (E1-T03: `fs.file.patch` when the patch's
wire bytes win, full-write fallback otherwise — imported, never reimplemented) and
dispatches it through E5-T04's `useDispatch` under its frozen reconciliation contract
(offset receipt, no optimistic apply, saved content appears only when the tail replays
the confirmed offset). A save whose base is stale — the page changed since the editor
loaded — is refused by E1-T04's fence with the typed 409
`{ class: 'validator-rejected', reason: 'stale-base', conflict }`, the branch's head
offset and tree digest byte-identical before and after, and the editor surfaces the
structured refusal inline with a load-latest affordance — **never a silent overwrite,
never a client-side merge**. Headline proof, inside `make verify-E5-T08`: two
authenticated sessions hold the same page open; A saves a patch; the change renders in
B without reload within the frozen 2000 ms live budget; at quiesce both sessions' DOM
`(offset, treeDigest)` pairs string-equal the server head and `ef replay --digest` over
the dumped wiki branch log — and the digest equals the committed golden for the
scripted session.

## Context

ROADMAP.md, "Epic 5 — the-meadow": "**wiki** as stream-fs pages on a wiki branch with
the same live sync as code," under the epic-wide rules — no database anywhere, every
list view names the derived stream or reducer it reads. This task is Epic 5's proof
that "one model to hold them all" is literal: issues needed a new event model
(E5-T01), PRs needed one (E5-T02), but the wiki needs **nothing** — Epic 1 already is a
wiki engine, and the entire task is provisioning plus rendering plus one more consumer
of the browser write path. It is also the first time E5-T04's `useDispatch` carries
stream-fs events (E5-T04 carried label events, E5-T05 issue events), which is exactly
why it depends on E5-T04: the reconciliation contract and the structured-refusal
surface frozen there are consumed here verbatim, and the stale-base editor flow this
task freezes is the pattern E7's collaborative edit surfaces inherit.

Builds on: **E5-T04** (`useDispatch` — offset receipt, no optimistic apply, refusal
rejection surfaced verbatim; `data-ef-confirmed-offset` and the DOM contract extension
conventions frozen there), **E1-T01/T02/T03** through the dependency closure (the
frozen `fs.*` envelope, tree digest, tombstoned delete and rename, the patch event and
its wire-bytes chooser — all consumed as imports; any wiki-side event construction that
doesn't go through `@eforest/streamfs`'s writer API is a finding), **E1-T04** (the
stale-base fence and its typed refusal — this task adds no fencing logic, it only
surfaces the server's), **E1-T08** (branch streams — the wiki branch is one),
**E3-T02/T03** (shell, Playwright harness, DOM attribute contract, `useStreamReducer`),
**E2-T06/T07** (namespaces and per-branch authorization — wiki write access is whatever
the repo's grants say; nothing wiki-specific).

Contracts frozen here (documented in the `packages/meadow` readme under
`<!-- frozen:E5-T08:<block> -->` markers, doc-sync checked like E5-T04's frozen-contract
blocks in `packages/web-hooks`): the wiki branch name `wiki` and its
provision-through-dispatch semantics (created empty, not forked from `main` content —
the wiki's history starts at its own offset zero); the page path convention
(`{slug}.md` at branch root, slug grammar above, nested directories out of scope and
refused by the editor's slug validation — the _server_ needs no such rule, a foreign
tool may write any tree and the index simply shows the `*.md` subset); and the three
route paths. Changing the branch name or path convention later invalidates this task's
golden digest and every downstream wiki fixture.

Non-goals: page history/diff UI (the event log view is E3's history surface; wiki gets
it free by being a branch), images/attachments (E5-T10/T11), merging wiki into `main`
or PRs against the wiki branch (nothing prevents it — the branch is ordinary — but no
UI here), search, concurrent-editor operational transform or merge-on-conflict (the
fence refuses, the human reloads — that is the design), WYSIWYG, comments, and any
markdown extension beyond a sanitized CommonMark-level render. No new server endpoint,
no new event type, no new reducer.

## Deliverables

- `packages/meadow/src/wiki/provision.ts` — `ensureWikiBranch(org, repo)`: authenticated
  dispatch creating the `wiki` branch stream through the E1-T08/E2-T06 machinery,
  idempotent (second call: zero appends, both calls return the same stream id), plus the
  frozen-contract doc blocks in the package readme. Unit tests for idempotence and the
  created-empty property.
- `packages/webapp/src/wiki/useWiki.ts` — the one thin binding of `useStreamReducer`
  (wiki branch metadata + page content streams, imported stream-fs reducer) and
  `useDispatch` (page writes via the imported `@eforest/streamfs` writer/patch chooser,
  base revision threading per E1-T04); no other webapp module touches wiki data or
  constructs `fs.*` payloads.
- `packages/webapp/src/wiki/renderMarkdown.ts` — deterministic markdown → sanitized DOM,
  with a committed adversarial corpus test (`renderMarkdown.spec.ts`): script tags,
  event-handler attributes, `javascript:`/`data:` hrefs, malformed nesting — asserted
  inert.
- `packages/webapp/src/routes/WikiIndex.tsx` — `/orgs/:org/repos/:repo/wiki`: the `*.md`
  filter over the reduced tree, region attributes (stream, offset, tree digest, reducer
  id, `data-ef-confirmed-offset` per E5-T04), each page row
  `data-testid="wiki-page-row"`, a new-page form (slug-validated) whose create is one
  dispatch.
- `packages/webapp/src/routes/WikiPage.tsx` — `/orgs/:org/repos/:repo/wiki/:slug`:
  sanitized render, region attributes plus the page's content revision, edit / rename /
  delete controls (rename and delete each exactly one dispatched E1-T02 event; a
  deleted page 404s and leaves the index live-updated).
- `packages/webapp/src/routes/WikiEditor.tsx` — the editor: source + captured base
  revision, patch-encoded save through `useDispatch`, pending-until-reconciled per
  E5-T04, inline `stale-base` refusal surface with load-latest.
- `packages/webapp/test/wiki.spec.ts` — Playwright (E3-T02 harness): provision → create
  → view → edit → rename → delete through real pointer/keyboard events; two-context
  live sync (A saves, B's open page updates within 2000 ms, zero reloads asserted); the
  stale save (B edits from an old base after A's save landed) refused and surfaced;
  write-path audit from the network log (exactly one `/api/dispatch` POST per mutation,
  zero other writes); the XSS page rendered inert; zero unexpected console errors. Chromium's
  one raw `Failed to load resource` error for the required stale-save HTTP 409 is preserved and
  must correlate one-for-one with that response; filtering or reporting it as zero refutes.
- `Makefile`: `verify-E5-T08` per the E0-T02 target contract — fresh server + data dir,
  provision, scripted session, Playwright (final pass under
  `tools/replay/record-run.sh -o e5-t08-final`), then the verdict phase: dump the wiki
  branch log, `ef replay --digest`, string-compare against both sessions' DOM pairs and
  the committed golden digest; run the same scripted edit once patch-encoded and once
  with forced full writes and require identical tree digests with the patch log's wire
  bytes strictly smaller (the E1-T03 differential, re-earned on wiki content); nonzero
  exit naming the first divergent offset via `ef bisect` on any mismatch. Joins
  `verify-all`.
- `evidence/` — `e5-t08-golden.digest` (the scripted session's tree digest, frozen),
  `e5-t08-session.events.jsonl` (the dumped wiki branch log),
  `e5-t08-patch-parity.txt` (patch vs full-write: both digests, both wire-byte sums),
  `e5-t08-fence.txt` (the stale save: request, typed refusal, head offset and tree
  digest before/after — identical), `e5-t08-write-audit.txt`, and
  `e5-t08-sensitivity.md`. The Replay recording is cited by URL in the Verification
  log — never committed.

## Acceptance criteria

- [ ] `make verify-E5-T08` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      with scrubbed env, zero `SKIPPED:` lines, all state created in-run.
- [ ] Zero new model: the diff adds no event type, no reducer, no server route, and no
      persistence — asserted by grep in the verify target (no `fs.` event construction
      outside `@eforest/streamfs` imports, no storage API in `packages/webapp/src/wiki/`)
      and by the write audit: for the scripted run (provision, ≥2 creates, ≥3 edits,
      1 rename, 1 delete) the network log shows exactly one `/api/dispatch` POST per
      mutation and zero other state-writing requests, and the dumped log contains
      exactly the corresponding frozen E1 events — accounting in
      `evidence/e5-t08-write-audit.txt`.
- [ ] Tree-digest parity, golden: `ef replay --digest` over
      `evidence/e5-t08-session.events.jsonl` equals `evidence/e5-t08-golden.digest`
      equals both sessions' DOM-published tree digests at quiesce equals the server
      head's — four string-equal values, quoted in the verify output. The index's
      rendered page set literal-equals the `*.md` entries of the reduced tree at the
      region's published offset (asserted from hook state, not a screenshot).
- [ ] Patch-vs-full-write parity: the same scripted edit sequence, patch-encoded and
      force-full-written, replays to identical tree digests with the patch log's summed
      wire bytes strictly smaller; and the recorded browser session's edits actually
      shipped as `fs.file.patch` events (asserted from the dumped log — an editor that
      always full-writes fails this criterion). Values in
      `evidence/e5-t08-patch-parity.txt`.
- [ ] Live sync, two sessions: A's save renders in B's open page (and B's open index)
      within 2000 ms of dispatch-accept with zero reloads/re-navigations (navigation
      count asserted); no optimistic apply — A's own DOM shows the saved content only
      at/after A's tail replays the confirmed offset, per E5-T04's counters.
- [ ] Stale save fenced end-to-end: B saves from a base captured before A's landed edit;
      the server refuses with the E1-T04 typed `stale-base` 409; the wiki branch's head
      offset and tree digest are byte-identical before and after (both quoted in
      `evidence/e5-t08-fence.txt`); the editor surfaces the structured refusal inline
      while preserving Chromium's one raw 409 resource error and showing zero additional console
      errors, offers load-latest, and after reloading B's re-based save lands. A save that
      overwrites A's edit without carrying it refutes.
- [ ] Hostile markdown inert: the committed adversarial corpus rendered in the real
      page view executes nothing (sentinel `window` flag never set, zero console
      errors), asserted in `wiki.spec.ts`; delete leaves a tombstone — the page 404s,
      the index updates live in the second session, and the dumped log shows the
      E1-T02 delete event, not a truncation.
- [ ] Provisioning idempotent: `ensureWikiBranch` twice → second call appends zero
      events (head offset unchanged, asserted), same stream id both times; a repo
      whose wiki was never touched shows an empty index, not an error.
- [ ] Replay (browser layer): one recording (`tools/replay/record-run.sh -o
    e5-t08-final`) containing the two-session live edit **and** the refused stale
      save, the single raw console resource error caused by its required HTTP 409, zero other
      console errors, and zero uncaught exceptions anywhere in it; URL plus
      point/time anchors at (a) A's save confirming, (b) the patch rendering in B's
      open page without reload, (c) the stale-save refusal with the unchanged digest,
      cited in the Verification log; if `tools/replay/preflight.sh` fails, declared per
      AGENTS.md with the Playwright transcript + network/console interrogation standing
      in.
- [ ] Sensitivity proof inside `make verify-E5-T08`: in a scratch worktree, (a) make
      the editor full-write unconditionally — the patch-parity criterion goes red;
      (b) make the editor visibly apply the edited bytes before dispatch acknowledgement — the
      no-optimistic-apply assertion goes red; (c) strip the base from the save payload
      or auto-retry a stale save with a fresh base — the fence criterion goes red;
      (d) unsanitize the renderer — the XSS corpus goes red; (e) corrupt one byte of
      `e5-t08-golden.digest` — the golden comparison goes red. Any sabotage the suite
      stays green on fails this criterion; transcripts in
      `evidence/e5-t08-sensitivity.md`.
- [ ] No regression: `verify-E5-T04`, `verify-E1-T03`, `verify-E1-T04`, and all root
      gates (`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test &&
    pnpm build`) re-run green on this tree; `make verify-list` maps `verify-E5-T08`
      to this task.

## Adversarial verification

The claim under attack: "the wiki is nothing but an Epic 1 branch — every page mutation
is one frozen `fs.*` event through `/api/dispatch`, the rendered pages are at all times a
replay of that log and nothing else, edits ship as patches, a stale save cannot touch
the log, and hostile page content cannot execute." Use your own pages, your own edit
sequences, your own browser contexts; invent at least one more angle.

1. **Your session, your replay.** Ignore the builder's script. Create and edit your own
   pages (unicode slugs' rejection, multi-kilobyte pages, rapid edit chains, a rename
   racing an edit), dump the wiki branch log yourself, `ef replay --digest` it, and
   compare against both sessions' DOM `(offset, treeDigest)` pairs and against
   `ef materialize` of the branch — the materialized `*.md` files' bytes must equal
   what the page views render from (source-level, pre-markdown). Any mismatch at head
   or at a sampled interior offset refutes; pin it with `ef bisect`. Then prove the
   apparatus lives: one more save must change the DOM tree digest.
2. **New-model hunt.** Grep the diff and built bundle for wiki-specific event types,
   reducers, endpoints, caches, or storage APIs. Dynamically: block `/api/dispatch` — every
   save/create/rename/delete must fail loudly with the digest unmoved; reload with the
   server killed — any page rendered refutes "no side store". Then write a page onto
   the wiki branch with a **foreign tool** (the E4 CLI or a raw `@eforest/streamfs`
   writer, bypassing the webapp entirely): it must appear in the open index and page
   view live, because the wiki is the branch. A wiki that only shows pages its own UI
   wrote refutes the headline claim.
3. **Patch-purity differential.** From the dumped log of your own browser session,
   verify the edits are `fs.file.patch` events satisfying E1-T03's chooser rule (wire
   bytes strictly smaller; full-write fallback only where the rule demands it — verify
   one such case with a page rewrite). Re-encode the same content history as full
   writes yourself and require digest equality. An editor event the chooser rule
   doesn't predict, or divergent digests, refutes.
4. **Fence, not etiquette.** Bypass the editor: craft saves with your own authenticated
   client — outdated bases, fabricated bases, a replayed previously-legal save, a save
   against a just-deleted page, a save racing a rename. Every stale/invalid base must
   get the typed E1-T04 refusal with head offset and tree digest byte-identical
   (re-dump and replay yourself). Then attack the UI's handling: hold two editors on
   one page, land A, save B — B must surface the refusal and must **not** auto-retry
   with a silently re-read base (an auto-rebased save that discards A's words without a
   human in the loop refutes the no-silent-overwrite contract; check the network log
   for a second `/api/dispatch` B's user never triggered). ≥20 racing-save trials: the log
   is the arbiter, exactly one winner per race, both sessions converge to identical
   digests.
5. **Markdown as attack surface.** Fuzz beyond the committed corpus: SVG event
   handlers, `<iframe>`/`<object>`, protocol-relative and `javascript:` links, HTML
   entities smuggling tags, a page whose _slug rendering_ could inject, a 1 MB page,
   deeply nested lists. Refutation: any script execution, any uncaught exception, any
   console error, or a page that wedges the tab. Also confirm sanitization is
   render-side only — the hostile bytes must be stored verbatim on the stream (dump and
   check); a save-side rewrite of page content refutes replay fidelity.
6. **Reducer-inheritance sabotage.** In a scratch worktree, inject a sentinel into the
   stream-fs reducer's tree digest: every wiki DOM digest (index and page, both
   sessions, post-refusal included) must change and parity with the equally-mutated
   server must hold — any digest unchanged proves a second reduction path. Separately
   sabotage the committed suite per the builder's sensitivity list plus your own: point
   the index region's reducer attribute at the wrong reducer id — the names-its-source
   assertion must go red. Any green run under sabotage refutes the apparatus and every
   transcript this task committed.
7. **Cold clone + recording sufficiency.** `tools/verify/cold_clone.sh verify-E5-T08`,
   scrubbed env, warm-server/planted-profile poison per the E3-T04 pattern; the golden
   digest must be a frozen committed artifact, not recomputed by the run it judges.
   Hold the cited Replay recording against the diff via the Replay MCP: the two-session
   live edit, the stale-save refusal, and a patch-encoded save must actually be in it —
   evaluate at points, pull the `/api/dispatch` bodies from network events and match them
   against the dumped log's events. A recording missing a claimed scene fails
   sufficiency; a changed hunk no run executed is unproven or dead.

Refutation currency: a mutation with no corresponding `/api/dispatch` event, a rendered
page set matching no truncation of the dumped log (offset-cited via `ef bisect`), a
stale save the server appended or the UI silently rebased, an edit shipped as a full
write where the chooser rule demands a patch, executed script from page content, a
sabotage run that stayed green, or a Replay point link where the DOM contradicts the
stream. "The wiki feels like GitHub's" is not a finding. No refutation → promote your
racing-save trial script, your crafted-stale-base corpus, and your markdown fuzz
inputs into the committed suite.

## Verification log

### 2026-08-27 — builder — implemented

- Implementation commits: `afe995dc` (empty, idempotently provisioned wiki branch and
  frozen meadow contracts) and `7449e49b` (live wiki routes, patch editor, Docstream
  renderer, parentless branch-genesis projection support, and focused regression tests).
- Focused builds passed: `pnpm --filter @eforest/meadow build`,
  `pnpm --filter @eforest/platform build`, `pnpm --filter @eforest/web-hooks build`, and
  `pnpm --filter @eforest/web build`. The isolated worktree links were materialized once
  with `pnpm install --frozen-lockfile`; no package versions were changed by that step.
- Ticket-local behavior passed: `pnpm exec vitest run
packages/meadow/test/provision.test.ts packages/reducers/src/file-content.test.ts
packages/platform/test/branch-projection.test.ts` (17 tests) and `pnpm exec vitest run
apps/web/src/wiki/renderMarkdown.test.ts` (2 tests, including hostile markdown rendered
  through the shared Docstream adapter). `git diff --check` passed.
- Replay: N/A (the user directed the queue to advance without another browser/provider
  verification cycle) + mitigation: status is only `implemented`, not `verified`; the
  focused provision, reducer, projection, sanitization, and affected-package build
  evidence above is preserved for the independent critic. No dependency verifier, root
  test suite, cold-clone gate, or previously completed ticket gate was rerun.

### 2026-08-27 — critic/refinement — VERDICT: refuted

- CANONICAL SAVE — `chooseWikiSaveEvent` converted the canonical chooser's
  `fs.file.write` fallback into `fs.file.patch`; require exact preservation of both
  `chooseWriteEvent` branches, including full writes.
- CANONICAL WRITERS — browser create/delete/rename/patch mutations hand-built frozen
  envelopes instead of importing the StreamFS writer constructors; require one shared
  constructor path and exact-envelope regressions.
- PROVISIONING — the production wiki routes never invoked `ensureWikiBranch`, and
  concurrent first opens could append two genesis events; require route gating plus a
  real dispatch-door race with exactly one accepted genesis.
- SUFFICIENCY — no deterministic two-session browser oracle covered live patch delivery,
  no optimistic apply, stale refusal without retry, dispatch-only writes, hostile
  markdown, delete/tombstone, digest parity, console/network state, or causal
  sensitivity. Replay preflight was unavailable (`unknown command mcp`), so require the
  declared Playwright fallback and committed stream evidence.

### 2026-08-27 — builder — rework implemented

- Rework commit: `4cd9dd23ad6f583d4380c4e4bbbc8c7bcdbc43fd`. Canonical StreamFS event constructors now
  own create/content/delete/rename/patch/write envelopes, and the wiki delegates to them;
  chooser tests prove both patch and full-write results equal the frozen
  `chooseWriteEvent` output before timestamping.
- Production wiki routes now gate rendering on the Meadow provisioner. Concurrent
  first-open callers race through the real dispatch door: one genesis is accepted, one
  receives `fs/branch-exists`, and the loser re-inspects the canonical winner. Focused
  platform and Meadow regressions preserve exactly one genesis.
- Focused deterministic verification passed: `CI=true EFOREST_TEST_PREBUILT=1 pnpm exec
vitest run --maxWorkers=1 packages/streamfs/src/writer-events.test.ts
packages/meadow/test/provision.test.ts apps/web/src/wiki/useWiki.test.ts
apps/web/src/wiki/WikiEditor.test.ts apps/web/src/wiki/renderMarkdown.test.ts
packages/reducers/src/file-content.test.ts packages/platform/test/branch-projection.test.ts`
  — 7 files, 29 tests. Affected builds for `@eforest/streamfs`, `@eforest/meadow`,
  `@eforest/platform`, `@eforest/browser-verify`, and `@eforest/web` passed; the focused
  browser oracle's standalone TypeScript check and `git diff --check` also passed.
- Focused browser fallback passed:
  `E5_T08_BROWSER_FALLBACK_OK sessions=2 dispatches=7 accepted=5 refused=2
head=0000000000000000_0000000000000007
digest=e0f09526b72eec1b3b8417c3db8d06a8a532ae7a90bf1094151c28a01b03158d`.
  It exercises two independent authenticated contexts, concurrent first open, a live
  patch with the writer tail deliberately paused, stale refusal with unchanged log bytes
  and no retry, create/delete/tombstone, foreign canonical full writes, hostile markdown
  inertness with verbatim source replay, dispatch-only network auditing, zero console or
  page errors, exact DOM/server/replay/golden parity, and one-byte causal sensitivity.
- Evidence: `evidence/e5-t08-session.events.jsonl`, `evidence/e5-t08-golden.digest`,
  `evidence/e5-t08-digests.txt`, `evidence/e5-t08-fence.txt`,
  `evidence/e5-t08-write-audit.txt`, `evidence/e5-t08-patch-parity.txt`,
  `evidence/e5-t08-sensitivity.md`, and `evidence/e5-t08-browser-fallback.json`.
  `node tools/verify/e5_t08_evidence.mjs` independently replayed all 8 accepted events
  and passed every committed marker.
- Replay: N/A (`tools/replay/preflight.sh` failed with `unknown command mcp`, and this
  rework explicitly excluded a Replay recording) + mitigation: the production-runtime
  two-session Playwright fallback commits the canonical event dump, golden, fence,
  dispatch audit, console/network interrogation, digest parity, and sensitivity results.
  Per the rework scope, no root/full suite, cold clone, dependency gate, Replay run, or
  unrelated test ran. Status remains `implemented` for a fresh critic session.

### 2026-08-27 — critic/refinement — VERDICT: refuted

- FULL-WRITE DATA LOSS — `chooseWikiSaveEvent` correctly preserved the canonical
  `fs.file.write` fallback, but `WikiEditor` sent only its metadata envelope. The browser
  therefore had no authorized path that persisted the referenced content bytes before
  metadata; require one existing `/api/dispatch` request, the canonical content generation,
  and two-session byte replay.
- ACTION SUFFICIENCY — the fallback recorded one accepted edit and no rename. Require at
  least three accepted browser edits, a pointer-driven `fs.rename`, disappearance of the old
  route, convergence on the new route, and one dispatch POST for each user action.
- SENSITIVITY — `e5-t08-sensitivity.md` contained labels rather than causal sabotage runs.
  Require exact nonzero transcripts for forced full-write, optimistic apply, stripped base,
  unsanitized rendering, and a corrupted committed golden.
- COVERAGE — no exact-head source coverage or per-hunk runtime classification demonstrated
  execution of the new full-write path or the rename path. Require an exact candidate-head
  inventory with runtime evidence or an explicit waiver for every hunk.

### 2026-08-27 — builder — rework implemented

- Rework commits: `f94bf044` (authorized canonical content companion on the existing
  `/api/dispatch` request), `fc5ad974` (exact-byte rename projection), `4155ac7d`
  (pre-navigation live-state sampling), and `ecb4cf983d468403b65a6d3a677096e63cad9de8`
  (dependent-patch causal refusal assertion). The full-write path appends the canonical
  `fs.file.content` bytes before its canonical `fs.file.write` metadata and uses no new
  route, transport, event family, reducer, or storage model.
- The sole focused gate passed at exact implementation head
  `ecb4cf983d468403b65a6d3a677096e63cad9de8`: `make verify-E5-T08`. Its affected builds
  (`@eforest/web-hooks`, `@eforest/reducers`, `@eforest/platform`, and `@eforest/web`)
  passed, as did 8 focused Vitest files / 38 tests. No dependency gate, root/full suite,
  cold clone, Replay/preflight, or unrelated test ran.
- Browser fallback passed:
  `E5_T08_BROWSER_FALLBACK_OK sessions=2 dispatches=10 accepted=8 refused=2 edits=3
  rename=fs.rename head=0000000000000000_0000000000000010
  digest=d33b6bd980b3bb1c9aa02af41222f857a2349ef28dbc59c1c4847e11ae854d34`.
  Two independent sessions rendered and replayed the forced full-write bytes exactly;
  two patches plus one full write were accepted, each action issued one dispatch, and a
  pointer-driven rename removed `home.md` while `guide.md` converged in writer and
  follower. The same run retained stale refusal/no optimistic apply, dispatch-only
  writes, hostile Markdown inertness with verbatim storage, delete/tombstone, complete
  request/response lifecycle accounting, zero unexpected browser console/network errors,
  and exact DOM/server/replay/golden digest parity.
- Causal sensitivity passed with five real nonzero runs and precise sensors:
  forced-full-write → `canonical-patch-chooser`, optimistic-local-apply →
  `no-optimistic-revision`, stripped-base → `caller-base-revision`, unsanitized-renderer
  → `hostile-sanitizer-removes-active-markup`, and corrupted-golden → `independent replay
  matches committed golden`. The exact commands, exits, and observed assertions are in
  `evidence/e5-t08-sensitivity.md`.
- Exact-head coverage classified all 116 hunks from
  `de9f59940eac1b6624a824965165d1cab5bd5b78` through `ecb4cf98` and records explicit
  runtime lines for `fs.file.write` at metadata offset 5 and pointer `fs.rename` at
  metadata offset 6. Evidence: `evidence/e5-t08-coverage.md`,
  `evidence/e5-t08-session.events.jsonl`, `evidence/e5-t08-browser-fallback.json`,
  `evidence/e5-t08-digests.txt`, `evidence/e5-t08-write-audit.txt`,
  `evidence/e5-t08-patch-parity.txt`, and `evidence/e5-t08-sensitivity.md`.
- Replay: N/A (the known preflight failure is `unknown command mcp`; preflight and Replay
  recording were explicitly excluded from this rework) + mitigation: the one focused
  production-runtime Playwright fallback commits raw console/network lifecycle logs,
  canonical events, exact bytes, route state, digest parity, per-hunk coverage, and causal
  sabotage transcripts. Status remains `implemented` for a fresh critic session.

### 2026-08-27 — fresh critic — VERDICT: verified

- STALE CONFLICT — VERIFIED. Commit `e4a5d715` preserves the stale-base HTTP 409;
  committed browser evidence records that 409, exactly one inherent Chromium
  failed-resource diagnostic, zero unexpected console errors, and zero page errors.
  Citations: `packages/platform/src/gateway.ts:1095`,
  `evidence/e5-t08-browser-fallback.json:20`, and
  `evidence/e5-t08-browser-fallback.json:168`.
- OPTIMISTIC APPLY — VERIFIED. The browser oracle holds the dispatch response before
  checking visible wiki bytes, and the `ffdf0df5` causal mutant renders the draft before
  acknowledgement and fails at that exact sensor. Production still awaits dispatch
  confirmation before rendering committed content. Citations: `apps/web/test/wiki.pw.ts:483`,
  `apps/web/test/wiki.pw.ts:525`, `tools/verify/e5_t08_sensitivity.mjs:45`, and
  `evidence/e5-t08-sensitivity.md:12`.
- COVERAGE — VERIFIED. The replacement inventories and fingerprints individual diff
  hunks and emits an independent classification per hunk; the committed artifact shows
  distinct executed, checked, waived, and mixed classifications within the same source
  files. Citations: `tools/verify/e5_t08_coverage.mjs:21`,
  `tools/verify/e5_t08_coverage.mjs:395`, and `evidence/e5-t08-coverage.md`.
- The critic accepted the serialized `06d6d288` → `ffdf0df5` → `b5f6af13` evidence
  chain. No browser run, focused gate, dependency gate, or root suite was rerun.
