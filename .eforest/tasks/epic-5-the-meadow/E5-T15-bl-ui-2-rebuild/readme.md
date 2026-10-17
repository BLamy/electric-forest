---
id: E5-T15
epic: 5
title: "Rebuild the web UI on @brett_lamy/ui 2.0.0: Tailwind v4, owned github-clone and discord-clone registry blocks wired to live stream hooks"
priority: 515
status: pending
deferred_from: implemented
human_deferred_on: 2026-10-16
depends_on: [E5-T14, E12]
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

### 2026-09-30 — builder — CLAIM: implemented

- **Candidate:** `01b571ecf822452c81827b296555a4ff5f254a3d`. This is `2ee7c8b9` (the rebuild) plus
  one change: the border decision below. Branch `claude/ui-2-rebuild`. Evidence paths are
  relative to this task folder.
- **Border decision (the last open criterion).** `--border` was `#15171c`. That is 1.05:1 on
  `--background` and identical to `--muted`, so Box lists, panels and form-field edges had no
  visible boundary. It is now `#686c75`, which clears WCAG 1.4.11's 3:1 on every surface it
  sits on:

  | Surface | Ratio |
  | --- | --- |
  | `--background` | 3.59 |
  | `--card` | 3.34 |
  | `--popover` | 3.09 |
  | `--muted` | 3.41 |

  The capstone's contrast assertion is unchanged and nothing was exempted.
- **Gates** (run once, in order, on `01b571ec`; logs in `evidence/final-run/`):
  - `pnpm format:check && pnpm lint`: exit 0.
  - `pnpm typecheck`: exit 0.
  - `pnpm test`: 122 files and 906 tests passed, exit 0.
  - `pnpm build`: exit 0.
- **Stream layer:**
  - **E5-T13 capstone.** `bash tools/verify/capstone_e5.sh` printed
    `E5_T13_CAUSAL_CAPSTONE_OK browser=rerun streams=7` and the no-database audit passed
    (`final-run/capstone-e5.log`). The run rewrites E5-T13's committed evidence, so I restored
    that evidence and kept the rerun under `final-run/t13-digest/`.
    - Two runs mint different UUIDs: the evidence-content stream, the replay attachment id and
      the wiki file content stream (`t13-uuid-map.txt`).
    - With those three swapped back, replaying all 7 rerun streams with
      `final-run/uuid-digest.mjs` gives a digest list that is `cmp`-identical to E5-T13's
      committed session (`t13-digest-committed.txt` = `t13-digest-rerun-substituted.txt`).
    - Inside the rerun, the replay composite digest equals the DOM composite digest.
  - **Evidence-attribute crawl.**
    `node tools/verify/e5_t15_evidence_crawl.mjs --baseline work/baseline/apps/web/dist --candidate apps/web/dist --out …`
    boots one seeded world and serves the `4752fbeb` bundle and then the candidate bundle, with
    no dispatch in between.
    - It covered 27 routes, 462 rows on each side, `identical=true`.
    - `cmp final-run/crawl/baseline.json final-run/crawl/candidate.json` exits 0. Both files
      have sha256 `f059e216…ce940`.
    - Declared gap: the crawl compares rendered state only. No `data-code` refusal row was
      provoked in it. Refusals are covered below, in the browser layer.
  - **Contract.** `node tools/verify/e5_t15_ui_contract.mjs` printed
    `E5_T15_UI_CONTRACT_OK checks=654 ui=2.0.0 docstream=1.5.0 editor=1.5.0 blocks=22`.
  - **Sensitivity.** `bash final-run/mutate.sh`: the unmutated scratch copy passes, and each of
    the 11 single mutations fails the contract (`final-run/mutate.log`). The mutations are:
    - re-adding `vendor/chatkit`;
    - a block view importing its mock `data.ts`;
    - MarkdownView, MessageMarkdown, FbMd or GitbookStreamdown bypassing the adapter on the
      wiki, chat, issue and PR comment surfaces (one mutation each);
    - the block FileTree and DiffView replacing Pierre;
    - `^2.0.0`, a `2.1.0` pin, and a lockfile resolving another version.
  - **Bundle copies.** `node final-run/bundle-copies.mjs apps/web/dist` reads all 502 inline
    rollup source maps. It finds exactly one store copy each of `@brett_lamy/ui@2.0.0`,
    `@brett_lamy/docstream@1.5.0` and `@brett_lamy/docstream-editor@1.5.0`, and prints
    `E5_T15_BUNDLE_SINGLE_COPY_OK`.
- **Browser layer, local deterministic run (Replay Chromium 108.0.5359.0).**
  `node --experimental-strip-types apps/web/test/visual-capstone.pw.ts` printed
  `E5_T15_BROWSER_OK captures=39 desktop=21 mobile=18 console=0 pageerrors=0`. The transcript
  is `evidence/e5-t15-browser.json` (`sourceHead` `01b571ec`), and all 39 capture hashes match
  `evidence/actual/*.jpg`. It covers:
  - every surface at 1440, including the signed-out landing, and again at 390;
  - NavigationStack:
    - reduced-motion push with no intermediate frames (control with motion allowed: 29
      intermediate frames);
    - pop via the package back control and via history;
    - a 5-screen deep link.
  - ChatShell drawer by pointer and by keyboard: focus moves in, Escape closes, focus returns;
  - the 1440 → 390 resize in the same document;
  - negative states: loading, empty mobile-kit (repo, wiki, labels, issues, pulls), unknown
    routes, and the platform unreachable;
  - hostile Markdown inert on issue, PR comment, wiki (saved from the editor) and chat;
  - keyboard: 90 stops, with arrows in the Repository and Pull request tab lists;
  - accessible names on every control;
  - `contrastFailures: []`.
- **Browser layer, Replay QA: N/A** (project `proj-electric-forest-ms8w0nv1` is `paused`,
  `paused_reason: budget_exhausted`, net 100 of 100 credits; see
  `final-run/qa-project-state.json` and `qa-usage.json`). What happened:
  - `replayqa proxy` connected the tunnel to a fresh world, with a 61787 forwarder for the
    target probe.
  - The service then resumed 28 old manual journey runs (`final-run/qa-resumed-runs.txt`) and
    paused the project for budget.
  - I stopped the proxy. No E5-T15 journey could run, so there are no journey, test-run or bug
    IDs and no recording URL. Raising the budget is the owner's call, not the builder's.
  - The four named journeys (J1–J4) are written and ready to launch: `final-run/qa-journeys/`.
- **Epic-closing exploration: N/A.** E5-T15 is the last open Epic 5 task, and the exploration
  needs the same paused project. It must run when the budget is restored, before Epic 5 is
  called complete.
- **Mitigation for both.** `node final-run/fallback-journeys.mjs evidence/e5-t15-fallback-journeys.json`
  runs J1–J4 headlessly in Replay Chromium 108 through the real UI against a freshly seeded
  world. Result: 25 of 25 steps passed, 0 unexpected console, page or 5xx errors.
  - The only errors logged are 5 expected negatives: the 409 from the stale-wiki refusal and the
    unknown-repo 404s.
  - The one dialog is the CLI-token revoke confirm.
  - Covered, all through dispatch:
    - repo list filter;
    - repo home, tree, blob and history;
    - issue;
    - PR tabs by arrow keys, and PR Changes (Pierre);
    - merge refused with `pr/merge-evidence-missing`, then a Replay link attached, then the
      merge: the second tab sees `merged this pull request` 184 ms later with no reload, and
      its list reads 3 Open / 2 Closed;
    - chat: the run accordion, with messages live in both directions between two tabs;
    - at 390: resize, NavigationStack push and pop (back control and history), deep links,
      every repo surface, the drawer by pointer and keyboard, and the public site;
    - label create, rename and recolor, converging in a second tab (counters sent,
      confirmed and reconciled all 3, refused 0);
    - issue create, label add and remove, close (`issue.opened`, `issue.labeled`,
      `issue.unlabeled`, `issue.closed`);
    - wiki create and save, a stale-edit refusal from a second tab (the page keeps tab A's
      text), rename and delete;
    - member invite;
    - CLI token mint and revoke;
    - the four hostile-Markdown surfaces typed through the UI.
- **Found, not fixed (pre-existing, outside this diff).** One multi-character text-input event
  (`insertText`, which is what IME commits and dictation deliver) carrying the whole hostile
  string into the chat composer throws `RangeError: Position 213 out of range`.
  - The stack goes through `@tiptap/core@3.30.5` `markInputRule` into `tr.delete`.
  - It is recorded as `observation` in the fallback transcript and excluded from pass/fail.
    Typing the same text key by key works.
  - `4752fbeb` used the same TipTap 3.30.5 and `GitbookEditor`. That was inferred from the
    lockfile and source, not reproduced on the baseline.
- **Not re-run on `01b571ec`, declared:**
  - The 16 other `apps/web/test/*.pw.ts` journeys, whose last run was on the prior candidate
    (`work/journeys-candidate`). The delta since then is one CSS token.
  - The Tailwind `@source`-removal attack and the computed-style diff against the upstream docs
    site. The contract checks the `@source` lines statically.
  - Multi-tab follow sharing is proven by `apps/web/src/live.test.ts`, not by a network
    measurement in the browser.

The run shows that the rebuilt UI on `@brett_lamy/ui@2.0.0` renders exactly the same stream
state as the `4752fbeb` baseline. Evidence attributes are `cmp`-identical over 27 routes, and
the E5-T13 capstone's stream digests are identical once the run-minted UUIDs are swapped back.
The `--border` change closes the last criterion: every palette pair, borders included, now meets
WCAG AA. The collaboration model survives the new shell in a real browser: merge gating and
two-tab convergence, chat liveness, and the removal and refusal paths all go through dispatch. That
layer is only local Replay Chromium, though. The required Replay QA journeys and the epic-closing
exploration could not run because the configured project is out of budget, and they must run
before Epic 5 closes.

### 2026-10-16 — human-directed hosting reprioritization

The human explicitly authorized updating the lifecycle to begin Railway hosting and
stubbed first deployments. Administratively defer this task to pending; its existing
implementation, claims, findings, evidence and verification-run history remain intact.
This is not a verification verdict, a finding closure, or a reset of any run/checkpoint.
E12-T00 executes the separate disposable preview scope first. All unearned acceptance
criteria still require their original independent proof before this task can verify.

### 2026-10-16 — hosting-first dependency clarification

The same human authorization prioritizes the complete public hosting epic before this
deferred UI verification. Resume after E12, retaining every original acceptance criterion
and all findings/run history. E12 has its own independent deployment/runtime verification;
its success cannot grant this UI task verified status. No gate or evidence rule is waived.
