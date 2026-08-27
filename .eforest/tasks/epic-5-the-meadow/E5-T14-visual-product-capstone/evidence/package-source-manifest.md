# E5-T14 package and source manifest

Captured 2026-08-27 from the installed workspace and the npm registry. Versions are
locked by `pnpm-lock.yaml`; application adapters read only the existing reducer state.

| Product boundary           | Exact source                                                                                                            | License                                                                                 | Electric Forest adapter                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Markdown                   | `@brett_lamy/docstream@0.3.7`, export `@brett_lamy/docstream/streamdown`, stylesheet `@brett_lamy/docstream/styles.css` | **Not declared** by the published `0.3.7` npm manifest or its upstream package manifest | `apps/web/src/components/markdown/Markdown.tsx`                                                             |
| Diffs                      | `@pierre/diffs@1.3.6`, export `@pierre/diffs/react`                                                                     | Apache-2.0                                                                              | `apps/web/src/prs/PrDetail.tsx` (`MultiFileDiff`, split/unified modes)                                      |
| File trees                 | `@pierre/trees@1.0.0-beta.6`, export `@pierre/trees/react`                                                              | Apache-2.0                                                                              | `apps/web/src/components/trees/RepositoryTree.tsx` (`FileTree` for repository and changed-file navigation)  |
| Desktop source components  | `shadcn@4.19.0`, schema `https://ui.shadcn.com/schema.json`, New York style, Lucide icons                               | MIT                                                                                     | `apps/web/components.json`; source-owned files under `apps/web/src/components/ui/`                          |
| Mobile product composition | `@brett_lamy/ui@0.0.1`, package root plus `@brett_lamy/ui/styles.css`                                                   | MIT                                                                                     | `apps/web/src/components/mobile/MobileProductShell.tsx`, `MobileOverlays.tsx`, and `MobileConversation.tsx` |

## Adapter contract

- `Markdown` applies Electric Forest's hostile-input URL and active-markup policy before
  handing canonical source text to Docstream. Repository Markdown, wiki, issues, pull
  requests, comments, reviews, and evidence descriptions share this component.
- `RepositoryTree` converts the published StreamFS reduction into Pierre Trees items; it
  introduces no GitHub API, cache, or alternate persistence. The PR changed-file pane uses
  the same adapter boundary.
- `PrDetail` gives Pierre Diffs the canonical PR change set and exposes both split and
  unified presentation modes.
- Desktop buttons, badges, cards, dialogs, inputs, selects, scroll areas, tabs, and
  textareas are source-owned shadcn-style components themed by the shared token layer.
- The mobile shell was checked against the published `0.0.1` implementation, not only its
  type declarations. It composes `TouchKitProvider`, `NavigationStack`, `SplitView`,
  `TabBar`, `List`, `ListRow`, `ListSection`, `SearchField`, `Segmented`, `Avatar`,
  `IndexBar`, `SideDrawer`, and `Credenza`. The adapter restores text selection and adds
  labelled dialog, focus containment/restoration, Escape, and inert-background behavior
  where the package currently leaves those responsibilities to the host app.

## Source links

- Docstream: <https://github.com/BLamy/docstream>
- Pierre Diffs: <https://github.com/pierrecomputer/pierre>
- Pierre Trees: <https://trees.software/>
- shadcn/ui: <https://ui.shadcn.com/>
- `@brett_lamy/ui`: <https://www.npmjs.com/package/@brett_lamy/ui>
