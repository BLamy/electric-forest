---
id: E9-T08
epic: 9
title: Declare Docstream, FFmpeg, Tailscale, and passkey-vault capabilities per runtime
priority: 908
status: pending
depends_on: [E9-T02, E9-T07]
estimate: M
capstone: false
---

## Goal

Electric Forest app manifests expose Docstream, FFmpeg, Tailscale, and passkey-vault integrations as explicit optional capabilities and package subpaths. A consumer resolves only selected features, and manifest validation refuses any integration/runtime combination not proven compatible by the committed matrix.

## Context

These integrations have distinct runtime and dependency needs. Keeping them opt-in lets a browser UI stay small while Electron or Almostnode apps choose capabilities they can support. Electric Forest owns the consumer checks and compatibility declarations; it does not vendor or claim to modify the source UI package.

## Deliverables

- A versioned integration/runtime compatibility matrix for web, Electron, and Almostnode profiles.
- Consumer fixtures that select and omit each capability/subpath and report their resolved dependency graphs.
- `make verify-E9-T08` with incompatible-profile refusal and unused-feature exclusion evidence.

## Acceptance criteria

- [ ] `evidence/integration-capability-matrix.json` gives each of Docstream, FFmpeg, Tailscale, and passkey vault an explicit package/subpath and per-runtime `supported` or `unsupported` result with pinned artifact identity and reason.
- [ ] For each supported selection, the consumer fixture resolves the declared subpath; for each unsupported selection, manifest validation fails before build/startup with a named capability/profile refusal. Exact results are in `evidence/integration-resolution-matrix.json`.
- [ ] Root-only and selected-feature dependency reports show omitted features absent from the root graph and selected features present only in graphs that request them; reports and bundle byte counts are committed in `evidence/integration-bundle-reports.json`.
- [ ] `make verify-E9-T08` exits 0, and its dependency audit contains no Docstream/UI cycle and no undeclared integration edge; report is `evidence/integration-dependency-audit.json`.

## Adversarial verification

1. Select each incompatible profile/capability pair and attempt to build. Any successful startup/build refutes the fail-closed matrix.
2. Remove a selected subpath export from the pinned artifact. If its consumer test passes, it is resolving an alias or fallback and the evidence is invalid.
3. Add all optional integrations as transitive dependencies of the root entry. If the root-only graph still passes, the unused-feature check is refuted.
4. Add a Docstream/UI cycle or an undeclared runtime edge. A green dependency audit refutes cycle/edge detection.

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
