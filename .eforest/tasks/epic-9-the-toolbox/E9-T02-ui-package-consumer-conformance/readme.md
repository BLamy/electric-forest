---
id: E9-T02
epic: 9
title: Published UI package subpaths stay small and acyclic for Electric Forest consumers
priority: 902
status: pending
depends_on: [E9-T01]
estimate: M
capstone: false
---

## Goal

An Electric Forest consumer fixture installs a pinned published `@brett_lamy/ui` artifact and proves that the browser-safe root import and selected optional subpaths resolve independently. The root dependency graph excludes unused features, selected modules such as `@brett_lamy/ui/ffmpeg` appear only when imported, and the resolved Docstream/UI package graph contains no cycle.

## Context

The UI source remains owned by its own repository. Electric Forest tests the published package as a consumer and does not vendor, patch, or claim to change it. This catches package-boundary regressions before apps depend on the UI family and leaves Docstream free to compose UI components without a reverse dependency.

## Deliverables

- A browser-only fixture pinned to a published `@brett_lamy/ui` version and integrity hash, with separate root-only, `@brett_lamy/ui/ffmpeg`, and `@brett_lamy/ui/docstream` entrypoints plus an explicit support result for each optional subpath.
- A package/export/dependency-graph audit and per-entrypoint bundle report under `evidence/`.
- `make verify-E9-T02` that resolves the package from its published artifact, not workspace source aliases.

## Acceptance criteria

- [ ] `make verify-E9-T02` installs the exact published version and integrity recorded in `evidence/ui-package-lock.json`; the browser-safe root resolves from that artifact. The matrix records both `@brett_lamy/ui/ffmpeg` and `@brett_lamy/ui/docstream` as `supported` with resolved exports or `unsupported` with exact missing-export results; an unsupported import fails closed rather than resolving through a local alias.
- [ ] The root-only bundle report lists no FFmpeg, Docstream, Electron, Almostnode, Tailscale, or passkey-vault implementation modules in its transitive graph; the selected-FFmpeg report includes the requested subpath and identifies its transitive modules. Both reports and byte counts are committed in `evidence/ui-bundle-reports.json`.
- [ ] The resolved module graph shows Docstream core as headless, Docstream visual components depending only on a leaf UI primitives entrypoint, and the optional aggregate UI Docstream entrypoint composing those components without an edge back from primitives or Docstream core. The graph is acyclic; `evidence/ui-docstream-graph.json` records concrete module paths, nodes, edges, and the result.
- [ ] The fixture contains no copied UI implementation and no source/workspace alias to the UI repository; `make verify-E9-T02` exits 0 and `evidence/consumer-provenance.json` records the installed artifact source and integrity.

## Adversarial verification

1. Import the UI root alone, then add an unused FFmpeg import in a scratch fixture. The first report must exclude FFmpeg and the second must include it; either mismatch refutes tree-shaking/subpath isolation.
2. Add a Docstream-to-UI edge and a UI-to-Docstream edge to the graph fixture. The cycle must be rejected; a green graph check refutes the audit.
3. Replace the installed package with a local source alias or copied implementation. If the provenance check still passes, consumer conformance is not measuring the published package.
4. Remove an export from the pinned artifact or request a nonexistent subpath. A successful resolve refutes export-map verification; an absent optional export without an explicit unsupported result also refutes the matrix.
5. Add a dependency from Docstream core or the UI primitives entrypoint back to the aggregate UI Docstream entrypoint. Any accepted cycle refutes the package-layering audit; the leaf imports must remain usable without loading the aggregate entrypoint.

## Roadmap alignment — 2026-10-16

This is later application-platform work after public launch, design, provider decisions and
changeset migration. Reuse E15's pinned contract/pilot/decision evidence before provider
qualification; optional app providers do not move Forest core authority out of streams.
Application source manifests pin E14 changeset identity and complete file-version/content
references. Derive comparisons in memory rather than storing patch artifacts outside redacted
agent logs.

Browser claims use named Replay QA journeys in `proj-electric-forest-ms8w0nv1` through the
configured managed tunnel; an epic capstone also requires the integrated exploration. Earlier
recording references mean recordings attached to those runs, never a direct local browser
recording substituted as final proof. Cite project/journey/test-run/exploration IDs and paired
stream/object digests. Any fallback follows AGENTS.md and cannot waive a stricter task
requirement.

Generated comparison scenes follow E14-T05's recording masks; do not persist derived
patch text in QA or Playwright evidence outside agent logs.

## Verification log
