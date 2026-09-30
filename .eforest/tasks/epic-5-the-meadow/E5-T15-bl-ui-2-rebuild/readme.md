---
id: E5-T15
epic: 5
title: "Rebuild the web UI on @brett_lamy/ui 2.0.0: Tailwind v4, owned github-clone and discord-clone registry blocks wired to live stream hooks"
priority: 515
status: pending
depends_on: [E5-T14]
estimate: L
capstone: false
---

## Goal

`apps/web` renders every product surface through
[`@brett_lamy/ui@2.0.0`](https://blamy.github.io/ui/) (exact pin), styled by Tailwind v4
through `@tailwindcss/vite`. The repository experience (repo list, repository home,
tree/blob, history, issues list/detail, labels, pull-request list/detail with
Activity/Commits/Checks/Changes, wiki, settings) is built from the package's
**`github-clone` registry block**, installed as owned source under
`apps/web/src/blocks/github/` and rewired from the block's mock `data.ts` to the app's
existing live hooks (`usePrs`, `useIssues`, `useWiki`, `useEvidence`, StreamFS tree/blob
reads, the dispatch hook). Org chat (`/chat/:org/:channel`) and the desktop frame are built
from the **`discord-clone` block** and the package's `ChatShell` parts, replacing the
hand-vendored `apps/web/src/vendor/chatkit`. Compact widths use the package's own adaptive
behaviour (`NavigationStack`, `ChatShell` drawer, `TabView`) rather than a parallel mobile
route tree. The app keeps its Electric Forest name, dark palette and stream-first
semantics; nothing about the data model changes.

## Context

E5-T14 finished the meadow on three foundations that stay mandatory and one pair that this
task replaces:

- **Kept:** all rendered Markdown through `@brett_lamy/docstream` (the shared
  `components/markdown/Markdown.tsx` adapter and its hostile-input URL policy); all diffs
  through `@pierre/diffs`; all file trees through `@pierre/trees`. 2.0.0's `MarkdownView`,
  `SurfaceDiff` and `SurfaceFiles` are themselves built on these packages and may be used
  **only** if they route through the same adapter policy (Markdown URL policy, exact
  content-digest admission for diff text, StreamFS-only tree input).
- **Replaced:** T14 mandate 4 (desktop on source-owned shadcn components in
  `components/ui/`) and mandate 5 (mobile on `@brett_lamy/ui@0.0.1` via
  `DesktopTouchKit`/`MobileProductShell`). Both collapse into one foundation: the 2.0.0
  package plus owned registry-block source. `tools/verify/e5_t14_visual_contract.mjs`
  asserts the old pins (and is already stale: it expects docstream `0.3.7`); this task
  supersedes those assertions with its own contract script and records the supersession
  in E5-T14's Verification log rather than editing T14's verified claim.

Upstream facts established before this task was filed (see `work/` for the fetched
artifacts):

- `@brett_lamy/ui@2.0.0` is the newest published version. The public registry
  (`https://blamy.github.io/ui/r/registry.json`) declares `@brett_lamy/ui@^2.1.0` for its
  blocks, but every `@brett_lamy/ui` import in `github-clone`, `discord-clone` and
  `t3-clone` resolves against 2.0.0's `dist/index.d.ts` (816 exports, zero missing). Pin
  `2.0.0` exactly anyway, as the owner requested.
- The blocks are Tailwind-authored; the package's own components ship compiled CSS
  (`@brett_lamy/ui/styles.css`) plus an optional iOS palette (`theme.css`). The block
  sources need Tailwind to see them, so Tailwind's `@source` must cover
  `src/**/*.{ts,tsx}` and the package's `dist` (for any class strings the package leaves
  to the host).
- 2.0.0 depends on `@brett_lamy/docstream@1.5.0` and `@brett_lamy/docstream-editor@1.5.0`
  while the app pins `0.6.0` / `0.7.0`. The builder resolves this deliberately — either
  align the app to 1.5.0 or prove the duplicate copies do not both load in one route — and
  records which in the claim.
- The discord-clone block's parts (channel list, messages, member list, composer) are
  install-only; `ChatShell`, `TabView`, `Sidebar*`, `Composer*` come from the package.
- The in-flight E6-T12 surfaces committed as the WIP baseline (`RunAccordion`,
  `runSteps`, `referenceSources`, `StreamDevtools`, personal-account code view) are part
  of the UI and are carried into the new shell, not dropped.

## Deliverables

- `apps/web/package.json`: `@brett_lamy/ui` pinned `2.0.0`; `tailwindcss` and
  `@tailwindcss/vite` added; peer deps the blocks need (`react-aria-components`,
  `framer-motion`) added at exact versions. Lockfile updated.
- `apps/web/src/styles/app.css` (or `styles.css` rewritten): `@import "tailwindcss"`, the
  package stylesheet, the `bl-ui` registry style's `@theme` color/spacing/ease tokens, and
  an Electric Forest theme (shadcn CSS variables) replacing `tokens.css`. The bespoke
  `styles.css`, `styles/product-shell.css`, `styles/tokens.css`, `chat/run-accordion.css`
  shrink to only what a block cannot express; the claim reports before/after line counts.
- `apps/web/src/blocks/github/`: the github-clone block as owned source, its `data.ts`
  mock deleted, every view reading a live hook. Each file keeps a header comment naming
  the upstream block file it came from and an `ef:` marker on every divergence.
- `apps/web/src/blocks/chat/`: the discord-clone block parts as owned source driving
  `ChatChannelPage`, `ChatComposer`, `RunAccordion`, members and invite pages.
  `apps/web/src/vendor/chatkit/` is deleted.
- A single app frame (`ForestShell` rewritten or replaced) on `ChatShell` +
  `TabView` workspace rail + `Sidebar*`, used at every width. `MobileProductShell`,
  `MobileConversation`, `MobileOverlays`, `DesktopTouchKit`, `touchkit/tokens.ts` and
  `components/ui/*` are deleted unless a remaining callsite is justified in the claim.
- The public site (`site/*`) restyled on the same tokens and package primitives.
- Every existing `data-testid`, `data-*` evidence attribute (offsets, digests, reducer
  ids, confirmation counters, typed refusals) and route path preserved with identical
  meaning.
- `tools/verify/e5_t15_ui_contract.mjs`: asserts the exact pin, Tailwind wiring, block
  provenance headers, absence of `vendor/chatkit` and `components/ui`, and that the three
  kept foundations (Docstream adapter, Pierre diffs, Pierre trees) are still the only
  Markdown/diff/tree renderers. Prints `E5_T15_UI_CONTRACT_OK ...`.
- Existing Playwright journeys under `apps/web/test/*.pw.ts` updated only where selectors
  referenced deleted chrome; `visual-capstone.pw.ts` re-captures desktop 1440×900 and
  mobile 390×844 into `evidence/actual/`.

## Acceptance criteria

- [ ] `apps/web/package.json` pins `"@brett_lamy/ui": "2.0.0"`; the built bundle contains
      exactly one copy of `@brett_lamy/ui` and exactly one copy of each Docstream package
      (checked from the Vite build manifest/rollup output, not by eye).
- [ ] Gates pass on the final commit: `pnpm format:check && pnpm lint` → `pnpm typecheck`
      → `pnpm test` → `pnpm build`, and the task's focused browser checks.
- [ ] `node tools/verify/e5_t15_ui_contract.mjs` passes, and each of these single
      mutations in a scratch copy makes it (or a named focused test) fail: re-adding
      `vendor/chatkit`; swapping a block view back to its mock `data.ts`; bypassing the
      Docstream adapter in one Markdown callsite; replacing Pierre diffs or trees in one
      callsite; unpinning `@brett_lamy/ui`.
- [ ] No route renders mock data: a source grep finds no import of any block `data.ts`,
      and a browser pass over each repository route shows only the seeded maple /
      reading-room stream data (names, PR numbers, issue titles, file paths).
- [ ] Every `data-testid` referenced by `apps/web/test/**` and `tools/verify/**` still
      resolves on its route; every evidence attribute (offset, digest, reducer id,
      confirmation counter, refusal code) renders byte-identical values to the WIP
      baseline `4752fbeb` for the same stream state.
- [ ] At 1440×900: repo list, repo home, tree, blob, history, issues list/detail, PR
      list, PR Activity/Commits/Checks/Changes, wiki page/editor, settings, labels, chat
      channel (with a run accordion), members, and the public landing are captured to
      `evidence/actual/` and each visibly uses the block structure (global header, repo
      header + underline tabs, bordered Box lists, PR conversation/timeline, chat rail +
      channel sidebar + transcript + composer).
- [ ] At 390×844 the same workflows are reachable, the document never scrolls
      horizontally, code/diff panels scroll internally, and navigation is the package's
      own compact behaviour (`NavigationStack` push/pop or `ChatShell` drawer), verified by
      DOM lineage, not CSS names alone.
- [ ] Live convergence unchanged: the E5-T13 issue-to-merge journey passes through the
      new UI with two sessions converging without reload, and chat messages/agent runs
      appear live in a second session.
- [ ] WCAG AA contrast on the Electric Forest palette, full keyboard navigation of the
      frame, repo tabs and PR tabs, visible focus, labelled controls, reduced-motion
      respected (the package's springs honour `prefers-reduced-motion`).
- [ ] Zero console errors and zero uncaught exceptions across the recorded journey.
- [ ] Recorded Replay walkthrough (per AGENTS.md "Pull requests carry evidence") of:
      repo list → repo home → tree → blob → issue → PR list → PR Changes (Pierre) →
      merge while a second session watches → chat channel with an agent run → 390 px
      pass over the same.

## Adversarial verification

Attack the rewiring, not the screenshots. Grep and runtime-probe for any residue of block
mock data (hard-coded users, `REPO`, `PULLS`, `ISSUE_COUNTS`, `ME`) leaking into a
rendered route, including empty/loading/error states where a lazy builder might fall back
to fixtures. Feed hostile Markdown into issue bodies, PR comments, wiki pages and chat
messages and prove every one still enters the Docstream adapter (the blocks and 2.0.0's
`MarkdownView` both render Markdown — make sure neither bypasses the URL policy). Compare
evidence attributes before/after on identical stream state — digests must `cmp`-equal.
Check the bundle for duplicate Docstream / `@brett_lamy/ui` copies and for Tailwind
purging classes used only inside block sources (a missing utility is a silent layout
break — diff computed styles of a few block nodes against the upstream docs site). At
390 px, confirm compact navigation crosses the package's `NavigationStack`/`ChatShell`
code rather than reimplemented lookalikes. Remove Tailwind's `@source` for the blocks in
a scratch copy and confirm a focused visual test fails. Navigate the whole frame by
keyboard with reduced motion on. Rerun only the E5-T13 capstone to prove the
collaboration model is untouched.

## Verification log

(appended over time by builders and critics)
