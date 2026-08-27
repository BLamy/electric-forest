# E5-T14 visual QA

Final result: **passed**

## Source of truth

- Nine owner-supplied originals are preserved byte-for-byte under
  `.eforest/tasks/epic-5-the-meadow/E5-T14-visual-product-capstone/references/`.
- Hashes and native dimensions are frozen in `references/README.md`.
- The target is the references' product hierarchy and dark visual language, with Electric
  Forest branding and stream-backed state kept truthful.

## Capture setup

- Desktop was exercised at the requested 1440 x 900 browser viewport; the in-app browser
  produced 1425 x 891 content captures after browser chrome/scrollbar allocation.
- Mobile was exercised at exactly 390 x 844.
- Each desktop source/actual pair was independently aspect-fitted and padded to 720 x 450,
  then combined into a 1440 x 450 side-by-side sheet. The original evidence files were not
  resized or overwritten.
- Final captures and all nine comparison sheets live under
  `.eforest/tasks/epic-5-the-meadow/E5-T14-visual-product-capstone/evidence/actual/`.

## Comparison coverage

| Source composition | Final capture | Comparison |
| --- | --- | --- |
| Repository registry | `01-registry-desktop.jpg` | `comparison-01-registry.png` |
| Repository tree | `02-tree-desktop.jpg` | `comparison-02-tree.png` |
| Markdown file view | `03-markdown-file-desktop.jpg` | `comparison-03-file.png` |
| Pull-request list | `04-pulls-list-desktop.jpg` | `comparison-04-pulls.png` |
| Pull-request detail | `05-pr-detail-desktop.jpg` | `comparison-05-detail.png` |
| Pierre diff view | `06-pr-changes-desktop.jpg` | `comparison-06-changes.png` |
| Pull-request activity | `07-pr-activity-desktop.jpg` | `comparison-07-activity.png` |
| Pull-request commits | `08-pr-commits-desktop.jpg` | `comparison-08-commits.png` |
| Pull-request checks | `09-pr-checks-desktop.jpg` | `comparison-09-checks.png` |

Mobile evidence additionally covers Issues, Wiki/Docstream, PR conversation, and Code/
Pierre Trees in `10-mobile-issues.jpg` through `13-mobile-code.jpg`.

## Review history

### Pass 1 findings

- The old light/debug-oriented shell did not match the near-black source product.
- Repository density and hierarchy were too sparse.
- Legacy route links appeared as oversized gray pills instead of compact product tabs.
- Markdown, changes, and file navigation did not have one visible package boundary.
- Mobile inherited desktop widths and clipped long PR conversation content.

### Fixes applied

- Added one fixed dark product rail, compact repository header, restrained bordered panels,
  quiet green/blue status accents, and shared typography/spacing tokens.
- Added persistent Code, Pull Requests, Issues, Wiki, and Settings tabs on every repository
  route, plus Activity, Commits, Checks, and Changes on PR detail.
- Routed all rendered Markdown through the shared Docstream adapter, all diffs through
  Pierre Diffs, and both repository/changed-file trees through Pierre Trees.
- Replaced new desktop controls with source-owned shadcn components and composed mobile
  navigation, lists, overlays, identity, and conversation indexing from `@brett_lamy/ui`.
- Reset inherited desktop `main` widths on mobile, constrained conversation children, and
  restored selectable Docstream/code text inside the mobile provider.

### Final comparison judgment

- **Layout and hierarchy:** matches the references' rail/header/content split, compact
  navigation, dense lists, bordered cards, and PR-level subordinate navigation.
- **Typography:** compact sans-serif product chrome and monospace revisions/code retain the
  same visual roles as the references.
- **Color and surfaces:** near-black canvas, slightly lifted panels, subtle borders, muted
  secondary text, and restrained green/blue/red states match the source language.
- **Images/assets:** no screenshot, browser chrome, third-party logo, or fake placeholder is
  shipped as product UI; the references remain evidence only.
- **Copy:** realistic Electric Forest repository, stream, issue, and PR content replaces the
  source brand without changing its information hierarchy.
- **Severity check:** no P0, P1, or P2 visual mismatch remains in the nine final pairs.

## Interaction and responsive checks

- Repository search filters real rows.
- Code opens the live Pierre tree; README and Wiki content render through Docstream.
- Repository and PR tabs navigate to real routes with active semantics.
- PR Changes switches between Pierre split and unified modes and uses the shared changed-file
  tree.
- Issues, Wiki, Pull Requests, and Settings remain available in the mobile TabBar.
- At 390 x 844, document and body scroll widths remain 390 px for the checked primary routes;
  wide content is contained rather than creating page overflow.
- The final local-browser pass reported zero current-origin console errors.

## Package/source record

Exact installed versions, licenses, source URLs, and Electric Forest adapter entrypoints are
recorded in
`.eforest/tasks/epic-5-the-meadow/E5-T14-visual-product-capstone/evidence/package-source-manifest.md`.
