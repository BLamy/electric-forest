---
id: E5-T14
epic: 5
title: "Capstone: the meadow as a polished code host — supplied dark product shell, Docstream markdown, Pierre diffs, and Trees file browsing"
priority: 514
status: pending
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

Three implementation choices are mandatory across the whole app:

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

The capstone keeps E5-T13's complete issue-to-merge scenario intact and reruns that one
dependency capstone only. Its recorded walkthrough begins at the repository list, opens
the repository tree, reads a Docstream README/wiki page, opens the PR list and one PR,
reviews its Pierre-rendered changes through the Trees file navigator, and completes the
merge while a second session observes the live state transition.

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

- A shared app shell and token layer implementing the supplied dark visual language at
  desktop and a deliberate responsive layout below 900 px.
- One `Markdown` adapter used by every Markdown callsite and backed by Docstream.
- Pierre Diffs integrated into every diff callsite and Pierre Trees into every file-tree
  callsite, both adapted from existing reducer state without alternate reads or storage.
- Finished repository list/home/tree/blob, issue, wiki, pull-request list/detail/changes,
  and evidence surfaces. Loading, empty, refused, stale, and error states receive the same
  finish as happy paths.
- A focused visual Playwright journey covering the nine source compositions at fixed
  desktop and mobile viewports, with semantic assertions and zero console errors.
- Same-session Replay + MP4 evidence for the final two-client E5-T13 journey through the
  finished shell; screenshots of each required composition are committed under
  `evidence/actual/` for critic comparison.
- A package/source manifest pinning the exact Docstream, `@pierre/diffs`, and
  `@pierre/trees` versions used, their licenses, and the adapter entrypoints.

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
inputs to the canonical PR change set. Disable each mandatory package in a scratch copy:
the corresponding route test must fail. Compare actual/reference pairs at both viewports,
then navigate the entire app by keyboard with reduced motion enabled. Finally rerun only
the E5-T13 capstone to prove the visual integration did not alter the collaboration model.

## Verification log

(appended over time by builders and critics)
