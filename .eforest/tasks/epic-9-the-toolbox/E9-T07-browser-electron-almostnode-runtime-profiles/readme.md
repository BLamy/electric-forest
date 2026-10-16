---
id: E9-T07
epic: 9
title: Version web, Electron, and Almostnode runtime profiles
priority: 907
status: pending
depends_on: [E9-T01, E9-T02]
estimate: M
capstone: false
---

## Goal

`@eforest/app-manifest` and the starter scaffold describe web, Electron, and Almostnode runtime profiles with explicit entrypoints, compatible capabilities, and allowed dependency sets. A profile build imports only its declared modules and refuses capabilities that the chosen profile cannot run.

## Context

The app contract and published UI consumer fixture provide the inputs for portable app scaffolds. Runtime choice must be visible in the manifest and dependency graph so browser apps do not pull in Electron or Almostnode code and server apps do not accidentally import browser-only modules. Profile declarations describe tested compatibility, not a blanket promise that all packages run everywhere.

## Deliverables

- Versioned profile definitions and scaffold fixtures for web, Electron (main/preload/renderer entrypoints), and Almostnode.
- A cold import/build matrix and forbidden-dependency report for each declared profile.
- `make verify-E9-T07` plus profile fixtures under `evidence/`.

## Acceptance criteria

- [ ] Each profile fixture resolves its manifest-declared entrypoints from a cold install and emits a build/import report with resolved modules and digests in `evidence/runtime-build-matrix.json`.
- [ ] Each profile entrypoint accepts only capabilities declared compatible with that profile; fixtures prove web rejects Electron-main and Almostnode-only imports, Electron rejects an undeclared capability, and Almostnode rejects a browser-only API. Exact refusals and exit statuses are recorded in `evidence/runtime-refusals.json`.
- [ ] Every capability accepted by a profile appears in that profile's manifest declaration and build graph; a static graph audit reports zero undeclared edges in `evidence/runtime-dependency-audit.json`.
- [ ] `make verify-E9-T07` exits 0 from a clean checkout and emits the pinned profile definitions and cold-build digests in `evidence/runtime-profile-digests.txt`.

## Adversarial verification

1. Add an Electron-main import to the web entrypoint, an undeclared capability to the Electron manifest, and a browser-only API to the Almostnode entrypoint. Each corresponding cold build must fail; any passing refutes profile enforcement.
2. Add a capability to a manifest without adding it to the selected profile's compatible set. Any accepted startup refutes the compatibility check.
3. Resolve dependencies through a workspace alias or warm build cache. If the cold-build report omits the actual resolved graph, the evidence is insufficient.
4. Compare declared module edges with the emitted graph. Any undeclared dependency or missing runtime-only edge refutes the audit.

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
