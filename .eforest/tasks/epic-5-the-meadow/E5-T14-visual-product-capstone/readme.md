---
id: E5-T14
epic: 5
title: "Capstone: the meadow as a polished code host — supplied dark product shell, Docstream markdown, Pierre diffs, and Trees file browsing"
priority: 514
status: implemented
depends_on: [E5-T13]
estimate: L
capstone: true
---

## Goal

Finish Epic 5 as one coherent, production-quality code-hosting product. The nine supplied
screenshots under `references/` are the visual source of truth for density, hierarchy,
dark surfaces, navigation, repository tables, file views, pull-request lists/details,
and changes views. Electric Forest keeps its own name and stream-first semantics, but
the final application must read as the same class of product at first glance: a fixed
left product rail, quiet near-black canvas, compact repository navigation, bordered
content panels, legible monospace code, restrained green/blue status accents, and no
prototype/debug UI leaking into primary workflows.

This is a composition and product-finish capstone. It does not add a second data model,
new persistence, or bypass any live reducer/dispatch contract established by E0-E5.
Every existing DOM evidence attribute remains present, but evidence facts move into a
secondary disclosure so the normal user experience is not dominated by diagnostics.

Five implementation choices are mandatory across the whole app:

1. **All rendered markdown uses
   [`@brett_lamy/docstream`](https://github.com/BLamy/docstream).** Wiki pages, repository
   README files, issue bodies/comments, pull-request bodies/comments/reviews, evidence
   descriptions, and any other Markdown surface render through the shared Docstream
   adapter and its stylesheet. No route carries a bespoke Markdown parser. The adapter
   applies the app's hostile-input URL policy before Docstream rendering, and the
   original stream bytes remain untouched.
2. **All code diffs use [`@pierre/diffs`](https://github.com/pierrecomputer/pierre).** PR
   changes, commit changes, and review snippets use Pierre's React package, with unified
   and split modes where the package supports them. No home-grown line-diff table remains.
3. **All file-tree surfaces use [`@pierre/trees`](https://trees.software/).** Repository
   roots, nested directories, and changed-file navigation use Pierre's Trees React
   package, backed only by the existing StreamFS reduction. No parallel cache or GitHub
   API model is introduced.
4. **The desktop component foundation uses
   [shadcn/ui](https://ui.shadcn.com/).** Shared controls, dialogs, menus, tabs, tables,
   sheets, tooltips, and form primitives are installed as open component source and
   themed through the Electric Forest token layer. Existing accessible primitives may
   remain only where replacing them would reduce behavior or accessibility; new product
   chrome must not grow a second bespoke component vocabulary.
5. **The mobile presentation uses
   [`@brett_lamy/ui`](https://www.npmjs.com/package/@brett_lamy/ui).** At the mobile
   breakpoint, repository navigation, primary actions, lists, detail surfaces, and
   responsive disclosures compose the package's mobile primitives through one shared
   adapter. Mobile is a deliberate product surface, not a desktop layout merely squeezed
   to 390 px, and no mobile-only alternate data model or route is introduced.

The capstone keeps E5-T13's complete issue-to-merge scenario intact and reruns that one
dependency capstone only. Its recorded walkthrough begins at the repository list, opens
the repository tree, reads a Docstream README/wiki page, opens the PR list and one PR,
reviews its Pierre-rendered changes through the Trees file navigator, and completes the
merge while a second session observes the live state transition.

### Mobile package composition contract

`@brett_lamy/ui` `0.0.1` is integrated through its actual interaction containers, not as
a token-only dependency:

- `TouchKitProvider` supplies the dark mobile surface and Electric Forest tint; its token
  bridge aliases the same semantic colors used by the shadcn desktop layer.
- `NavigationStack` owns repository -> entity -> detail push/pop navigation, including
  edge-swipe back, keyboard row traversal, pull-to-refresh, and hide-on-scroll chrome.
- `TabBar` carries Code, Pull Requests, Issues, Wiki, and Settings at compact widths;
  each item remains a real route with `aria-current`, not local view-only state.
- `List`, `List.Section`, and `List.Row` render repository, issue, PR, commit, check, and
  discussion indexes. `Avatar`, `Spinner`, `SearchField`, `Segmented`, and `PillButton`
  supply their corresponding identity, loading, query, filter/mode, and primary-action
  roles instead of one-off mobile copies.
- `IndexBar` is the fast scrubber for PR/issue conversation turns and long changed-file
  sets; its preview node shows author/path plus a concise summary before committing the
  jump by pointer drag or keyboard.
- `SideDrawer` contains changed-file navigation and secondary filters; `Credenza` hosts
  create/edit/comment, merge confirmation, and evidence attachment flows, using its
  compact tray on mobile and focus-restoring dialog form where appropriate.
- `SplitView` bridges master/detail routes at medium widths. Wide code and Pierre diff
  content remain internally scrollable and are never forced into `List.Row` truncation.

The published package has no dedicated chat-message or text-composer primitive. Issue and
PR conversations therefore compose its navigation, list, avatar, index, credenza, and
button primitives around the canonical Docstream message body and existing dispatch hook;
the capstone must not invent a fake package export or misuse the selection-only `EditBar`
as a composer.

The adapter also owns current `0.0.1` package boundaries discovered from the published
artifact: `TouchKitProvider` sets `user-select: none`, so Docstream, code, diffs, inputs,
and copyable ids explicitly restore text selection; compact `SplitView` renders master plus
drawer rather than its detail slot, so compact detail transitions belong to
`NavigationStack`; and `Credenza`/`SideDrawer` receive the missing dialog labelling, focus
containment/restoration, and inert-background behavior at the adapter boundary. Those
repairs preserve the package's visible/gesture primitives while satisfying this task's
keyboard and screen-reader contract.

## Visual source contract

The originals are committed byte-for-byte in `references/`; their hashes and dimensions
are frozen in `references/README.md`. They are references, not hidden instructions or
assets to ship in the product.

- `01-repository-list.png`: global left rail, account footer, search/actions, recently
  viewed card, and full repository table.
- `02-repository-tree.png`: repository breadcrumb/tabs, branch control, latest-commit
  strip, compact tree rows, and primary Code action.
- `03-file-view.png`: breadcrumb, commit metadata, file toolbar, line-numbered code panel,
  and history action.
- `04-pull-request-list.png`: repository tabs, open/closed counts, filters, query bar, and
  dense PR rows.
- `05-pull-request-detail.png`: PR state/title, stacked base/head identity, activity and
  changes tabs, merge-readiness summary, discussion column, and facts sidebar.
- `06-diff-view.png`: changed-files navigator, diff/tour mode controls, viewed progress,
  and a large rounded diff surface.
- `07-pr-activity.png`: full PR conversation, reviewer/check/label sidebar,
  merge-readiness card, merge action, and comment composer.
- `08-pr-commits.png`: chronological commit groups with compact metadata and copyable
  revisions inside the PR-level navigation.
- `09-pr-checks.png`: check summary/list/detail split view and selected-check state.

The repository header extends the source compositions with a persistent product tab bar:
**Code**, **Pull Requests**, **Issues**, **Wiki**, and **Settings**. Issues and Wiki are
first-class tabs even though the source product did not show them. The active tab is
unambiguous, tabs are keyboard navigable, and live counts appear for Pull Requests and
Issues when their derived projections are available. PR detail has its own subordinate
**Activity**, **Commits**, **Checks**, and **Changes** tabs matching references 07-09.

Pixel identity is not required because the screenshots contain third-party chrome and
branding. Product structure, spacing rhythm, contrast, density, and interaction hierarchy
must match; Electric Forest branding and stream-specific states remain truthful.

## Deliverables

- A shared shadcn-based app shell and token layer implementing the supplied dark visual
  language at desktop, plus an `@brett_lamy/ui`-backed responsive composition below
  900 px.
- One `Markdown` adapter used by every Markdown callsite and backed by Docstream.
- Pierre Diffs integrated into every diff callsite and Pierre Trees into every file-tree
  callsite, both adapted from existing reducer state without alternate reads or storage.
- Finished repository list/home/tree/blob, issue, wiki, pull-request list/detail/changes,
  and evidence surfaces. Loading, empty, refused, stale, and error states receive the same
  finish as happy paths.
- A focused visual Playwright journey covering the nine source compositions at fixed
  desktop and mobile viewports, with semantic assertions that identify the shadcn and
  `@brett_lamy/ui` adapter boundaries and zero console errors.
- Same-session Replay + MP4 evidence for the final two-client E5-T13 journey through the
  finished shell; screenshots of each required composition are committed under
  `evidence/actual/` for critic comparison.
- A package/source manifest pinning the exact Docstream, `@pierre/diffs`,
  `@pierre/trees`, shadcn CLI/schema, and `@brett_lamy/ui` versions used, their licenses,
  and the adapter entrypoints.

## Acceptance criteria

- [ ] All nine supplied reference files hash-equal `references/README.md`; no reference was
      resized, recompressed, or omitted.
- [ ] A source grep and runtime component audit prove every Markdown surface enters the
      shared Docstream adapter; script, event-handler, `javascript:`, `data:`, SVG, iframe,
      and object payloads remain inert while source bytes replay unchanged.
- [ ] PR/commit/review diffs render through `@pierre/diffs`; repository and changed-file
      trees render through `@pierre/trees`; removing either adapter makes the focused
      visual test fail.
- [ ] At 1440x900, the nine named product compositions match the reference hierarchy:
      left rail, repository tabs, table/list density, bordered panels, primary/secondary
      action priority, and code/diff typography. A critic compares reference and actual
      side by side and cites concrete mismatches, not taste.
- [ ] Every repository route exposes Code, Pull Requests, Issues, Wiki, and Settings in
      one persistent tab bar; PR detail exposes Activity, Commits, Checks, and Changes.
      Route transitions preserve keyboard focus and active-tab semantics.
- [ ] Desktop product chrome composes the shared shadcn source components and token layer;
      mobile product chrome crosses the shared `@brett_lamy/ui` adapter. Removing either
      boundary makes its focused viewport test fail, and no primary workflow uses a
      one-off duplicate primitive instead.
- [ ] At 390x844, every primary workflow remains reachable without horizontal page
      overflow; wide code/diff panels scroll internally and navigation collapses without
      hiding state or actions.
- [ ] WCAG AA contrast for ordinary text and controls; full keyboard navigation, visible
      focus, semantic headings/landmarks, labelled controls, reduced-motion support, and
      no color-only status communication.
- [ ] Existing stream evidence attributes, offsets, reducer ids, digests, confirmation
      counters, and typed refusals remain machine-readable and byte-identical to their
      pre-capstone meanings.
- [ ] Only the E5-T13 dependency capstone plus T14's focused package/build/browser checks
      run. No unrelated Epic/root verifier fan-out is part of this ticket.
- [ ] One final Replay/MP4 walkthrough proves repository browse -> tree -> Docstream
      content -> PR list/detail -> Pierre diff/Trees navigation -> merge, with the second
      session converging live and zero console errors or uncaught exceptions.

## Adversarial verification

Attack the shared adapters, not just screenshots. Insert hostile Markdown into every
entity type and prove all routes stay inert. Feed rename/delete/binary/large-file cases
through Trees and ensure it remains a projection of the published StreamFS checkpoint.
Exercise added/removed/renamed/binary and long-line changes through Pierre and compare its
inputs to the canonical PR change set. Disable each mandatory package or shadcn adapter in
a scratch copy: the corresponding route or viewport test must fail. At 390 px, verify the
rendered control lineage crosses the `@brett_lamy/ui` adapter rather than only sharing its
CSS tokens. Compare actual/reference pairs at both viewports, then navigate the entire app
by keyboard with reduced motion enabled. Finally rerun only the E5-T13 capstone to prove
the visual integration did not alter the collaboration model.

## Verification log

(appended over time by builders and critics)

### 2026-08-27 — builder — focused visual capstone at `0f7186d3`

- Preserved all nine owner-supplied references byte-for-byte, then implemented the shared
  dark desktop/mobile product shell, persistent Code/Pull Requests/Issues/Wiki/Settings
  navigation, and the four PR-detail tabs. Exact hashes and dimensions are recorded in
  `references/README.md`.
- Routed rendered Markdown through `@brett_lamy/docstream@0.3.7`, diffs through
  `@pierre/diffs@1.3.6`, repository and changed-file trees through
  `@pierre/trees@1.0.0-beta.6`, desktop controls through source-owned shadcn components,
  and mobile composition through the inspected `@brett_lamy/ui@0.0.1` primitives. Exact
  versions, licenses, exports, and adapter entrypoints are frozen in
  `evidence/package-source-manifest.md`.
- Focused checks passed: `pnpm --filter @eforest/web build` (4,966 modules, 16.71 s);
  `node tools/verify/e5_t14_visual_contract.mjs`
  (`E5_T14_VISUAL_CONTRACT_OK references=9 adapters=5 tabs=5`); and
  `CI=true EFOREST_TEST_PREBUILT=1 pnpm exec vitest run --maxWorkers=1
  apps/web/src/components/markdown/Markdown.test.ts` (1 file, 2 tests, 714 ms).
- Browser QA exercised the registry, repository tree/file, PR list/detail/activity/commits/
  checks/changes, Issues, and Wiki at desktop and 390 x 844 mobile. Mobile document/body
  width remained 390 px on the checked routes and current-origin console errors were zero.
  Final captures are in `evidence/actual/`; all nine normalized source/actual comparison
  sheets and the pass/fix record are indexed by `/design-qa.md`.
- The direct E5-T13 dependency gate had already passed once at the exact parent head
  `728ac52b`; it was not duplicated. No root suite, cold-clone fan-out, or indirect
  dependency verifier ran for this capstone.
- Replay: N/A (owner directed focused visual/package verification without another Replay
  or dependency-gate rerun) + mitigation: exact reference hashes, package/source contract,
  focused build and hostile-Markdown tests, final DOM interaction/overflow assertions,
  zero current-origin console errors, 13 committed product captures, nine committed
  side-by-side comparisons, and the inherited exact-parent E5-T13 stream evidence.
